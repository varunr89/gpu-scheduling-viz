import pytest
from viz.tools.log_parser import parse_job_arrival, parse_allocation, parse_telemetry

# Task 1.7 tests
def test_parse_job_arrival():
    line = 'scheduler:INFO [0] EVENT {"event": "job_arrival", "job_id": "23", "job_type": "ResNet-50 (batch size 64)", "scale_factor": 4, "total_steps": 91799.83, "arrival_time": 0, "sim_time": 0}'
    result = parse_job_arrival(line)
    assert result is not None
    assert result['job_id'] == 23
    assert result['job_type'] == "ResNet-50 (batch size 64)"
    assert result['scale_factor'] == 4

def test_parse_job_arrival_returns_none_for_other_events():
    line = 'scheduler:INFO [0] EVENT {"event": "job_completion", "job_id": "23", "sim_time": 1000}'
    assert parse_job_arrival(line) is None

def test_parse_job_arrival_returns_none_for_non_event():
    line = 'scheduler:DEBUG [0] Some debug message'
    assert parse_job_arrival(line) is None

# Task 1.8 tests
def test_parse_allocation_single_worker():
    line = 'scheduler:INFO [0] [Micro-task scheduled]\tJob ID: 23\tWorker type: v100\tWorker ID(s): 77\tPriority: 19.67'
    result = parse_allocation(line)
    assert result is not None
    assert result['job_id'] == 23
    assert result['worker_type'] == 'v100'
    assert result['worker_ids'] == [77]

def test_parse_allocation_multiple_workers():
    line = 'scheduler:INFO [0] [Micro-task scheduled]\tJob ID: 56\tWorker type: v100\tWorker ID(s): 72, 73, 74, 75\tPriority: 10.0'
    result = parse_allocation(line)
    assert result['job_id'] == 56
    assert result['worker_ids'] == [72, 73, 74, 75]

def test_parse_allocation_returns_none_for_other_lines():
    line = 'scheduler:INFO [0] EVENT {"event": "job_arrival"}'
    assert parse_allocation(line) is None

# Task 1.9 tests
def test_parse_telemetry():
    line = 'scheduler:INFO [0] TELEMETRY {"round": 5, "sim_time": 1799.99, "wall_time": 0.23, "jobs_generated": 59, "jobs_active": 57, "jobs_running": 57, "jobs_completed_total": 2, "jobs_completed_window": 0, "jobs_queued": 0, "utilization": 0.9568, "avg_jct": 0, "next_arrival": 2445.86, "v100_used": 36, "v100_total": 36, "p100_used": 36, "p100_total": 36, "k80_used": 36, "k80_total": 36, "windowed_completion_rate": null}'
    result = parse_telemetry(line)
    assert result is not None
    assert result['round'] == 5
    assert abs(result['sim_time'] - 1799.99) < 0.01
    assert result['jobs_running'] == 57

def test_parse_telemetry_returns_none_for_non_telemetry():
    line = 'scheduler:INFO [0] EVENT {"event": "job_arrival"}'
    assert parse_telemetry(line) is None
