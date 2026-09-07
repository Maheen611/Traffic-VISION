"""
The decision engine is the single place that turns raw model output
into the answers the product actually needs to display:

  - should the signal change?
  - should the green corridor start / advance?
  - should an accident alert fire?
  - should rerouting be suggested?
  - should a congestion warning appear?

Every decision it makes is logged as a plain-English string alongside
a structured event so the frontend's "AI Decision Engine" feed and the
`traffic_events` table both get the same source of truth.
"""
from dataclasses import dataclass, field
from typing import List, Optional

from .ambulance import AmbulanceTrack, GreenCorridorEngine
from .accident import AccidentDetector, Incident
from .traffic_intelligence import TrafficIntelligence


@dataclass
class DecisionEvent:
    event_type: str
    severity: str
    description: str
    frame_number: int


class DecisionEngine:
    def __init__(self, fps: float = 25.0, pixels_per_metre: float = None, num_signals: int = 4):
        self.intelligence = TrafficIntelligence(fps=fps, pixels_per_metre=pixels_per_metre)
        self.corridor = GreenCorridorEngine(num_signals=num_signals)
        self.accidents = AccidentDetector(fps=fps)
        self.ambulance_tracks: dict[int, AmbulanceTrack] = {}
        self._last_density: Optional[str] = None
        self.log: List[DecisionEvent] = []

    def process_frame(self, frame_idx: int, tracked_objects, emergency_track_ids: set) -> dict:
        stats = self.intelligence.update(frame_idx, tracked_objects)
        events: List[DecisionEvent] = []

        # congestion warning
        if stats["density"] != self._last_density:
            if stats["density"] in ("High", "Critical"):
                events.append(DecisionEvent(
                    "congestion", "warning" if stats["density"] == "High" else "critical",
                    f"Density escalated to {stats['density']} ({stats['total']} vehicles). "
                    f"Congestion warning raised.", frame_idx,
                ))
            self._last_density = stats["density"]

        # ambulance confirmation + corridor
        for obj in tracked_objects:
            if obj.track_id in emergency_track_ids:
                track = self.ambulance_tracks.setdefault(obj.track_id, AmbulanceTrack(obj.track_id))
                track.update(confidence=obj.confidence)
                if track.confirmed and not self.corridor.is_active:
                    self.corridor.start(obj.track_id)
                    events.append(DecisionEvent(
                        "green_corridor", "critical",
                        f"Ambulance (track #{obj.track_id}) confirmed — green corridor engaged "
                        f"across {self.corridor.num_signals} signals.", frame_idx,
                    ))

        if self.corridor.is_active and frame_idx % 40 == 0:  # placeholder cadence; drive from ETA in production
            self.corridor.advance()
            if self.corridor.is_active:
                events.append(DecisionEvent(
                    "signal_change", "high",
                    f"Signal {self.corridor.current_step + 1} switched to GREEN for corridor sweep.",
                    frame_idx,
                ))
            else:
                events.append(DecisionEvent(
                    "green_corridor", "info", "Ambulance cleared all signals — corridor closed.", frame_idx,
                ))

        # accidents
        tracks_speed = {t.track_id: 0.0 for t in tracked_objects}  # filled by caller in production
        tracks_bbox = {t.track_id: t.bbox for t in tracked_objects}
        for incident in self.accidents.evaluate(frame_idx, tracks_speed, tracks_bbox):
            events.append(DecisionEvent(
                incident.kind, incident.severity, incident.description, frame_idx,
            ))
            if incident.severity in ("high", "critical"):
                events.append(DecisionEvent(
                    "reroute", "warning",
                    f"Alternate route suggested — incident near track(s) {incident.track_ids}.",
                    frame_idx,
                ))

        self.log.extend(events)
        return {
            "stats": stats,
            "corridor": self.corridor.state(),
            "events": [e.__dict__ for e in events],
        }
