"""
Fine-tunes a YOLO checkpoint on the merged emergency-vehicle dataset.

Uses Ultralytics' training loop directly (real API, not a wrapper
guess) with augmentation settings tilted to help the rare classes
(ambulance/fire_truck/police_vehicle) — mosaic and copy-paste in
particular expose the model to more varied contexts for whichever
classes are thin on data.

Usage:
    python train.py --data data.yaml --weights yolo11n.pt --epochs 80 \
        --oversample ambulance,fire_truck,police_vehicle
"""
import argparse
import shutil
from pathlib import Path

import yaml


def oversample_rare_classes(data_yaml: Path, class_names: list, factor: int = 3):
    """
    Duplicates (as extra file copies, not just list entries — Ultralytics
    globs the images/ folder directly) images containing any of the given
    rare classes `factor`x in the training split. Cheap, standard trick
    for single-stage detectors where you can't easily reweight the loss
    per class without patching the library.
    """
    with open(data_yaml) as f:
        cfg = yaml.safe_load(f)
    root = data_yaml.parent / cfg.get("path", ".")
    names = cfg["names"]
    name_to_id = {v: k for k, v in (names.items() if isinstance(names, dict) else enumerate(names))}
    rare_ids = {name_to_id[n] for n in class_names if n in name_to_id}
    if not rare_ids:
        print(f"None of {class_names} found in data.yaml names — skipping oversample.")
        return

    train_img_dir = root / cfg["train"]
    train_lbl_dir = train_img_dir.parent.parent / "labels" / train_img_dir.name

    duplicated = 0
    for img_path in list(train_img_dir.glob("*")):
        label_path = train_lbl_dir / (img_path.stem + ".txt")
        if not label_path.exists():
            continue
        has_rare = any(
            int(line.split()[0]) in rare_ids
            for line in label_path.read_text().splitlines() if line.strip()
        )
        if not has_rare:
            continue
        for i in range(factor - 1):  # factor=3 -> 2 extra copies
            new_stem = f"{img_path.stem}__dup{i}"
            shutil.copy2(img_path, train_img_dir / f"{new_stem}{img_path.suffix}")
            shutil.copy2(label_path, train_lbl_dir / f"{new_stem}.txt")
            duplicated += 1
    print(f"Oversampled {duplicated} extra training copies for classes {class_names} (factor={factor}).")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="data.yaml")
    parser.add_argument("--weights", default="yolo11n.pt", help="Starting checkpoint (transfer learning)")
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--device", default="0", help="'0' for first GPU, 'cpu' for CPU")
    parser.add_argument("--oversample", default=None, help="Comma-separated class names to oversample, e.g. ambulance,fire_truck")
    parser.add_argument("--oversample-factor", type=int, default=3)
    parser.add_argument("--project", default="runs/detect")
    parser.add_argument("--name", default="train")
    args = parser.parse_args()

    if args.oversample:
        oversample_rare_classes(Path(args.data), args.oversample.split(","), args.oversample_factor)

    from ultralytics import YOLO

    model = YOLO(args.weights)
    model.train(
        data=args.data,
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        project=args.project,
        name=args.name,
        # augmentation tilted to help minority classes generalize
        mosaic=1.0,
        copy_paste=0.3,
        mixup=0.1,
        hsv_h=0.015, hsv_s=0.7, hsv_v=0.4,  # lighting/livery-colour robustness (ambulances vary by country/state)
        degrees=5.0,
        translate=0.1,
        scale=0.5,
        fliplr=0.5,
        patience=20,  # early stop if val mAP plateaus
    )
    print(f"\nDone. Best weights at {args.project}/{args.name}/weights/best.pt — "
          f"set YOLO_WEIGHTS to that path in your .env")


if __name__ == "__main__":
    main()
