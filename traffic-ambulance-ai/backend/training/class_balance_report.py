"""
Scans a YOLO-format labels directory and reports instance counts per
class, so you know how imbalanced your merged dataset actually is
before spending GPU hours training on it.

Usage:
    python class_balance_report.py --labels ../datasets/merged_emergency_vehicles/labels --data data.yaml
"""
import argparse
from collections import Counter
from pathlib import Path

import yaml


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--labels", required=True, help="Directory containing label .txt files (searches recursively)")
    parser.add_argument("--data", default=str(Path(__file__).parent / "data.yaml"))
    args = parser.parse_args()

    with open(args.data) as f:
        names_raw = yaml.safe_load(f)["names"]
    names = {int(k): v for k, v in names_raw.items()} if isinstance(names_raw, dict) else dict(enumerate(names_raw))

    counts = Counter()
    image_counts = Counter()  # how many images contain >=1 instance of a class
    files = list(Path(args.labels).rglob("*.txt"))
    if not files:
        raise SystemExit(f"No label files found under {args.labels}")

    for label_file in files:
        seen_classes = set()
        for line in label_file.read_text().splitlines():
            if not line.strip():
                continue
            cls_id = int(line.split()[0])
            counts[cls_id] += 1
            seen_classes.add(cls_id)
        for c in seen_classes:
            image_counts[c] += 1

    total = sum(counts.values())
    print(f"{len(files)} label files, {total} total instances\n")
    print(f"{'class':16s} {'instances':>10s} {'% of total':>11s} {'images w/ 1+':>13s}")
    print("-" * 54)
    for cls_id in sorted(names.keys()):
        n = counts.get(cls_id, 0)
        pct = (n / total * 100) if total else 0
        imgs = image_counts.get(cls_id, 0)
        flag = "  <-- rare, see README" if total and n / total < 0.05 else ""
        print(f"{names[cls_id]:16s} {n:>10d} {pct:>10.1f}% {imgs:>13d}{flag}")


if __name__ == "__main__":
    main()
