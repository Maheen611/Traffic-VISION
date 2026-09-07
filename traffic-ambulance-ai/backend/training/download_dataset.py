"""
Downloads a dataset from Roboflow Universe in YOLO format.

Usage:
    export ROBOFLOW_API_KEY=your_key
    python download_dataset.py --workspace <ws> --project <proj> --version 1 --out ../datasets/raw/name

Find <workspace>/<project>/<version> from the dataset's Universe URL:
    https://universe.roboflow.com/<workspace>/<project>/dataset/<version>
"""
import argparse
import os
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--version", type=int, required=True)
    parser.add_argument("--out", required=True, help="Output directory")
    parser.add_argument("--format", default="yolov11", help="Annotation format (yolov11, yolov8, coco, ...)")
    args = parser.parse_args()

    api_key = os.getenv("ROBOFLOW_API_KEY")
    if not api_key:
        sys.exit("Set ROBOFLOW_API_KEY (free account at roboflow.com) before running this script.")

    try:
        from roboflow import Roboflow
    except ImportError:
        sys.exit("Run `pip install roboflow` first.")

    rf = Roboflow(api_key=api_key)
    project = rf.workspace(args.workspace).project(args.project)
    version = project.version(args.version)

    os.makedirs(args.out, exist_ok=True)
    dataset = version.download(args.format, location=args.out)
    print(f"Downloaded to {dataset.location}")


if __name__ == "__main__":
    main()
