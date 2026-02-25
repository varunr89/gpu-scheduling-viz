import json
from workbench.api.types import ClusterSpec, RoundEvent, CompleteEvent, ErrorEvent

def test_cluster_spec_creation():
    spec = ClusterSpec(gpu_types={"v100": 36, "p100": 36}, gpus_per_node=8)
    assert spec.gpu_types == {"v100": 36, "p100": 36}
    assert spec.gpus_per_node == 8

def test_cluster_spec_flat():
    spec = ClusterSpec(gpu_types={"v100": 36})
    assert spec.gpus_per_node is None
    assert spec.total_gpus == 36

def test_round_event_serialization():
    event = RoundEvent(
        round_num=0, elapsed_time=0.0,
        allocations={0: [0, 1], 1: [2, 3]},
        queue=[2, 3], metrics={"utilization": 0.5}
    )
    d = event.to_dict()
    assert d["round_num"] == 0
    assert json.dumps(d)  # Must be JSON-serializable

def test_complete_event_serialization():
    event = CompleteEvent(
        summary={"avg_jct": 3600.0, "utilization": 0.94},
        config={"policy": "max_min_fairness"}
    )
    d = event.to_dict()
    assert d["summary"]["avg_jct"] == 3600.0

def test_error_event():
    event = ErrorEvent(message="OOM", traceback="Traceback...")
    d = event.to_dict()
    assert d["message"] == "OOM"
