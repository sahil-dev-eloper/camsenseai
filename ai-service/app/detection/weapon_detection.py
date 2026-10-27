"""Weapon and harmful sharp object detection.

Detects:
  - Firearms / Guns (via the dedicated threat model)
  - Bladed weapons / Knives (via threat model + COCO)
  - Harmful sharp & blunt tools (scissors, forks, baseball bats from COCO)
  - Explosives / Grenades (via threat model)
"""
from app.config import get_settings
from app.detection.base import Detector
from app.detection.weapon_model import WeaponThreatModel
from app.detection.yolo_model import YoloModel
from app.models.schemas import Detection

# Objects in COCO that are harmful, sharp, or weapon-like:
COCO_SHARP_WEAPON_CLASSES = {"knife", "scissors", "fork", "baseball bat"}

# Threat model labels to consider as weapons:
THREAT_WEAPON_CLASSES = {"gun", "knife", "grenade", "explosion"}


def _iou(box_a: list[int], box_b: list[int]) -> float:
    """Intersection-over-union of two [x, y, w, h] boxes."""
    ax, ay, aw, ah = box_a
    bx, by, bw, bh = box_b
    if aw <= 0 or ah <= 0 or bw <= 0 or bh <= 0:
        return 0.0
    ix1, iy1 = max(ax, bx), max(ay, by)
    ix2, iy2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    union = (aw * ah) + (bw * bh) - inter
    return float(inter / union) if union > 0 else 0.0


class WeaponDetector(Detector):
    type = "weapon"
    label = "Weapon & Sharp Object Detection"

    def detect(self, frame) -> list[Detection]:
        conf = min(float(get_settings().weapon_confidence), 0.20)
        detections: list[Detection] = []

        # 1. Dedicated weapon/threat model (detects Guns, Knives, Grenades)
        threat_model = WeaponThreatModel.instance()
        if threat_model.available:
            result = threat_model.predict(frame, conf=conf, imgsz=480)
            if result is not None and result.boxes is not None:
                for box in result.boxes:
                    cls_id = int(box.cls[0])
                    name = str(threat_model.names.get(cls_id, str(cls_id))).lower()
                    if name not in THREAT_WEAPON_CLASSES:
                        continue
                    box_conf = float(box.conf[0])
                    if box_conf < conf:
                        continue
                    x1, y1, x2, y2 = (int(v) for v in box.xyxy[0].tolist())
                    detections.append(
                        Detection(
                            type=self.type,
                            label=name,
                            confidence=round(box_conf, 2),
                            bbox=[x1, y1, x2 - x1, y2 - y1],
                            source="real",
                        )
                    )

        # 2. Base YOLO model (detects knives, scissors, forks, bats from COCO)
        base_model = YoloModel.instance()
        if base_model.available:
            result = base_model.predict(frame, conf=conf, imgsz=480)
            if result is not None and result.boxes is not None:
                for box in result.boxes:
                    cls_id = int(box.cls[0])
                    name = str(base_model.names.get(cls_id, str(cls_id))).lower()
                    if name not in COCO_SHARP_WEAPON_CLASSES:
                        continue
                    box_conf = float(box.conf[0])
                    if box_conf < conf:
                        continue
                    x1, y1, x2, y2 = (int(v) for v in box.xyxy[0].tolist())
                    cand_box = [x1, y1, x2 - x1, y2 - y1]
                    cand_conf = round(box_conf, 2)

                    # De-duplicate if already detected by threat model with high overlap
                    duplicate = False
                    for existing in detections:
                        if _iou(existing.bbox, cand_box) > 0.35:
                            duplicate = True
                            if cand_conf > existing.confidence:
                                existing.confidence = cand_conf
                                existing.label = name
                            break

                    if not duplicate:
                        detections.append(
                            Detection(
                                type=self.type,
                                label=name,
                                confidence=cand_conf,
                                bbox=cand_box,
                                source="real",
                            )
                        )

        return detections

    def status(self) -> str:
        threat_model = WeaponThreatModel.instance()
        base_model = YoloModel.instance()
        return "active" if (threat_model.available or base_model.available) else "unavailable"
