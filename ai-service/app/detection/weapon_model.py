"""Dedicated Weapon & Threat YOLO model loader.

Loads the fine-tuned threat detection model (trained to detect Guns, knives,
grenades, and explosions). Runs as a singleton alongside the general YOLO
model so frames are processed without reloading weights.
"""
from __future__ import annotations

import os
import threading

from app.config import get_settings


class WeaponThreatModel:
    _instance: "WeaponThreatModel | None" = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        self.model = None
        self.available = False
        self.names: dict[int, str] = {}
        self._load()

    def _load(self) -> None:
        settings = get_settings()
        path = settings.weapon_model_path
        if not os.path.isabs(path):
            root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
            path = os.path.normpath(os.path.join(root, path))

        if not os.path.exists(path):
            print(f"[weapon_model] dedicated weapon model not found at: {path}")
            self.available = False
            return

        try:
            from ultralytics import YOLO

            self.model = YOLO(path)
            self.names = self.model.names
            self.available = True
            print(f"[weapon_model] dedicated weapon model loaded successfully from {path}")
        except Exception as exc:  # noqa: BLE001
            print(f"[weapon_model] model unavailable: {exc}")
            self.available = False

    @classmethod
    def instance(cls) -> "WeaponThreatModel":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = WeaponThreatModel()
        return cls._instance

    def predict(self, frame, conf: float = 0.20, imgsz: int = 480):
        if not self.available or self.model is None:
            return None
        frame_id = id(frame)
        if getattr(self, "_last_frame_id", None) == frame_id and getattr(self, "_last_result", None) is not None:
            return self._last_result
        res = self.model.predict(frame, conf=conf, imgsz=imgsz, verbose=False)[0]
        self._last_frame_id = frame_id
        self._last_result = res
        return res
