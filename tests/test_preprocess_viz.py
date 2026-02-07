import pytest
import tempfile
import os
from viz.tools.preprocess_viz import preprocess_simulation
from viz.tools.binary_format import read_viz_header, MAGIC, VERSION

SAMPLE_LOG = '''scheduler:INFO [0] Running scheduler
scheduler:INFO [0] EVENT {"event": "job_arrival", "job_id": "0", "job_type": "ResNet-18 (batch size 64)", "scale_factor": 1, "total_steps": 1000, "arrival_time": 0, "sim_time": 0}
scheduler:INFO [0] EVENT {"event": "job_arrival", "job_id": "1", "job_type": "LM (batch size 5)", "scale_factor": 2, "total_steps": 2000, "arrival_time": 0, "sim_time": 0}
scheduler:INFO [0] TELEMETRY {"round": 0, "sim_time": 0, "wall_time": 0.001, "jobs_generated": 2, "jobs_active": 2, "jobs_running": 0, "jobs_completed_total": 0, "jobs_completed_window": 0, "jobs_queued": 2, "utilization": 0, "avg_jct": 0, "next_arrival": 0, "v100_used": 0, "v100_total": 4, "p100_used": 0, "p100_total": 4, "k80_used": 0, "k80_total": 4, "windowed_completion_rate": null}
scheduler:INFO [0] [Micro-task scheduled]\tJob ID: 0\tWorker type: v100\tWorker ID(s): 8\tPriority: 1.0
scheduler:INFO [0] [Micro-task scheduled]\tJob ID: 1\tWorker type: v100\tWorker ID(s): 9, 10\tPriority: 1.0
scheduler:INFO [0] TELEMETRY {"round": 1, "sim_time": 360, "wall_time": 0.01, "jobs_generated": 2, "jobs_active": 2, "jobs_running": 2, "jobs_completed_total": 0, "jobs_completed_window": 0, "jobs_queued": 0, "utilization": 0.25, "avg_jct": 0, "next_arrival": 1000, "v100_used": 3, "v100_total": 4, "p100_used": 0, "p100_total": 4, "k80_used": 0, "k80_total": 4, "windowed_completion_rate": null}
'''

def test_preprocess_simulation_creates_viz_file():
    with tempfile.TemporaryDirectory() as tmpdir:
        log_path = os.path.join(tmpdir, 'simulation.log')
        output_path = os.path.join(tmpdir, 'output.viz.bin')
        with open(log_path, 'w') as f:
            f.write(SAMPLE_LOG)
        preprocess_simulation(log_path=log_path, output_path=output_path, cluster_spec="4:4:4", measurement_window=(0, 100))
        assert os.path.exists(output_path)
        header = read_viz_header(output_path)
        assert header['magic'] == MAGIC
        assert header['num_rounds'] == 2
        assert header['num_jobs'] == 2
        assert header['total_gpus'] == 12
