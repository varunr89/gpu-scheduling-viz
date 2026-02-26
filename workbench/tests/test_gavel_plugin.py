"""Tests for the Gavel simulator plugin.

Tests 1-4 verify the plugin interface (config schema, policies, presets)
without importing Gavel. Test 5 runs an actual simulation and requires
the Gavel codebase + dependencies (cvxpy, numpy, etc.) to be importable.
"""

from __future__ import annotations

import multiprocessing
import os
import sys

import pytest

# Ensure the project root is on sys.path so workbench is importable.
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from workbench.api.simulator import Simulator
from workbench.api.types import ClusterSpec, CompleteEvent, ErrorEvent, RoundEvent
from workbench.plugins.gavel import GavelSimulator


# -----------------------------------------------------------------------
# 1. Interface compliance
# -----------------------------------------------------------------------

class TestGavelInterface:
    """Verify GavelSimulator satisfies the Simulator ABC."""

    def test_is_subclass_of_simulator(self):
        assert issubclass(GavelSimulator, Simulator)

    def test_can_instantiate(self):
        sim = GavelSimulator()
        assert sim.name == "Gavel"
        assert sim.api_version == "1.0"
        assert sim.plugin_version == "0.1.0"
        assert isinstance(sim.description, str)
        assert len(sim.description) > 0

    def test_has_required_class_attrs(self):
        for attr in ("name", "description", "api_version", "plugin_version"):
            assert hasattr(GavelSimulator, attr), f"Missing class attribute: {attr}"

    def test_run_is_not_static(self):
        """run() should be an instance method, not static."""
        sim = GavelSimulator()
        assert callable(getattr(sim, "run"))


# -----------------------------------------------------------------------
# 2. config_schema()
# -----------------------------------------------------------------------

class TestConfigSchema:
    """Verify config_schema() returns valid JSON Schema."""

    def test_returns_dict(self):
        schema = GavelSimulator.config_schema()
        assert isinstance(schema, dict)

    def test_has_type_object(self):
        schema = GavelSimulator.config_schema()
        assert schema.get("type") == "object"

    def test_has_properties(self):
        schema = GavelSimulator.config_schema()
        props = schema.get("properties", {})
        assert isinstance(props, dict)
        assert len(props) > 0

    def test_policy_is_required(self):
        schema = GavelSimulator.config_schema()
        required = schema.get("required", [])
        assert "policy" in required

    def test_policy_has_enum(self):
        schema = GavelSimulator.config_schema()
        policy_prop = schema["properties"]["policy"]
        assert "enum" in policy_prop
        assert isinstance(policy_prop["enum"], list)
        assert len(policy_prop["enum"]) > 0

    def test_required_fields_present(self):
        """Key config fields should appear in properties."""
        schema = GavelSimulator.config_schema()
        props = schema["properties"]
        expected_keys = [
            "policy",
            "cluster_spec",
            "cluster_preset",
            "mode",
            "lam",
            "num_total_jobs",
            "window_start",
            "window_end",
            "seed",
            "time_per_iteration",
            "max_simulated_time",
            "generate_multi_gpu_jobs",
            "gpus_per_node",
            "enable_fgd",
            "fgd_placement_mode",
            "workload_mode",
            "enable_migration_penalty",
            "log_level",
        ]
        for key in expected_keys:
            assert key in props, f"Missing config property: {key}"


# -----------------------------------------------------------------------
# 3. policy_specs()
# -----------------------------------------------------------------------

class TestPolicySpecs:
    """Verify policy_specs() returns expected policies."""

    def test_returns_list(self):
        specs = GavelSimulator.policy_specs()
        assert isinstance(specs, list)
        assert len(specs) > 0

    def test_each_spec_has_required_keys(self):
        for spec in GavelSimulator.policy_specs():
            assert "name" in spec
            assert "description" in spec
            assert "config_schema" in spec

    def test_contains_fifo(self):
        names = [s["name"] for s in GavelSimulator.policy_specs()]
        assert "fifo" in names

    def test_contains_max_min_fairness_perf(self):
        names = [s["name"] for s in GavelSimulator.policy_specs()]
        assert "max_min_fairness_perf" in names

    def test_contains_finish_time_fairness_perf(self):
        names = [s["name"] for s in GavelSimulator.policy_specs()]
        assert "finish_time_fairness_perf" in names

    def test_contains_isolated(self):
        names = [s["name"] for s in GavelSimulator.policy_specs()]
        assert "isolated" in names

    def test_at_least_six_policies(self):
        specs = GavelSimulator.policy_specs()
        assert len(specs) >= 6

    def test_descriptions_are_nonempty(self):
        for spec in GavelSimulator.policy_specs():
            assert len(spec["description"]) > 0, (
                f"Policy '{spec['name']}' has empty description"
            )


# -----------------------------------------------------------------------
# 4. cluster_presets()
# -----------------------------------------------------------------------

class TestClusterPresets:
    """Verify cluster_presets() returns expected presets."""

    def test_returns_dict(self):
        presets = GavelSimulator.cluster_presets()
        assert isinstance(presets, dict)

    def test_has_philly(self):
        presets = GavelSimulator.cluster_presets()
        assert "Philly 108" in presets

    def test_has_alibaba(self):
        presets = GavelSimulator.cluster_presets()
        assert "Alibaba 6200" in presets

    def test_philly_spec(self):
        preset = GavelSimulator.cluster_presets()["Philly 108"]
        assert isinstance(preset, ClusterSpec)
        assert preset.gpu_types == {"v100": 36, "p100": 36, "k80": 36}
        assert preset.total_gpus == 108
        assert preset.gpus_per_node is None  # Flat allocation

    def test_alibaba_spec(self):
        preset = GavelSimulator.cluster_presets()["Alibaba 6200"]
        assert isinstance(preset, ClusterSpec)
        assert preset.total_gpus == 6200
        assert preset.gpus_per_node == 8
        assert "G2" in preset.gpu_types
        assert preset.gpu_types["G2"] == 4392

    def test_all_presets_are_cluster_spec(self):
        for name, preset in GavelSimulator.cluster_presets().items():
            assert isinstance(preset, ClusterSpec), (
                f"Preset '{name}' is not a ClusterSpec"
            )


# -----------------------------------------------------------------------
# 5. run() -- actual simulation (requires Gavel + dependencies)
# -----------------------------------------------------------------------

_GAVEL_PATH = "/Users/varunr/projects/courses/stanford/cs244c/gavel"
_GAVEL_SCHED_PATH = os.path.join(_GAVEL_PATH, "src", "scheduler")

def _gavel_importable() -> bool:
    """Check whether the gavel scheduler can be imported."""
    if not os.path.isdir(_GAVEL_SCHED_PATH):
        return False
    saved_path = sys.path[:]
    try:
        if _GAVEL_SCHED_PATH not in sys.path:
            sys.path.insert(0, _GAVEL_SCHED_PATH)
        if _GAVEL_PATH not in sys.path:
            sys.path.insert(0, _GAVEL_PATH)
        import scheduler  # noqa: F401
        import utils  # noqa: F401
        return True
    except ImportError:
        return False
    finally:
        sys.path[:] = saved_path


@pytest.mark.skipif(
    not _gavel_importable(),
    reason="Gavel scheduler not importable (missing code or dependencies)",
)
class TestGavelRun:
    """Integration test: run a tiny simulation through the plugin."""

    def test_fixed_jobs_fifo(self):
        """FIFO policy, Philly 108, 5 fixed jobs -- should complete quickly."""
        sim = GavelSimulator()
        queue = multiprocessing.Queue()
        cancel = multiprocessing.Event()

        config = {
            "policy": "fifo",
            "cluster_preset": "Philly 108",
            "mode": "fixed_jobs",
            "num_total_jobs": 5,
            "lam": 0.0,
            "seed": 42,
            "time_per_iteration": 360,
            "log_level": "WARNING",
        }

        sim.run(config, queue, cancel)

        # Drain the queue.
        events = []
        while not queue.empty():
            events.append(queue.get_nowait())

        # Must have at least one event (CompleteEvent).
        assert len(events) >= 1, "Expected at least a CompleteEvent"

        # The last event should be CompleteEvent.
        last = events[-1]
        assert isinstance(last, CompleteEvent), (
            f"Expected CompleteEvent, got {type(last).__name__}"
        )

        # Check the summary.
        summary = last.summary
        assert "avg_jct" in summary
        assert "num_completed_jobs" in summary
        assert summary["num_completed_jobs"] > 0
        assert summary.get("saturated") is False

    def test_cancel_before_emit(self):
        """Setting cancel_event before run should produce at most a CompleteEvent."""
        sim = GavelSimulator()
        queue = multiprocessing.Queue()
        cancel = multiprocessing.Event()

        # The simulation will run to completion (simulate is synchronous),
        # but the round emission loop should be interrupted.
        cancel.set()

        config = {
            "policy": "fifo",
            "cluster_preset": "Philly 108",
            "mode": "fixed_jobs",
            "num_total_jobs": 5,
            "lam": 0.0,
            "seed": 0,
            "log_level": "WARNING",
        }

        sim.run(config, queue, cancel)

        events = []
        while not queue.empty():
            events.append(queue.get_nowait())

        # No RoundEvents should be emitted since cancel was set.
        round_events = [e for e in events if isinstance(e, RoundEvent)]
        assert len(round_events) == 0, (
            f"Expected 0 RoundEvents with cancel set, got {len(round_events)}"
        )

    def test_invalid_policy_emits_error(self):
        """An invalid policy name should result in an ErrorEvent."""
        sim = GavelSimulator()
        queue = multiprocessing.Queue()
        cancel = multiprocessing.Event()

        config = {
            "policy": "nonexistent_policy_xyz",
            "cluster_preset": "Philly 108",
            "mode": "fixed_jobs",
            "num_total_jobs": 5,
            "lam": 0.0,
            "log_level": "WARNING",
        }

        sim.run(config, queue, cancel)

        events = []
        while not queue.empty():
            events.append(queue.get_nowait())

        # Should get an ErrorEvent.
        assert len(events) >= 1
        error_events = [e for e in events if isinstance(e, ErrorEvent)]
        assert len(error_events) == 1, (
            f"Expected exactly 1 ErrorEvent, got {len(error_events)}"
        )
        assert "nonexistent_policy_xyz" in error_events[0].traceback or \
               "Unknown policy" in error_events[0].traceback

    def test_invalid_preset_emits_error(self):
        """An invalid cluster preset should result in an ErrorEvent."""
        sim = GavelSimulator()
        queue = multiprocessing.Queue()
        cancel = multiprocessing.Event()

        config = {
            "policy": "fifo",
            "cluster_preset": "NonexistentCluster",
            "mode": "fixed_jobs",
            "num_total_jobs": 5,
            "lam": 0.0,
            "log_level": "WARNING",
        }

        sim.run(config, queue, cancel)

        events = []
        while not queue.empty():
            events.append(queue.get_nowait())

        assert len(events) >= 1
        error_events = [e for e in events if isinstance(e, ErrorEvent)]
        assert len(error_events) == 1
        assert "NonexistentCluster" in error_events[0].traceback
