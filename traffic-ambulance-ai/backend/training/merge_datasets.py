"""
Merges one or more YOLO-format datasets (as exported by Roboflow —
train/valid/test splits, each with images/ + labels/, plus a
data.yaml listing that dataset's own class names) into a single
dataset using this project's unified taxonomy (see data.yaml).

Different datasets name the same class differently
("firetruck" vs "fire_truck" vs "fire-engine"). This script
normalizes common synonyms automatically and lets you override
anything it can't resolve via a class_map.json:

    {
      "some_dataset_folder_name:weird_class_name": "fire_truck"
    }

Unmapped classes are skipped (with a printed warning) rather than
guessed — silently misassigning a class is worse than dropping it.

Usage:
    python merge_datasets.py --sources ../datasets/raw/indian_ev ../datasets/raw/zk8pk \
        --out ../datasets/merged_emergency_vehicles --target-yaml data.yaml
"""
import argparse
import json
import shutil
from pathlib import Path

import yaml

# normalized (lowercase, no spaces/dashes/underscores) -> target class name
SYNONYMS = {
    "car": "car", "automobile": "car", "sedan": "car", "hatchback": "car",
    "motorcycle": "bike", "motorbike": "bike", "bike": "bike", "scooter": "bike", "twowheeler": "bike",
    "bus": "bus",
    "truck": "truck", "lorry": "truck", "van": "truck", "pickup": "truck",
    "autorickshaw": "auto_rickshaw", "rickshaw": "auto_rickshaw", "tempo": "auto_rickshaw",
    "cng": "auto_rickshaw", "threewheeler": "auto_rickshaw", "auto": "auto_rickshaw",
    "bicycle": "bicycle", "cycle": "bicycle",
    "person": "pedestrian", "pedestrian": "pedestrian", "human": "pedestrian",
    "ambulance": "ambulance",
    "firetruck": "fire_truck", "firetrucks": "fire_truck", "fireengine": "fire_truck",
    "firebrigade": "fire_truck", "fireladder": "fire_truck",
    "police": "police_vehicle", "policevehicle": "police_vehicle", "policecar": "police_vehicle",
}


def normalize(name: str) -> str:
    return name.lower().strip().replace(" ", "").replace("-", "").replace("_", "")


def load_source_classes(source_dir: Path):
    yaml_path = source_dir / "data.yaml"
    if not yaml_path.exists():
        raise FileNotFoundError(f"No data.yaml found in {source_dir}")
    with open(yaml_path) as f:
        cfg = yaml.safe_load(f)
    names = cfg["names"]
    if isinstance(names, dict):
        # {0: 'car', 1: 'bus', ...} -> ordered list
        names = [names[i] for i in sorted(names.keys())]
    return names  # list, index == class id in this source's label files


def build_class_mapping(source_dir: Path, source_names: list, overrides: dict):
    """Returns {source_class_id: target_class_name or None}."""
    mapping = {}
    for idx, name in enumerate(source_names):
        override_key = f"{source_dir.name}:{name}"
        if override_key in overrides:
            mapping[idx] = overrides[override_key]
        elif name in overrides:
            mapping[idx] = overrides[name]
        else:
            mapping[idx] = SYNONYMS.get(normalize(name))
        if mapping[idx] is None:
            print(f"  [unmapped] {source_dir.name}: class '{name}' (id {idx}) — instances will be skipped. "
                  f"Add \"{source_dir.name}:{name}\": \"target_class\" to your class_map.json to include it.")
    return mapping


def find_splits(source_dir: Path):
    """Roboflow exports use train/valid/test; normalize 'valid' -> 'val'."""
    found = {}
    for split_name, out_name in [("train", "train"), ("valid", "val"), ("val", "val"), ("test", "test")]:
        split_dir = source_dir / split_name
        if split_dir.exists() and (split_dir / "images").exists():
            found[out_name] = split_dir
    return found


def merge(sources: list, out_dir: Path, target_names: list, overrides: dict):
    target_id = {name: i for i, name in enumerate(target_names)}
    out_dir.mkdir(parents=True, exist_ok=True)
    counts = {name: 0 for name in target_names}

    for source_dir in sources:
        source_dir = Path(source_dir)
        print(f"\nProcessing {source_dir} ...")
        source_names = load_source_classes(source_dir)
        mapping = build_class_mapping(source_dir, source_names, overrides)
        splits = find_splits(source_dir)
        if not splits:
            print(f"  No train/valid/test splits found under {source_dir}, skipping.")
            continue

        for out_split, split_dir in splits.items():
            img_dir, lbl_dir = split_dir / "images", split_dir / "labels"
            out_img_dir = out_dir / "images" / out_split
            out_lbl_dir = out_dir / "labels" / out_split
            out_img_dir.mkdir(parents=True, exist_ok=True)
            out_lbl_dir.mkdir(parents=True, exist_ok=True)

            for img_path in img_dir.glob("*"):
                if not img_path.is_file():
                    continue
                label_path = lbl_dir / (img_path.stem + ".txt")
                new_lines = []
                if label_path.exists():
                    for line in label_path.read_text().splitlines():
                        if not line.strip():
                            continue
                        parts = line.split()
                        src_cls = int(parts[0])
                        target_name = mapping.get(src_cls)
                        if target_name is None or target_name not in target_id:
                            continue  # unmapped class, drop this instance
                        counts[target_name] += 1
                        new_lines.append(" ".join([str(target_id[target_name])] + parts[1:]))

                prefixed_stem = f"{source_dir.name}__{img_path.stem}"
                shutil.copy2(img_path, out_img_dir / f"{prefixed_stem}{img_path.suffix}")
                (out_lbl_dir / f"{prefixed_stem}.txt").write_text("\n".join(new_lines))

    # write the merged data.yaml
    merged_yaml = {
        "path": ".",
        "train": "images/train",
        "val": "images/val",
        "names": {i: n for i, n in enumerate(target_names)},
    }
    if (out_dir / "images" / "test").exists():
        merged_yaml["test"] = "images/test"
    with open(out_dir / "data.yaml", "w") as f:
        yaml.safe_dump(merged_yaml, f, sort_keys=False)

    print("\n---- Merged instance counts per target class ----")
    for name, count in counts.items():
        print(f"  {name:16s} {count}")
    total = sum(counts.values())
    for name, count in counts.items():
        if total and count / total < 0.05:
            print(f"  WARNING: '{name}' is {count/total:.1%} of instances — see class_balance_report.py "
                  f"before training, consider --oversample.")
    return counts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sources", nargs="+", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--class-map", default=None, help="Path to class_map.json overrides")
    parser.add_argument("--target-yaml", default=str(Path(__file__).parent / "data.yaml"))
    args = parser.parse_args()

    overrides = {}
    if args.class_map and Path(args.class_map).exists():
        overrides = json.loads(Path(args.class_map).read_text())

    with open(args.target_yaml) as f:
        target_cfg = yaml.safe_load(f)
    target_names_raw = target_cfg["names"]
    target_names = [target_names_raw[i] for i in sorted(target_names_raw.keys())] \
        if isinstance(target_names_raw, dict) else list(target_names_raw)

    merge(args.sources, Path(args.out), target_names, overrides)


if __name__ == "__main__":
    main()
