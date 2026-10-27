"""Human/person detection using YOLO (COCO 'person' class).

This is a REAL detector: it runs the shared YOLO model and returns actual
person bounding boxes with confidences.
"""
from app.config import get_settings
from app.detection.base import Detector
from app.detection.yolo_model import YoloModel
from app.models.schemas import Detection


class HumanDetector(Detector):
    type = "human"
    label = "Human Detection"

    def detect(self, frame) -> list[Detection]:
        model = YoloModel.instance()
        if not model.available:
            return []

        conf = float(get_settings().person_confidence)
        result = model.predict(frame, conf=conf, imgsz=480)
        if result is None or result.boxes is None:
            return []

        detections: list[Detection] = []
        for box in result.boxes:
            cls_id = int(box.cls[0])
            name = model.names.get(cls_id, str(cls_id))
            if name != "person":
                continue
            box_conf = float(box.conf[0])
            if box_conf < conf:
                continue
            x1, y1, x2, y2 = (int(v) for v in box.xyxy[0].tolist())
            detections.append(
                Detection(
                    type=self.type,
                    label="person",
                    confidence=round(box_conf, 2),
                    bbox=[x1, y1, x2 - x1, y2 - y1],
                    source="real",
                )
            )
        return detections

    def status(self) -> str:
        return "active" if YoloModel.instance().available else "unavailable"
