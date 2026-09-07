"""
Evaluates a trained checkpoint and prints per-class AP — the number
that actually matters here, since overall mAP can look fine while the
model is still weak specifically on ambulance/police_vehicle/fire_truck.

Usage:
    python evaluate.py --weights runs/detect/train/weights/best.pt --data data.yaml
"""
import argparse


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", required=True)
    parser.add_argument("--data", default="data.yaml")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--conf", type=float, default=0.25)
    args = parser.parse_args()

    from ultralytics import YOLO

    model = YOLO(args.weights)
    metrics = model.val(data=args.data, imgsz=args.imgsz, conf=args.conf)

    print("\n---- Per-class AP@0.5 ----")
    names = metrics.names
    # metrics.box.ap50 is an array aligned to class index order
    for idx, ap in enumerate(metrics.box.ap50):
        cls_name = names.get(idx, str(idx)) if isinstance(names, dict) else names[idx]
        flag = "  <-- check this one closely" if cls_name in ("ambulance", "fire_truck", "police_vehicle") else ""
        print(f"  {cls_name:16s} AP@0.5 = {ap:.3f}{flag}")

    print(f"\noverall mAP@0.5:      {metrics.box.map50:.3f}")
    print(f"overall mAP@0.5:0.95:  {metrics.box.map:.3f}")


if __name__ == "__main__":
    main()
