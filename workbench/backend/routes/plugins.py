"""Plugin / simulator discovery routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

router = APIRouter()


@router.get("/simulators")
async def list_simulators(request: Request) -> list:
    """Return metadata for all registered simulators."""
    registry = request.app.state.registry
    return registry.list_simulators()


@router.get("/simulators/{name}/schema")
async def get_simulator_schema(name: str, request: Request) -> dict:
    """Return full config_schema and policy_specs for a named simulator."""
    registry = request.app.state.registry
    cls = registry.simulators.get(name)
    if cls is None:
        raise HTTPException(status_code=404, detail=f"Simulator '{name}' not found")
    return {
        "config_schema": cls.config_schema(),
        "policy_specs": cls.policy_specs(),
    }


@router.get("/simulators/{name}/presets")
async def get_simulator_presets(name: str, request: Request) -> dict:
    """Return cluster presets for a named simulator."""
    registry = request.app.state.registry
    cls = registry.simulators.get(name)
    if cls is None:
        raise HTTPException(status_code=404, detail=f"Simulator '{name}' not found")
    presets = cls.cluster_presets()
    return {k: v.to_dict() for k, v in presets.items()}
