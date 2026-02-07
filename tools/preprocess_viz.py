# tools/preprocess_viz.py
"""Preprocess simulation logs to generate .viz.bin files."""
import re
from typing import Dict, List, Tuple
from viz.tools.log_parser import (
    parse_job_arrival, parse_allocation, parse_job_completion, parse_telemetry
)
from viz.tools.binary_format import write_viz_file

# Job type mapping for categories
JOB_TYPE_CATEGORIES = {
    'ResNet': 'resnet',
    'VGG': 'vgg',
    'Inception': 'inception',
    'Transformer': 'transformer',
    'BERT': 'transformer',
    'LM': 'language_model',
    'GPT': 'language_model',
    'Recommendation': 'recommendation',
    'CycleGAN': 'cyclegan'
}


def parse_cluster_spec(spec: str) -> List[Dict]:
    """Parse a cluster specification string into gpu_types list.

    Supports two formats:
      - Named: "G2=4392,T4=840,G3=312" or "G2:4392,T4:840"
      - Legacy: "36:36:36" (maps to k80, p100, v100)
    """
    # Named format: contains '=' or letters before digits
    if '=' in spec or ',' in spec:
        gpu_types = []
        for part in spec.split(','):
            if '=' in part:
                name, count = part.split('=')
            elif ':' in part:
                name, count = part.split(':')
            else:
                raise ValueError(f"Cannot parse cluster spec part: {part}")
            gpu_types.append({'name': name.strip(), 'count': int(count.strip())})
        return gpu_types
    # Legacy format: colon-separated counts
    counts = [int(x) for x in spec.split(':')]
    default_names = ['k80', 'p100', 'v100', 'a100', 'h100', 'b200']
    return [
        {'name': default_names[i] if i < len(default_names) else f'gpu{i}',
         'count': c}
        for i, c in enumerate(counts)
    ]


def get_job_category(job_type: str) -> str:
    """Map a job type string to its category.

    Args:
        job_type: Full job type string (e.g., "ResNet-50 (batch size 64)")

    Returns:
        Category name (e.g., "resnet") or "other" if no match
    """
    for key, category in JOB_TYPE_CATEGORIES.items():
        if key in job_type:
            return category
    return 'other'


def preprocess_simulation(
    log_path: str,
    output_path: str,
    cluster_spec: str = "36:36:36",
    measurement_window: Tuple[int, int] = (4000, 5000),
    policy: str = "unknown",
    gpus_per_node: int = 1
) -> None:
    """Process a simulation log file and generate a .viz.bin file.

    Args:
        log_path: Path to the simulation.log file
        output_path: Path for the output .viz.bin file
        cluster_spec: Cluster specification as "k80:p100:v100" counts
        measurement_window: Tuple of (start_job, end_job) for measurement window
        policy: Name of the scheduling policy
        gpus_per_node: Number of GPUs per physical node (for fragmentation metrics)
    """
    gpu_types = parse_cluster_spec(cluster_spec)
    for gt in gpu_types:
        gt['gpus_per_node'] = gpus_per_node
    total_gpus = sum(g['count'] for g in gpu_types)

    jobs: List[Dict] = []
    job_index: Dict[int, Dict] = {}  # job_id -> job dict (for updating completion)
    job_type_map: Dict[str, int] = {}
    job_types_list: List[Dict] = []
    allocations_by_round: Dict[int, List[int]] = {}
    telemetry_data: List[Dict] = []
    current_round = -1
    current_allocations = [0] * total_gpus
    # Track completed job durations for running avg JCT
    completed_durations: List[float] = []
    completed_ids_snapshot: Dict[int, set] = {}  # round -> set of completed job IDs
    pending_completed_ids: set = set()
    avg_jct_by_round: Dict[int, float] = {}

    with open(log_path) as f:
        for line in f:
            arrival = parse_job_arrival(line)
            if arrival:
                job_type = arrival['job_type']
                if job_type not in job_type_map:
                    type_id = len(job_types_list)
                    job_type_map[job_type] = type_id
                    job_types_list.append({
                        'id': type_id,
                        'name': job_type,
                        'category': get_job_category(job_type)
                    })
                job_dict = {
                    'job_id': arrival['job_id'],
                    'type_id': job_type_map[job_type],
                    'scale_factor': arrival['scale_factor'],
                    'arrival_round': max(0, current_round),
                    'completion_round': 0,
                    'duration': 0.0
                }
                jobs.append(job_dict)
                job_index[arrival['job_id']] = job_dict
                continue

            completion = parse_job_completion(line)
            if completion:
                completed_durations.append(completion['duration'])
                pending_completed_ids.add(completion['job_id'])
                # Update job metadata with completion info
                if completion['job_id'] in job_index:
                    job_index[completion['job_id']]['completion_round'] = max(0, current_round)
                    job_index[completion['job_id']]['duration'] = completion['duration']
                continue

            alloc = parse_allocation(line)
            if alloc:
                for worker_id in alloc['worker_ids']:
                    if 0 <= worker_id < total_gpus:
                        current_allocations[worker_id] = alloc['job_id']
                continue

            telem = parse_telemetry(line)
            if telem:
                new_round = telem['round']
                # Save accumulated allocations for the round that just ended.
                # Allocations between TELEMETRY(N) and TELEMETRY(N+1) are
                # the schedule for round N+1. So when we see TELEMETRY(N+1),
                # we save current_allocations as round N+1's state.
                if new_round > 0:
                    allocations_by_round[new_round] = list(current_allocations)
                else:
                    allocations_by_round[0] = [0] * total_gpus
                # Snapshot completed jobs for this round's queue calculation
                completed_ids_snapshot[new_round] = set(pending_completed_ids)
                # Compute running avg JCT from completions seen so far
                if completed_durations:
                    avg_jct_by_round[new_round] = (
                        sum(completed_durations) / len(completed_durations)
                    )
                # Reset for next round -- each round emits a complete
                # set of allocation lines, so we must not carry over.
                current_allocations = [0] * total_gpus
                current_round = new_round
                telemetry_data.append(telem)

    rounds: List[Dict] = []
    queues: List[List[int]] = []
    for telem in telemetry_data:
        r = telem['round']
        gpu_used = []
        for gt in gpu_types:
            key = f"{gt['name']}_used"
            gpu_used.append(telem.get(key, 0))

        allocs = allocations_by_round.get(r, [0] * total_gpus)
        running_jobs = set(j for j in allocs if j > 0)
        completed_by_now = completed_ids_snapshot.get(r, set())
        queued = [
            j['job_id'] for j in jobs
            if (j['job_id'] not in running_jobs
                and j['job_id'] not in completed_by_now
                and j['arrival_round'] <= r)
        ]

        # Use our computed running avg JCT (telemetry avg_jct is 0
        # when measurement window is unreachable)
        avg_jct = avg_jct_by_round.get(r, 0)

        rounds.append({
            'round': r,
            'sim_time': telem.get('sim_time', 0),
            'utilization': telem.get('utilization', 0),
            'jobs_running': telem.get('jobs_running', 0),
            'jobs_queued': telem.get('jobs_queued', len(queued)),
            'jobs_completed': telem.get('jobs_completed_total', 0),
            'avg_jct': avg_jct,
            'completion_rate': telem.get('windowed_completion_rate', 0) or 0,
            'gpu_used': gpu_used,
            'allocations': allocs
        })
        queues.append(queued)

    config = {
        'policy': policy,
        'gpu_types': gpu_types,
        'measurement_window': {
            'start_job': measurement_window[0],
            'end_job': measurement_window[1]
        },
        'job_types': job_types_list
    }
    write_viz_file(output_path, config, jobs, rounds, queues)


if __name__ == '__main__':
    import argparse
    import sys

    parser = argparse.ArgumentParser(
        description='Preprocess simulation logs to .viz.bin files'
    )
    parser.add_argument('log_path', help='Path to simulation.log file')
    parser.add_argument('output_path', help='Path for output .viz.bin file')
    parser.add_argument(
        '--cluster', default='36:36:36',
        help='Cluster spec: "36:36:36" (legacy) or "G2=4392,T4=840,G3=312" (named)'
    )
    parser.add_argument(
        '--policy', default='unknown',
        help='Policy name for display'
    )
    parser.add_argument(
        '--window-start', type=int, default=4000,
        help='Measurement window start job (default: 4000)'
    )
    parser.add_argument(
        '--window-end', type=int, default=5000,
        help='Measurement window end job (default: 5000)'
    )
    parser.add_argument(
        '--gpus-per-node', type=int, default=1,
        help='GPUs per physical node for fragmentation metrics (default: 1)'
    )
    args = parser.parse_args()

    # Auto-detect policy from log first line if not specified
    policy = args.policy
    if policy == 'unknown':
        with open(args.log_path) as f:
            first_line = f.readline()
            m = re.search(r'policy=(\w+)', first_line)
            if m:
                policy = m.group(1)

    print(f"Processing {args.log_path} (policy={policy})...")
    preprocess_simulation(
        args.log_path,
        args.output_path,
        cluster_spec=args.cluster,
        measurement_window=(args.window_start, args.window_end),
        policy=policy,
        gpus_per_node=args.gpus_per_node,
    )
    print(f"Written to {args.output_path}")
