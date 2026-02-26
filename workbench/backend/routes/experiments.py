"""Experiment group CRUD and execution routes."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from workbench.api.types import CompleteEvent, ErrorEvent, RoundEvent
from workbench.backend.core.exporter import Exporter

logger = logging.getLogger(__name__)

# Project root -- the gpu-scheduling-viz directory.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class ExperimentSpec(BaseModel):
    name: str
    policy: str
    config: dict


class CreateGroupRequest(BaseModel):
    name: str
    simulator: str
    experiments: List[ExperimentSpec]


# ---------------------------------------------------------------------------
# CRUD routes
# ---------------------------------------------------------------------------

@router.post("", status_code=201)
async def create_group(body: CreateGroupRequest, request: Request) -> dict:
    """Create an experiment group with its child experiments."""
    db = request.app.state.db

    group = await db.create_group(name=body.name, simulator=body.simulator)
    experiments = []
    for exp_spec in body.experiments:
        exp = await db.create_experiment(
            group_id=group["id"],
            config=exp_spec.config,
            policy=exp_spec.policy,
            name=exp_spec.name,
        )
        experiments.append(exp)

    group["experiments"] = experiments
    return group


@router.get("")
async def list_groups(request: Request) -> list:
    """List all experiment groups."""
    db = request.app.state.db
    return await db.list_groups()


@router.get("/{group_id}")
async def get_group(group_id: str, request: Request) -> dict:
    """Return a single experiment group with its experiments."""
    db = request.app.state.db
    group = await db.get_group(group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")
    group["experiments"] = await db.list_experiments(group_id)
    return group


@router.delete("/{group_id}")
async def delete_group(group_id: str, request: Request) -> dict:
    """Delete an experiment group (cascades to experiments and artifacts)."""
    db = request.app.state.db
    group = await db.get_group(group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")
    await db.delete_group(group_id)
    return {"status": "deleted", "id": group_id}


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------

async def _run_experiment_task(app, experiment_id: str, simulator, config: dict) -> None:
    """Background task that runs a single experiment via the runner."""
    db = app.state.db
    runner = app.state.runner
    await db.update_experiment(experiment_id, status="running")
    try:
        async for event in runner.run_experiment(experiment_id, simulator, config):
            if isinstance(event, RoundEvent):
                # Update progress -- the round_num is a best-effort indicator.
                pass
            elif isinstance(event, CompleteEvent):
                await db.update_experiment(
                    experiment_id,
                    status="completed",
                    summary=event.summary,
                )
            elif isinstance(event, ErrorEvent):
                await db.update_experiment(experiment_id, status="failed")
    except Exception:
        logger.exception("Experiment %s failed", experiment_id)
        await db.update_experiment(experiment_id, status="failed")


@router.post("/{group_id}/run")
async def run_group(group_id: str, request: Request) -> dict:
    """Queue all pending experiments in a group for execution."""
    db = request.app.state.db
    registry = request.app.state.registry

    group = await db.get_group(group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")

    simulator = registry.get_simulator(group["simulator"])
    if simulator is None:
        raise HTTPException(
            status_code=400,
            detail=f"Simulator '{group['simulator']}' not found in registry",
        )

    experiments = await db.list_experiments(group_id)
    queued = []
    for exp in experiments:
        if exp["status"] != "pending":
            continue
        asyncio.create_task(
            _run_experiment_task(
                request.app, exp["id"], simulator, exp["config"]
            )
        )
        queued.append(exp["id"])

    return {"status": "running", "group_id": group_id, "queued": queued}


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

@router.post("/{group_id}/export")
async def export_group(group_id: str, request: Request) -> dict:
    """Export all completed experiments in a group to .viz.bin files.

    Creates .viz.bin files in the project's ``data/`` directory and
    updates ``data/manifest.json`` so the viz tool can discover them.
    """
    db = request.app.state.db

    group = await db.get_group(group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")

    experiments = await db.list_experiments(group_id)
    completed = [e for e in experiments if e["status"] == "completed"]
    if not completed:
        raise HTTPException(
            status_code=400,
            detail="No completed experiments to export",
        )

    exporter = Exporter(
        data_dir=request.app.state.runner._data_dir,
        viz_data_dir=_PROJECT_ROOT / "data",
        manifest_path=_PROJECT_ROOT / "data" / "manifest.json",
    )

    paths: List[str] = []
    for exp in completed:
        path = exporter.export_experiment(exp["id"], exp)
        paths.append(path)

    exporter.update_manifest(completed, paths)
    return {"exported": len(paths), "files": paths}


# ---------------------------------------------------------------------------
# WebSocket event streaming
# ---------------------------------------------------------------------------

@router.websocket("/{group_id}/stream")
async def stream_events(websocket: WebSocket, group_id: str) -> None:
    """Stream experiment events over WebSocket.

    On connect, runs all *pending* experiments in the group sequentially via
    ``runner.run_group()`` and pushes each event to the client as JSON.

    Features:
    - **Backpressure**: Round events are sampled (every Nth round sent)
      so a slow client does not cause memory buildup.
    - **Cancellation**: The client can send ``{"type": "cancel"}`` to
      cancel all remaining experiments.
    - **DB updates**: Terminal events (complete, error) update experiment
      status in the database.
    """
    await websocket.accept()

    db = websocket.app.state.db
    registry = websocket.app.state.registry
    runner = websocket.app.state.runner

    # --- Validate group exists ---
    group = await db.get_group(group_id)
    if not group:
        await websocket.close(code=4004, reason="Group not found")
        return

    # --- Resolve simulator ---
    simulator = registry.get_simulator(group["simulator"])
    if not simulator:
        await websocket.close(code=4000, reason="Simulator not found")
        return

    # --- Filter to pending/queued experiments ---
    experiments = await db.list_experiments(group_id)
    pending = [e for e in experiments if e["status"] in ("pending", "queued")]

    if not pending:
        await websocket.send_json(
            {"type": "group_complete", "message": "No pending experiments"}
        )
        await websocket.close()
        return

    # Mark experiments as running.
    for exp in pending:
        await db.update_experiment(exp["id"], status="running")

    # --- Cancel listener task ---
    cancel_requested = asyncio.Event()

    async def _listen_for_cancel() -> None:
        try:
            while True:
                data = await websocket.receive_json()
                if isinstance(data, dict) and data.get("type") == "cancel":
                    cancel_requested.set()
                    for exp in pending:
                        runner.cancel_experiment(exp["id"])
        except WebSocketDisconnect:
            cancel_requested.set()
        except Exception:
            pass

    cancel_task = asyncio.create_task(_listen_for_cancel())

    # --- Stream events with backpressure sampling ---
    # Send every Nth round event to avoid overwhelming slow clients.
    SAMPLE_INTERVAL = 10
    round_count = 0

    try:
        async for event in runner.run_group(group_id, pending, simulator):
            if cancel_requested.is_set():
                break

            # Backpressure: sample round events.
            if event["type"] == "round":
                round_count += 1
                if round_count % SAMPLE_INTERVAL != 0:
                    continue

            # Update database on terminal events.
            if event["type"] == "complete":
                exp_data = event.get("data", {})
                await db.update_experiment(
                    event["experiment_id"],
                    status="completed",
                    summary=exp_data.get("summary"),
                )
            elif event["type"] == "error":
                await db.update_experiment(
                    event["experiment_id"], status="failed"
                )

            try:
                await websocket.send_json(event)
            except Exception:
                break
    finally:
        cancel_task.cancel()
        try:
            await cancel_task
        except (asyncio.CancelledError, Exception):
            pass
