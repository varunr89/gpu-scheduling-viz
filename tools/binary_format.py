"""
Binary format utilities for GPU scheduling visualizer.

File format: .viz.bin
- Little-endian byte order
- 8-byte alignment for all sections
- Fixed 256-byte header
"""
import json
import struct

# Constants
MAGIC = b"GPUVIZ01"
VERSION = 1
HEADER_SIZE = 256


def align_to_8(offset: int) -> int:
    """Round up to next 8-byte boundary."""
    return (offset + 7) & ~7


# Header format: little-endian
# 8s  - magic
# I   - version (uint32)
# I   - num_rounds (uint32)
# I   - num_jobs (uint32)
# B   - num_gpu_types (uint8)
# H   - total_gpus (uint16)
# x   - padding (1 byte)
# Q   - job_metadata_offset (uint64)
# Q   - rounds_offset (uint64)
# Q   - queue_offset (uint64)
# Q   - index_offset (uint64)
# Q   - config_json_offset (uint64)
# Total: 8 + 4 + 4 + 4 + 1 + 2 + 1 + 8*5 = 64 bytes, padded to 256

HEADER_FORMAT = "<8sIIIBHxQQQQQ"
HEADER_PACKED_SIZE = struct.calcsize(HEADER_FORMAT)  # 64 bytes


def pack_header(
    num_rounds: int,
    num_jobs: int,
    num_gpu_types: int,
    total_gpus: int,
    job_metadata_offset: int,
    rounds_offset: int,
    queue_offset: int,
    index_offset: int,
    config_json_offset: int
) -> bytes:
    """Pack header into 256-byte buffer."""
    packed = struct.pack(
        HEADER_FORMAT,
        MAGIC,
        VERSION,
        num_rounds,
        num_jobs,
        num_gpu_types,
        total_gpus,
        job_metadata_offset,
        rounds_offset,
        queue_offset,
        index_offset,
        config_json_offset
    )
    # Pad to 256 bytes
    return packed + b"\x00" * (HEADER_SIZE - len(packed))


def unpack_header(data: bytes) -> dict:
    """Unpack 256-byte header buffer."""
    if len(data) < HEADER_SIZE:
        raise ValueError(f"Header too short: {len(data)} < {HEADER_SIZE}")

    values = struct.unpack(HEADER_FORMAT, data[:HEADER_PACKED_SIZE])
    magic = values[0]

    if magic != MAGIC:
        raise ValueError(f"Invalid magic: {magic!r}, expected {MAGIC!r}")

    return {
        'magic': magic,
        'version': values[1],
        'num_rounds': values[2],
        'num_jobs': values[3],
        'num_gpu_types': values[4],
        'total_gpus': values[5],
        'job_metadata_offset': values[6],
        'rounds_offset': values[7],
        'queue_offset': values[8],
        'index_offset': values[9],
        'config_json_offset': values[10]
    }


# Job metadata format: 24 bytes each
# I   - job_id (uint32)
# H   - type_id (uint16)
# B   - scale_factor (uint8)
# x   - padding (1 byte)
# I   - arrival_round (uint32)
# I   - completion_round (uint32, 0 if not completed)
# f   - duration (float32, JCT in seconds, 0 if not completed)
# xxxx - padding (4 bytes)
JOB_METADATA_FORMAT = "<IHBxIIfxxxx"
JOB_METADATA_SIZE = 24


def pack_job_metadata(job: dict) -> bytes:
    """Pack job metadata into 24-byte buffer."""
    return struct.pack(
        JOB_METADATA_FORMAT,
        job['job_id'],
        job['type_id'],
        job['scale_factor'],
        job['arrival_round'],
        job.get('completion_round', 0),
        job.get('duration', 0.0)
    )


def unpack_job_metadata(data: bytes) -> dict:
    """Unpack 24-byte job metadata buffer."""
    values = struct.unpack(JOB_METADATA_FORMAT, data[:JOB_METADATA_SIZE])
    return {
        'job_id': values[0],
        'type_id': values[1],
        'scale_factor': values[2],
        'arrival_round': values[3],
        'completion_round': values[4],
        'duration': values[5]
    }


# Round data base format (28 bytes)
# I   - round (uint32)
# f   - sim_time (float32)
# f   - utilization (float32)
# H   - jobs_running (uint16)
# H   - jobs_queued (uint16)
# I   - jobs_completed (uint32)
# f   - avg_jct (float32)
# f   - completion_rate (float32)
ROUND_BASE_FORMAT = "<IffHHIff"
ROUND_BASE_SIZE = struct.calcsize(ROUND_BASE_FORMAT)  # 28 bytes


def compute_round_size(num_gpu_types: int, total_gpus: int) -> int:
    """Compute size of round data record.

    Formula: 28 + 2*num_gpu_types + 4*total_gpus, aligned to 8
    """
    size = ROUND_BASE_SIZE + num_gpu_types * 2 + total_gpus * 4
    return align_to_8(size)


def pack_round(round_data: dict, num_gpu_types: int, total_gpus: int) -> bytes:
    """Pack round data into fixed-size buffer."""
    base = struct.pack(
        ROUND_BASE_FORMAT,
        round_data['round'],
        round_data['sim_time'],
        round_data['utilization'],
        round_data['jobs_running'],
        round_data['jobs_queued'],
        round_data['jobs_completed'],
        round_data['avg_jct'],
        round_data['completion_rate']
    )
    gpu_used = struct.pack(f"<{num_gpu_types}H", *round_data['gpu_used'])
    allocations = struct.pack(f"<{total_gpus}I", *round_data['allocations'])
    data = base + gpu_used + allocations
    target_size = compute_round_size(num_gpu_types, total_gpus)
    return data + b"\x00" * (target_size - len(data))


def unpack_round(data: bytes, num_gpu_types: int, total_gpus: int) -> dict:
    """Unpack fixed-size round data buffer."""
    offset = 0
    base = struct.unpack(ROUND_BASE_FORMAT, data[offset:offset + ROUND_BASE_SIZE])
    offset += ROUND_BASE_SIZE
    gpu_used = list(struct.unpack(f"<{num_gpu_types}H", data[offset:offset + num_gpu_types * 2]))
    offset += num_gpu_types * 2
    allocations = list(struct.unpack(f"<{total_gpus}I", data[offset:offset + total_gpus * 4]))
    return {
        'round': base[0],
        'sim_time': base[1],
        'utilization': base[2],
        'jobs_running': base[3],
        'jobs_queued': base[4],
        'jobs_completed': base[5],
        'avg_jct': base[6],
        'completion_rate': base[7],
        'gpu_used': gpu_used,
        'allocations': allocations
    }


# Queue data section
# Each queue entry: H (uint16 length) + I*length (uint32 job IDs)
# Queue index: Q*num_rounds (uint64 offsets)

def pack_queue_entry(queue: list) -> bytes:
    """Pack a queue (list of job IDs) into variable-length buffer."""
    length = len(queue)
    header = struct.pack("<H", length)
    if length == 0:
        return header
    return header + struct.pack(f"<{length}I", *queue)


def unpack_queue_entry(data: bytes) -> list:
    """Unpack a queue entry from variable-length buffer."""
    length = struct.unpack("<H", data[:2])[0]
    if length == 0:
        return []
    return list(struct.unpack(f"<{length}I", data[2:2 + length * 4]))


def pack_queue_index(offsets: list) -> bytes:
    """Pack queue index (list of offsets) into buffer."""
    return struct.pack(f"<{len(offsets)}Q", *offsets)


def unpack_queue_index(data: bytes, num_rounds: int) -> list:
    """Unpack queue index from buffer."""
    return list(struct.unpack(f"<{num_rounds}Q", data[:num_rounds * 8]))


# Complete binary file writer

def write_viz_file(path: str, config: dict, jobs: list, rounds: list, queues: list):
    """Write complete visualization binary file."""
    num_rounds = len(rounds)
    num_jobs = len(jobs)
    num_gpu_types = len(config['gpu_types'])
    total_gpus = sum(g['count'] for g in config['gpu_types'])

    # Config JSON section
    config_json = json.dumps(config).encode('utf-8')
    config_json_padded_size = align_to_8(len(config_json))
    config_json_offset = HEADER_SIZE

    # Job metadata section
    job_metadata_offset = config_json_offset + config_json_padded_size
    job_metadata_size = num_jobs * JOB_METADATA_SIZE
    job_metadata_padded_size = align_to_8(job_metadata_size)

    # Rounds section
    rounds_offset = job_metadata_offset + job_metadata_padded_size
    round_size = compute_round_size(num_gpu_types, total_gpus)
    rounds_total_size = num_rounds * round_size

    # Queue section
    queue_offset = rounds_offset + rounds_total_size
    queue_data = bytearray()
    queue_index = []
    for q in queues:
        queue_index.append(len(queue_data))
        queue_data.extend(pack_queue_entry(q))
    queue_padded_size = align_to_8(len(queue_data))
    index_offset = queue_offset + queue_padded_size

    with open(path, 'wb') as f:
        # Write header
        f.write(pack_header(
            num_rounds=num_rounds,
            num_jobs=num_jobs,
            num_gpu_types=num_gpu_types,
            total_gpus=total_gpus,
            job_metadata_offset=job_metadata_offset,
            rounds_offset=rounds_offset,
            queue_offset=queue_offset,
            index_offset=index_offset,
            config_json_offset=config_json_offset
        ))

        # Write config JSON
        f.write(config_json + b"\x00" * (config_json_padded_size - len(config_json)))

        # Write job metadata
        for job in jobs:
            f.write(pack_job_metadata(job))
        if job_metadata_padded_size > job_metadata_size:
            f.write(b"\x00" * (job_metadata_padded_size - job_metadata_size))

        # Write rounds
        for rd in rounds:
            f.write(pack_round(rd, num_gpu_types, total_gpus))

        # Write queue data
        f.write(queue_data + b"\x00" * (queue_padded_size - len(queue_data)))

        # Write queue index
        f.write(pack_queue_index(queue_index))


def read_viz_header(path: str) -> dict:
    """Read and unpack header from visualization binary file."""
    with open(path, 'rb') as f:
        return unpack_header(f.read(HEADER_SIZE))
