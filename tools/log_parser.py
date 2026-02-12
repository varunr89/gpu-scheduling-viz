# cluster/viz/log_parser.py
"""Parser for simulation.log files to extract job and allocation data."""
import json
import re
from typing import List, Optional


def parse_job_arrival(line: str) -> Optional[dict]:
    """Parse a job arrival event from a log line.

    Args:
        line: A log line that may contain a job_arrival event

    Returns:
        Dict with job_id, job_type, scale_factor if this is a job_arrival event,
        None otherwise
    """
    if 'EVENT' not in line or '"job_arrival"' not in line:
        return None
    match = re.search(r'EVENT\s+(\{.*\})', line)
    if not match:
        return None
    try:
        data = json.loads(match.group(1))
        if data.get('event') != 'job_arrival':
            return None
        return {
            'job_id': int(data['job_id']),
            'job_type': data['job_type'],
            'scale_factor': data['scale_factor'],
            'gpu_request': float(data.get('gpu_request', 1.0))
        }
    except (json.JSONDecodeError, KeyError, ValueError):
        return None


def parse_allocation(line: str) -> Optional[dict]:
    """Parse a micro-task allocation from a log line.

    Args:
        line: A log line that may contain a micro-task scheduled event

    Returns:
        Dict with job_id, worker_type, worker_ids if this is an allocation,
        None otherwise
    """
    if '[Micro-task scheduled]' not in line:
        return None
    job_match = re.search(r'Job ID:\s*(\d+)', line)
    type_match = re.search(r'Worker type:\s*(\w+)', line)
    ids_match = re.search(r'Worker ID\(s\):\s*([\d,\s]+)', line)
    if not all([job_match, type_match, ids_match]):
        return None
    return {
        'job_id': int(job_match.group(1)),
        'worker_type': type_match.group(1),
        'worker_ids': [int(x.strip()) for x in ids_match.group(1).split(',')]
    }


def parse_allocation_bulk(line: str) -> Optional[List[dict]]:
    """Parse a compact ALLOCATION line emitted once per scheduling round.

    Format: ALLOCATION {"job_id":[worker_id,...],...}
    Returns a list of allocation dicts (same shape as parse_allocation output),
    or None if the line is not an ALLOCATION line.
    """
    if 'ALLOCATION' not in line:
        return None
    match = re.search(r'ALLOCATION\s+(\{.*\})', line)
    if not match:
        return None
    try:
        data = json.loads(match.group(1))
    except json.JSONDecodeError:
        return None
    results = []
    for job_id_str, worker_ids in data.items():
        results.append({
            'job_id': int(job_id_str),
            'worker_ids': worker_ids,
        })
    return results


def parse_job_completion(line: str) -> Optional[dict]:
    """Parse a job completion event from a log line.

    Args:
        line: A log line that may contain a job_complete event

    Returns:
        Dict with job_id, duration if this is a job_complete event,
        None otherwise
    """
    if 'EVENT' not in line or '"job_complete"' not in line:
        return None
    match = re.search(r'EVENT\s+(\{.*\})', line)
    if not match:
        return None
    try:
        data = json.loads(match.group(1))
        if data.get('event') != 'job_complete':
            return None
        return {
            'job_id': int(data['job_id']),
            'duration': float(data['duration'])
        }
    except (json.JSONDecodeError, KeyError, ValueError):
        return None


def parse_telemetry(line: str) -> Optional[dict]:
    """Parse a telemetry event from a log line.

    Args:
        line: A log line that may contain a TELEMETRY event

    Returns:
        Dict with all telemetry fields if this is a telemetry line,
        None otherwise
    """
    if 'TELEMETRY' not in line:
        return None
    match = re.search(r'TELEMETRY\s+(\{.*\})', line)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return None
