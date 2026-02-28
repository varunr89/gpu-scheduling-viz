"""FastAPI application factory for the Experiment Workbench."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from workbench.backend.core.db import Database
from workbench.backend.core.registry import PluginRegistry
from workbench.backend.core.runner import ExperimentRunner
from workbench.backend.routes.experiments import router as experiments_router
from workbench.backend.routes.plugins import router as plugins_router

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Project root -- the gpu-scheduling-viz directory
# ---------------------------------------------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parent.parent


def create_app(
    data_dir: str = "workbench/data",
    plugins_dir: str = "workbench/plugins",
    db_path: str = "workbench/data/experiments.db",
) -> FastAPI:
    """Build and return a configured FastAPI application.

    Parameters
    ----------
    data_dir:
        Directory for experiment event data and artifacts.
    plugins_dir:
        Directory scanned for simulator plugin packages.
    db_path:
        Path to the SQLite database file.
    """
    # Resolve paths relative to project root if they are not absolute.
    data_path = Path(data_dir)
    if not data_path.is_absolute():
        data_path = _PROJECT_ROOT / data_path
    plugins_path = Path(plugins_dir)
    if not plugins_path.is_absolute():
        plugins_path = _PROJECT_ROOT / plugins_path
    db_file = Path(db_path)
    if not db_file.is_absolute():
        db_file = _PROJECT_ROOT / db_file

    # Ensure data directory exists.
    data_path.mkdir(parents=True, exist_ok=True)
    db_file.parent.mkdir(parents=True, exist_ok=True)

    # Create core components (not yet started).
    db = Database(db_file)
    registry = PluginRegistry(plugins_path)
    runner = ExperimentRunner(max_workers=2, data_dir=data_path)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Startup
        await db.init()
        registry.discover()
        recovered = await db.recover_interrupted()
        if recovered:
            logger.info("Recovered %d interrupted experiments", len(recovered))

        # Attach to app state so route handlers can access them.
        app.state.db = db
        app.state.registry = registry
        app.state.runner = runner

        yield

        # Shutdown
        await runner.shutdown()
        await db.close()

    app = FastAPI(title="GPU Scheduling Experiment Workbench", lifespan=lifespan)

    # ----- API routers -----
    app.include_router(plugins_router, prefix="/api/plugins")
    app.include_router(experiments_router, prefix="/api/experiments")

    # ----- Static file mounts -----
    src_dir = _PROJECT_ROOT / "src"
    if src_dir.is_dir():
        app.mount("/src", StaticFiles(directory=str(src_dir)), name="src")

    viz_data_dir = _PROJECT_ROOT / "data"
    if viz_data_dir.is_dir():
        app.mount("/data", StaticFiles(directory=str(viz_data_dir)), name="data")

    frontend_dir = _PROJECT_ROOT / "workbench" / "frontend"
    if frontend_dir.is_dir():
        app.mount(
            "/workbench/frontend",
            StaticFiles(directory=str(frontend_dir)),
            name="workbench_frontend",
        )

    # ----- HTML entry-point routes -----
    index_html = _PROJECT_ROOT / "index.html"
    workbench_html = _PROJECT_ROOT / "workbench" / "frontend" / "workbench.html"

    @app.get("/")
    async def serve_index():
        if index_html.exists():
            return FileResponse(str(index_html))
        return {"detail": "index.html not found"}

    @app.get("/workbench")
    async def serve_workbench():
        if workbench_html.exists():
            return FileResponse(str(workbench_html))
        return {"detail": "workbench.html not found"}

    return app


# Module-level instance for ``uvicorn workbench.app:app``
app = create_app()
