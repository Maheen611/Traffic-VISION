"""
Ambulance priority tracking + green corridor state machine.

The corridor is a simple finite-state machine over N signals
(default 4): once an ambulance track is confirmed for
CONFIRM_FRAMES consecutive frames, the corridor advances one
signal at a time as the ambulance's estimated position/ETA
crosses each signal's trigger distance.
"""
from dataclasses import dataclass, field
from typing import Optional, List


@dataclass
class AmbulanceTrack:
    track_id: int
    confidence_history: List[float] = field(default_factory=list)
    confirmed: bool = False
    speed_kmh: float = 0.0
    lane: Optional[str] = None

    CONFIRM_FRAMES = 5
    CONFIRM_THRESHOLD = 0.5  # fraction of recent frames that must be classed as ambulance

    def update(self, confidence: float):
        self.confidence_history.append(confidence)
        self.confidence_history = self.confidence_history[-10:]
        if len(self.confidence_history) >= self.CONFIRM_FRAMES:
            hit_rate = sum(1 for c in self.confidence_history if c > 0) / len(self.confidence_history)
            self.confirmed = hit_rate >= self.CONFIRM_THRESHOLD


class GreenCorridorEngine:
    """One instance per intersection cluster (default: 4 signals in sequence)."""

    def __init__(self, num_signals: int = 4, trigger_distance_m: float = 120.0):
        self.num_signals = num_signals
        self.trigger_distance_m = trigger_distance_m
        self.signals = ["red"] * num_signals
        self.active_track_id: Optional[int] = None
        self.current_step = -1

    def start(self, track_id: int):
        self.active_track_id = track_id
        self.current_step = 0
        self.signals = ["green" if i == 0 else "red" for i in range(self.num_signals)]

    def advance(self):
        if self.current_step < 0:
            return
        if self.current_step < self.num_signals - 1:
            self.current_step += 1
            self.signals = [
                "green" if i == self.current_step else ("passed" if i < self.current_step else "red")
                for i in range(self.num_signals)
            ]
        else:
            self.finish()

    def finish(self):
        self.active_track_id = None
        self.current_step = -1
        self.signals = ["red"] * self.num_signals

    @property
    def is_active(self) -> bool:
        return self.active_track_id is not None

    def state(self) -> dict:
        return {
            "active": self.is_active,
            "active_track_id": self.active_track_id,
            "current_step": self.current_step,
            "signals": self.signals,
        }
