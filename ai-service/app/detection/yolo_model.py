"""Shared YOLO model loader.

The model is loaded exactly once and reused across all frames and cameras
(per the performance requirement — never reload per frame). If weights are
missing or ultralytics/torch aren't installed, `available` is False and the
detectors fall back gracefully instead of crashing the service.
"""
from __future__ import annotations

import os
import threading

from app.config import get_settings


class YoloModel:
    _instance: "YoloModel | None" = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        self.model = None
        self.available = False
        self.names: dict[int, str] = {}
        self._load()

    def _load(self) -> None:
        settings = get_settings()
        path = settings.model_path
        # Resolve relative to the ai-service root regardless of CWD.
        if not os.path.isabs(path):
            root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
            path = os.path.normpath(os.path.join(root, path))
        try:
            from ultralytics import YOLO  # imported lazily so import errors are caught

            self.model = YOLO(path)
            self.names = self.model.names
            self.available = True
        except Exception as exc:  # noqa: BLE001 - any failure → graceful fallback
            print(f"[yolo] model unavailable: {exc}")
            self.available = False

    @classmethod
    def instance(cls) -> "YoloModel":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = YoloModel()
        return cls._instance

    def predict(self, frame, conf: float, imgsz: int = 480):
        """Run inference on a BGR frame. Returns the ultralytics Results, or None."""
        if not self.available or self.model is None:
            return None

        # Cache result if called multiple times on the same frame in the same tick
        frame_id = id(frame)
        if getattr(self, "_last_frame_id", None) == frame_id and getattr(self, "_last_result", None) is not None:
            return self._last_result

        # Run inference once with lowest threshold needed across detectors
        run_conf = min(float(conf), 0.20)
        res = self.model.predict(frame, conf=run_conf, imgsz=imgsz, verbose=False)[0]
        self._last_frame_id = frame_id
        self._last_result = res
        return res
