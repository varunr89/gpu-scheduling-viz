"""Experiment group CRUD and execution routes."""

from __future__ import annotations

import asyncio
import logging
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from workbench.api.types import CompleteEvent, ErrorEvent, RoundEvent

logger = logging.getLogger(__name__)

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
# WebSocket (stub for Task 13)
# ---------------------------------------------------------------------------

@router.websocket("/{group_id}/stream")
async def stream_events(websocket: WebSocket, group_id: str) -> None:
    """WebSocket endpoint for live event streaming (stub)."""
    await websocket.accept()
    try:
        while True:
            # Wait for client messages; close on disconnect.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
