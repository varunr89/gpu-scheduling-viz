import multiprocessing
from workbench.api.simulator import Simulator
from workbench.api.types import ClusterSpec, RoundEvent, CompleteEvent

class DummySimulator(Simulator):
    name = "Dummy"
    description = "Test simulator"
    api_version = "1.0"
    plugin_version = "0.1"

    @staticmethod
    def config_schema():
        return {
            "type": "object",
            "properties": {
                "policy": {"type": "string", "enum": ["fifo"]},
                "num_rounds": {"type": "integer", "default": 10},
            },
            "required": ["policy"],
        }

    @staticmethod
    def policy_specs():
        return [{"name": "fifo", "description": "First in first out", "config_schema": {}}]

    @staticmethod
    def cluster_presets():
        return {"Tiny": ClusterSpec(gpu_types={"gpu": 4})}

    def run(self, config, event_queue, cancel_event):
        for i in range(config.get("num_rounds", 10)):
            if cancel_event.is_set():
                return
            event_queue.put(RoundEvent(
                round_num=i, elapsed_time=float(i),
                allocations={}, queue=[], metrics={"utilization": 0.5}
            ))
        event_queue.put(CompleteEvent(summary={"avg_jct": 100.0}, config=config))


def test_dummy_simulator_implements_interface():
    sim = DummySimulator()
    assert sim.name == "Dummy"
    assert len(sim.policy_specs()) == 1
    assert "Tiny" in sim.cluster_presets()

def test_dummy_simulator_runs():
    sim = DummySimulator()
    queue = multiprocessing.Queue()
    cancel = multiprocessing.Event()
    sim.run({"policy": "fifo", "num_rounds": 3}, queue, cancel)
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    assert len(events) == 4  # 3 rounds + 1 complete
    assert isinstance(events[0], RoundEvent)
    assert isinstance(events[3], CompleteEvent)

def test_dummy_simulator_cancellation():
    sim = DummySimulator()
    queue = multiprocessing.Queue()
    cancel = multiprocessing.Event()
    cancel.set()
    sim.run({"policy": "fifo", "num_rounds": 100}, queue, cancel)
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    assert len(events) == 0
