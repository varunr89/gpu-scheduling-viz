"""Export pipeline: convert workbench JSONL events to .viz.bin files.

Reads chunked JSONL round-event files written by the ExperimentRunner,
reconstructs per-GPU allocation arrays and job timelines, then writes
a binary .viz.bin file using the existing binary_format encoder.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Ensure the project root is on sys.path so tools.binary_format is importable
# from within the workbench package hierarchy.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from tools.binary_format import write_viz_file  # noqa: E402

logger = logging.getLogger(__name__)


class Exporter:
    """Converts experiment event data to .viz.bin files for the viz tool."""

    def __init__(
        self,
        data_dir: Path,
        viz_data_dir: Path,
        manifest_path: Path,
    ) -> None:
        self.data_dir = data_dir            # workbench/data
        self.viz_data_dir = viz_data_dir    # <project_root>/data
        self.manifest_path = manifest_path  # <project_root>/data/manifest.json

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def export_experiment(self, experiment_id: str, experiment: dict) -> str:
        """Export a completed experiment to .viz.bin.

        Parameters
        ----------
        experiment_id:
            Unique experiment identifier (UUID string).
        experiment:
            Experiment dict from the database, containing at least
            ``config``, ``name``, ``policy``, and optionally ``summary``.

        Returns
        -------
        str
            Path of the created .viz.bin file relative to the project root
            (e.g. ``"data/workbench_abc12345.viz.bin"``).
        """
        events_dir = self.data_dir / "events" / experiment_id

        # 1. Read all round JSONL files
        round_events = self._read_round_events(events_dir)

        # 2. Read complete.json for config/summary
        complete = self._read_complete_event(events_dir)

        # 3. Build gpu_types config for binary format
        config = self._build_viz_config(experiment, complete)
        total_gpus = sum(g["count"] for g in config["gpu_types"])

        # 4. Build rounds and queues lists
        rounds, queues = self._build_rounds_and_queues(
            round_events, config, total_gpus
        )

        # 5. Build jobs list from allocation data
        jobs = self._build_jobs(round_events, total_gpus)

        # 6. Write .viz.bin
        short_id = experiment_id[:8]
        filename = f"workbench_{short_id}.viz.bin"
        output_path = self.viz_data_dir / filename
        self.viz_data_dir.mkdir(parents=True, exist_ok=True)
        write_viz_file(str(output_path), config, jobs, rounds, queues)

        logger.info(
            "Exported experiment %s -> %s (%d rounds, %d jobs)",
            experiment_id, filename, len(rounds), len(jobs),
        )
        return f"data/{filename}"

    def update_manifest(
        self,
        experiments: List[dict],
        file_paths: List[str],
    ) -> None:
        """Add exported experiments to manifest.json.

        Existing entries with the same ``file`` path are skipped to
        avoid duplicates.
        """
        manifest = self._read_manifest()

        existing_files = {e.get("file") for e in manifest.get("experiments", [])}
        if "experiments" not in manifest:
            manifest["experiments"] = []

        for exp, path in zip(experiments, file_paths):
            # Normalize: manifest stores filenames without the "data/" prefix.
            normalized = path.replace("data/", "", 1) if path.startswith("data/") else path
            if normalized in existing_files:
                continue
            policy = exp.get("policy", exp.get("config", {}).get("policy", "unknown"))
            name = exp.get("name", exp.get("id", "unnamed"))
            manifest["experiments"].append({
                "file": normalized,
                "label": f"Workbench | {name} | {policy}",
                "filters": {
                    "source": "workbench",
                    "policy": policy,
                },
                "rounds": 0,
                "complete": True,
            })

        with open(self.manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)
            f.write("\n")

    # ------------------------------------------------------------------
    # File reading helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _read_round_events(events_dir: Path) -> List[dict]:
        """Read all round JSONL files from the events directory.

        Files are named ``rounds_XXXX.jsonl`` and sorted lexicographically
        so rounds appear in order.
        """
        round_events: List[dict] = []
        if not events_dir.exists():
            return round_events

        jsonl_files = sorted(events_dir.glob("rounds_*.jsonl"))
        for path in jsonl_files:
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if line:
                        round_events.append(json.loads(line))
        return round_events

    @staticmethod
    def _read_complete_event(events_dir: Path) -> Optional[dict]:
        """Read the complete.json terminal event if it exists."""
        complete_path = events_dir / "complete.json"
        if complete_path.exists():
            with open(complete_path) as f:
                return json.load(f)
        return None

    # ------------------------------------------------------------------
    # Conversion helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_viz_config(experiment: dict, complete: Optional[dict]) -> dict:
        """Build the config dict expected by write_viz_file.

        The config must contain at least ``gpu_types`` -- a list of
        ``{"name": str, "count": int}`` dicts.
        """
        exp_config = experiment.get("config", {})

        # Merge complete-event config if available (has post-run data).
        if complete and "config" in complete:
            merged = dict(complete["config"])
            merged.update(exp_config)
            exp_config = merged

        # Resolve gpu_types from cluster_spec, cluster_preset, or default.
        gpu_types = _resolve_gpu_types(exp_config)

        policy = experiment.get(
            "policy",
            exp_config.get("policy", "unknown"),
        )

        config: Dict[str, Any] = {
            "gpu_types": gpu_types,
            "policy": policy,
            "source": "workbench",
            "experiment_name": experiment.get("name", ""),
        }

        # Propagate optional fields if present.
        for key in (
            "seed", "lam", "num_total_jobs", "mode",
            "cluster_preset", "workload_mode",
        ):
            if key in exp_config:
                config[key] = exp_config[key]

        return config

    @staticmethod
    def _build_rounds_and_queues(
        round_events: List[dict],
        config: dict,
        total_gpus: int,
    ) -> Tuple[List[dict], List[List[int]]]:
        """Convert RoundEvent dicts to the binary-format round/queue lists.

        Each binary round dict has:
            round, sim_time, utilization, jobs_running, jobs_queued,
            jobs_completed, avg_jct, completion_rate, gpu_used, allocations

        ``allocations`` is a flat list of length ``total_gpus`` where each
        entry is the job_id occupying that GPU index, or 0 for unallocated.
        """
        num_gpu_types = len(config["gpu_types"])
        rounds: List[dict] = []
        queues: List[List[int]] = []
        cumulative_completed = 0

        for evt in round_events:
            # Build per-GPU allocation array from {job_id: [gpu_indices]}.
            allocs = [0] * total_gpus
            alloc_map = evt.get("allocations", {})
            running_count = 0
            for job_id_str, gpu_indices in alloc_map.items():
                job_id = int(job_id_str)
                running_count += 1
                for idx in gpu_indices:
                    if 0 <= idx < total_gpus:
                        allocs[idx] = job_id

            # Metrics from the event.
            metrics = evt.get("metrics", {})
            utilization = metrics.get("utilization", 0.0)
            queued_count = metrics.get("queued", 0)
            completed_count = metrics.get("completed", 0)
            cumulative_completed += completed_count

            queue_list = [int(j) for j in evt.get("queue", [])]

            # Per-GPU-type usage counts.
            gpu_used = _compute_gpu_used(allocs, config["gpu_types"])

            rounds.append({
                "round": evt.get("round_num", len(rounds)),
                "sim_time": evt.get("elapsed_time", 0.0),
                "utilization": utilization,
                "jobs_running": metrics.get("running", running_count),
                "jobs_queued": queued_count if queued_count else len(queue_list),
                "jobs_completed": cumulative_completed,
                "avg_jct": metrics.get("avg_jct", 0.0),
                "completion_rate": metrics.get("completion_rate", 0.0),
                "gpu_used": gpu_used,
                "allocations": allocs,
            })
            queues.append(queue_list)

        return rounds, queues

    @staticmethod
    def _build_jobs(
        round_events: List[dict],
        total_gpus: int,
    ) -> List[dict]:
        """Reconstruct job metadata from allocation history.

        We track the first round a job appears in allocations
        (arrival_round) and the last round (completion_round).
        """
        # job_id -> {first_seen_round, last_seen_round, num_gpus}
        job_info: Dict[int, Dict[str, Any]] = {}

        for evt in round_events:
            round_num = evt.get("round_num", 0)
            alloc_map = evt.get("allocations", {})
            for job_id_str, gpu_indices in alloc_map.items():
                job_id = int(job_id_str)
                if job_id not in job_info:
                    job_info[job_id] = {
                        "first_seen": round_num,
                        "last_seen": round_num,
                        "num_gpus": len(gpu_indices),
                    }
                else:
                    info = job_info[job_id]
                    info["last_seen"] = round_num
                    info["num_gpus"] = max(info["num_gpus"], len(gpu_indices))

            # Also track jobs that appear only in queues.
            for job_id in evt.get("queue", []):
                job_id = int(job_id)
                if job_id not in job_info:
                    job_info[job_id] = {
                        "first_seen": round_num,
                        "last_seen": 0,
                        "num_gpus": 0,
                    }

        jobs: List[dict] = []
        for job_id, info in sorted(job_info.items()):
            jobs.append({
                "job_id": job_id,
                "type_id": 0,
                "scale_factor": max(1, info["num_gpus"]),
                "arrival_round": info["first_seen"],
                "completion_round": info["last_seen"],
                "duration": 0.0,
            })
        return jobs

    # ------------------------------------------------------------------
    # Manifest reading
    # ------------------------------------------------------------------

    def _read_manifest(self) -> dict:
        """Read the existing manifest.json or return a fresh structure."""
        if self.manifest_path.exists():
            with open(self.manifest_path) as f:
                data = json.load(f)
            # Handle both list and dict formats.
            if isinstance(data, list):
                return {"experiments": data}
            return data
        return {"experiments": []}


# ======================================================================
# Module-level helpers
# ======================================================================

def _resolve_gpu_types(config: dict) -> List[Dict[str, Any]]:
    """Resolve gpu_types list from experiment config.

    Checks ``cluster_spec`` (dict of name -> count), then falls back
    to a small default cluster.
    """
    cluster_spec = config.get("cluster_spec")
    if cluster_spec and isinstance(cluster_spec, dict):
        return [
            {"name": name, "count": count}
            for name, count in cluster_spec.items()
        ]

    # Check if gpu_types is already in the right format.
    gpu_types = config.get("gpu_types")
    if gpu_types and isinstance(gpu_types, list):
        return gpu_types

    # Fall back to a default small cluster.
    return [{"name": "gpu", "count": 4}]


def _compute_gpu_used(
    allocs: List[int],
    gpu_types: List[Dict[str, Any]],
) -> List[int]:
    """Count how many GPUs of each type are in use (allocated to a job).

    GPUs are laid out contiguously by type in the allocation array:
    first ``gpu_types[0]['count']`` entries are type 0, etc.
    """
    gpu_used: List[int] = []
    offset = 0
    for gt in gpu_types:
        count = gt["count"]
        used = sum(1 for i in range(offset, offset + count) if allocs[i] != 0)
        gpu_used.append(used)
        offset += count
    return gpu_used
