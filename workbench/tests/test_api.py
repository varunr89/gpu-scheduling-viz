"""Tests for the FastAPI application and REST routes."""

from __future__ import annotations

import asyncio
from typing import Optional

import pytest
import httpx

from workbench.app import create_app


@pytest.fixture
def app(tmp_path):
    """Create a test application with a temp database and empty plugins dir."""
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
    yield application
    loop.run_until_complete(ctx.__aexit__(None, None, None))
    loop.close()


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def test_list_simulators(app):
    """GET /api/plugins/simulators returns 200 with a list."""
    async def do():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/plugins/simulators")
            assert resp.status_code == 200
            data = resp.json()
            assert isinstance(data, list)
    _run(do())


def test_create_group(app):
    """POST /api/experiments returns 201 with group and experiments."""
    async def do():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            body = {
                "name": "Test sweep",
                "simulator": "fake_sim",
                "experiments": [
                    {"name": "exp1", "policy": "fifo", "config": {"param": 1}},
                    {"name": "exp2", "policy": "round_robin", "config": {"param": 2}},
                ],
            }
            resp = await client.post("/api/experiments", json=body)
            assert resp.status_code == 201
            data = resp.json()
            assert data["name"] == "Test sweep"
            assert data["simulator"] == "fake_sim"
            assert "experiments" in data
            assert len(data["experiments"]) == 2
            assert data["experiments"][0]["name"] == "exp1"
            assert data["experiments"][0]["policy"] == "fifo"
            assert data["experiments"][1]["name"] == "exp2"
    _run(do())


def test_list_groups(app):
    """GET /api/experiments returns list of groups."""
    async def do():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            # Create two groups
            for name in ["Group A", "Group B"]:
                await client.post("/api/experiments", json={
                    "name": name,
                    "simulator": "sim",
                    "experiments": [],
                })
            resp = await client.get("/api/experiments")
            assert resp.status_code == 200
            data = resp.json()
            assert len(data) == 2
    _run(do())


def test_get_group(app):
    """GET /api/experiments/{id} returns group with its experiments."""
    async def do():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            create_resp = await client.post("/api/experiments", json={
                "name": "Detail group",
                "simulator": "sim",
                "experiments": [
                    {"name": "e1", "policy": "fifo", "config": {"x": 1}},
                ],
            })
            group_id = create_resp.json()["id"]

            resp = await client.get(f"/api/experiments/{group_id}")
            assert resp.status_code == 200
            data = resp.json()
            assert data["id"] == group_id
            assert data["name"] == "Detail group"
            assert len(data["experiments"]) == 1
            assert data["experiments"][0]["name"] == "e1"
    _run(do())


def test_delete_group(app):
    """DELETE /api/experiments/{id} returns 200."""
    async def do():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            create_resp = await client.post("/api/experiments", json={
                "name": "To delete",
                "simulator": "sim",
                "experiments": [],
            })
            group_id = create_resp.json()["id"]

            resp = await client.delete(f"/api/experiments/{group_id}")
            assert resp.status_code == 200

            # Verify it is gone
            resp2 = await client.get(f"/api/experiments/{group_id}")
            assert resp2.status_code == 404
    _run(do())


def test_get_nonexistent_group(app):
    """GET /api/experiments/bogus returns 404."""
    async def do():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/experiments/bogus-id-does-not-exist")
            assert resp.status_code == 404
    _run(do())
