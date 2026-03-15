"""Gavel simulator plugin for the Experiment Workbench.

Wraps the existing Gavel scheduler (OSDI 2020) to run simulations via the
Workbench API. All Gavel-specific imports happen inside ``run()`` because
the runner spawns a separate process via ProcessPoolExecutor and the gavel
source tree must be added to sys.path in that process.
"""

from __future__ import annotations

import logging
import multiprocessing
import os
import sys
import traceback
from pathlib import Path

from workbench.api.simulator import Simulator
from workbench.api.types import (
    ClusterSpec,
    CompleteEvent,
    ErrorEvent,
    RoundEvent,
)

logger = logging.getLogger(__name__)

# Gavel repo root -- resolved relative to this file so it works regardless
# of the working directory of the worker process.
_GAVEL_ROOT = str(
    Path(__file__).resolve().parents[4] / "gavel"
)
_GAVEL_SCHEDULER_DIR = os.path.join(_GAVEL_ROOT, "src", "scheduler")

# ---------------------------------------------------------------------------
# Policy catalogue -- descriptions for the UI.
# ---------------------------------------------------------------------------

_POLICIES = [
    {
        "name": "fifo",
        "description": "First-in first-out: jobs scheduled in arrival order.",
        "config_schema": {},
    },
    {
        "name": "fifo_perf",
        "description": "FIFO with heterogeneity-aware placement (Perf).",
        "config_schema": {},
    },
    {
        "name": "max_min_fairness",
        "description": "Max-min fairness LP (type-agnostic allocation).",
        "config_schema": {},
    },
    {
        "name": "max_min_fairness_perf",
        "description": "Max-min fairness LP with heterogeneity-aware throughputs (Gavel default).",
        "config_schema": {},
    },
    {
        "name": "max_min_fairness_packed",
        "description": "Max-min fairness with job packing (slow at scale).",
        "config_schema": {},
    },
    {
        "name": "finish_time_fairness",
        "description": "Finish-time fairness LP (type-agnostic).",
        "config_schema": {},
    },
    {
        "name": "finish_time_fairness_perf",
        "description": "Finish-time fairness LP with heterogeneity-aware throughputs.",
        "config_schema": {},
    },
    {
        "name": "isolated",
        "description": "Isolated policy -- each job gets a dedicated GPU.",
        "config_schema": {},
    },
    {
        "name": "gandiva",
        "description": "Gandiva-style affinity-aware scheduling.",
        "config_schema": {},
    },
    {
        "name": "max_sum_throughput_perf",
        "description": "Maximize total throughput with heterogeneity awareness.",
        "config_schema": {},
    },
    {
        "name": "min_total_duration",
        "description": "Minimize total training duration.",
        "config_schema": {},
    },
    {
        "name": "min_total_duration_perf",
        "description": "Minimize total training duration with heterogeneity awareness.",
        "config_schema": {},
    },
]

_POLICY_NAMES = [p["name"] for p in _POLICIES]


class GavelSimulator(Simulator):
    """Simulator plugin that wraps the Gavel scheduler."""

    name = "Gavel"
    description = "Gavel GPU cluster scheduler (OSDI 2020) with optional FGD extensions."
    api_version = "1.0"
    plugin_version = "0.1.0"

    # ---------------------------------------------------------------
    # Static interface methods
    # ---------------------------------------------------------------

    @staticmethod
    def config_schema() -> dict:
        return {
            "type": "object",
            "properties": {
                "policy": {
                    "type": "string",
                    "enum": _POLICY_NAMES,
                    "description": "Scheduling policy to use.",
                },
                "cluster_spec": {
                    "type": "object",
                    "description": (
                        "Mapping of GPU type name to count. "
                        "If omitted, a cluster_preset must be specified."
                    ),
                    "additionalProperties": {"type": "integer", "minimum": 1},
                },
                "cluster_preset": {
                    "type": "string",
                    "description": "Name of a built-in cluster preset (alternative to cluster_spec).",
                },
                "mode": {
                    "type": "string",
                    "enum": ["fixed_jobs", "steady_state"],
                    "default": "fixed_jobs",
                    "description": (
                        "fixed_jobs: generate N jobs then run to completion. "
                        "steady_state: Poisson arrivals with a measurement window."
                    ),
                },
                "lam": {
                    "type": "number",
                    "minimum": 0,
                    "description": "Inter-arrival time parameter (1/rate) for Poisson arrivals.",
                },
                "num_total_jobs": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 50,
                    "description": "Number of jobs to generate in fixed_jobs mode.",
                },
                "window_start": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Start of measurement window (job index) for steady_state mode.",
                },
                "window_end": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "End of measurement window (job index) for steady_state mode.",
                },
                "seed": {
                    "type": "integer",
                    "default": 0,
                    "description": "Random seed for reproducibility.",
                },
                "time_per_iteration": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 360,
                    "description": "Scheduling round duration in simulated seconds.",
                },
                "max_simulated_time": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 7200000,
                    "description": "Maximum simulated time in seconds before timeout.",
                },
                "max_wall_time": {
                    "type": ["integer", "null"],
                    "default": None,
                    "description": "Wall-clock timeout in seconds (null = no limit).",
                },
                "generate_multi_gpu_jobs": {
                    "type": "boolean",
                    "default": False,
                    "description": "Generate jobs with scale_factor > 1.",
                },
                "gpus_per_node": {
                    "type": ["integer", "object", "null"],
                    "default": None,
                    "description": "GPUs per server node. Int = uniform size. Dict = per-type mixed sizes (e.g. {\"generic\": {\"8\": 462, \"4\": 310}}). Null = flat.",
                },
                "enable_fgd": {
                    "type": "boolean",
                    "default": False,
                    "description": "Enable FGD fragmentation-aware placement.",
                },
                "fgd_placement_mode": {
                    "type": "string",
                    "enum": ["fgd", "bestfit", "firstfit"],
                    "default": "fgd",
                    "description": "FGD placement algorithm variant.",
                },
                "workload_mode": {
                    "type": "string",
                    "enum": ["philly", "alibaba"],
                    "default": "philly",
                    "description": "Workload model (affects throughput file and job generation).",
                },
                "enable_migration_penalty": {
                    "type": "boolean",
                    "default": False,
                    "description": "Penalize GPU migrations in the LP objective.",
                },
                "enable_gpu_sharing": {
                    "type": "boolean",
                    "default": False,
                    "description": "Allow multiple jobs to share a single GPU.",
                },
                "solver": {
                    "type": "string",
                    "default": "ECOS",
                    "description": "LP solver backend (ECOS, SCS, etc.).",
                },
                "completion_rate_threshold": {
                    "type": "number",
                    "default": 0.1,
                    "description": "Early-exit threshold for steady-state saturation detection.",
                },
                "log_level": {
                    "type": "string",
                    "enum": ["DEBUG", "INFO", "WARNING", "ERROR"],
                    "default": "WARNING",
                    "description": "Gavel scheduler log verbosity.",
                },
                "throughputs_file": {
                    "type": "string",
                    "enum": [
                        "simulation_throughputs.json",
                        "simulation_throughputs_alibaba.json",
                        "simulation_throughputs_cluster_h.json",
                    ],
                    "description": (
                        "Throughputs JSON file. Must match the GPU types in "
                        "cluster_spec. Philly uses simulation_throughputs.json, "
                        "Alibaba uses simulation_throughputs_alibaba.json, "
                        "generic/Cluster H uses simulation_throughputs_cluster_h.json."
                    ),
                },
                "reference_worker_type": {
                    "type": "string",
                    "description": (
                        "GPU type used as the reference for job generation. "
                        "Must be a key in the throughputs file. "
                        "E.g. 'v100' for Philly, 'V100M32' for Alibaba, "
                        "'generic' for Cluster H."
                    ),
                },
            },
            "required": ["policy"],
            "additionalProperties": False,
        }

    @staticmethod
    def policy_specs() -> list[dict]:
        return list(_POLICIES)

    @staticmethod
    def cluster_presets() -> dict[str, ClusterSpec]:
        return {
            "Philly 108": ClusterSpec(
                gpu_types={"v100": 36, "p100": 36, "k80": 36},
            ),
            "Alibaba 6200": ClusterSpec(
                gpu_types={
                    "G2": 4392,
                    "T4": 840,
                    "G3": 312,
                    "P100": 264,
                    "V100M32": 200,
                    "V100M16": 192,
                },
                gpus_per_node=8,
            ),
            "Cluster H 5592": ClusterSpec(
                gpu_types={"generic": 5592},
                gpus_per_node={"generic": {"8": 462, "4": 310, "2": 228, "1": 200}},
            ),
            "Cluster H 560": ClusterSpec(
                gpu_types={"generic": 560},
                gpus_per_node={"generic": {"8": 46, "4": 31, "2": 23, "1": 20}},
            ),
            "Philly 108 Mixed Nodes": ClusterSpec(
                gpu_types={"v100": 36, "p100": 36, "k80": 36},
                gpus_per_node={
                    "v100": {"8": 3, "4": 3},
                    "p100": {"4": 5, "2": 8},
                    "k80": {"2": 8, "1": 20},
                },
            ),
            "Demo 504": ClusterSpec(
                gpu_types={"v100": 200, "p100": 180, "k80": 124},
                gpus_per_node={
                    "v100": {"8": 15, "4": 10},
                    "p100": {"8": 10, "4": 15, "2": 10},
                    "k80": {"4": 10, "2": 16, "1": 20},
                },
            ),
        }

    # ---------------------------------------------------------------
    # run() -- main simulation adapter
    # ---------------------------------------------------------------

    def run(
        self,
        config: dict,
        event_queue: multiprocessing.Queue,
        cancel_event: multiprocessing.Event,
    ) -> None:
        """Run a Gavel simulation, emitting events into *event_queue*.

        This method executes inside a worker process. All gavel imports
        happen here so that sys.path manipulation is process-local.
        """
        try:
            self._run_impl(config, event_queue, cancel_event)
        except Exception as exc:
            tb = traceback.format_exc()
            event_queue.put(ErrorEvent(
                message=str(exc) or "Gavel simulation failed",
                traceback=tb,
            ))

    # ---------------------------------------------------------------
    # Internal implementation
    # ---------------------------------------------------------------

    def _run_impl(
        self,
        config: dict,
        event_queue: multiprocessing.Queue,
        cancel_event: multiprocessing.Event,
    ) -> None:
        # ----------------------------------------------------------
        # 1. Set up sys.path and import Gavel modules
        # ----------------------------------------------------------
        if _GAVEL_SCHEDULER_DIR not in sys.path:
            sys.path.insert(0, _GAVEL_SCHEDULER_DIR)
        if _GAVEL_ROOT not in sys.path:
            sys.path.insert(0, _GAVEL_ROOT)

        import scheduler as scheduler_module
        import utils as gavel_utils

        # ----------------------------------------------------------
        # 2. Resolve cluster spec
        # ----------------------------------------------------------
        cluster_spec = self._resolve_cluster_spec(config)

        # ----------------------------------------------------------
        # 3. Resolve configuration parameters
        # ----------------------------------------------------------
        policy_name = config["policy"]
        seed = config.get("seed", 0)
        mode = config.get("mode", "fixed_jobs")
        lam = config.get("lam", 0.0)
        num_total_jobs = config.get("num_total_jobs", 50)
        time_per_iteration = config.get("time_per_iteration", 360)
        max_simulated_time = config.get("max_simulated_time", 7200000)
        max_wall_time = config.get("max_wall_time", None)
        generate_multi_gpu_jobs = config.get("generate_multi_gpu_jobs", False)
        gpus_per_node = config.get("gpus_per_node", None)
        enable_fgd = config.get("enable_fgd", False)
        fgd_placement_mode = config.get("fgd_placement_mode", "fgd")
        workload_mode = config.get("workload_mode", "philly")
        enable_migration_penalty = config.get("enable_migration_penalty", False)
        enable_gpu_sharing = config.get("enable_gpu_sharing", False)
        solver = config.get("solver", "ECOS")
        completion_rate_threshold = config.get("completion_rate_threshold", 0.1)

        # Map string log level to logging constant.
        log_level_str = config.get("log_level", "WARNING")
        log_level = getattr(logging, log_level_str, logging.WARNING)

        # num_gpus_per_server: convert to Gavel convention.
        # - int: uniform node size -> {"type": int} for each type
        # - dict: nested per-type node size distributions (Cluster H style)
        #   e.g. {"generic": {"8": 462, "4": 310, "2": 228, "1": 200}}
        num_gpus_per_server = None
        if gpus_per_node is not None:
            if isinstance(gpus_per_node, dict):
                # Nested dict: per-type node size distributions
                num_gpus_per_server = gpus_per_node
            else:
                # Single int: uniform node size across all types
                num_gpus_per_server = {
                    wt: gpus_per_node for wt in cluster_spec
                }

        # ----------------------------------------------------------
        # 4. Select throughputs file
        # ----------------------------------------------------------
        throughputs_override = config.get("throughputs_file")
        if throughputs_override:
            throughputs_file = os.path.join(
                _GAVEL_SCHEDULER_DIR, throughputs_override
            )
        elif workload_mode == "alibaba":
            throughputs_file = os.path.join(
                _GAVEL_SCHEDULER_DIR, "simulation_throughputs_alibaba.json"
            )
        else:
            throughputs_file = os.path.join(
                _GAVEL_SCHEDULER_DIR, "simulation_throughputs.json"
            )

        # Validate: GPU types in cluster_spec must exist in the
        # throughputs file.  Fail fast with a clear message.
        import json as _json
        with open(throughputs_file) as _f:
            _tp_keys = set(_json.load(_f).keys())
        # Strip "_unconsolidated" suffixes for the comparison.
        tp_gpu_types = {k for k in _tp_keys if not k.endswith("_unconsolidated")}
        missing = set(cluster_spec.keys()) - tp_gpu_types
        if missing:
            tp_basename = os.path.basename(throughputs_file)
            raise ValueError(
                f"GPU type(s) {missing} from cluster_spec not found in "
                f"throughputs file '{tp_basename}'. "
                f"Available GPU types: {sorted(tp_gpu_types)}. "
                f"Set 'throughputs_file' to the correct file (e.g. "
                f"'simulation_throughputs_cluster_h.json' for generic clusters)."
            )

        # ----------------------------------------------------------
        # 5. Instantiate policy and scheduler
        # ----------------------------------------------------------
        policy = gavel_utils.get_policy(policy_name, solver=solver, seed=seed)

        sched = scheduler_module.Scheduler(
            policy,
            throughputs_file=throughputs_file,
            seed=seed,
            time_per_iteration=time_per_iteration,
            simulate=True,
            profiling_percentage=1.0,
            num_reference_models=26,
            enable_fgd=enable_fgd,
            fgd_placement_mode=fgd_placement_mode,
            fgd_workload_mode=workload_mode,
            enable_migration_penalty=enable_migration_penalty,
            enable_gpu_sharing=enable_gpu_sharing,
            log_level=log_level,
        )

        # ----------------------------------------------------------
        # 6. Run simulation
        # ----------------------------------------------------------
        # Build a per-round callback that emits RoundEvents live.
        _round_counter = [0]  # mutable counter for closure

        def round_cb(metrics_dict):
            """Called by Scheduler.simulate() after each round."""
            if cancel_event.is_set():
                return
            i = _round_counter[0]
            _round_counter[0] += 1
            # Build allocations dict: {job_id: [gpu_indices]} from flat array.
            gpu_allocs = metrics_dict.get("gpu_allocations", [])
            alloc_map = {}
            for gpu_idx, job_id in enumerate(gpu_allocs):
                if job_id != 0:
                    alloc_map.setdefault(str(job_id), []).append(gpu_idx)

            # Pre-aggregate pending demand by scale factor.
            pending_demand = {}
            for entry in metrics_dict.get("queued_with_sf", []):
                sf = entry["sf"]
                pending_demand[sf] = pending_demand.get(sf, 0) + 1

            event_queue.put(RoundEvent(
                round_num=i,
                elapsed_time=metrics_dict.get("simulated_time", 0.0),
                allocations=alloc_map,
                queue=metrics_dict.get("queue_job_ids", []),
                metrics={
                    "utilization": metrics_dict.get("utilization", 0.0),
                    "utilization_pct": True,  # Gavel reports 0-100
                    "frag_value": metrics_dict.get("frag_value", 0.0),
                    "frag_rate": metrics_dict.get("frag_rate", 0.0),
                    "frag_total": metrics_dict.get("frag_total", 0.0),
                    "unalloc_pct": metrics_dict.get("unalloc_pct", 0.0),
                    "occupied_nodes": metrics_dict.get("occupied_nodes", 0),
                    "allocated_gpus": metrics_dict.get("allocated_gpus", 0),
                    "total_gpus": metrics_dict.get("total_gpus", 0),
                    "num_queued": metrics_dict.get("num_queued", 0),
                    "num_completed": metrics_dict.get("num_completed", 0),
                    "completions": metrics_dict.get("completions_this_round", []),
                    "arrivals_count": metrics_dict.get("arrivals_this_round", 0),
                    "pending_demand": pending_demand,
                },
            ))

        # Redirect stdout to suppress Gavel's verbose prints.
        devnull = open(os.devnull, "w")
        old_stdout = sys.stdout
        try:
            sys.stdout = devnull

            if mode == "steady_state":
                from job_id_pair import JobIdPair

                window_start = config["window_start"]
                window_end = config["window_end"]
                jobs_to_complete = set(
                    JobIdPair(i, None) for i in range(window_start, window_end)
                )

                # Compute reasonable max_simulated_time if not explicit.
                if "max_simulated_time" not in config and lam > 0:
                    max_simulated_time = int(window_end * lam * 1.5)

                # Scale factor generator and reference worker type.
                scale_factor_generator_func = None
                reference_worker_type = config.get("reference_worker_type", "v100")
                if workload_mode == "alibaba":
                    scale_factor_generator_func = gavel_utils._generate_scale_factor_alibaba
                    if reference_worker_type == "v100":
                        reference_worker_type = "V100M32"

                # Validate reference_worker_type exists in the throughputs.
                if reference_worker_type not in tp_gpu_types:
                    raise ValueError(
                        f"reference_worker_type '{reference_worker_type}' not found "
                        f"in throughputs file '{os.path.basename(throughputs_file)}'. "
                        f"Available types: {sorted(tp_gpu_types)}. "
                        f"Set 'reference_worker_type' to a valid GPU type."
                    )

                sched.simulate(
                    cluster_spec=cluster_spec,
                    lam=lam,
                    jobs_to_complete=jobs_to_complete,
                    generate_multi_gpu_jobs=generate_multi_gpu_jobs,
                    simulate_steady_state=True,
                    num_gpus_per_server=num_gpus_per_server,
                    max_wall_time=max_wall_time,
                    max_simulated_time=max_simulated_time,
                    completion_rate_threshold=completion_rate_threshold,
                    scale_factor_generator_func=scale_factor_generator_func,
                    reference_worker_type=reference_worker_type,
                    round_callback=round_cb,
                )
            else:
                # fixed_jobs mode
                scale_factor_generator_func = None
                reference_worker_type = config.get("reference_worker_type", "v100")
                if workload_mode == "alibaba":
                    scale_factor_generator_func = gavel_utils._generate_scale_factor_alibaba
                    if reference_worker_type == "v100":
                        reference_worker_type = "V100M32"

                if reference_worker_type not in tp_gpu_types:
                    raise ValueError(
                        f"reference_worker_type '{reference_worker_type}' not found "
                        f"in throughputs file '{os.path.basename(throughputs_file)}'. "
                        f"Available types: {sorted(tp_gpu_types)}. "
                        f"Set 'reference_worker_type' to a valid GPU type."
                    )

                sched.simulate(
                    cluster_spec=cluster_spec,
                    lam=lam,
                    num_total_jobs=num_total_jobs,
                    generate_multi_gpu_jobs=generate_multi_gpu_jobs,
                    num_gpus_per_server=num_gpus_per_server,
                    max_wall_time=max_wall_time,
                    max_simulated_time=max_simulated_time,
                    scale_factor_generator_func=scale_factor_generator_func,
                    reference_worker_type=reference_worker_type,
                    round_callback=round_cb,
                )
        finally:
            sys.stdout = old_stdout
            devnull.close()

        # Round events were already emitted live via round_callback.

        # ----------------------------------------------------------
        # 7. Compute summary and emit CompleteEvent
        # ----------------------------------------------------------
        is_saturated = getattr(sched, "saturated", False)

        # Compute average JCT.
        avg_jct = None
        try:
            # Redirect stdout again since get_average_jct prints.
            devnull = open(os.devnull, "w")
            sys.stdout = devnull
            try:
                if mode == "steady_state":
                    if sched.is_done(jobs_to_complete):
                        avg_jct = sched.get_average_jct(jobs_to_complete)
                    elif is_saturated:
                        avg_jct = getattr(sched, "partial_jct", None) or float("inf")
                    else:
                        avg_jct = sched.get_average_jct(jobs_to_complete)
                else:
                    avg_jct = sched.get_average_jct(verbose=False)
            finally:
                sys.stdout = old_stdout
                devnull.close()
        except Exception:
            avg_jct = None

        # Count completed/failed jobs.
        completion_times = getattr(sched, "_job_completion_times", {})
        completed = sum(1 for t in completion_times.values() if t is not None)
        failed = sum(1 for t in completion_times.values() if t is None)

        summary = {
            "avg_jct": avg_jct,
            "saturated": is_saturated,
            "num_completed_jobs": completed,
            "num_failed_jobs": failed,
            "num_rounds": _round_counter[0],
        }

        event_queue.put(CompleteEvent(summary=summary, config=config))

    # ---------------------------------------------------------------
    # Helpers
    # ---------------------------------------------------------------

    def _resolve_cluster_spec(self, config: dict) -> dict:
        """Return a Gavel-format cluster spec dict from config.

        The config can specify either ``cluster_spec`` directly (a dict of
        gpu_type -> count) or ``cluster_preset`` (a named preset).
        When a preset is used, its ``gpus_per_node`` is injected into config
        if not already set.
        """
        if "cluster_spec" in config:
            return config["cluster_spec"]

        preset_name = config.get("cluster_preset")
        if preset_name:
            presets = self.cluster_presets()
            preset = presets.get(preset_name)
            if preset is None:
                raise ValueError(
                    f"Unknown cluster preset '{preset_name}'. "
                    f"Available: {list(presets.keys())}"
                )
            # Inject preset's gpus_per_node if config doesn't override it.
            if "gpus_per_node" not in config and preset.gpus_per_node is not None:
                config["gpus_per_node"] = preset.gpus_per_node
            return preset.gpu_types

        # Default to Philly 108.
        return {"v100": 36, "p100": 36, "k80": 36}
