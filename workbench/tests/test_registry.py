from pathlib import Path
from workbench.backend.core.registry import PluginRegistry

def _write_test_plugin(tmp_path):
    plugin_dir = tmp_path / "test_sim"
    plugin_dir.mkdir()
    (plugin_dir / "__init__.py").write_text('''
from workbench.api.simulator import Simulator
from workbench.api.types import ClusterSpec, RoundEvent, CompleteEvent

class TestSimulator(Simulator):
    name = "Test"
    description = "Test simulator"
    api_version = "1.0"
    plugin_version = "0.1"

    @staticmethod
    def config_schema():
        return {"type": "object", "properties": {"policy": {"type": "string"}}}

    @staticmethod
    def policy_specs():
        return [{"name": "fifo", "description": "FIFO", "config_schema": {}}]

    @staticmethod
    def cluster_presets():
        return {"Tiny": ClusterSpec(gpu_types={"gpu": 4})}

    def run(self, config, event_queue, cancel_event):
        event_queue.put(CompleteEvent(summary={}, config=config))
''')
    return tmp_path

def test_discover_plugins(tmp_path):
    plugin_dir = _write_test_plugin(tmp_path)
    registry = PluginRegistry(plugin_dir)
    registry.discover()
    assert "Test" in registry.simulators

def test_empty_directory(tmp_path):
    registry = PluginRegistry(tmp_path)
    registry.discover()
    assert len(registry.simulators) == 0

def test_get_simulator(tmp_path):
    plugin_dir = _write_test_plugin(tmp_path)
    registry = PluginRegistry(plugin_dir)
    registry.discover()
    sim = registry.get_simulator("Test")
    assert sim is not None
    assert sim.name == "Test"

def test_list_simulators(tmp_path):
    plugin_dir = _write_test_plugin(tmp_path)
    registry = PluginRegistry(plugin_dir)
    registry.discover()
    sims = registry.list_simulators()
    assert len(sims) == 1
    assert sims[0]["name"] == "Test"
    assert len(sims[0]["policies"]) == 1
