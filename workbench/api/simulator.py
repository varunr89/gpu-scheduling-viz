from __future__ import annotations
import multiprocessing
from abc import ABC, abstractmethod

from workbench.api.types import ClusterSpec

class Simulator(ABC):
    name: str
    description: str
    api_version: str
    plugin_version: str

    @staticmethod
    @abstractmethod
    def config_schema() -> dict:
        """Return JSON Schema for simulator configuration."""
        ...

    @staticmethod
    @abstractmethod
    def policy_specs() -> list[dict]:
        """Return list of supported policies.
        Each: {"name": str, "description": str, "config_schema": dict}"""
        ...

    @staticmethod
    @abstractmethod
    def cluster_presets() -> dict[str, ClusterSpec]:
        """Return named cluster presets for quick UI selection."""
        ...

    @abstractmethod
    def run(self, config: dict,
            event_queue: multiprocessing.Queue,
            cancel_event: multiprocessing.Event) -> None:
        """Run simulation. Emit events into queue. Check cancel_event periodically."""
        ...
