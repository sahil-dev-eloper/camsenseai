"""Thread-safe cache of the enrolled face embeddings.

Performance requirement: a registered person's embedding is computed ONCE at
registration time and stored by the backend. It is never recomputed at match
time. This cache holds those vectors as a single stacked, L2-normalized numpy
matrix so matching one live face against every enrolled identity is a single
matrix-vector product instead of a Python loop.

Where the data comes from (the AI service never touches MongoDB directly —
the Node backend is the only database owner):

    GET {embedding_source}/api/ai/face-embeddings
    headers: { "x-ai-secret": <settings.ingest_secret> }

Expected response (the usual backend envelope; a bare list or a bare
``{"items": [...]}`` is also accepted so the two services can be deployed
slightly out of step):

    {
      "success": true,
      "data": {
        "items": [
          {
            "personId": "PRN-0001",
            "name": "Example Person",
            "embedding": [0.01, ...],          # 128 floats
            "embeddingModel": "sface_2021dec",
            "embeddingDim": 128
          }
        ]
      }
    }

Only people the backend considers eligible (recognition enabled, not deleted,
valid embedding) must appear in that payload — this cache does not re-apply
that policy, it trusts the backend's filter, and REPLACES its contents
wholesale on every successful refresh so a person who was deleted or had
recognition disabled disappears from matching immediately.

Privacy: embedding values are never printed or logged. Only counts, person
ids, and error strings appear in diagnostics.
"""
from __future__ import annotations

import threading
import time

import numpy as np

from app.config import get_settings


def l2_normalize(matrix: np.ndarray) -> np.ndarray:
    """Row-wise L2 normalization. Zero rows are left as zeros (never NaN)."""
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


class EmbeddingCache:
    """Holds the enrolled identities for vectorized matching."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._matrix: np.ndarray | None = None
        self._people: list[dict] = []
        self._loaded = False          # True once a refresh has ever succeeded
        # TWO CLOCKS, deliberately separate (this was a review finding):
        #   _fetched_at — when a refresh was last ATTEMPTED. Bumped on failure
        #                 too, so a dead backend is not hammered once per frame.
        #                 It is the back-off clock, nothing else.
        #   _loaded_at  — when data was last SUCCESSFULLY installed. Freshness
        #                 is measured from this and only this. Measuring it from
        #                 _fetched_at made the staleness gate unreachable: every
        #                 failed attempt reset the clock, so a cache whose
        #                 refreshes kept failing never aged past TTL + grace.
        self._fetched_at = 0.0
        self._loaded_at = 0.0
        self._last_error: str | None = None
        self._skipped = 0             # candidates dropped for dim/model mismatch
        self._refresh_in_flight = 0   # background/blocking refreshes running now
        self._refresh_thread: threading.Thread | None = None
        # Bumped whenever the cached generation is known to be out of date (an
        # invalidation, or the start of a forced refresh). A fetch that was
        # already in flight when this changed is DISCARDED instead of installed,
        # so a refresh that read the pre-change identity set cannot overwrite a
        # newer one.
        self._generation = 0
        # True from an invalidation until a replacement is installed: the
        # backend has told us this set is out of date, so it is treated as stale
        # (matching fails closed) even if it is still inside its TTL.
        self._superseded = False

    # ── time (one seam, so tests can drive the refresh cycle) ──

    def _now(self) -> float:
        """Current time. Overridden in tests to exercise TTL/grace behaviour
        against the real refresh loop instead of poking timestamps by hand."""
        return time.time()

    # ── state ──────────────────────────────────────────────────

    @property
    def loaded(self) -> bool:
        """True once the identity set has been fetched successfully at least once.

        Matching MUST report RECOGNITION_UNAVAILABLE (never UNKNOWN) while this
        is False: an unloaded cache cannot distinguish "nobody matches" from
        "we could not look".
        """
        with self._lock:
            return self._loaded

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._people)

    @property
    def skipped(self) -> int:
        with self._lock:
            return self._skipped

    @property
    def last_error(self) -> str | None:
        with self._lock:
            return self._last_error

    def age_seconds(self) -> float | None:
        """Age of the DATA currently cached (seconds since the last successful
        load), or None if nothing has ever loaded. Deliberately not the age of
        the last attempt — see the two clocks in ``__init__``."""
        with self._lock:
            if not self._loaded_at:
                return None
            return round(self._now() - self._loaded_at, 1)

    def attempt_age_seconds(self) -> float | None:
        """Seconds since a refresh was last attempted (the back-off clock)."""
        with self._lock:
            if not self._fetched_at:
                return None
            return round(self._now() - self._fetched_at, 1)

    @property
    def superseded(self) -> bool:
        """True when the backend has told us this generation is out of date and
        no replacement has been installed yet."""
        with self._lock:
            return self._superseded

    def is_stale(self, grace: float = 0.0) -> bool:
        """True when the cached identity set must no longer be trusted.

        Stale means: never loaded, superseded by an invalidation we have not
        yet replaced, or LAST SUCCESSFULLY LOADED more than
        ``embedding_cache_ttl + grace`` ago. The middle and last cases are the
        ones that matter for safety — a refresh that keeps failing leaves the
        previous generation in place (deliberately, so a brief backend outage
        does not erase every identity), but that generation may still contain a
        person whose recognition was disabled or who was deleted in the
        meantime. Callers fail CLOSED on a stale cache rather than matching
        against it.

        Measured from ``_loaded_at`` (last success), NOT ``_fetched_at`` (last
        attempt). Using the attempt clock made this unreachable: a refresh
        failing once per TTL reset the age before it could ever exceed
        TTL + grace, which is exactly the scenario the gate exists for.
        """
        settings = get_settings()
        with self._lock:
            if not self._loaded or not self._loaded_at:
                return True
            if self._superseded:
                return True
            age = self._now() - self._loaded_at
        return age >= float(settings.embedding_cache_ttl) + float(grace)

    def state(self) -> dict:
        with self._lock:
            return {
                "loaded": self._loaded,
                "candidates": len(self._people),
                "skipped": self._skipped,
                "age_seconds": self.age_seconds(),
                "last_attempt_age_seconds": self.attempt_age_seconds(),
                "last_error": self._last_error,
                "refreshing": self._refresh_in_flight > 0,
                "superseded": self._superseded,
            }

    def snapshot(self) -> tuple[np.ndarray | None, list[dict]]:
        """Return the current matrix + parallel metadata under one lock.

        Both are returned together so a concurrent refresh can never hand a
        caller a matrix and metadata from two different generations.
        """
        with self._lock:
            return self._matrix, list(self._people)

    def invalidate(self) -> None:
        """Mark the cached generation out of date and force the next access to
        re-fetch.

        Called when the backend tells us the enrolled set changed (a person was
        registered, edited, disabled or deleted). The current data stays
        readable, but it is marked SUPERSEDED, so ``is_stale()`` reports True
        and matching fails closed until a replacement is actually installed —
        the whole point of the notification is that this generation may name
        somebody who must no longer be matched.

        Bumping the generation also means a fetch that is already in flight
        (and may have read the pre-change list) is discarded rather than
        installed.
        """
        with self._lock:
            self._fetched_at = 0.0
            self._generation += 1
            self._superseded = True

    # ── loading ────────────────────────────────────────────────

    def replace(self, items, expected_dim: int | None = None,
                expected_model: str | None = None) -> dict:
        """Replace the cache wholesale from a list of candidate dicts.

        REPLACE, never merge: anything absent from ``items`` is gone. This is
        what makes a deleted or recognition-disabled person immediately
        unmatchable after a refresh.

        Candidates whose embedding dimension or embedding model disagrees with
        the live embedder are DROPPED and counted, never padded, truncated, or
        scored against an incompatible space.
        """
        vectors: list[list[float]] = []
        people: list[dict] = []
        skipped = 0

        for raw in items or []:
            if not isinstance(raw, dict):
                skipped += 1
                continue
            embedding = raw.get("embedding") or raw.get("faceEmbedding")
            person_id = raw.get("personId") or raw.get("person_id") or raw.get("id")
            if not isinstance(embedding, (list, tuple)) or not embedding or not person_id:
                skipped += 1
                continue
            model = raw.get("embeddingModel") or raw.get("embedding_model")
            declared_dim = raw.get("embeddingDim") or raw.get("embedding_dim") or len(embedding)

            if expected_dim is not None and len(embedding) != expected_dim:
                skipped += 1
                continue
            try:
                declared_dim = int(declared_dim)
            except (TypeError, ValueError):
                declared_dim = len(embedding)
            if expected_dim is not None and declared_dim != expected_dim:
                skipped += 1
                continue
            if expected_model is not None and model is not None and model != expected_model:
                skipped += 1
                continue
            try:
                vector = [float(v) for v in embedding]
            except (TypeError, ValueError):
                skipped += 1
                continue

            vectors.append(vector)
            people.append(
                {
                    "person_id": str(person_id),
                    "name": raw.get("name") or raw.get("personName") or str(person_id),
                    "embedding_model": model,
                    "embedding_dim": len(vector),
                }
            )

        if vectors:
            matrix = l2_normalize(np.asarray(vectors, dtype=np.float32))
        else:
            matrix = None

        with self._lock:
            self._matrix = matrix
            self._people = people
            self._skipped = skipped
            self._loaded = True
            now = self._now()
            self._fetched_at = now
            # Freshness is measured from here, and only from here.
            self._loaded_at = now
            self._superseded = False
            self._last_error = None
            return {
                "loaded": True,
                "candidates": len(people),
                "skipped": skipped,
                "age_seconds": 0.0,
                "last_error": None,
            }

    def ensure_fresh(self, expected_dim: int | None = None,
                     expected_model: str | None = None,
                     force: bool = False,
                     blocking: bool = True) -> bool:
        """Refresh if never loaded, past its TTL, or forced. Returns ``loaded``.

        ``blocking=False`` (what the camera workers use) dispatches the fetch
        on a short-lived background thread and returns IMMEDIATELY with
        whatever is currently cached. That matters because this is called from
        the same worker thread that runs YOLO: a backend that accepts
        connections but stalls must not be able to hold up human and weapon
        detection.

        DEDUPLICATION APPLIES TO UNFORCED REFRESHES ONLY. N camera threads
        hitting the same lapsed TTL must not each start a fetch, so an unforced
        call returns early while another refresh is in flight. A FORCED refresh
        (the backend telling us a person changed) is never swallowed that way:
        it bumps the generation — which discards the in-flight fetch's result —
        and runs its own. Returning early from a forced call used to install
        the pre-change identity set and report success.

        ``blocking=True`` (the HTTP cache-refresh route, and the startup
        prefetch) fetches inline, because those callers need to report the
        outcome.

        A failed refresh leaves the previous generation intact and records the
        error — losing contact with the backend must not silently erase every
        identity, and must not crash the camera worker. ``is_stale()`` is what
        stops a long-failing refresh from being trusted indefinitely.
        """
        settings = get_settings()
        with self._lock:
            age = self._now() - self._fetched_at if self._fetched_at else None
            stale = age is None or age >= float(settings.embedding_cache_ttl)
            if not force and not stale:
                return self._loaded
            if self._refresh_in_flight and not force:
                # Someone else is already fetching; never queue a second one.
                return self._loaded
            if force:
                # Supersede anything in flight: its result predates this call.
                self._generation += 1
            self._refresh_in_flight += 1
            generation = self._generation

        if not blocking:
            thread = threading.Thread(
                target=self._refresh_now,
                kwargs={
                    "expected_dim": expected_dim,
                    "expected_model": expected_model,
                    "generation": generation,
                },
                name="face-cache-refresh",
                daemon=True,
            )
            with self._lock:
                self._refresh_thread = thread
            thread.start()
            return self.loaded

        self._refresh_now(
            expected_dim=expected_dim,
            expected_model=expected_model,
            generation=generation,
        )
        return self.loaded

    def refresh_blocking(self, expected_dim: int | None = None,
                         expected_model: str | None = None) -> dict:
        """Invalidate, fetch inline, and report honestly what happened.

        Used by the HTTP cache-refresh route and the startup prefetch. Returns
        ``state()`` plus ``refreshed`` — True only when a fetch actually ran
        AND installed a new generation. The route used to return ``state()``
        alone, which showed ``loaded: true`` and the old candidate count even
        when no fetch had run at all, so the backend logged a refresh that had
        not happened.
        """
        self.invalidate()
        with self._lock:
            self._generation += 1
            self._refresh_in_flight += 1
            generation = self._generation
        installed = self._refresh_now(
            expected_dim=expected_dim,
            expected_model=expected_model,
            generation=generation,
        )
        result = self.state()
        result["refreshed"] = bool(installed)
        return result

    def _refresh_now(self, expected_dim: int | None = None,
                     expected_model: str | None = None,
                     generation: int | None = None) -> bool:
        """Perform one fetch-and-replace.

        Returns True only when this call installed a new generation. Never
        raises, and always releases its in-flight slot.
        """
        try:
            try:
                items = self._fetch_candidates()
            except Exception as exc:  # noqa: BLE001 - backend down must not propagate
                with self._lock:
                    self._last_error = str(exc)
                    # Back off so a dead backend isn't hammered once per frame.
                    # This is the ATTEMPT clock only — _loaded_at is untouched,
                    # so the data keeps ageing towards stale.
                    self._fetched_at = self._now()
                print(f"[face-cache] refresh failed: {exc}")
                return False

            with self._lock:
                superseded = generation is not None and generation != self._generation
                if superseded:
                    # An invalidation (or a forced refresh) happened while this
                    # fetch was in flight, so this list may predate the change.
                    # Discard it rather than install a known-old generation.
                    self._fetched_at = self._now()
                    self._last_error = (
                        "A refresh was superseded by a newer invalidation and its result "
                        "was discarded."
                    )
            if superseded:
                print("[face-cache] refresh result discarded: superseded by a newer invalidation")
                return False

            self.replace(items, expected_dim=expected_dim, expected_model=expected_model)
            return True
        finally:
            with self._lock:
                self._refresh_in_flight = max(0, self._refresh_in_flight - 1)

    def _fetch_candidates(self) -> list[dict]:
        """Fetch the enrolled identities from the backend's internal endpoint.

        Overridden in unit tests so cache behaviour can be verified without a
        running backend.
        """
        import requests  # imported lazily to keep this module test-importable

        settings = get_settings()
        url = f"{settings.embedding_source}/api/ai/face-embeddings"
        response = requests.get(
            url,
            headers={"x-ai-secret": settings.ingest_secret},
            timeout=float(settings.embedding_fetch_timeout),
        )
        response.raise_for_status()
        return self._extract_items(response.json())

    @staticmethod
    def _extract_items(payload) -> list[dict]:
        """Pull the candidate list out of the backend's response envelope."""
        if isinstance(payload, list):
            return payload
        if not isinstance(payload, dict):
            return []
        data = payload.get("data", payload)
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            items = data.get("items")
            if isinstance(items, list):
                return items
        items = payload.get("items")
        return items if isinstance(items, list) else []


#: Process-wide cache shared by the HTTP layer and every camera worker.
embedding_cache = EmbeddingCache()
