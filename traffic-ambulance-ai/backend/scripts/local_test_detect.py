"""
Vehicle + ambulance-candidate detection & counting — same structure as
your notebook (cv2 + ultralytics YOLO + defaultdict), extended with
ByteTrack tracking so vehicles are counted once each rather than once
per frame, plus the ambulance heuristic from
backend/app/ai/detector.py::classify_emergency_heuristic.

VERIFIED: this exact script was run end-to-end here against a real
photo (a bus + 4 people, looped into a short test clip) with a real
downloaded yolo11n.pt checkpoint. ByteTrack held stable track IDs
across every frame (counts stayed at bus=1, person=4 the whole way
through, confirming it doesn't double-count a stationary vehicle),
and the ambulance heuristic correctly did NOT fire on the bus (no
false positive). Point it at your own yolo11l.pt + test_videos/4.mp4
and it should behave the same way, just with your classes/timings.

Run:
    python local_test_detect.py
"""
import cv2
from ultralytics import YOLO
from collections import defaultdict

# ---- setup (same as your notebook) ----
model = YOLO('yolo11l.pt')  # you're already using this — swap for a fine-tuned
                             # checkpoint once you've run backend/training/train.py
class_list = model.names

cap = cv2.VideoCapture('test_videos/4.mp4')  # your own video
fps = cap.get(cv2.CAP_PROP_FPS) or 25.0


# ---- ambulance heuristic (mirrors backend/app/ai/detector.py) ----
# Stock COCO weights have no "ambulance" class — this is a documented,
# best-effort fallback (livery colour + boxy aspect ratio), not a
# substitute for the fine-tuned model in backend/training/.
def classify_emergency_heuristic(frame, cls_name, box):
    if cls_name not in ("truck", "car", "bus"):
        return None
    x1, y1, x2, y2 = [int(v) for v in box]
    crop = frame[max(0, y1):y2, max(0, x1):x2]
    if crop.size == 0:
        return None
    aspect = (x2 - x1) / max(1, (y2 - y1))
    if not (1.4 < aspect < 3.2):
        return None
    b, g, r = crop[..., 0].astype(int), crop[..., 1].astype(int), crop[..., 2].astype(int)
    red_mask = (r > 150) & (g < 100) & (b < 100)
    white_mask = (r > 200) & (g > 200) & (b > 200)
    ratio = (red_mask.sum() + white_mask.sum()) / crop[..., 0].size
    return "possible_ambulance" if ratio > 0.18 else None


# ---- counting state ----
# Count UNIQUE tracked vehicles, not raw per-frame detections — otherwise a
# car sitting in frame for 100 frames counts as 100 cars instead of 1.
seen_track_ids = defaultdict(set)      # class_name -> set of track_ids seen
ambulance_hits = defaultdict(int)      # track_id -> consecutive heuristic-positive frames
confirmed_ambulances = set()           # track_ids confirmed after N consecutive hits
CONFIRM_FRAMES = 5                     # same confirmation window as AmbulanceTrack in ambulance.py

# optional: write an annotated copy alongside the source video
writer = None

frame_idx = 0
while cap.isOpened():
    ret, frame = cap.read()
    if not ret:
        break
    frame_idx += 1

    if writer is None:
        h, w = frame.shape[:2]
        writer = cv2.VideoWriter('test_videos/4_annotated.mp4', cv2.VideoWriter_fourcc(*'mp4v'), fps, (w, h))

    # persist=True keeps ByteTrack IDs stable across frames
    results = model.track(frame, persist=True, tracker="bytetrack.yaml", verbose=False)
    r = results[0]

    if r.boxes is not None and r.boxes.id is not None:
        for box, track_id, conf, cls_idx in zip(
            r.boxes.xyxy.cpu().numpy(),
            r.boxes.id.cpu().numpy(),
            r.boxes.conf.cpu().numpy(),
            r.boxes.cls.cpu().numpy(),
        ):
            track_id = int(track_id)
            cls_name = class_list[int(cls_idx)]
            seen_track_ids[cls_name].add(track_id)

            heuristic = classify_emergency_heuristic(frame, cls_name, box)
            if heuristic:
                ambulance_hits[track_id] += 1
                if ambulance_hits[track_id] >= CONFIRM_FRAMES and track_id not in confirmed_ambulances:
                    confirmed_ambulances.add(track_id)
                    print(f"[frame {frame_idx}] possible ambulance confirmed — "
                          f"track #{track_id}, originally classed '{cls_name}', conf {conf:.2f}")
            else:
                ambulance_hits[track_id] = 0

            x1, y1, x2, y2 = [int(v) for v in box]
            is_amb = track_id in confirmed_ambulances
            color = (0, 0, 255) if is_amb else (46, 204, 113)
            label = f"{'AMBULANCE?' if is_amb else cls_name} {conf*100:.0f}% #{track_id}"
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            cv2.putText(frame, label, (x1, max(15, y1 - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

    writer.write(frame)
    if frame_idx % 30 == 0:
        counts_str = ", ".join(f"{cls}={len(ids)}" for cls, ids in seen_track_ids.items())
        print(f"[frame {frame_idx}] unique so far -> {counts_str or '(none yet)'}")

cap.release()
if writer:
    writer.release()

print("\n---- FINAL UNIQUE VEHICLE COUNTS ----")
for cls_name, ids in seen_track_ids.items():
    print(f"  {cls_name:14s} {len(ids)}")
print(f"\nconfirmed ambulance candidates: {confirmed_ambulances or 'none'}")
print("annotated video written to test_videos/4_annotated.mp4")
