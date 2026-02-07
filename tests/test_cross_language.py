#!/usr/bin/env python3
"""Generate reference data for cross-language compatibility testing."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from viz.tools.binary_format import write_viz_file, read_viz_header, compute_round_size

def generate_reference():
    config = {
        'gpu_types': [
            {'name': 'k80', 'count': 4},
            {'name': 'p100', 'count': 4},
            {'name': 'v100', 'count': 4}
        ],
        'measurement_window': {'start_job': 10, 'end_job': 20},
        'job_types': [
            {'id': 0, 'name': 'ResNet-18', 'category': 'resnet'},
            {'id': 1, 'name': 'LM (batch size 5)', 'category': 'language_model'},
        ]
    }

    jobs = [
        {'job_id': 1, 'type_id': 0, 'scale_factor': 1, 'arrival_round': 0},
        {'job_id': 2, 'type_id': 1, 'scale_factor': 2, 'arrival_round': 0},
        {'job_id': 70000, 'type_id': 0, 'scale_factor': 4, 'arrival_round': 1},
    ]

    rounds = [
        {
            'round': 0, 'sim_time': 0.0, 'utilization': 0.0,
            'jobs_running': 0, 'jobs_queued': 3, 'jobs_completed': 0,
            'avg_jct': 0.0, 'completion_rate': 0.0,
            'gpu_used': [0, 0, 0], 'allocations': [0] * 12
        },
        {
            'round': 1, 'sim_time': 360.5, 'utilization': 0.5,
            'jobs_running': 2, 'jobs_queued': 1, 'jobs_completed': 0,
            'avg_jct': 0.0, 'completion_rate': 0.0,
            'gpu_used': [2, 2, 2],
            'allocations': [1, 0, 0, 0, 2, 2, 0, 0, 70000, 70000, 70000, 70000]
        }
    ]
    queues = [[1, 2, 70000], [70000]]

    output_dir = os.path.dirname(__file__)
    viz_path = os.path.join(output_dir, 'cross_language_test.viz.bin')
    expected_path = os.path.join(output_dir, 'cross_language_expected.json')

    write_viz_file(viz_path, config, jobs, rounds, queues)

    header = read_viz_header(viz_path)
    expected = {
        'header': {
            'numRounds': header['num_rounds'],
            'numJobs': header['num_jobs'],
            'numGpuTypes': header['num_gpu_types'],
            'totalGpus': header['total_gpus'],
        },
        'jobs': jobs,
        'rounds': rounds,
        'roundSize': compute_round_size(3, 12),
    }
    with open(expected_path, 'w') as f:
        json.dump(expected, f, indent=2)

    print(f"Generated: {viz_path}")
    print(f"Expected: {expected_path}")

if __name__ == '__main__':
    generate_reference()
