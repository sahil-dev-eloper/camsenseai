"""Downloads the model weights and demo video the AI service needs.

These files are intentionally NOT committed to git (they're large binaries, and
.gitignore already excludes models/*.pt and models/*.onnx), so run this once
after installing dependencies:

    python download_assets.py

It fetches:
  - ../models/yolov8n.pt                              (YOLOv8n weights, ~6 MB, via ultralytics)
  - samples/vtest.avi                                  (OpenCV pedestrian demo video, ~8 MB)
  - ../models/face_detection_yunet_2023mar.onnx        (YuNet face detector, ~230 KB)
  - ../models/face_recognition_sface_2021dec.onnx      (SFace face embedder, ~37 MB)
"""
import os
import shutil
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.normpath(os.path.join(HERE, "..", "models"))
SAMPLES_DIR = os.path.join(HERE, "samples")

VIDEO_URLS = [
    "https://raw.githubusercontent.com/opencv/opencv/4.x/samples/data/vtest.avi",
    "https://raw.githubusercontent.com/opencv/opencv/master/samples/data/vtest.avi",
]

_ZOO_MEDIA = "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models"
_ZOO_RAW = "https://raw.githubusercontent.com/opencv/opencv_zoo/main/models"

FACE_MODELS = [
    {
        "file": "face_detection_yunet_2023mar.onnx",
        "dir": "face_detection_yunet",
        "label": "YuNet face detector",
        "min_bytes": 100_000,
    },
    {
        "file": "face_recognition_sface_2021dec.onnx",
        "dir": "face_recognition_sface",
        "label": "SFace face embedder (128-d)",
        "min_bytes": 10_000_000,
    },
]


def _download_url_to_file(url: str, target: str) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp, open(target, "wb") as f:
        shutil.copyfileobj(resp, f)


def fetch_weights() -> None:
    target = os.path.join(MODELS_DIR, "yolov8n.pt")
    if os.path.exists(target):
        print(f"[OK] weights already present: {target}")
        return
    os.makedirs(MODELS_DIR, exist_ok=True)
    print("Downloading YOLOv8n weights via ultralytics ...")
    from ultralytics import YOLO

    YOLO("yolov8n.pt")  # downloads into CWD
    downloaded = os.path.join(os.getcwd(), "yolov8n.pt")
    if os.path.exists(downloaded):
        shutil.move(downloaded, target)
    print(f"[OK] weights ready: {target}")


def fetch_video() -> None:
    target = os.path.join(SAMPLES_DIR, "vtest.avi")
    if os.path.exists(target):
        print(f"[OK] sample video already present: {target}")
        return
    os.makedirs(SAMPLES_DIR, exist_ok=True)
    print("Downloading sample pedestrian video ...")
    for url in VIDEO_URLS:
        try:
            _download_url_to_file(url, target)
            print(f"[OK] sample video ready: {target}")
            return
        except Exception as exc:
            if os.path.exists(target):
                try:
                    os.remove(target)
                except OSError:
                    pass
            print(f"  -> {url} failed: {exc}")
    print("[X] sample video could not be downloaded (skipping).")


def fetch_face_models() -> None:
    os.makedirs(MODELS_DIR, exist_ok=True)
    for model in FACE_MODELS:
        target = os.path.join(MODELS_DIR, model["file"])
        if os.path.exists(target) and os.path.getsize(target) >= model["min_bytes"]:
            print(f"[OK] {model['label']} already present: {target}")
            continue

        urls = [
            f"{_ZOO_MEDIA}/{model['dir']}/{model['file']}",
            f"{_ZOO_RAW}/{model['dir']}/{model['file']}",
        ]
        print(f"Downloading {model['label']} ...")
        ok = False
        for url in urls:
            try:
                _download_url_to_file(url, target)
                size = os.path.getsize(target)
                if size < model["min_bytes"]:
                    os.remove(target)
                    print(f"  -> {url} returned only {size} bytes (not the real model) - trying next source")
                    continue
                print(f"[OK] {model['label']} ready: {target}")
                ok = True
                break
            except Exception as exc:
                if os.path.exists(target):
                    try:
                        os.remove(target)
                    except OSError:
                        pass
                print(f"  -> {url} failed: {exc}")

        if not ok:
            print(
                f"[X] could not download {model['label']}.\n"
                f"  Face recognition will report UNAVAILABLE until this file exists.\n"
                f"  Place it manually at: {target}\n"
                f"  Source: {urls[0]}"
            )


if __name__ == "__main__":
    fetch_weights()
    fetch_video()
    fetch_face_models()
    print("\nAll AI assets ready. You can now start the service:")
    print("  uvicorn app.main:app --reload")
