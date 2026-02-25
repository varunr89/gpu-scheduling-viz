import asyncio
import pytest
from workbench.backend.core.db import Database

@pytest.fixture
def db(tmp_path):
    database = Database(tmp_path / "test.db")
    asyncio.get_event_loop().run_until_complete(database.init())
    yield database
    asyncio.get_event_loop().run_until_complete(database.close())

def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)

def test_create_group(db):
    group = _run(db.create_group("MMF sweep", "gavel"))
    assert group["id"] is not None
    assert group["name"] == "MMF sweep"
    assert group["status"] == "draft"

def test_create_experiment(db):
    group = _run(db.create_group("test", "gavel"))
    exp = _run(db.create_experiment(
        group_id=group["id"],
        config={"policy": "fifo", "lam": 900},
        policy="fifo",
        name="fifo_2jph_s0",
    ))
    assert exp["status"] == "pending"
    assert exp["config"]["policy"] == "fifo"

def test_list_groups(db):
    _run(db.create_group("A", "gavel"))
    _run(db.create_group("B", "gavel"))
    groups = _run(db.list_groups())
    assert len(groups) == 2

def test_update_experiment_status(db):
    group = _run(db.create_group("test", "gavel"))
    exp = _run(db.create_experiment(group["id"], {"policy": "fifo"}, "fifo", "exp1"))
    _run(db.update_experiment(exp["id"], status="running", progress_pct=50))
    updated = _run(db.get_experiment(exp["id"]))
    assert updated["status"] == "running"
    assert updated["progress_pct"] == 50

def test_crash_recovery(db):
    group = _run(db.create_group("test", "gavel"))
    exp = _run(db.create_experiment(group["id"], {"policy": "fifo"}, "fifo", "exp1"))
    _run(db.update_experiment(exp["id"], status="running"))
    interrupted = _run(db.recover_interrupted())
    assert len(interrupted) == 1
    assert interrupted[0]["id"] == exp["id"]
    updated = _run(db.get_experiment(exp["id"]))
    assert updated["status"] == "interrupted"

def test_delete_group(db):
    group = _run(db.create_group("test", "gavel"))
    _run(db.create_experiment(group["id"], {"policy": "fifo"}, "fifo", "e1"))
    _run(db.delete_group(group["id"]))
    groups = _run(db.list_groups())
    assert len(groups) == 0
