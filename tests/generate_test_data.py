#!/usr/bin/env python3
"""Generate test data files for browser testing."""
import os
import sys

# Add parent dirs to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from viz.tools.binary_format import write_viz_file

def generate_test_data():
    """Generate a small .viz.bin file with known data."""
    config = {
        'gpu_types': [
            {'name': 'k80', 'count': 4},
            {'name': 'p100', 'count': 4},
            {'name': 'v100', 'count': 4}
        ],
        'measurement_window': {'start_job': 2, 'end_job': 8},
        'job_types': [
            {'id': 0, 'name': 'ResNet-18 (batch size 64)', 'category': 'resnet'},
            {'id': 1, 'name': 'LM (batch size 5)', 'category': 'language_model'},
            {'id': 2, 'name': 'Transformer (big)', 'category': 'transformer'},
            {'id': 3, 'name': 'CycleGAN', 'category': 'cyclegan'},
        ]
    }

    jobs = [
        {'job_id': 1, 'type_id': 0, 'scale_factor': 1, 'arrival_round': 0},
        {'job_id': 2, 'type_id': 1, 'scale_factor': 2, 'arrival_round': 0},
        {'job_id': 3, 'type_id': 2, 'scale_factor': 4, 'arrival_round': 1},
        {'job_id': 4, 'type_id': 0, 'scale_factor': 1, 'arrival_round': 2},
        {'job_id': 5, 'type_id': 3, 'scale_factor': 2, 'arrival_round': 3},
        {'job_id': 6, 'type_id': 1, 'scale_factor': 1, 'arrival_round': 5},
        {'job_id': 7, 'type_id': 2, 'scale_factor': 2, 'arrival_round': 7},
        {'job_id': 8, 'type_id': 0, 'scale_factor': 1, 'arrival_round': 9},
    ]

    # Generate 20 rounds of data with gradually changing allocations
    rounds = []
    queues = []

    for r in range(20):
        sim_time = r * 360.0  # 6 minutes per round
        allocs = [0] * 12  # 12 GPUs total
        gpu_used = [0, 0, 0]  # k80, p100, v100
        running = 0
        queued_jobs = []

        # Round 0-4: Jobs 1,2 running
        if r >= 0:
            allocs[8] = 1   # v100 GPU 8: job 1 (ResNet-18, 1 GPU)
            gpu_used[2] += 1
            running += 1

        if r >= 0 and r < 15:
            allocs[4] = 2   # p100 GPU 4: job 2 (LM, 2 GPUs)
            allocs[5] = 2   # p100 GPU 5
            gpu_used[1] += 2
            running += 1

        # Round 1+: Job 3 (Transformer, 4 GPUs)
        if r >= 1 and r < 12:
            allocs[0] = 3; allocs[1] = 3; allocs[2] = 3; allocs[3] = 3  # k80 GPUs
            gpu_used[0] += 4
            running += 1

        # Round 2+: Job 4
        if r >= 2 and r < 10:
            allocs[9] = 4  # v100 GPU 9
            gpu_used[2] += 1
            running += 1

        # Round 3+: Job 5 (CycleGAN, 2 GPUs)
        if r >= 3 and r < 14:
            allocs[6] = 5; allocs[7] = 5  # p100 GPUs 6,7
            gpu_used[1] += 2
            running += 1

        # Round 5+: Job 6
        if r >= 5 and r < 18:
            allocs[10] = 6  # v100 GPU 10
            gpu_used[2] += 1
            running += 1

        # Round 7+: Job 7 (Transformer, 2 GPUs)
        if r >= 7 and r < 16:
            allocs[11] = 7  # v100 GPU 11
            if r >= 10 and allocs[9] == 0:
                allocs[9] = 7
                gpu_used[2] += 1
            gpu_used[2] += 1
            running += 1

        # Round 9+: Job 8
        if r >= 9:
            if allocs[0] == 0:
                allocs[0] = 8
                gpu_used[0] += 1
                running += 1

        # Compute queued: arrived but not running
        running_ids = set(j for j in allocs if j > 0)
        for job in jobs:
            if job['arrival_round'] <= r and job['job_id'] not in running_ids:
                queued_jobs.append(job['job_id'])

        completed = 0
        if r >= 10: completed += 1  # job 4 completes
        if r >= 12: completed += 1  # job 3 completes
        if r >= 14: completed += 1  # job 5 completes
        if r >= 15: completed += 1  # job 2 completes
        if r >= 16: completed += 1  # job 7 completes
        if r >= 18: completed += 1  # job 6 completes

        used = sum(gpu_used)
        utilization = used / 12.0

        rounds.append({
            'round': r,
            'sim_time': sim_time,
            'utilization': utilization,
            'jobs_running': running,
            'jobs_queued': len(queued_jobs),
            'jobs_completed': completed,
            'avg_jct': (r * 180.0) if completed > 0 else 0.0,
            'completion_rate': completed / max(1, r) if r > 0 else 0.0,
            'gpu_used': gpu_used,
            'allocations': allocs
        })
        queues.append(queued_jobs)

    output_dir = os.path.dirname(__file__)
    output_path = os.path.join(output_dir, 'test_data.viz.bin')
    write_viz_file(output_path, config, jobs, rounds, queues)
    print(f"Generated: {output_path}")
    print(f"  Rounds: {len(rounds)}")
    print(f"  Jobs: {len(jobs)}")
    print(f"  GPU types: {len(config['gpu_types'])}")
    print(f"  Total GPUs: {sum(t['count'] for t in config['gpu_types'])}")

if __name__ == '__main__':
    generate_test_data()
