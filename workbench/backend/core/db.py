"""SQLite persistence layer for experiment metadata.

Uses WAL mode and aiosqlite for async access. All IDs are uuid4 strings,
timestamps are UTC ISO-8601, and config/summary fields are stored as JSON text.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import aiosqlite


class Database:
    """Async SQLite wrapper for experiment workbench metadata."""

    def __init__(self, path: str | Path) -> None:
        self._path = str(path)
        self._db: aiosqlite.Connection | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def init(self) -> None:
        """Open the database, enable WAL mode, and create tables."""
        self._db = await aiosqlite.connect(self._path)
        self._db.row_factory = aiosqlite.Row
        await self._db.execute("PRAGMA journal_mode=WAL")
        await self._db.execute("PRAGMA busy_timeout=5000")
        await self._db.execute("PRAGMA foreign_keys=ON")
        await self._create_tables()

    async def close(self) -> None:
        """Close the database connection."""
        if self._db is not None:
            await self._db.close()
            self._db = None

    # ------------------------------------------------------------------
    # Schema
    # ------------------------------------------------------------------

    async def _create_tables(self) -> None:
        await self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS experiment_groups (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                simulator   TEXT NOT NULL,
                status      TEXT NOT NULL DEFAULT 'draft',
                created_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS experiments (
                id            TEXT PRIMARY KEY,
                group_id      TEXT NOT NULL REFERENCES experiment_groups(id) ON DELETE CASCADE,
                name          TEXT NOT NULL,
                config_json   TEXT NOT NULL,
                policy        TEXT NOT NULL,
                status        TEXT NOT NULL DEFAULT 'pending',
                progress_pct  REAL NOT NULL DEFAULT 0,
                summary_json  TEXT,
                wall_time_s   REAL,
                created_at    TEXT NOT NULL,
                completed_at  TEXT
            );

            CREATE TABLE IF NOT EXISTS artifacts (
                id            TEXT PRIMARY KEY,
                experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
                type          TEXT NOT NULL,
                path          TEXT NOT NULL,
                created_at    TEXT NOT NULL
            );
            """
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _new_id() -> str:
        return str(uuid4())

    @staticmethod
    def _row_to_dict(row: aiosqlite.Row) -> dict:
        """Convert an aiosqlite.Row to a plain dict."""
        return dict(row)

    # ------------------------------------------------------------------
    # Groups
    # ------------------------------------------------------------------

    async def create_group(self, name: str, simulator: str) -> dict:
        gid = self._new_id()
        now = self._now()
        await self._db.execute(
            "INSERT INTO experiment_groups (id, name, simulator, status, created_at) "
            "VALUES (?, ?, ?, 'draft', ?)",
            (gid, name, simulator, now),
        )
        await self._db.commit()
        return await self.get_group(gid)

    async def get_group(self, group_id: str) -> dict | None:
        cursor = await self._db.execute(
            "SELECT * FROM experiment_groups WHERE id = ?", (group_id,)
        )
        row = await cursor.fetchone()
        return self._row_to_dict(row) if row else None

    async def list_groups(self) -> list[dict]:
        cursor = await self._db.execute(
            "SELECT * FROM experiment_groups ORDER BY created_at"
        )
        rows = await cursor.fetchall()
        return [self._row_to_dict(r) for r in rows]

    async def delete_group(self, group_id: str) -> None:
        """Delete a group and cascade-delete its experiments and artifacts."""
        await self._db.execute(
            "DELETE FROM experiment_groups WHERE id = ?", (group_id,)
        )
        await self._db.commit()

    # ------------------------------------------------------------------
    # Experiments
    # ------------------------------------------------------------------

    async def create_experiment(
        self,
        group_id: str,
        config: dict,
        policy: str,
        name: str,
    ) -> dict:
        eid = self._new_id()
        now = self._now()
        await self._db.execute(
            "INSERT INTO experiments "
            "(id, group_id, name, config_json, policy, status, progress_pct, created_at) "
            "VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)",
            (eid, group_id, name, json.dumps(config), policy, now),
        )
        await self._db.commit()
        return await self.get_experiment(eid)

    async def get_experiment(self, experiment_id: str) -> dict | None:
        cursor = await self._db.execute(
            "SELECT * FROM experiments WHERE id = ?", (experiment_id,)
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        d = self._row_to_dict(row)
        d["config"] = json.loads(d.pop("config_json"))
        summary_raw = d.pop("summary_json")
        d["summary"] = json.loads(summary_raw) if summary_raw else None
        return d

    async def list_experiments(self, group_id: str) -> list[dict]:
        cursor = await self._db.execute(
            "SELECT * FROM experiments WHERE group_id = ? ORDER BY created_at",
            (group_id,),
        )
        rows = await cursor.fetchall()
        results = []
        for row in rows:
            d = self._row_to_dict(row)
            d["config"] = json.loads(d.pop("config_json"))
            summary_raw = d.pop("summary_json")
            d["summary"] = json.loads(summary_raw) if summary_raw else None
            results.append(d)
        return results

    # Whitelist of column names accepted by update_experiment to prevent
    # SQL injection via dynamic column interpolation.
    _UPDATABLE_COLUMNS = frozenset({
        "status", "progress_pct", "wall_time_s", "completed_at",
    })

    async def update_experiment(self, experiment_id: str, **kwargs) -> dict:
        """Update experiment fields. Supported kwargs: status, progress_pct,
        summary, config, wall_time_s, completed_at."""
        sets = []
        params = []
        for key, value in kwargs.items():
            if key == "summary":
                sets.append("summary_json = ?")
                params.append(json.dumps(value))
            elif key == "config":
                sets.append("config_json = ?")
                params.append(json.dumps(value))
            elif key in self._UPDATABLE_COLUMNS:
                sets.append(f"{key} = ?")
                params.append(value)
            else:
                raise ValueError(f"Cannot update unknown column: {key!r}")
        if not sets:
            return await self.get_experiment(experiment_id)
        params.append(experiment_id)
        await self._db.execute(
            f"UPDATE experiments SET {', '.join(sets)} WHERE id = ?",
            tuple(params),
        )
        await self._db.commit()
        return await self.get_experiment(experiment_id)

    # ------------------------------------------------------------------
    # Crash recovery
    # ------------------------------------------------------------------

    async def recover_interrupted(self) -> list[dict]:
        """Mark all RUNNING experiments as INTERRUPTED and return them."""
        cursor = await self._db.execute(
            "SELECT id FROM experiments WHERE status = 'running'"
        )
        rows = await cursor.fetchall()
        if not rows:
            return []
        ids = [r["id"] for r in rows]
        await self._db.execute(
            "UPDATE experiments SET status = 'interrupted' WHERE status = 'running'"
        )
        await self._db.commit()
        results = []
        for eid in ids:
            exp = await self.get_experiment(eid)
            if exp:
                results.append(exp)
        return results
