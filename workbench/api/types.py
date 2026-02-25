from __future__ import annotations
import dataclasses
from dataclasses import dataclass
from typing import Union

@dataclass
class ClusterSpec:
    gpu_types: dict[str, int]        # {"v100": 36, "p100": 36}
    gpus_per_node: int | None = None # None = flat (1 GPU = 1 node)

    @property
    def total_gpus(self) -> int:
        return sum(self.gpu_types.values())

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)

@dataclass
class RoundEvent:
    round_num: int
    elapsed_time: float
    allocations: dict[int, list[int]]  # job_id -> [gpu_indices]
    queue: list[int]
    metrics: dict

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)

@dataclass
class CompleteEvent:
    summary: dict
    config: dict

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)

@dataclass
class ErrorEvent:
    message: str
    traceback: str | None = None

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)

ExperimentEvent = Union[RoundEvent, CompleteEvent, ErrorEvent]
