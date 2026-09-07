# Fine-tuning YOLO for real ambulance / police / fire-truck detection

Stock COCO-pretrained YOLO weights (`yolo11n.pt` etc.) only know `car`,
`truck`, `bus`, `motorcycle`, `bicycle`, `person`. They have never seen
an "ambulance" label. This directory is the real, runnable path from
"generic vehicle detector" to "actually recognizes emergency vehicles":
pick a dataset → merge it into one taxonomy → check class balance →
train → evaluate → point `YOLO_WEIGHTS` at the result.

## 1. Pick a starting dataset

You don't need to collect images from scratch — there are usable public
datasets on Roboflow Universe today. A few worth starting from
(all checked live, sizes/classes as of this writing):

| Dataset | Images | Classes | License | Link |
|---|---|---|---|---|
| Indian emergency vehicles (AVANTHIKA S) | ~8,200 | 24 fine-grained (ambulance/police/fire-truck variants, Indian road signage) | — check page | [universe.roboflow.com/avanthika-s-nfpex/indian-emergency-vehicles](https://universe.roboflow.com/avanthika-s-nfpex/indian-emergency-vehicles) |
| Emergency Vehicle Detection (zk8pk) | 560 | ambulance, fire-engine, police (clean 3-class) | CC BY 4.0 | [universe.roboflow.com/emergency-vehicle-detection/emergency-vehicle-detection-zk8pk](https://universe.roboflow.com/emergency-vehicle-detection/emergency-vehicle-detection-zk8pk) |
| Ambulance Detection (yolo-emergency-recognition) | 1,000 | ambulance, firetruck | CC BY 4.0 | [universe.roboflow.com/yolo-emergency-recognition/ambulance-detection-wdbvs](https://universe.roboflow.com/yolo-emergency-recognition/ambulance-detection-wdbvs) |
| Ambulance (v18) | 9,013 | ambulance | — check page | [universe.roboflow.com/ambulance-uj5pi/ambulance-sjpea/dataset/18](https://universe.roboflow.com/ambulance-uj5pi/ambulance-sjpea/dataset/18) |
| Emergency vehicles (Traffic) | 242 | ambulance, autorickshaw, bicycle, bus, car, cng, firetruck, motorcycle, police-car, rickshaw, truck, van | CC BY 4.0 | [universe.roboflow.com/traffic-rbwic/emergency-vehicles-snzgj](https://universe.roboflow.com/traffic-rbwic/emergency-vehicles-snzgj) |

**Recommended starting combo for this project:** the *Indian emergency
vehicles* set (biggest, and matches Hyderabad traffic — autorickshaws,
Indian plates, Indian ambulance liveries) merged with the clean 3-class
*zk8pk* set for extra ambulance/police/fire-truck volume, then
supplemented with a general vehicle dataset (or your own recorded
intersection footage) for the car/bus/truck/pedestrian classes so the
model doesn't forget those.

Browse more at the [Roboflow Universe ambulance search](https://universe.roboflow.com/search?q=class:ambulance)
and [emergency-vehicle search](https://universe.roboflow.com/search?q=class:emergency-vehicle) —
check each project's own license before using it commercially; several
above are CC BY 4.0 (free to use with attribution), some don't state a
license on the page, which means asking the uploader before anything
beyond personal/academic use.

## 2. Download

```bash
pip install roboflow
export ROBOFLOW_API_KEY=your_key   # free account at roboflow.com
python download_dataset.py --workspace avanthika-s-nfpex --project indian-emergency-vehicles --version 1 --out ../datasets/raw/indian_ev
python download_dataset.py --workspace emergency-vehicle-detection --project emergency-vehicle-detection-zk8pk --version 1 --out ../datasets/raw/zk8pk
```

## 3. Merge into one taxonomy

Different datasets use different class names/ids for the same thing
(`firetruck` vs `fire_truck` vs `Fire truck`). `merge_datasets.py`
remaps everything to `data.yaml`'s taxonomy and combines the images:

```bash
python merge_datasets.py \
  --sources ../datasets/raw/indian_ev ../datasets/raw/zk8pk \
  --out ../datasets/merged_emergency_vehicles \
  --class-map class_map.json
```

## 4. Check class balance BEFORE training

```bash
python class_balance_report.py --labels ../datasets/merged_emergency_vehicles/labels
```

Emergency-vehicle classes are almost always <5% of instances in any
merged set — that's expected, not a bug. If they come out that low:
- set `--oversample` in `train.py` (duplicates rare-class images in
  the training list — cheap and effective for YOLO)
- keep `mosaic`/`copy_paste` augmentation on (already default in
  `train.py`) — it helps minority classes more than majority ones
- don't just add epochs; a badly imbalanced set overfits on `car`
  first regardless of epoch count

## 5. Train

```bash
python train.py --data data.yaml --weights yolo11n.pt --epochs 80 --imgsz 640 --oversample ambulance,fire_truck,police_vehicle
```

On CPU this is impractically slow for anything beyond a tiny smoke
run — use a GPU (Colab's free tier works for a first pass; expect a
few hours for 80 epochs on ~10k images even on a mid-range GPU).

## 6. Evaluate

```bash
python evaluate.py --weights runs/detect/train/weights/best.pt --data data.yaml
```
Look at **per-class AP**, not just overall mAP — a model can post a
good overall mAP while being weak specifically on `ambulance` because
it's outnumbered 20:1 by `car`. That per-class number is the one that
actually matters for this project.

## 7. Wire it into the app

```bash
# .env
YOLO_WEIGHTS=/absolute/path/to/runs/detect/train/weights/best.pt
```
`detector.py` already reads `YOLO_WEIGHTS` from settings — once it
points here, `TrackedObject.cls` will genuinely be `"ambulance"` /
`"police_vehicle"` / `"fire_truck"` for real, no heuristic fallback
needed. You can then delete/ignore `classify_emergency_heuristic()`.

## Alternative: skip local GPU training, use Roboflow's hosted platform instead

Everything above assumes you're training locally/on a rented GPU. If
you have a Roboflow account connected, their platform can do the
dataset curation *and* the training itself, which sidesteps needing
your own GPU entirely:

1. **Search + fork a dataset** — Roboflow Universe search finds public
   datasets (the same ones listed above, and more); forking one pulls
   it straight into your workspace instead of you downloading/merging
   files by hand.
2. **Upload + label your own footage** — if you record real Hyderabad
   intersection video, Roboflow's data-management tools handle
   upload, labeling, tagging, splits, and versioning in one place —
   more convenient than the local `merge_datasets.py` flow for
   original data (still useful for combining multiple *existing*
   downloaded datasets, though).
3. **Train through the platform** — Roboflow can fine-tune a model for
   you (architecture selection, checkpoints, evaluation metrics) and
   even set up an Active Learning loop, where the model in production
   flags images it's unsure about for you to label and feed back in —
   useful here since ambulance sightings are rare in any given
   intersection feed, so the model needs a steady trickle of new hard
   examples, not just one big upfront training run.
4. **Export or deploy** — pull the resulting weights down for
   `YOLO_WEIGHTS` as above, or call the hosted model directly instead
   of running Ultralytics locally at all.

This wasn't exercised end-to-end in this session — the Roboflow MCP
connection returned an approval error on every call attempted here
(dataset search and workspace listing both failed the same way), so
this section describes the intended flow rather than something
verified against your live account. If you've got Roboflow connected,
worth trying the search/fork tools directly and seeing how far the
guided flow gets you.
