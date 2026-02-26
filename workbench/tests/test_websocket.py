"""Tests for the WebSocket event streaming endpoint."""

from __future__ import annotations

import asyncio
import multiprocessing
import time
from typing import Optional

import pytest
from starlette.testclient import TestClient

from workbench.api.simulator import Simulator
from workbench.api.types import ClusterSpec, CompleteEvent, ErrorEvent, RoundEvent
from workbench.app import create_app


# ---------------------------------------------------------------------------
# Fake simulators for tests
# ---------------------------------------------------------------------------


class FakeSimulator(Simulator):
    """Emits a configurable number of rounds then completes."""

    name = "fake_ws_sim"
    description = "Fake simulator for WebSocket tests"
    api_version = "1.0"
    plugin_version = "0.1"

    @staticmethod
    def config_schema():
        return {
            "type": "object",
            "properties": {"num_rounds": {"type": "integer"}},
        }

    @staticmethod
    def policy_specs():
        return [{"name": "fifo", "description": "FIFO", "config_schema": {}}]

    @staticmethod
    def cluster_presets():
        return {"Tiny": ClusterSpec(gpu_types={"gpu": 4})}

    def run(self, config, event_queue, cancel_event):
        for i in range(config.get("num_rounds", 3)):
            if cancel_event.is_set():
                return
            event_queue.put(
                RoundEvent(
                    round_num=i,
                    elapsed_time=float(i),
                    allocations={},
                    queue=[],
                    metrics={"utilization": 0.5},
                )
            )
            time.sleep(0.01)
        event_queue.put(
            CompleteEvent(summary={"avg_jct": 42.0}, config=config)
        )


class ErrorSimulator(Simulator):
    """Always raises an exception."""

    name = "error_ws_sim"
    description = "Simulator that always errors"
    api_version = "1.0"
    plugin_version = "0.1"

    @staticmethod
    def config_schema():
        return {"type": "object"}

    @staticmethod
    def policy_specs():
        return [{"name": "fifo", "description": "FIFO", "config_schema": {}}]

    @staticmethod
    def cluster_presets():
        return {"Tiny": ClusterSpec(gpu_types={"gpu": 4})}

    def run(self, config, event_queue, cancel_event):
        raise RuntimeError("Intentional test error")


class SlowSimulator(Simulator):
    """Emits rounds slowly to allow cancellation testing."""

    name = "slow_ws_sim"
    description = "Slow simulator for cancel tests"
    api_version = "1.0"
    plugin_version = "0.1"

    @staticmethod
    def config_schema():
        return {"type": "object"}

    @staticmethod
    def policy_specs():
        return [{"name": "fifo", "description": "FIFO", "config_schema": {}}]

    @staticmethod
    def cluster_presets():
        return {"Tiny": ClusterSpec(gpu_types={"gpu": 4})}

    def run(self, config, event_queue, cancel_event):
        for i in range(1000):
            if cancel_event.is_set():
                return
            event_queue.put(
                RoundEvent(
                    round_num=i,
                    elapsed_time=float(i),
                    allocations={},
                    queue=[],
                    metrics={},
                )
            )
            time.sleep(0.05)
        event_queue.put(CompleteEvent(summary={}, config=config))


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def app_with_sim(tmp_path):
    """Create a test app and register FakeSimulator."""
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    application = create_app(
        data_dir=str(data_dir),
        plugins_dir=str(plugins_dir),
        db_path=str(tmp_path / "test.db"),
    )

    loop = asyncio.new_event_loop()
    ctx = application.router.lifespan_context(application)
    loop.run_until_complete(ctx.__aenter__())

    # Manually register our test simulators.
    application.state.registry.simulators["fake_ws_sim"] = FakeSimulator
    application.state.registry.simulators["error_ws_sim"] = ErrorSimulator
    application.state.registry.simulators["slow_ws_sim"] = SlowSimulator

    yield application

    loop.run_until_complete(ctx.__aexit__(None, None, None))
    loop.close()


def _create_group(client: TestClient, simulator: str, num_experiments: int = 1, num_rounds: int = 3) -> str:
    """Helper to create a group with pending experiments and return the group_id."""
    experiments = [
        {
            "name": f"exp_{i}",
            "policy": "fifo",
            "config": {"num_rounds": num_rounds},
        }
        for i in range(num_experiments)
    ]
    resp = client.post(
        "/api/experiments",
        json={"name": "WS test group", "simulator": simulator, "experiments": experiments},
    )
    assert resp.status_code == 201
    return resp.json()["id"]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_ws_nonexistent_group(app_with_sim):
    """WebSocket to non-existent group should close with code 4004."""
    client = TestClient(app_with_sim)
    with pytest.raises(Exception):
        # Starlette TestClient raises on close with non-1000 code.
        with client.websocket_connect("/api/experiments/nonexistent-id/stream") as ws:
            ws.receive_json()


def test_ws_no_pending_experiments(app_with_sim):
    """WebSocket to group with no pending experiments sends group_complete."""
    client = TestClient(app_with_sim)
    # Create group, then manually mark experiments as completed.
    group_id = _create_group(client, "fake_ws_sim", num_experiments=1)

    # Mark the experiment as completed so there are no pending ones.
    loop = asyncio.new_event_loop()
    db = app_with_sim.state.db
    exps = loop.run_until_complete(db.list_experiments(group_id))
    for exp in exps:
        loop.run_until_complete(db.update_experiment(exp["id"], status="completed"))
    loop.close()

    with client.websocket_connect(f"/api/experiments/{group_id}/stream") as ws:
        data = ws.receive_json()
        assert data["type"] == "group_complete"
        assert "No pending experiments" in data.get("message", "")


def test_ws_streams_events(app_with_sim):
    """WebSocket streams round and complete events for pending experiments."""
    client = TestClient(app_with_sim)
    group_id = _create_group(client, "fake_ws_sim", num_experiments=1, num_rounds=20)

    events = []
    with client.websocket_connect(f"/api/experiments/{group_id}/stream") as ws:
        while True:
            data = ws.receive_json()
            events.append(data)
            if data["type"] in ("group_complete",):
                break

    # Should have some round events (sampled), a complete, and group_complete.
    types = [e["type"] for e in events]
    assert "complete" in types
    assert "group_complete" in types
    # All round events should have experiment_idx and experiment_id.
    for ev in events:
        if ev["type"] == "round":
            assert "experiment_idx" in ev
            assert "experiment_id" in ev
            assert "data" in ev


def test_ws_multiple_experiments(app_with_sim):
    """WebSocket streams events for multiple experiments sequentially."""
    client = TestClient(app_with_sim)
    group_id = _create_group(client, "fake_ws_sim", num_experiments=3, num_rounds=20)

    events = []
    with client.websocket_connect(f"/api/experiments/{group_id}/stream") as ws:
        while True:
            data = ws.receive_json()
            events.append(data)
            if data["type"] == "group_complete":
                break

    complete_events = [e for e in events if e["type"] == "complete"]
    assert len(complete_events) == 3
    # Each complete event should have a distinct experiment_idx.
    idxs = {e["experiment_idx"] for e in complete_events}
    assert idxs == {0, 1, 2}


def test_ws_error_experiment(app_with_sim):
    """WebSocket streams error event when experiment fails."""
    client = TestClient(app_with_sim)
    group_id = _create_group(client, "error_ws_sim", num_experiments=1)

    events = []
    with client.websocket_connect(f"/api/experiments/{group_id}/stream") as ws:
        while True:
            data = ws.receive_json()
            events.append(data)
            if data["type"] == "group_complete":
                break

    types = [e["type"] for e in events]
    assert "error" in types
    assert "group_complete" in types


def test_ws_updates_db_on_completion(app_with_sim):
    """Completed experiments are marked as 'completed' in the database."""
    client = TestClient(app_with_sim)
    group_id = _create_group(client, "fake_ws_sim", num_experiments=1, num_rounds=20)

    with client.websocket_connect(f"/api/experiments/{group_id}/stream") as ws:
        while True:
            data = ws.receive_json()
            if data["type"] == "group_complete":
                break

    # Check DB status.
    loop = asyncio.new_event_loop()
    db = app_with_sim.state.db
    exps = loop.run_until_complete(db.list_experiments(group_id))
    loop.close()
    assert len(exps) == 1
    assert exps[0]["status"] == "completed"


def test_ws_updates_db_on_error(app_with_sim):
    """Failed experiments are marked as 'failed' in the database."""
    client = TestClient(app_with_sim)
    group_id = _create_group(client, "error_ws_sim", num_experiments=1)

    with client.websocket_connect(f"/api/experiments/{group_id}/stream") as ws:
        while True:
            data = ws.receive_json()
            if data["type"] == "group_complete":
                break

    loop = asyncio.new_event_loop()
    db = app_with_sim.state.db
    exps = loop.run_until_complete(db.list_experiments(group_id))
    loop.close()
    assert len(exps) == 1
    assert exps[0]["status"] == "failed"
