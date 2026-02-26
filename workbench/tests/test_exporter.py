"""Tests for the Exporter -- JSONL events to .viz.bin conversion."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Dict, List

import pytest

# Ensure project root is on sys.path so tools.binary_format is importable.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from workbench.backend.core.exporter import Exporter  # noqa: E402
from tools.binary_format import read_viz_header, unpack_header  # noqa: E402


# -----------------------------------------------------------------------
# Helpers for creating fake event data
# -----------------------------------------------------------------------

def _make_round_event(
    round_num: int,
    allocations: Dict[str, List[int]],
    queue: List[int],
    elapsed_time: float = 0.0,
    utilization: float = 0.5,
    running: int = 0,
    queued: int = 0,
    completed: int = 0,
) -> dict:
    """Build a RoundEvent dict matching the JSONL format."""
    return {
        "round_num": round_num,
        "elapsed_time": elapsed_time,
        "allocations": allocations,
        "queue": queue,
        "metrics": {
            "utilization": utilization,
            "running": running,
            "queued": queued,
            "completed": completed,
        },
    }


def _make_complete_event(
    avg_jct: float = 100.0,
    num_completed_jobs: int = 3,
    config: dict = None,
) -> dict:
    return {
        "type": "complete",
        "summary": {
            "avg_jct": avg_jct,
            "num_completed_jobs": num_completed_jobs,
        },
        "config": config or {},
    }


def _write_round_events(events_dir: Path, events: List[dict]) -> None:
    """Write round events to a single JSONL chunk file."""
    events_dir.mkdir(parents=True, exist_ok=True)
    path = events_dir / "rounds_0000.jsonl"
    with open(path, "w") as f:
        for evt in events:
            f.write(json.dumps(evt) + "\n")


def _write_complete_event(events_dir: Path, event: dict) -> None:
    events_dir.mkdir(parents=True, exist_ok=True)
    with open(events_dir / "complete.json", "w") as f:
        json.dump(event, f)


# -----------------------------------------------------------------------
# Fixtures
# -----------------------------------------------------------------------

@pytest.fixture
def tmp_dirs(tmp_path):
    """Set up temporary data and viz directories."""
    data_dir = tmp_path / "workbench_data"
    data_dir.mkdir()
    viz_data_dir = tmp_path / "viz_data"
    viz_data_dir.mkdir()
    manifest_path = viz_data_dir / "manifest.json"
    return data_dir, viz_data_dir, manifest_path


@pytest.fixture
def exporter(tmp_dirs):
    data_dir, viz_data_dir, manifest_path = tmp_dirs
    return Exporter(
        data_dir=data_dir,
        viz_data_dir=viz_data_dir,
        manifest_path=manifest_path,
    )


@pytest.fixture
def sample_experiment() -> dict:
    """A minimal experiment dict as returned by the database."""
    return {
        "id": "abcd1234-5678-9012-3456-789012345678",
        "name": "test_fifo_export",
        "policy": "fifo",
        "status": "completed",
        "config": {
            "policy": "fifo",
            "cluster_spec": {"v100": 4},
            "num_total_jobs": 10,
            "seed": 42,
        },
        "summary": {"avg_jct": 100.0, "num_completed_jobs": 3},
    }


@pytest.fixture
def sample_round_events() -> List[dict]:
    """Three rounds with simple allocations on a 4-GPU cluster."""
    return [
        _make_round_event(
            round_num=0,
            allocations={"1": [0, 1], "2": [2]},
            queue=[3, 4],
            elapsed_time=0.0,
            utilization=0.75,
            running=2,
            queued=2,
            completed=0,
        ),
        _make_round_event(
            round_num=1,
            allocations={"1": [0, 1], "2": [2], "3": [3]},
            queue=[4],
            elapsed_time=360.0,
            utilization=1.0,
            running=3,
            queued=1,
            completed=0,
        ),
        _make_round_event(
            round_num=2,
            allocations={"3": [0, 1], "4": [2, 3]},
            queue=[],
            elapsed_time=720.0,
            utilization=1.0,
            running=2,
            queued=0,
            completed=2,
        ),
    ]


# -----------------------------------------------------------------------
# Tests
# -----------------------------------------------------------------------

class TestReadRoundEvents:
    """Test _read_round_events."""

    def test_reads_single_chunk(self, tmp_path):
        events_dir = tmp_path / "events" / "exp1"
        events = [
            _make_round_event(0, {"1": [0]}, []),
            _make_round_event(1, {"2": [1]}, []),
        ]
        _write_round_events(events_dir, events)

        result = Exporter._read_round_events(events_dir)
        assert len(result) == 2
        assert result[0]["round_num"] == 0
        assert result[1]["round_num"] == 1

    def test_reads_multiple_chunks(self, tmp_path):
        events_dir = tmp_path / "events" / "exp1"
        events_dir.mkdir(parents=True)

        # Chunk 0
        with open(events_dir / "rounds_0000.jsonl", "w") as f:
            f.write(json.dumps(_make_round_event(0, {}, [])) + "\n")
            f.write(json.dumps(_make_round_event(1, {}, [])) + "\n")

        # Chunk 1
        with open(events_dir / "rounds_0001.jsonl", "w") as f:
            f.write(json.dumps(_make_round_event(2, {}, [])) + "\n")

        result = Exporter._read_round_events(events_dir)
        assert len(result) == 3
        assert [r["round_num"] for r in result] == [0, 1, 2]

    def test_returns_empty_for_missing_dir(self, tmp_path):
        result = Exporter._read_round_events(tmp_path / "nonexistent")
        assert result == []


class TestBuildJobs:
    """Test _build_jobs reconstruction from allocation history."""

    def test_basic_jobs(self, sample_round_events):
        jobs = Exporter._build_jobs(sample_round_events, total_gpus=4)
        job_ids = {j["job_id"] for j in jobs}
        # Jobs 1-4 appear in allocations or queues.
        assert job_ids == {1, 2, 3, 4}

    def test_arrival_and_completion_rounds(self, sample_round_events):
        jobs = Exporter._build_jobs(sample_round_events, total_gpus=4)
        by_id = {j["job_id"]: j for j in jobs}

        # Job 1: allocated in rounds 0-1, last_seen=1
        assert by_id[1]["arrival_round"] == 0
        assert by_id[1]["completion_round"] == 1

        # Job 3: first in queue at round 0, allocated at round 1-2
        assert by_id[3]["arrival_round"] == 0
        assert by_id[3]["completion_round"] == 2

    def test_scale_factor_from_gpu_count(self, sample_round_events):
        jobs = Exporter._build_jobs(sample_round_events, total_gpus=4)
        by_id = {j["job_id"]: j for j in jobs}
        # Job 1 uses 2 GPUs.
        assert by_id[1]["scale_factor"] == 2
        # Job 2 uses 1 GPU.
        assert by_id[2]["scale_factor"] == 1


class TestBuildRoundsAndQueues:
    """Test _build_rounds_and_queues conversion."""

    def test_allocation_array(self, sample_round_events):
        config = {"gpu_types": [{"name": "v100", "count": 4}]}
        rounds, queues = Exporter._build_rounds_and_queues(
            sample_round_events, config, total_gpus=4,
        )
        assert len(rounds) == 3

        # Round 0: job 1 on gpus 0,1; job 2 on gpu 2; gpu 3 free.
        assert rounds[0]["allocations"] == [1, 1, 2, 0]
        # Round 1: fully allocated.
        assert rounds[1]["allocations"] == [1, 1, 2, 3]
        # Round 2: job 3 on gpus 0,1; job 4 on gpus 2,3.
        assert rounds[2]["allocations"] == [3, 3, 4, 4]

    def test_queue_lists(self, sample_round_events):
        config = {"gpu_types": [{"name": "v100", "count": 4}]}
        _, queues = Exporter._build_rounds_and_queues(
            sample_round_events, config, total_gpus=4,
        )
        assert queues[0] == [3, 4]
        assert queues[1] == [4]
        assert queues[2] == []

    def test_gpu_used_per_type(self, sample_round_events):
        # 2 GPU types: 2 v100 + 2 p100.
        config = {
            "gpu_types": [
                {"name": "v100", "count": 2},
                {"name": "p100", "count": 2},
            ]
        }
        rounds, _ = Exporter._build_rounds_and_queues(
            sample_round_events, config, total_gpus=4,
        )
        # Round 0: allocs = [1, 1, 2, 0] -> v100: 2 used, p100: 1 used.
        assert rounds[0]["gpu_used"] == [2, 1]

    def test_utilization_from_metrics(self, sample_round_events):
        config = {"gpu_types": [{"name": "v100", "count": 4}]}
        rounds, _ = Exporter._build_rounds_and_queues(
            sample_round_events, config, total_gpus=4,
        )
        assert rounds[0]["utilization"] == 0.75
        assert rounds[1]["utilization"] == 1.0


class TestBuildVizConfig:
    """Test _build_viz_config."""

    def test_from_cluster_spec(self, sample_experiment):
        config = Exporter._build_viz_config(sample_experiment, complete=None)
        assert config["policy"] == "fifo"
        assert config["gpu_types"] == [{"name": "v100", "count": 4}]

    def test_with_complete_event(self, sample_experiment):
        complete = _make_complete_event(config={"seed": 99})
        config = Exporter._build_viz_config(sample_experiment, complete)
        # experiment config seed=42 overrides complete config seed=99
        assert config.get("seed") == 42

    def test_default_gpu_types(self):
        """Falls back to default if no cluster_spec."""
        exp = {"config": {"policy": "fifo"}, "policy": "fifo"}
        config = Exporter._build_viz_config(exp, complete=None)
        assert config["gpu_types"] == [{"name": "gpu", "count": 4}]


class TestExportExperiment:
    """Integration test: full export to .viz.bin."""

    def test_creates_viz_bin(
        self, tmp_dirs, exporter, sample_experiment, sample_round_events,
    ):
        data_dir, viz_data_dir, _ = tmp_dirs
        exp_id = sample_experiment["id"]

        events_dir = data_dir / "events" / exp_id
        _write_round_events(events_dir, sample_round_events)
        _write_complete_event(events_dir, _make_complete_event())

        path = exporter.export_experiment(exp_id, sample_experiment)

        # Verify the file was created.
        assert path.startswith("data/")
        filename = path.replace("data/", "")
        full_path = viz_data_dir / filename
        assert full_path.exists()
        assert full_path.stat().st_size > 0

    def test_viz_bin_header_valid(
        self, tmp_dirs, exporter, sample_experiment, sample_round_events,
    ):
        data_dir, viz_data_dir, _ = tmp_dirs
        exp_id = sample_experiment["id"]

        events_dir = data_dir / "events" / exp_id
        _write_round_events(events_dir, sample_round_events)
        _write_complete_event(events_dir, _make_complete_event())

        path = exporter.export_experiment(exp_id, sample_experiment)
        filename = path.replace("data/", "")
        full_path = viz_data_dir / filename

        header = read_viz_header(str(full_path))
        assert header["num_rounds"] == 3
        assert header["num_gpu_types"] == 1
        assert header["total_gpus"] == 4
        # 4 unique jobs appear in allocations/queues.
        assert header["num_jobs"] == 4

    def test_export_with_empty_allocations(self, tmp_dirs, exporter):
        """Experiments with empty allocations still export successfully."""
        data_dir, viz_data_dir, _ = tmp_dirs
        exp_id = "empty000-0000-0000-0000-000000000000"
        exp = {
            "id": exp_id,
            "name": "empty_test",
            "policy": "fifo",
            "status": "completed",
            "config": {"policy": "fifo", "cluster_spec": {"gpu": 2}},
            "summary": {},
        }

        events_dir = data_dir / "events" / exp_id
        events = [
            _make_round_event(0, {}, [], utilization=0.0),
            _make_round_event(1, {}, [], utilization=0.0),
        ]
        _write_round_events(events_dir, events)
        _write_complete_event(events_dir, _make_complete_event(num_completed_jobs=0))

        path = exporter.export_experiment(exp_id, exp)
        filename = path.replace("data/", "")
        full_path = viz_data_dir / filename
        assert full_path.exists()

        header = read_viz_header(str(full_path))
        assert header["num_rounds"] == 2
        assert header["num_jobs"] == 0
        assert header["total_gpus"] == 2


class TestUpdateManifest:
    """Test manifest.json update logic."""

    def test_creates_manifest_from_scratch(self, tmp_dirs, exporter):
        _, _, manifest_path = tmp_dirs
        assert not manifest_path.exists()

        experiments = [{"name": "exp1", "policy": "fifo", "id": "abc"}]
        paths = ["data/workbench_abc.viz.bin"]
        exporter.update_manifest(experiments, paths)

        assert manifest_path.exists()
        manifest = json.loads(manifest_path.read_text())
        assert len(manifest["experiments"]) == 1
        entry = manifest["experiments"][0]
        assert entry["file"] == "workbench_abc.viz.bin"
        assert entry["filters"]["source"] == "workbench"
        assert entry["filters"]["policy"] == "fifo"

    def test_appends_to_existing_manifest(self, tmp_dirs, exporter):
        _, _, manifest_path = tmp_dirs

        # Write an initial manifest.
        initial = {
            "experiments": [
                {"file": "existing.viz.bin", "label": "Old", "filters": {}, "rounds": 100, "complete": True}
            ]
        }
        manifest_path.write_text(json.dumps(initial))

        experiments = [{"name": "exp2", "policy": "rr", "id": "def"}]
        paths = ["data/workbench_def.viz.bin"]
        exporter.update_manifest(experiments, paths)

        manifest = json.loads(manifest_path.read_text())
        assert len(manifest["experiments"]) == 2
        assert manifest["experiments"][0]["file"] == "existing.viz.bin"
        assert manifest["experiments"][1]["file"] == "workbench_def.viz.bin"

    def test_no_duplicate_entries(self, tmp_dirs, exporter):
        _, _, manifest_path = tmp_dirs

        experiments = [{"name": "exp1", "policy": "fifo", "id": "abc"}]
        paths = ["data/workbench_abc.viz.bin"]

        exporter.update_manifest(experiments, paths)
        exporter.update_manifest(experiments, paths)

        manifest = json.loads(manifest_path.read_text())
        assert len(manifest["experiments"]) == 1

    def test_handles_list_format_manifest(self, tmp_dirs, exporter):
        """Old manifest format was a bare list, not wrapped in an object."""
        _, _, manifest_path = tmp_dirs
        manifest_path.write_text(json.dumps([
            {"file": "old.viz.bin", "label": "Old"}
        ]))

        experiments = [{"name": "exp1", "policy": "fifo", "id": "abc"}]
        paths = ["data/workbench_abc.viz.bin"]
        exporter.update_manifest(experiments, paths)

        manifest = json.loads(manifest_path.read_text())
        assert "experiments" in manifest
        assert len(manifest["experiments"]) == 2


class TestMultiGpuTypeExport:
    """Test export with multiple GPU types."""

    def test_multi_type_cluster(self, tmp_dirs, exporter):
        data_dir, viz_data_dir, _ = tmp_dirs
        exp_id = "multi000-0000-0000-0000-000000000000"
        exp = {
            "id": exp_id,
            "name": "multi_type",
            "policy": "max_min_fairness_perf",
            "status": "completed",
            "config": {
                "policy": "max_min_fairness_perf",
                "cluster_spec": {"v100": 2, "p100": 2, "k80": 2},
            },
            "summary": {},
        }

        events_dir = data_dir / "events" / exp_id
        # Job 1 on v100 gpus (indices 0,1), job 2 on p100 (indices 2,3).
        events = [
            _make_round_event(
                round_num=0,
                allocations={"1": [0, 1], "2": [2, 3]},
                queue=[3],
                utilization=0.67,
                running=2,
                queued=1,
            ),
        ]
        _write_round_events(events_dir, events)
        _write_complete_event(events_dir, _make_complete_event())

        path = exporter.export_experiment(exp_id, exp)
        filename = path.replace("data/", "")
        full_path = viz_data_dir / filename

        header = read_viz_header(str(full_path))
        assert header["num_gpu_types"] == 3
        assert header["total_gpus"] == 6
        assert header["num_rounds"] == 1
