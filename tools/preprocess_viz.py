# tools/preprocess_viz.py
"""Preprocess simulation logs to generate .viz.bin files."""
import re
from typing import Dict, List, Tuple
from viz.tools.log_parser import (
    parse_job_arrival, parse_allocation, parse_allocation_bulk,
    parse_job_completion, parse_telemetry
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
    """Map a job type string to its category."""
    for key, category in JOB_TYPE_CATEGORIES.items():
        if key in job_type:
            return category
    return 'other'


def _fill_quarter_slots(slots, job_id, num_quarters):
    """Fill quarter-slots for a job, starting from first empty slot."""
    filled = 0
    for s in range(4):
        if filled >= num_quarters:
            break
        if slots[s] == 0:
            slots[s] = job_id
            filled += 1


def _process_allocation(worker_id, job_id, total_gpus, gpu_req,
                        current_allocations, current_gpu_slots):
    """Process a single worker allocation for both primary and quarter-slot tracking."""
    if not (0 <= worker_id < total_gpus):
        return
    num_quarters = max(1, round(gpu_req / 0.25))
    # Primary allocation: first job to claim this GPU
    if current_allocations[worker_id] == 0:
        current_allocations[worker_id] = job_id
    # Quarter-slot tracking
    if num_quarters < 4:
        if worker_id not in current_gpu_slots:
            current_gpu_slots[worker_id] = [0, 0, 0, 0]
        _fill_quarter_slots(current_gpu_slots[worker_id], job_id, num_quarters)
    else:
        if worker_id in current_gpu_slots:
            current_gpu_slots[worker_id] = [job_id, job_id, job_id, job_id]


def _parse_jobs_and_telemetry(log_path, total_gpus, job_gpu_request,
                              jobs, job_index, job_type_map, job_types_list):
    """Parse job arrivals, completions, and telemetry from a log file.

    Skips allocation lines entirely. Returns telemetry_data, newly_completed_by_round,
    avg_jct_by_round, has_sharing.
    """
    telemetry_data = []
    newly_completed_by_round: Dict[int, set] = {}
    pending_completed_ids: set = set()
    avg_jct_by_round: Dict[int, float] = {}
    jct_running_sum = 0.0
    jct_running_count = 0
    has_sharing = False
    current_round = -1

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
                gpu_req = arrival.get('gpu_request', 1.0)
                job_gpu_request[arrival['job_id']] = gpu_req
                if gpu_req < 1.0:
                    has_sharing = True
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
                jct_running_sum += completion['duration']
                jct_running_count += 1
                pending_completed_ids.add(completion['job_id'])
                if completion['job_id'] in job_index:
                    job_index[completion['job_id']]['completion_round'] = max(0, current_round)
                    job_index[completion['job_id']]['duration'] = completion['duration']
                continue

            telem = parse_telemetry(line)
            if telem:
                new_round = telem['round']
                if pending_completed_ids:
                    newly_completed_by_round[new_round] = set(pending_completed_ids)
                    pending_completed_ids = set()
                if jct_running_count > 0:
                    avg_jct_by_round[new_round] = jct_running_sum / jct_running_count
                current_round = new_round
                telemetry_data.append(telem)

    return telemetry_data, newly_completed_by_round, avg_jct_by_round, has_sharing


def _parse_allocations_for_rounds(log_path, total_gpus, job_gpu_request,
                                  sampled_rounds, has_sharing):
    """Second-pass: parse only allocation data for sampled rounds.

    Returns allocations_by_round, gpu_slots_by_round.
    """
    allocations_by_round: Dict[int, List[int]] = {}
    gpu_slots_by_round: Dict[int, Dict[int, List[int]]] = {}
    current_allocations = [0] * total_gpus
    current_gpu_slots: Dict[int, List[int]] = {}
    current_round = -1
    keep_current = sampled_rounds is None

    with open(log_path) as f:
        for line in f:
            if keep_current:
                bulk_allocs = parse_allocation_bulk(line)
                if bulk_allocs is not None:
                    for alloc_entry in bulk_allocs:
                        job_id = alloc_entry['job_id']
                        gpu_req = job_gpu_request.get(job_id, 1.0)
                        for worker_id in alloc_entry['worker_ids']:
                            _process_allocation(
                                worker_id, job_id, total_gpus, gpu_req,
                                current_allocations, current_gpu_slots
                            )
                    continue

                alloc = parse_allocation(line)
                if alloc:
                    job_id = alloc['job_id']
                    gpu_req = job_gpu_request.get(job_id, 1.0)
                    for worker_id in alloc['worker_ids']:
                        _process_allocation(
                            worker_id, job_id, total_gpus, gpu_req,
                            current_allocations, current_gpu_slots
                        )
                    continue

            telem = parse_telemetry(line)
            if telem:
                new_round = telem['round']
                if keep_current:
                    if new_round > 0:
                        allocations_by_round[new_round] = list(current_allocations)
                        if has_sharing and current_gpu_slots:
                            gpu_slots_by_round[new_round] = {
                                idx: list(slots)
                                for idx, slots in current_gpu_slots.items()
                            }
                    else:
                        allocations_by_round[0] = [0] * total_gpus
                # Reset for next round
                current_allocations = [0] * total_gpus
                current_gpu_slots = {}
                current_round = new_round
                keep_current = sampled_rounds is None or new_round in sampled_rounds

    return allocations_by_round, gpu_slots_by_round


def preprocess_simulation(
    log_path: str,
    output_path: str,
    cluster_spec: str = "36:36:36",
    measurement_window: Tuple[int, int] = (4000, 5000),
    policy: str = "unknown",
    gpus_per_node: int = 1,
    max_rounds: int = 0
) -> None:
    """Process a simulation log file and generate a .viz.bin file.

    Args:
        log_path: Path to the simulation.log file
        output_path: Path for the output .viz.bin file
        cluster_spec: Cluster specification as "k80:p100:v100" counts
        measurement_window: Tuple of (start_job, end_job) for measurement window
        policy: Name of the scheduling policy
        gpus_per_node: Number of GPUs per physical node (for fragmentation metrics)
        max_rounds: If > 0, downsample to at most this many rounds (0 = no limit)
    """
    gpu_types = parse_cluster_spec(cluster_spec)
    for gt in gpu_types:
        gt['gpus_per_node'] = gpus_per_node
    total_gpus = sum(g['count'] for g in gpu_types)

    jobs: List[Dict] = []
    job_index: Dict[int, Dict] = {}
    job_type_map: Dict[str, int] = {}
    job_types_list: List[Dict] = []
    job_gpu_request: Dict[int, float] = {}

    if max_rounds > 0:
        # Two-pass approach: first collect metadata, then selectively parse allocations
        telemetry_data, newly_completed_by_round, avg_jct_by_round, has_sharing = \
            _parse_jobs_and_telemetry(
                log_path, total_gpus, job_gpu_request,
                jobs, job_index, job_type_map, job_types_list
            )

        # Determine which rounds to sample
        sampled_rounds = None
        if len(telemetry_data) > max_rounds:
            step = len(telemetry_data) / max_rounds
            sampled_indices = set(int(i * step) for i in range(max_rounds))
            sampled_indices.add(0)
            sampled_indices.add(len(telemetry_data) - 1)
            sampled_telem = [t for i, t in enumerate(telemetry_data) if i in sampled_indices]
            sampled_rounds = set(t['round'] for t in sampled_telem)
            # Merge completions from skipped rounds into the next sampled round
            all_rounds_sorted = [t['round'] for t in telemetry_data]
            sampled_sorted = sorted(sampled_rounds)
            merged_completions: Dict[int, set] = {}
            pending_merge: set = set()
            si = 0
            for r in all_rounds_sorted:
                ids = newly_completed_by_round.get(r)
                if ids:
                    pending_merge |= ids
                if si < len(sampled_sorted) and r == sampled_sorted[si]:
                    if pending_merge:
                        merged_completions[r] = pending_merge
                        pending_merge = set()
                    si += 1
            newly_completed_by_round = merged_completions
            telemetry_data = sampled_telem

        # Second pass: parse allocations only for sampled rounds
        allocations_by_round, gpu_slots_by_round = _parse_allocations_for_rounds(
            log_path, total_gpus, job_gpu_request, sampled_rounds, has_sharing
        )
    else:
        # Single-pass approach: parse everything at once
        allocations_by_round: Dict[int, List[int]] = {}
        gpu_slots_by_round: Dict[int, Dict[int, List[int]]] = {}
        telemetry_data: List[Dict] = []
        newly_completed_by_round: Dict[int, set] = {}
        pending_completed_ids: set = set()
        avg_jct_by_round: Dict[int, float] = {}
        jct_running_sum: float = 0.0
        jct_running_count: int = 0
        has_sharing = False
        current_round = -1
        current_allocations = [0] * total_gpus
        current_gpu_slots: Dict[int, List[int]] = {}

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
                    gpu_req = arrival.get('gpu_request', 1.0)
                    job_gpu_request[arrival['job_id']] = gpu_req
                    if gpu_req < 1.0:
                        has_sharing = True
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
                    jct_running_sum += completion['duration']
                    jct_running_count += 1
                    pending_completed_ids.add(completion['job_id'])
                    if completion['job_id'] in job_index:
                        job_index[completion['job_id']]['completion_round'] = max(0, current_round)
                        job_index[completion['job_id']]['duration'] = completion['duration']
                    continue

                bulk_allocs = parse_allocation_bulk(line)
                if bulk_allocs is not None:
                    for alloc_entry in bulk_allocs:
                        job_id = alloc_entry['job_id']
                        gpu_req = job_gpu_request.get(job_id, 1.0)
                        for worker_id in alloc_entry['worker_ids']:
                            _process_allocation(
                                worker_id, job_id, total_gpus, gpu_req,
                                current_allocations, current_gpu_slots
                            )
                    continue

                alloc = parse_allocation(line)
                if alloc:
                    job_id = alloc['job_id']
                    gpu_req = job_gpu_request.get(job_id, 1.0)
                    for worker_id in alloc['worker_ids']:
                        _process_allocation(
                            worker_id, job_id, total_gpus, gpu_req,
                            current_allocations, current_gpu_slots
                        )
                    continue

                telem = parse_telemetry(line)
                if telem:
                    new_round = telem['round']
                    if new_round > 0:
                        allocations_by_round[new_round] = list(current_allocations)
                        if has_sharing and current_gpu_slots:
                            gpu_slots_by_round[new_round] = {
                                idx: list(slots)
                                for idx, slots in current_gpu_slots.items()
                            }
                    else:
                        allocations_by_round[0] = [0] * total_gpus
                    if pending_completed_ids:
                        newly_completed_by_round[new_round] = set(pending_completed_ids)
                        pending_completed_ids = set()
                    if jct_running_count > 0:
                        avg_jct_by_round[new_round] = jct_running_sum / jct_running_count
                    # Reset for next round
                    current_allocations = [0] * total_gpus
                    current_gpu_slots = {}
                    current_round = new_round
                    telemetry_data.append(telem)

    # Build output rounds
    rounds: List[Dict] = []
    queues: List[List[int]] = []
    sharing: List[List] = []

    # Build sorted job arrival index for efficient queue computation
    jobs_by_arrival = sorted(jobs, key=lambda j: j['arrival_round'])
    arrival_cursor = 0
    active_job_ids = set()

    for telem in telemetry_data:
        r = telem['round']
        gpu_used = []
        for gt in gpu_types:
            key = f"{gt['name']}_used"
            gpu_used.append(telem.get(key, 0))

        allocs = allocations_by_round.get(r, [0] * total_gpus)
        running_jobs = set(j for j in allocs if j > 0)

        # Incrementally add newly arrived jobs
        while arrival_cursor < len(jobs_by_arrival) and jobs_by_arrival[arrival_cursor]['arrival_round'] <= r:
            active_job_ids.add(jobs_by_arrival[arrival_cursor]['job_id'])
            arrival_cursor += 1

        # Remove only newly completed jobs (incremental)
        newly_completed = newly_completed_by_round.get(r, None)
        if newly_completed:
            active_job_ids -= newly_completed

        # Queued = active (arrived, not completed) minus running
        queued = [jid for jid in active_job_ids if jid not in running_jobs]

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

        # Build sharing entries: only for GPUs with mixed occupancy
        round_sharing = []
        slot_data = gpu_slots_by_round.get(r, {})
        for gpu_idx, slots in sorted(slot_data.items()):
            unique = set(slots)
            if len(unique) > 1:
                round_sharing.append((gpu_idx, slots))
        sharing.append(round_sharing)

    config = {
        'policy': policy,
        'gpu_types': gpu_types,
        'measurement_window': {
            'start_job': measurement_window[0],
            'end_job': measurement_window[1]
        },
        'job_types': job_types_list
    }

    has_any_sharing = any(len(entries) > 0 for entries in sharing)
    write_viz_file(
        output_path, config, jobs, rounds, queues,
        sharing=sharing if has_any_sharing else None
    )


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
    parser.add_argument(
        '--max-rounds', type=int, default=0,
        help='Max rounds to keep (0 = no limit). Downsamples evenly if exceeded.'
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
        max_rounds=args.max_rounds,
    )
    print(f"Written to {args.output_path}")
