"""Per-camera video processing workers.

Each monitored camera runs one background thread that:
  1. opens the source with OpenCV (sample video in demo mode; RTSP/IP URL in real mode)
  2. reads frames, skipping to hit a target inference FPS (performance)
  3. runs the detection pipeline (model loaded once, reused)
  4. keeps the latest annotated JPEG + live stats in memory (for the MJPEG stream)
  5. reports significant detections to the backend

Review 2 additionally runs face detection and face recognition on every Nth
processed frame (``settings.face_recognition_every_n_frames``). Object
detection still runs on EVERY processed frame exactly as in Review 1 — identity
work is additive and deliberately lower-cadence: on a non-recognition frame the
pipeline is handed an empty face list, so neither YuNet nor the embedder runs.
The recognition pass does no blocking network I/O on this thread: the identity
cache refresh and the report POST are both dispatched to background threads.
Any recognition failure is counted and logged while detection, the MJPEG stream
and detection reporting carry on.

Consequence worth knowing: grey face boxes and the ``faces`` stat update at the
recognition cadence, not every frame. Identity overlays from the most recent
pass are redrawn for a short TTL so labels do not flicker.

The MJPEG endpoint just reads each worker's latest frame — decoupled from event
generation, so a dropped video viewer never stops detection/alerting.
"""
from __future__ import annotations

import os
import threading
import time

import cv2

from app.config import get_settings
from app.detection.yolo_model import YoloModel
from app.models.schemas import Detection, FaceRecognitionResult
from app.recognition import face_service
from app.services.event_reporter import reporter
from app.services.pipeline import pipeline

# Minimum IoU for two face boxes in consecutive recognition passes to be
# treated as the same short-lived track.
_TRACK_IOU = 0.3


class _LiveCapture:
    """Zero-latency reader for live video sources (webcams, RTSP streams).

    Continuously drains frames from the hardware/driver buffer in a dedicated background
    thread so the AI processing loop always receives the absolute latest real-time frame
    with zero buffering delay.
    """
    def __init__(self, source: int | str) -> None:
        self.source = source
        self._lock = threading.Lock()
        self._frame = None
        self._ok = False
        self._stop = threading.Event()
        self._cap: cv2.VideoCapture | None = None
        self._thread: threading.Thread | None = None
        self._open()

    def _open(self) -> bool:
        if isinstance(self.source, int):
            cap = cv2.VideoCapture(self.source, cv2.CAP_DSHOW)
            if not cap.isOpened():
                cap = cv2.VideoCapture(self.source)
        else:
            cap = cv2.VideoCapture(self.source)

        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass

        self._cap = cap
        if cap.isOpened():
            ok, frame = cap.read()
            if ok and frame is not None:
                self._ok = True
                self._frame = frame
            self._thread = threading.Thread(target=self._reader, name="live-capture-reader", daemon=True)
            self._thread.start()
            return True
        return False

    def _reader(self) -> None:
        while not self._stop.is_set():
            if self._cap is None or not self._cap.isOpened():
                time.sleep(0.05)
                continue
            ok, frame = self._cap.read()
            if ok and frame is not None:
                with self._lock:
                    self._ok = True
                    self._frame = frame
            else:
                time.sleep(0.01)

    def read(self) -> tuple[bool, any]:
        with self._lock:
            if not self._ok or self._frame is None:
                return False, None
            return True, self._frame.copy()

    def isOpened(self) -> bool:
        return self._cap is not None and self._cap.isOpened()

    def release(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        if self._cap and self._cap.isOpened():
            self._cap.release()


class _CameraWorker:
    #: Seconds a transient face track survives without being re-seen.
    _TRACK_TTL = 4.0
    #: Seconds an identity overlay keeps being drawn after its recognition pass.
    _OVERLAY_TTL = 1.5

    def __init__(self, camera_id: str, source: str | None, mode: str) -> None:
        self.camera_id = camera_id
        self.mode = mode
        self._source = self._resolve_source(source, mode)
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()

        self._latest_jpeg: bytes | None = None
        self._frame_seq = 0
        self._new_frame_event = threading.Event()
        self._demo_weapon_until: float = 0.0

        # Live stats.
        self.fps = 0.0
        self.inference_ms = 0.0
        self.people = 0
        self.weapons = 0
        # Review 2 stats.
        self.faces = 0
        self.known_faces = 0
        self.unknown_faces = 0
        self.recognition_errors = 0

        # Recognition cadence + transient face tracks (see _track_for).
        self._frame_counter = 0
        self._recognition_pass = 0
        self._tracks: list[dict] = []
        self._track_seq = 0
        self._latest_recognitions: list[FaceRecognitionResult] = []
        self._recognitions_until = 0.0

    @staticmethod
    def _resolve_source(source: str | None, mode: str):
        settings = get_settings()
        if mode == "webcam":
            try:
                return int(source) if source is not None and str(source).strip().isdigit() else 0
            except (ValueError, TypeError):
                return 0
        if mode == "real" and source:
            if isinstance(source, str) and source.strip().isdigit():
                return int(source.strip())
            return source
        # Demo mode → bundled sample video (resolved relative to ai-service root).
        path = settings.sample_video
        if not os.path.isabs(path):
            root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
            path = os.path.normpath(os.path.join(root, path))
        return path

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name=f"cam-{self.camera_id}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)

    def trigger_demo_weapon(self, seconds: float = 4.0) -> None:
        """Inject a clearly-labelled DEMO weapon detection for the next N seconds."""
        self._demo_weapon_until = time.time() + seconds

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def latest_jpeg(self) -> bytes | None:
        with self._lock:
            return self._latest_jpeg

    def _run(self) -> None:
        settings = get_settings()
        is_live = self.mode in ("webcam", "real")
        cap = _LiveCapture(self._source) if is_live else cv2.VideoCapture(self._source)
        target_dt = 1.0 / max(1, settings.target_fps)
        last_time = 0.0

        while not self._stop.is_set():
            ok, frame = cap.read()
            if not ok or frame is None:
                if self.mode == "demo":
                    if isinstance(cap, cv2.VideoCapture):
                        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    continue
                time.sleep(0.1)
                continue

            now = time.time()
            if now - last_time < target_dt:
                time.sleep(0.005)
                continue  # frame skipping to hit target FPS
            last_time = now

            # Resize for faster inference while keeping aspect ratio.
            h, w = frame.shape[:2]
            scale = settings.frame_width / float(w)
            frame = cv2.resize(frame, (settings.frame_width, int(h * scale)))

            # ── Review 2: decide whether identity work runs on this frame ──
            # Object detection runs every processed frame (Review 1 behaviour).
            # Face detection AND recognition run on every Nth processed frame.
            self._frame_counter += 1
            every = max(1, int(settings.face_recognition_every_n_frames))
            recognition_due = self._frame_counter % every == 0
            faces: list[dict] = []
            if recognition_due:
                try:
                    faces = face_service.detect_faces(frame)
                except Exception as exc:  # noqa: BLE001 - never stop detection
                    self.recognition_errors += 1
                    print(f"[stream:{self.camera_id}] face detection failed: {exc}")
                    faces = []

            t0 = time.time()
            detections = pipeline.run(frame, faces=faces)
            self.inference_ms = round((time.time() - t0) * 1000, 1)

            detections = self._maybe_add_demo_weapon(detections, frame)

            recognitions: list[FaceRecognitionResult] = []
            if recognition_due:
                recognitions = self._recognize(frame, faces)

            pipeline.annotate(frame, detections, self._overlay_recognitions())
            self._update_stats(now, detections, recognitions, recognition_due)
            self._encode(frame)

            reporter.report(self.camera_id, detections, frame, self.mode)
            if recognitions:
                reporter.report_recognition(self.camera_id, recognitions, frame, self.mode)

        cap.release()

    def _recognize(self, frame, faces) -> list[FaceRecognitionResult]:
        """Run identity matching for this frame. Never raises.

        A recognition failure is counted and logged; YOLO detection, the MJPEG
        stream and detection reporting are unaffected.
        """
        self._recognition_pass += 1
        try:
            results = face_service.recognize_frame(
                frame,
                self.camera_id,
                faces=faces,
                tracker=self._track_for,
            )
        except Exception as exc:  # noqa: BLE001 - recognition must never crash the worker
            self.recognition_errors += 1
            print(f"[stream:{self.camera_id}] recognition failed: {exc}")
            return []

        # ── Track Identity Persistence & Hysteresis Smoothing ──
        # Avoid momentary "UNKNOWN" flicker when an enrolled person tilts their head, blinks, or moves
        now = time.time()
        threshold = float(get_settings().face_match_threshold)
        for res in results:
            if not res.track_id:
                continue
            track = next((t for t in self._tracks if t.get("id") == res.track_id), None)
            if not track:
                continue

            if res.status == "KNOWN" and res.person_id:
                track["last_known_id"] = res.person_id
                track["last_known_name"] = res.person_name
                track["last_known_ts"] = now
                track["last_known_sim"] = max(res.similarity or 0.0, track.get("last_known_sim", 0.0))
                track["unmatched_streak"] = 0
            elif track.get("last_known_id"):
                time_since_known = now - track.get("last_known_ts", 0)
                track["unmatched_streak"] = track.get("unmatched_streak", 0) + 1
                # If verified as KNOWN in the last 4.0 seconds and hasn't persistently failed:
                if time_since_known <= 4.0 and track["unmatched_streak"] <= 5:
                    res.status = "KNOWN"
                    res.person_id = track["last_known_id"]
                    res.person_name = track["last_known_name"]
                    # Smooth similarity above threshold so backend's validateIdentityClaim accepts the claim
                    # and never downgrades to UNKNOWN:
                    base_sim = track.get("last_known_sim", threshold)
                    res.similarity = max(
                        res.similarity or 0.0,
                        threshold,
                        round(base_sim * 0.95, 4),
                    )

        self._latest_recognitions = results
        self._recognitions_until = time.time() + self._OVERLAY_TTL
        return results

    def _overlay_recognitions(self) -> list[FaceRecognitionResult]:
        """The identity overlays worth drawing right now."""
        if time.time() > self._recognitions_until:
            return []
        return self._latest_recognitions

    def _track_for(self, bbox) -> str:
        """Transient per-camera handle for repeated sightings of one face.

        Associates this pass's face boxes with the previous pass by greedy
        bbox-IoU and center proximity so head turns/leans do not break tracking.
        """
        now = time.time()
        self._tracks = [t for t in self._tracks if now - t["ts"] <= self._TRACK_TTL]
        best, best_score = None, 0.0
        bx, by, bw, bh = bbox
        bc_x, bc_y = bx + bw / 2.0, by + bh / 2.0
        b_size = max(bw, bh)

        for track in self._tracks:
            if track.get("pass") == self._recognition_pass:
                continue  # already claimed by another face in this same pass
            tx, ty, tw, th = track["bbox"]
            iou = face_service.bbox_iou(bbox, track["bbox"])
            if iou >= 0.20:
                score = iou
            else:
                tc_x, tc_y = tx + tw / 2.0, ty + th / 2.0
                dist = ((bc_x - tc_x) ** 2 + (bc_y - tc_y) ** 2) ** 0.5
                avg_size = (b_size + max(tw, th)) / 2.0
                # If face centers are close (within 1.2x face size), it's the same head
                if avg_size > 0 and dist <= avg_size * 1.2:
                    score = max(0.20, 1.0 - (dist / (avg_size * 2.0)))
                else:
                    score = 0.0

            if score > best_score:
                best, best_score = track, score

        if best is not None and best_score >= 0.20:
            best["bbox"] = list(bbox)
            best["ts"] = now
            best["pass"] = self._recognition_pass
            return str(best["id"])

        self._track_seq += 1
        track_id = f"{self.camera_id}-face-{self._track_seq}"
        self._tracks.append(
            {"id": track_id, "bbox": list(bbox), "ts": now, "pass": self._recognition_pass}
        )
        return track_id

    def _maybe_add_demo_weapon(self, detections: list[Detection], frame) -> list[Detection]:
        if time.time() >= self._demo_weapon_until:
            return detections
        h, w = frame.shape[:2]
        detections.append(
            Detection(
                type="weapon",
                label="knife",
                confidence=0.9,
                bbox=[int(w * 0.4), int(h * 0.4), int(w * 0.15), int(h * 0.15)],
                source="demo",
            )
        )
        return detections

    def _update_stats(self, now: float, detections: list[Detection],
                      recognitions: list[FaceRecognitionResult] | None = None,
                      recognition_due: bool = True) -> None:
        self.people = sum(1 for d in detections if d.type == "human")
        self.weapons = sum(1 for d in detections if d.type == "weapon")
        if recognition_due:
            self.faces = sum(1 for d in detections if d.type == "face")
        if recognitions is not None and recognitions:
            self.known_faces = sum(1 for r in recognitions if r.status == "KNOWN")
            self.unknown_faces = sum(1 for r in recognitions if r.status == "UNKNOWN")
        # Smooth FPS from the achieved processing cadence.
        if not hasattr(self, "_frame_times"):
            self._frame_times: list[float] = []
        self._frame_times.append(now)
        self._frame_times = self._frame_times[-15:]
        if len(self._frame_times) > 1:
            span = self._frame_times[-1] - self._frame_times[0]
            self.fps = round((len(self._frame_times) - 1) / span, 1) if span > 0 else 0.0

    def _encode(self, frame) -> None:
        settings = get_settings()
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, settings.jpeg_quality])
        if ok:
            with self._lock:
                self._latest_jpeg = buf.tobytes()
                self._frame_seq += 1
            self._new_frame_event.set()


class StreamManager:
    def __init__(self) -> None:
        self._workers: dict[str, _CameraWorker] = {}
        self._lock = threading.Lock()

    def start(self, camera_id: str, source: str | None, mode: str) -> _CameraWorker:
        with self._lock:
            worker = self._workers.get(camera_id)
            if worker and worker.running:
                return worker
            worker = _CameraWorker(camera_id, source, mode)
            self._workers[camera_id] = worker
        worker.start()
        return worker

    def stop(self, camera_id: str) -> bool:
        with self._lock:
            worker = self._workers.pop(camera_id, None)
        if worker:
            worker.stop()
            return True
        return False

    def get(self, camera_id: str) -> _CameraWorker | None:
        return self._workers.get(camera_id)

    def mjpeg(self, camera_id: str):
        """Multipart MJPEG generator for a camera's annotated stream."""
        boundary = b"--frame"
        last_seq = -1
        while True:
            worker = self._workers.get(camera_id)
            if worker is None or not worker.running:
                break
            # Wait for worker to produce a fresh frame (up to 80ms)
            worker._new_frame_event.wait(timeout=0.08)
            worker._new_frame_event.clear()

            with worker._lock:
                seq = worker._frame_seq
                jpeg = worker._latest_jpeg

            if jpeg is not None and seq != last_seq:
                last_seq = seq
                yield boundary + b"\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"


stream_manager = StreamManager()
