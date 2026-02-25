import asyncio
import multiprocessing
import pytest
from pathlib import Path
from workbench.backend.core.runner import ExperimentRunner
from workbench.api.simulator import Simulator
from workbench.api.types import ClusterSpec, RoundEvent, CompleteEvent, ErrorEvent

class SlowSimulator(Simulator):
    name = "Slow"
    description = "Simulator that emits N rounds"
    api_version = "1.0"
    plugin_version = "0.1"

    @staticmethod
    def config_schema():
        return {"type": "object", "properties": {"policy": {"type": "string"}, "num_rounds": {"type": "integer"}}}

    @staticmethod
    def policy_specs():
        return [{"name": "fifo", "description": "FIFO", "config_schema": {}}]

    @staticmethod
    def cluster_presets():
        return {"Tiny": ClusterSpec(gpu_types={"gpu": 4})}

    def run(self, config, event_queue, cancel_event):
        import time
        for i in range(config.get("num_rounds", 5)):
            if cancel_event.is_set():
                return
            event_queue.put(RoundEvent(
                round_num=i, elapsed_time=float(i),
                allocations={}, queue=[], metrics={"utilization": 0.5}
            ))
            time.sleep(0.01)
        event_queue.put(CompleteEvent(summary={"avg_jct": 100.0}, config=config))


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def test_runner_executes_experiment(tmp_path):
    runner = ExperimentRunner(max_workers=1, data_dir=tmp_path)
    collected_events = []

    async def run_it():
        async for event in runner.run_experiment("exp1", SlowSimulator(), {"policy": "fifo", "num_rounds": 3}):
            collected_events.append(event)
        await runner.shutdown()

    _run(run_it())
    assert len(collected_events) == 4  # 3 rounds + 1 complete
    assert isinstance(collected_events[-1], CompleteEvent)

def test_runner_writes_events_to_disk(tmp_path):
    runner = ExperimentRunner(max_workers=1, data_dir=tmp_path)

    async def run_it():
        async for _ in runner.run_experiment("exp2", SlowSimulator(), {"policy": "fifo", "num_rounds": 3}):
            pass
        await runner.shutdown()

    _run(run_it())
    events_dir = tmp_path / "events" / "exp2"
    assert events_dir.exists()
    jsonl_files = list(events_dir.glob("*.jsonl"))
    assert len(jsonl_files) >= 1
