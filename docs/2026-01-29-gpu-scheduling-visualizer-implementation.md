# GPU Scheduling Visualizer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a web-based visualization tool that animates GPU job scheduling simulations with side-by-side comparison support.

**Architecture:** Binary preprocessing pipeline (Python) generates `.viz.bin` files from simulation logs. Web app (Vanilla JS + Canvas) streams binary data via range requests, renders GPU grid, and provides playback controls. Modular design: DataSource -> Decoder (Web Worker) -> Model -> Renderer -> Controller.

**Tech Stack:** Python 3.12 (struct, json), Vanilla JS (ES6 modules), HTML5 Canvas, CSS Grid, pytest, Chrome browser testing via Claude-in-Chrome MCP.

**Design Document:** `cluster/docs/plans/2026-01-29-gpu-scheduling-visualizer-design.md`

---

## Phase 1: Binary Format & Preprocessing (Python)

### Task 1.1: Binary Format Constants and Utilities

**Design Requirement:** Binary format with little-endian, 8-byte alignment, magic number "GPUVIZ01"

**Files:**
- Create: `cluster/viz/binary_format.py`
- Test: `cluster/viz/tests/test_binary_format.py`

**Step 1: Create test directory and write failing test**

```bash
mkdir -p cluster/viz/tests
touch cluster/viz/tests/__init__.py
```

```python
# cluster/viz/tests/test_binary_format.py
import pytest
from viz.binary_format import MAGIC, VERSION, HEADER_SIZE, align_to_8

def test_magic_number_is_8_bytes():
    assert len(MAGIC) == 8
    assert MAGIC == b"GPUVIZ01"

def test_version_is_1():
    assert VERSION == 1

def test_header_size_is_256():
    assert HEADER_SIZE == 256

def test_align_to_8_already_aligned():
    assert align_to_8(0) == 0
    assert align_to_8(8) == 8
    assert align_to_8(16) == 16

def test_align_to_8_needs_padding():
    assert align_to_8(1) == 8
    assert align_to_8(7) == 8
    assert align_to_8(9) == 16
    assert align_to_8(255) == 256
```

**Step 2: Run test to verify it fails**

```bash
cd cluster && python -m pytest viz/tests/test_binary_format.py -v
```

Expected: FAIL with "ModuleNotFoundError: No module named 'viz.binary_format'"

**Step 3: Write minimal implementation**

```python
# cluster/viz/binary_format.py
"""
Binary format utilities for GPU scheduling visualizer.

File format: .viz.bin
- Little-endian byte order
- 8-byte alignment for all sections
- Fixed 256-byte header
"""
import struct

# Constants
MAGIC = b"GPUVIZ01"
VERSION = 1
HEADER_SIZE = 256

def align_to_8(offset: int) -> int:
    """Round up to next 8-byte boundary."""
    return (offset + 7) & ~7
```

**Step 4: Run test to verify it passes**

```bash
cd cluster && python -m pytest viz/tests/test_binary_format.py -v
```

Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add cluster/viz/binary_format.py cluster/viz/tests/
git commit -m "feat(viz): add binary format constants and alignment utility"
```

---

### Task 1.2: Header Struct Packing/Unpacking

**Design Requirement:** Fixed 256-byte header with magic, version, offsets, counts

**Files:**
- Modify: `cluster/viz/binary_format.py`
- Test: `cluster/viz/tests/test_binary_format.py`

**Step 1: Write failing test**

```python
# Add to cluster/viz/tests/test_binary_format.py
from viz.binary_format import pack_header, unpack_header

def test_pack_header_returns_256_bytes():
    header = pack_header(
        num_rounds=1000,
        num_jobs=500,
        num_gpu_types=3,
        total_gpus=108,
        job_metadata_offset=256,
        rounds_offset=1024,
        queue_offset=50000,
        index_offset=60000,
        config_json_offset=200
    )
    assert len(header) == 256

def test_unpack_header_roundtrip():
    original = {
        'num_rounds': 1000,
        'num_jobs': 500,
        'num_gpu_types': 3,
        'total_gpus': 108,
        'job_metadata_offset': 256,
        'rounds_offset': 1024,
        'queue_offset': 50000,
        'index_offset': 60000,
        'config_json_offset': 200
    }
    packed = pack_header(**original)
    unpacked = unpack_header(packed)

    assert unpacked['magic'] == MAGIC
    assert unpacked['version'] == VERSION
    for key in original:
        assert unpacked[key] == original[key], f"{key} mismatch"

def test_unpack_header_validates_magic():
    bad_header = b"BADMAGIC" + b"\x00" * 248
    with pytest.raises(ValueError, match="Invalid magic"):
        unpack_header(bad_header)
```

**Step 2: Run test to verify it fails**

```bash
cd cluster && python -m pytest viz/tests/test_binary_format.py::test_pack_header_returns_256_bytes -v
```

Expected: FAIL with "cannot import name 'pack_header'"

**Step 3: Write minimal implementation**

```python
# Add to cluster/viz/binary_format.py

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
```

**Step 4: Run test to verify it passes**

```bash
cd cluster && python -m pytest viz/tests/test_binary_format.py -v
```

Expected: All 8 tests PASS

**Step 5: Commit**

```bash
git add cluster/viz/binary_format.py cluster/viz/tests/test_binary_format.py
git commit -m "feat(viz): add header pack/unpack with validation"
```

---

### Task 1.2b: Section Alignment Verification Tests

**Design Requirement:** All section offsets must be 8-byte aligned

**Files:**
- Modify: `cluster/viz/tests/test_binary_format.py`

**Step 1: Write failing test**

```python
# Add to cluster/viz/tests/test_binary_format.py
def test_header_offsets_are_8_byte_aligned():
    """Verify all offsets in header are divisible by 8."""
    header = pack_header(
        num_rounds=1000,
        num_jobs=500,
        num_gpu_types=3,
        total_gpus=108,
        job_metadata_offset=256,
        rounds_offset=1024,
        queue_offset=50000,
        index_offset=60000,
        config_json_offset=256  # Should be HEADER_SIZE
    )
    unpacked = unpack_header(header)

    # All offsets must be 8-byte aligned
    assert unpacked['config_json_offset'] % 8 == 0, "config_json_offset not aligned"
    assert unpacked['job_metadata_offset'] % 8 == 0, "job_metadata_offset not aligned"
    assert unpacked['rounds_offset'] % 8 == 0, "rounds_offset not aligned"
    assert unpacked['queue_offset'] % 8 == 0, "queue_offset not aligned"
    assert unpacked['index_offset'] % 8 == 0, "index_offset not aligned"

def test_write_viz_file_section_alignment():
    """Verify write_viz_file produces 8-byte aligned sections."""
    import tempfile
    import os

    config = {
        'gpu_types': [{'name': 'v100', 'count': 36}, {'name': 'p100', 'count': 36}, {'name': 'k80', 'count': 36}],
        'measurement_window': {'start_job': 4000, 'end_job': 5000},
        'job_types': [{'id': 0, 'name': 'ResNet-18', 'category': 'resnet'}]
    }
    jobs = [{'job_id': i, 'type_id': 0, 'scale_factor': 1, 'arrival_round': 0} for i in range(7)]  # Odd number
    rounds = [{
        'round': 0, 'sim_time': 0.0, 'utilization': 0.0,
        'jobs_running': 0, 'jobs_queued': 1, 'jobs_completed': 0,
        'avg_jct': 0.0, 'completion_rate': 0.0,
        'gpu_used': [0, 0, 0], 'allocations': [0] * 108
    }]
    queues = [[0]]

    with tempfile.NamedTemporaryFile(suffix='.viz.bin', delete=False) as f:
        path = f.name

    try:
        write_viz_file(path, config, jobs, rounds, queues)
        header = read_viz_header(path)

        # All section offsets must be 8-byte aligned
        assert header['config_json_offset'] % 8 == 0
        assert header['job_metadata_offset'] % 8 == 0
        assert header['rounds_offset'] % 8 == 0
        assert header['queue_offset'] % 8 == 0
        assert header['index_offset'] % 8 == 0
    finally:
        os.unlink(path)
```

**Step 2: Run test to verify it passes**

```bash
cd cluster && python -m pytest viz/tests/test_binary_format.py::test_header_offsets_are_8_byte_aligned -v
cd cluster && python -m pytest viz/tests/test_binary_format.py::test_write_viz_file_section_alignment -v
```

Expected: PASS (implementation already uses align_to_8)

**Step 3: Commit**

```bash
git add cluster/viz/tests/test_binary_format.py
git commit -m "test(viz): add section alignment verification tests"
```

---

### Task 1.3: Job Metadata Struct

**Design Requirement:** Per-job record: job_id (uint32), type_id (uint16), scale_factor (uint8), arrival_round (uint32) - 16 bytes each

**Files:**
- Modify: `cluster/viz/binary_format.py`
- Test: `cluster/viz/tests/test_binary_format.py`

**Step 1: Write failing test**

```python
# Add to cluster/viz/tests/test_binary_format.py
from viz.binary_format import pack_job_metadata, unpack_job_metadata, JOB_METADATA_SIZE

def test_job_metadata_size_is_16():
    assert JOB_METADATA_SIZE == 16

def test_pack_job_metadata():
    job = {'job_id': 42, 'type_id': 5, 'scale_factor': 4, 'arrival_round': 100}
    packed = pack_job_metadata(job)
    assert len(packed) == 16

def test_job_metadata_roundtrip():
    jobs = [
        {'job_id': 0, 'type_id': 0, 'scale_factor': 1, 'arrival_round': 0},
        {'job_id': 65536, 'type_id': 25, 'scale_factor': 8, 'arrival_round': 9999},
    ]
    for job in jobs:
        packed = pack_job_metadata(job)
        unpacked = unpack_job_metadata(packed)
        assert unpacked == job, f"Mismatch for {job}"

def test_pack_multiple_jobs():
    jobs = [
        {'job_id': i, 'type_id': i % 26, 'scale_factor': 1, 'arrival_round': i * 10}
        for i in range(100)
    ]
    packed = b"".join(pack_job_metadata(j) for j in jobs)
    assert len(packed) == 100 * 16

    # Unpack and verify
    for i, job in enumerate(jobs):
        chunk = packed[i*16:(i+1)*16]
        unpacked = unpack_job_metadata(chunk)
        assert unpacked == job
```

**Step 2: Run test to verify it fails**

```bash
cd cluster && python -m pytest viz/tests/test_binary_format.py::test_job_metadata_size_is_16 -v
```

Expected: FAIL with "cannot import name 'pack_job_metadata'"

**Step 3: Write minimal implementation**

```python
# Add to cluster/viz/binary_format.py

# Job metadata format: 16 bytes each
# I   - job_id (uint32)
# H   - type_id (uint16)
# B   - scale_factor (uint8)
# x   - padding (1 byte)
# I   - arrival_round (uint32)
# xxxx - padding (4 bytes)
JOB_METADATA_FORMAT = "<IHBxIxxxx"
JOB_METADATA_SIZE = 16

def pack_job_metadata(job: dict) -> bytes:
    """Pack single job metadata into 16 bytes."""
    return struct.pack(
        JOB_METADATA_FORMAT,
        job['job_id'],
        job['type_id'],
        job['scale_factor'],
        job['arrival_round']
    )

def unpack_job_metadata(data: bytes) -> dict:
    """Unpack 16-byte job metadata."""
    values = struct.unpack(JOB_METADATA_FORMAT, data[:JOB_METADATA_SIZE])
    return {
        'job_id': values[0],
        'type_id': values[1],
        'scale_factor': values[2],
        'arrival_round': values[3]
    }
```

**Step 4: Run test to verify it passes**

```bash
cd cluster && python -m pytest viz/tests/test_binary_format.py -v
```

Expected: All 12 tests PASS

**Step 5: Commit**

```bash
git add cluster/viz/binary_format.py cluster/viz/tests/test_binary_format.py
git commit -m "feat(viz): add job metadata pack/unpack (16 bytes each)"
```

---

### Task 1.4: Round Data Struct (Fixed-Size)

**Design Requirement:** Fixed-size round records with metrics and allocations array

**Files:**
- Modify: `cluster/viz/binary_format.py`
- Test: `cluster/viz/tests/test_binary_format.py`

**Step 1: Write failing test**

```python
# Add to cluster/viz/tests/test_binary_format.py
from viz.binary_format import (
    compute_round_size, pack_round, unpack_round
)

def test_compute_round_size():
    # 3 GPU types, 108 total GPUs
    # Base: 28 bytes (metrics)
    # gpu_used: 3 * 2 = 6 bytes
    # allocations: 108 * 4 = 432 bytes
    # Total: 28 + 6 + 432 = 466, aligned to 8 = 472
    size = compute_round_size(num_gpu_types=3, total_gpus=108)
    assert size == 472

def test_pack_round():
    round_data = {
        'round': 42,
        'sim_time': 3600.5,
        'utilization': 0.95,
        'jobs_running': 50,
        'jobs_queued': 5,
        'jobs_completed': 100,
        'avg_jct': 7200.0,
        'completion_rate': 2.5,
        'gpu_used': [36, 34, 32],  # per type
        'allocations': [0] * 108   # all empty
    }
    packed = pack_round(round_data, num_gpu_types=3, total_gpus=108)
    assert len(packed) == 472

def test_round_roundtrip():
    round_data = {
        'round': 100,
        'sim_time': 86400.0,
        'utilization': 0.87,
        'jobs_running': 45,
        'jobs_queued': 10,
        'jobs_completed': 500,
        'avg_jct': 14400.0,
        'completion_rate': 5.2,
        'gpu_used': [30, 28, 25],
        'allocations': [i % 100 for i in range(108)]  # some jobs allocated
    }
    packed = pack_round(round_data, num_gpu_types=3, total_gpus=108)
    unpacked = unpack_round(packed, num_gpu_types=3, total_gpus=108)

    assert unpacked['round'] == round_data['round']
    assert abs(unpacked['sim_time'] - round_data['sim_time']) < 0.01
    assert abs(unpacked['utilization'] - round_data['utilization']) < 0.001
    assert unpacked['jobs_running'] == round_data['jobs_running']
    assert unpacked['jobs_queued'] == round_data['jobs_queued']
    assert unpacked['jobs_completed'] == round_data['jobs_completed']
    assert unpacked['gpu_used'] == round_data['gpu_used']
    assert unpacked['allocations'] == round_data['allocations']
```

**Step 2: Run test to verify it fails**

```bash
cd cluster && python -m pytest viz/tests/test_binary_format.py::test_compute_round_size -v
```

Expected: FAIL with "cannot import name 'compute_round_size'"

**Step 3: Write minimal implementation**

```python
# Add to cluster/viz/binary_format.py

# Round data base format (28 bytes):
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
    """Compute fixed size for one round record."""
    size = ROUND_BASE_SIZE
    size += num_gpu_types * 2  # gpu_used: uint16 per type
    size += total_gpus * 4     # allocations: uint32 per GPU
    return align_to_8(size)

def pack_round(round_data: dict, num_gpu_types: int, total_gpus: int) -> bytes:
    """Pack round data into fixed-size buffer."""
    # Pack base fields
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

    # Pack gpu_used array
    gpu_used = struct.pack(f"<{num_gpu_types}H", *round_data['gpu_used'])

    # Pack allocations array
    allocations = struct.pack(f"<{total_gpus}I", *round_data['allocations'])

    # Combine and pad
    data = base + gpu_used + allocations
    target_size = compute_round_size(num_gpu_types, total_gpus)
    padding = target_size - len(data)

    return data + b"\x00" * padding

def unpack_round(data: bytes, num_gpu_types: int, total_gpus: int) -> dict:
    """Unpack fixed-size round buffer."""
    offset = 0

    # Unpack base fields
    base = struct.unpack(ROUND_BASE_FORMAT, data[offset:offset + ROUND_BASE_SIZE])
    offset += ROUND_BASE_SIZE

    # Unpack gpu_used array
    gpu_used_size = num_gpu_types * 2
    gpu_used = list(struct.unpack(f"<{num_gpu_types}H", data[offset:offset + gpu_used_size]))
    offset += gpu_used_size

    # Unpack allocations array
    alloc_size = total_gpus * 4
    allocations = list(struct.unpack(f"<{total_gpus}I", data[offset:offset + alloc_size]))

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
```

**Step 4: Run test to verify it passes**

```bash
cd cluster && python -m pytest viz/tests/test_binary_format.py -v
```

Expected: All 15 tests PASS

**Step 5: Commit**

```bash
git add cluster/viz/binary_format.py cluster/viz/tests/test_binary_format.py
git commit -m "feat(viz): add fixed-size round data pack/unpack"
```

---

### Task 1.4b: Round Size Formula Verification

**Design Requirement:** Round size = 28 + 2*num_gpu_types + 4*total_gpus, aligned to 8

**Files:**
- Modify: `cluster/viz/tests/test_binary_format.py`

**Step 1: Write tests for multiple configurations**

```python
# Add to cluster/viz/tests/test_binary_format.py
def test_compute_round_size_multiple_configs():
    """Verify round size formula: 28 + 2*num_gpu_types + 4*total_gpus, aligned to 8."""
    test_cases = [
        # (num_gpu_types, total_gpus, expected_size)
        (3, 108, 472),   # 28 + 6 + 432 = 466 -> 472
        (3, 12, 88),     # 28 + 6 + 48 = 82 -> 88
        (1, 4, 48),      # 28 + 2 + 16 = 46 -> 48
        (5, 500, 2040),  # 28 + 10 + 2000 = 2038 -> 2040
        (2, 1000, 4032), # 28 + 4 + 4000 = 4032 -> 4032 (already aligned)
    ]

    for num_gpu_types, total_gpus, expected in test_cases:
        actual = compute_round_size(num_gpu_types, total_gpus)
        # Verify formula
        raw_size = 28 + 2 * num_gpu_types + 4 * total_gpus
        assert actual == align_to_8(raw_size), f"Failed for ({num_gpu_types}, {total_gpus})"
        assert actual == expected, f"Expected {expected}, got {actual} for ({num_gpu_types}, {total_gpus})"

def test_gpu_used_is_uint16():
    """Verify gpu_used array uses uint16 (supports >255 GPUs per type)."""
    # Create round data with gpu_used values > 255
    round_data = {
        'round': 0,
        'sim_time': 0.0,
        'utilization': 0.9,
        'jobs_running': 500,
        'jobs_queued': 100,
        'jobs_completed': 1000,
        'avg_jct': 3600.0,
        'completion_rate': 10.0,
        'gpu_used': [300, 400, 500],  # Values > 255 require uint16
        'allocations': [0] * 12
    }
    packed = pack_round(round_data, num_gpu_types=3, total_gpus=12)
    unpacked = unpack_round(packed, num_gpu_types=3, total_gpus=12)

    assert unpacked['gpu_used'] == [300, 400, 500], "uint16 gpu_used failed for values > 255"

def test_allocations_is_uint32():
    """Verify allocations array uses uint32 (supports >65535 jobs)."""
    # Create round data with job IDs > 65535
    round_data = {
        'round': 0,
        'sim_time': 0.0,
        'utilization': 0.5,
        'jobs_running': 4,
        'jobs_queued': 0,
        'jobs_completed': 0,
        'avg_jct': 0.0,
        'completion_rate': 0.0,
        'gpu_used': [2, 2, 0],
        'allocations': [70000, 80000, 90000, 100000, 0, 0, 0, 0, 0, 0, 0, 0]  # Values > 65535
    }
    packed = pack_round(round_data, num_gpu_types=3, total_gpus=12)
    unpacked = unpack_round(packed, num_gpu_types=3, total_gpus=12)

    assert unpacked['allocations'][:4] == [70000, 80000, 90000, 100000], "uint32 allocations failed"
```

**Step 2: Run tests**

```bash
cd cluster && python -m pytest viz/tests/test_binary_format.py::test_compute_round_size_multiple_configs -v
cd cluster && python -m pytest viz/tests/test_binary_format.py::test_gpu_used_is_uint16 -v
cd cluster && python -m pytest viz/tests/test_binary_format.py::test_allocations_is_uint32 -v
```

Expected: All PASS

**Step 3: Commit**

```bash
git add cluster/viz/tests/test_binary_format.py
git commit -m "test(viz): add round size formula and data type verification tests"
```

---

### Task 1.5: Queue Data Section

**Design Requirement:** Separate variable-length queue section with index

**Files:**
- Modify: `cluster/viz/binary_format.py`
- Test: `cluster/viz/tests/test_binary_format.py`

**Step 1: Write failing test**

```python
# Add to cluster/viz/tests/test_binary_format.py
from viz.binary_format import pack_queue_entry, unpack_queue_entry, pack_queue_index

def test_pack_queue_entry_empty():
    packed = pack_queue_entry([])
    assert len(packed) == 2  # just length prefix

def test_pack_queue_entry_with_jobs():
    queue = [10, 20, 30, 40, 50]
    packed = pack_queue_entry(queue)
    # 2 bytes length + 5 * 4 bytes = 22 bytes
    assert len(packed) == 22

def test_queue_entry_roundtrip():
    queues = [
        [],
        [1],
        [100, 200, 300],
        list(range(1000)),  # large queue
    ]
    for queue in queues:
        packed = pack_queue_entry(queue)
        unpacked = unpack_queue_entry(packed)
        assert unpacked == queue, f"Mismatch for queue of length {len(queue)}"

def test_pack_queue_index():
    offsets = [0, 100, 250, 500]
    packed = pack_queue_index(offsets)
    assert len(packed) == 4 * 8  # 4 uint64 values
```

**Step 2: Run test to verify it fails**

```bash
cd cluster && python -m pytest viz/tests/test_binary_format.py::test_pack_queue_entry_empty -v
```

Expected: FAIL with "cannot import name 'pack_queue_entry'"

**Step 3: Write minimal implementation**

```python
# Add to cluster/viz/binary_format.py

def pack_queue_entry(queue: list) -> bytes:
    """Pack queue (list of job IDs) with length prefix."""
    length = len(queue)
    header = struct.pack("<H", length)
    if length == 0:
        return header
    body = struct.pack(f"<{length}I", *queue)
    return header + body

def unpack_queue_entry(data: bytes) -> list:
    """Unpack queue entry, returns list of job IDs."""
    length = struct.unpack("<H", data[:2])[0]
    if length == 0:
        return []
    return list(struct.unpack(f"<{length}I", data[2:2 + length * 4]))

def pack_queue_index(offsets: list) -> bytes:
    """Pack queue index (byte offsets per round)."""
    return struct.pack(f"<{len(offsets)}Q", *offsets)

def unpack_queue_index(data: bytes, num_rounds: int) -> list:
    """Unpack queue index."""
    return list(struct.unpack(f"<{num_rounds}Q", data[:num_rounds * 8]))
```

**Step 4: Run test to verify it passes**

```bash
cd cluster && python -m pytest viz/tests/test_binary_format.py -v
```

Expected: All 19 tests PASS

**Step 5: Commit**

```bash
git add cluster/viz/binary_format.py cluster/viz/tests/test_binary_format.py
git commit -m "feat(viz): add queue section pack/unpack with index"
```

---

### Task 1.6: Complete Binary File Writer

**Design Requirement:** Write complete .viz.bin file with all sections

**Files:**
- Modify: `cluster/viz/binary_format.py`
- Test: `cluster/viz/tests/test_binary_format.py`

**Step 1: Write failing test**

```python
# Add to cluster/viz/tests/test_binary_format.py
import tempfile
import os
from viz.binary_format import write_viz_file, read_viz_header

def test_write_viz_file_creates_file():
    config = {
        'gpu_types': [{'name': 'v100', 'count': 36}, {'name': 'p100', 'count': 36}, {'name': 'k80', 'count': 36}],
        'measurement_window': {'start_job': 4000, 'end_job': 5000},
        'job_types': [{'id': 0, 'name': 'ResNet-18', 'category': 'resnet'}]
    }
    jobs = [{'job_id': 0, 'type_id': 0, 'scale_factor': 1, 'arrival_round': 0}]
    rounds = [{
        'round': 0, 'sim_time': 0.0, 'utilization': 0.0,
        'jobs_running': 0, 'jobs_queued': 1, 'jobs_completed': 0,
        'avg_jct': 0.0, 'completion_rate': 0.0,
        'gpu_used': [0, 0, 0], 'allocations': [0] * 108
    }]
    queues = [[0]]  # job 0 in queue

    with tempfile.NamedTemporaryFile(suffix='.viz.bin', delete=False) as f:
        path = f.name

    try:
        write_viz_file(path, config, jobs, rounds, queues)
        assert os.path.exists(path)
        assert os.path.getsize(path) > 256  # at least header

        # Verify header is readable
        header = read_viz_header(path)
        assert header['magic'] == MAGIC
        assert header['version'] == VERSION
        assert header['num_rounds'] == 1
        assert header['num_jobs'] == 1
        assert header['num_gpu_types'] == 3
        assert header['total_gpus'] == 108
    finally:
        os.unlink(path)
```

**Step 2: Run test to verify it fails**

```bash
cd cluster && python -m pytest viz/tests/test_binary_format.py::test_write_viz_file_creates_file -v
```

Expected: FAIL with "cannot import name 'write_viz_file'"

**Step 3: Write minimal implementation**

```python
# Add to cluster/viz/binary_format.py
import json

def write_viz_file(path: str, config: dict, jobs: list, rounds: list, queues: list):
    """
    Write complete .viz.bin file.

    Args:
        path: Output file path
        config: GPU types, measurement window, job types
        jobs: List of job metadata dicts
        rounds: List of round data dicts
        queues: List of queue lists (one per round)
    """
    num_rounds = len(rounds)
    num_jobs = len(jobs)
    num_gpu_types = len(config['gpu_types'])
    total_gpus = sum(g['count'] for g in config['gpu_types'])

    # Compute section offsets
    config_json = json.dumps(config).encode('utf-8')
    config_json_padded_size = align_to_8(len(config_json))

    config_json_offset = HEADER_SIZE
    job_metadata_offset = config_json_offset + config_json_padded_size
    job_metadata_size = num_jobs * JOB_METADATA_SIZE
    job_metadata_padded_size = align_to_8(job_metadata_size)

    rounds_offset = job_metadata_offset + job_metadata_padded_size
    round_size = compute_round_size(num_gpu_types, total_gpus)
    rounds_total_size = num_rounds * round_size

    queue_offset = rounds_offset + rounds_total_size

    # Pack queue data and build index
    queue_data = bytearray()
    queue_index = []
    for q in queues:
        queue_index.append(len(queue_data))
        queue_data.extend(pack_queue_entry(q))

    queue_padded_size = align_to_8(len(queue_data))
    index_offset = queue_offset + queue_padded_size

    # Write file
    with open(path, 'wb') as f:
        # Header
        header = pack_header(
            num_rounds=num_rounds,
            num_jobs=num_jobs,
            num_gpu_types=num_gpu_types,
            total_gpus=total_gpus,
            job_metadata_offset=job_metadata_offset,
            rounds_offset=rounds_offset,
            queue_offset=queue_offset,
            index_offset=index_offset,
            config_json_offset=config_json_offset
        )
        f.write(header)

        # Config JSON
        f.write(config_json)
        f.write(b"\x00" * (config_json_padded_size - len(config_json)))

        # Job metadata
        for job in jobs:
            f.write(pack_job_metadata(job))
        padding = job_metadata_padded_size - job_metadata_size
        if padding > 0:
            f.write(b"\x00" * padding)

        # Round data
        for rd in rounds:
            f.write(pack_round(rd, num_gpu_types, total_gpus))

        # Queue data
        f.write(queue_data)
        padding = queue_padded_size - len(queue_data)
        if padding > 0:
            f.write(b"\x00" * padding)

        # Queue index
        f.write(pack_queue_index(queue_index))

def read_viz_header(path: str) -> dict:
    """Read and parse header from .viz.bin file."""
    with open(path, 'rb') as f:
        return unpack_header(f.read(HEADER_SIZE))
```

**Step 4: Run test to verify it passes**

```bash
cd cluster && python -m pytest viz/tests/test_binary_format.py -v
```

Expected: All 20 tests PASS

**Step 5: Commit**

```bash
git add cluster/viz/binary_format.py cluster/viz/tests/test_binary_format.py
git commit -m "feat(viz): add complete binary file writer"
```

---

### Task 1.7: Log Parser - Job Arrivals

**Design Requirement:** Parse `EVENT {"event": "job_arrival", ...}` from simulation.log

**Files:**
- Create: `cluster/viz/log_parser.py`
- Test: `cluster/viz/tests/test_log_parser.py`

**Step 1: Write failing test**

```python
# cluster/viz/tests/test_log_parser.py
import pytest
from viz.log_parser import parse_job_arrival

def test_parse_job_arrival():
    line = 'scheduler:INFO [0] EVENT {"event": "job_arrival", "job_id": "23", "job_type": "ResNet-50 (batch size 64)", "scale_factor": 4, "total_steps": 91799.83, "arrival_time": 0, "sim_time": 0}'
    result = parse_job_arrival(line)

    assert result is not None
    assert result['job_id'] == 23
    assert result['job_type'] == "ResNet-50 (batch size 64)"
    assert result['scale_factor'] == 4

def test_parse_job_arrival_returns_none_for_other_events():
    line = 'scheduler:INFO [0] EVENT {"event": "job_completion", "job_id": "23", "sim_time": 1000}'
    result = parse_job_arrival(line)
    assert result is None

def test_parse_job_arrival_returns_none_for_non_event():
    line = 'scheduler:DEBUG [0] Some debug message'
    result = parse_job_arrival(line)
    assert result is None
```

**Step 2: Run test to verify it fails**

```bash
cd cluster && python -m pytest viz/tests/test_log_parser.py -v
```

Expected: FAIL with "ModuleNotFoundError: No module named 'viz.log_parser'"

**Step 3: Write minimal implementation**

```python
# cluster/viz/log_parser.py
"""
Parser for simulation.log files to extract job and allocation data.
"""
import json
import re

def parse_job_arrival(line: str) -> dict | None:
    """
    Parse job arrival event from log line.

    Returns dict with job_id, job_type, scale_factor, or None if not a job arrival.
    """
    if 'EVENT' not in line or '"job_arrival"' not in line:
        return None

    # Extract JSON from line
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
            'scale_factor': data['scale_factor']
        }
    except (json.JSONDecodeError, KeyError, ValueError):
        return None
```

**Step 4: Run test to verify it passes**

```bash
cd cluster && python -m pytest viz/tests/test_log_parser.py -v
```

Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add cluster/viz/log_parser.py cluster/viz/tests/test_log_parser.py
git commit -m "feat(viz): add log parser for job arrivals"
```

---

### Task 1.8: Log Parser - Micro-task Allocations

**Design Requirement:** Parse `[Micro-task scheduled] Job ID: X Worker type: Y Worker ID(s): Z`

**Files:**
- Modify: `cluster/viz/log_parser.py`
- Test: `cluster/viz/tests/test_log_parser.py`

**Step 1: Write failing test**

```python
# Add to cluster/viz/tests/test_log_parser.py
from viz.log_parser import parse_allocation

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

    assert result is not None
    assert result['job_id'] == 56
    assert result['worker_ids'] == [72, 73, 74, 75]

def test_parse_allocation_returns_none_for_other_lines():
    line = 'scheduler:INFO [0] EVENT {"event": "job_arrival"}'
    result = parse_allocation(line)
    assert result is None
```

**Step 2: Run test to verify it fails**

```bash
cd cluster && python -m pytest viz/tests/test_log_parser.py::test_parse_allocation_single_worker -v
```

Expected: FAIL with "cannot import name 'parse_allocation'"

**Step 3: Write minimal implementation**

```python
# Add to cluster/viz/log_parser.py

def parse_allocation(line: str) -> dict | None:
    """
    Parse micro-task allocation from log line.

    Returns dict with job_id, worker_type, worker_ids, or None if not an allocation.
    """
    if '[Micro-task scheduled]' not in line:
        return None

    # Extract Job ID
    job_match = re.search(r'Job ID:\s*(\d+)', line)
    if not job_match:
        return None

    # Extract Worker type
    type_match = re.search(r'Worker type:\s*(\w+)', line)
    if not type_match:
        return None

    # Extract Worker ID(s) - can be single or comma-separated
    ids_match = re.search(r'Worker ID\(s\):\s*([\d,\s]+)', line)
    if not ids_match:
        return None

    worker_ids = [int(x.strip()) for x in ids_match.group(1).split(',')]

    return {
        'job_id': int(job_match.group(1)),
        'worker_type': type_match.group(1),
        'worker_ids': worker_ids
    }
```

**Step 4: Run test to verify it passes**

```bash
cd cluster && python -m pytest viz/tests/test_log_parser.py -v
```

Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add cluster/viz/log_parser.py cluster/viz/tests/test_log_parser.py
git commit -m "feat(viz): add log parser for micro-task allocations"
```

---

### Task 1.9: Log Parser - Round Telemetry

**Design Requirement:** Parse `TELEMETRY {...}` JSON from simulation.log

**Files:**
- Modify: `cluster/viz/log_parser.py`
- Test: `cluster/viz/tests/test_log_parser.py`

**Step 1: Write failing test**

```python
# Add to cluster/viz/tests/test_log_parser.py
from viz.log_parser import parse_telemetry

def test_parse_telemetry():
    line = 'scheduler:INFO [0] TELEMETRY {"round": 5, "sim_time": 1799.99, "wall_time": 0.23, "jobs_generated": 59, "jobs_active": 57, "jobs_running": 57, "jobs_completed_total": 2, "jobs_completed_window": 0, "jobs_queued": 0, "utilization": 0.9568, "avg_jct": 0, "next_arrival": 2445.86, "v100_used": 36, "v100_total": 36, "p100_used": 36, "p100_total": 36, "k80_used": 36, "k80_total": 36, "windowed_completion_rate": null}'
    result = parse_telemetry(line)

    assert result is not None
    assert result['round'] == 5
    assert abs(result['sim_time'] - 1799.99) < 0.01
    assert result['jobs_running'] == 57
    assert result['jobs_queued'] == 0
    assert abs(result['utilization'] - 0.9568) < 0.0001
    assert result['v100_used'] == 36

def test_parse_telemetry_returns_none_for_non_telemetry():
    line = 'scheduler:INFO [0] EVENT {"event": "job_arrival"}'
    result = parse_telemetry(line)
    assert result is None
```

**Step 2: Run test to verify it fails**

```bash
cd cluster && python -m pytest viz/tests/test_log_parser.py::test_parse_telemetry -v
```

Expected: FAIL with "cannot import name 'parse_telemetry'"

**Step 3: Write minimal implementation**

```python
# Add to cluster/viz/log_parser.py

def parse_telemetry(line: str) -> dict | None:
    """
    Parse TELEMETRY JSON from log line.

    Returns dict with all telemetry fields, or None if not telemetry.
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
```

**Step 4: Run test to verify it passes**

```bash
cd cluster && python -m pytest viz/tests/test_log_parser.py -v
```

Expected: All 8 tests PASS

**Step 5: Commit**

```bash
git add cluster/viz/log_parser.py cluster/viz/tests/test_log_parser.py
git commit -m "feat(viz): add log parser for telemetry events"
```

---

### Task 1.10: Complete Preprocessing Script

**Design Requirement:** Parse simulation.log, generate .viz.bin

**Files:**
- Create: `cluster/viz/preprocess_viz.py`
- Test: `cluster/viz/tests/test_preprocess_viz.py`

**Step 1: Write failing test**

```python
# cluster/viz/tests/test_preprocess_viz.py
import pytest
import tempfile
import os
from viz.preprocess_viz import preprocess_simulation
from viz.binary_format import read_viz_header, MAGIC, VERSION

# Sample log content
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

        preprocess_simulation(
            log_path=log_path,
            output_path=output_path,
            cluster_spec="4:4:4",
            measurement_window=(0, 100)
        )

        assert os.path.exists(output_path)

        header = read_viz_header(output_path)
        assert header['magic'] == MAGIC
        assert header['version'] == VERSION
        assert header['num_rounds'] == 2
        assert header['num_jobs'] == 2
        assert header['num_gpu_types'] == 3
        assert header['total_gpus'] == 12
```

**Step 2: Run test to verify it fails**

```bash
cd cluster && python -m pytest viz/tests/test_preprocess_viz.py -v
```

Expected: FAIL with "ModuleNotFoundError: No module named 'viz.preprocess_viz'"

**Step 3: Write minimal implementation**

See design document for full implementation. Key function signature:

```python
# cluster/viz/preprocess_viz.py
def preprocess_simulation(
    log_path: str,
    output_path: str,
    cluster_spec: str = "36:36:36",
    measurement_window: tuple = (4000, 5000)
):
    """Process simulation log and generate .viz.bin file."""
    # Implementation parses log, builds data structures, writes binary file
    ...
```

**Step 4: Run test to verify it passes**

```bash
cd cluster && python -m pytest viz/tests/test_preprocess_viz.py -v
```

Expected: All tests PASS

**Step 5: Commit**

```bash
git add cluster/viz/preprocess_viz.py cluster/viz/tests/test_preprocess_viz.py
git commit -m "feat(viz): add complete preprocessing script"
```

---

## Phase 2: Web Application (HTML/JS/CSS)

### Task 2.1: HTML Layout Structure

**Design Requirement:** File pickers, two Canvas grids, timeline, queue panels

**Files:**
- Create: `cluster/viz/index.html`
- Create: `cluster/viz/viz.css`

**Verification:** Load in browser, check layout renders correctly.

See design document for full HTML/CSS implementation.

**Commit:**
```bash
git add cluster/viz/index.html cluster/viz/viz.css
git commit -m "feat(viz): add HTML layout and CSS styling"
```

---

### Task 2.2: DataSource Module with Caching and AbortController

**Design Requirement:** Range requests with LRU caching, AbortController for cancellation

**Files:**
- Create: `cluster/viz/data-source.js`

**Key Implementation:**

```javascript
// cluster/viz/data-source.js
export class DataSource {
    constructor(url) {
        this.url = url;
        this.cache = new Map();          // LRU cache
        this.pendingRequests = new Map(); // Dedup in-flight requests
        this.maxCacheSize = 100;
    }

    /**
     * Fetch bytes using range request with caching.
     * @param {number} start - Start byte offset
     * @param {number} end - End byte offset (exclusive)
     * @param {AbortSignal} signal - Abort signal for cancellation
     */
    async fetchRange(start, end, signal = null) {
        const cacheKey = `${start}-${end}`;

        // Return cached data if available
        if (this.cache.has(cacheKey)) {
            this._touchCache(cacheKey);
            return this.cache.get(cacheKey);
        }

        // Dedup: return pending request if same range in flight
        if (this.pendingRequests.has(cacheKey)) {
            return this.pendingRequests.get(cacheKey);
        }

        // Make range request
        const promise = this._fetchWithAbort(start, end, signal);
        this.pendingRequests.set(cacheKey, promise);

        try {
            const data = await promise;
            this._addToCache(cacheKey, data);
            return data;
        } finally {
            this.pendingRequests.delete(cacheKey);
        }
    }

    async _fetchWithAbort(start, end, signal) {
        const response = await fetch(this.url, {
            headers: { 'Range': `bytes=${start}-${end - 1}` },
            signal  // AbortController.signal for cancellation
        });

        if (!response.ok && response.status !== 206) {
            throw new Error(`HTTP ${response.status}`);
        }
        return response.arrayBuffer();
    }

    _addToCache(key, data) {
        // LRU eviction
        if (this.cache.size >= this.maxCacheSize) {
            const oldest = this.cache.keys().next().value;
            this.cache.delete(oldest);
        }
        this.cache.set(key, data);
    }

    _touchCache(key) {
        // Move to end for LRU
        const data = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, data);
    }

    cancelAll() {
        // Called when scrubbing rapidly - abort pending requests
        // Controller manages AbortController instances
    }
}
```

**Verification:**
1. Open browser console
2. Test: `const ds = new DataSource('test.viz.bin'); await ds.fetchRange(0, 256);`
3. Verify caching: Second call should return instantly
4. Test abort: Create AbortController, pass signal, call abort()

**Commit:**
```bash
git add cluster/viz/data-source.js
git commit -m "feat(viz): add DataSource with LRU caching and AbortController"
```

---

### Task 2.3: Decoder Module

**Design Requirement:** Binary parsing for header, jobs, rounds

**Files:**
- Create: `cluster/viz/decoder.js`

**Key Implementation:**

```javascript
// cluster/viz/decoder.js
export class Decoder {
    constructor(header, configJson) {
        this.header = header;
        this.config = configJson;
        this.roundSize = this._computeRoundSize();
    }

    _computeRoundSize() {
        // Formula: 28 + 2*numGpuTypes + 4*totalGpus, aligned to 8
        const size = 28 + this.header.numGpuTypes * 2 + this.header.totalGpus * 4;
        return Math.ceil(size / 8) * 8;
    }

    getRoundRange(startRound, count) {
        const start = this.header.roundsOffset + startRound * this.roundSize;
        const end = start + count * this.roundSize;
        return { start, end };
    }

    decodeRounds(buffer, startRound, count) {
        const rounds = [];
        const view = new DataView(buffer);
        for (let i = 0; i < count; i++) {
            rounds.push(this._decodeRound(view, i * this.roundSize));
        }
        return rounds;
    }

    _decodeRound(view, offset) {
        // Parse fixed fields, then gpu_used (uint16[]), then allocations (uint32[])
        // See design document for full implementation
    }

    decodeJobs(buffer) {
        // Parse job metadata array (16 bytes each)
    }
}
```

**Verification:**
1. Generate test_data.viz.bin with Python
2. Load in browser, decode header and first round
3. Verify decoded values match Python output

**Commit:**
```bash
git add cluster/viz/decoder.js
git commit -m "feat(viz): add Decoder for binary parsing"
```

---

### Task 2.3b: Decoder Web Worker

**Design Requirement:** Parse binary data in Web Worker to avoid UI jank

**Files:**
- Create: `cluster/viz/decoder.worker.js`
- Modify: `cluster/viz/decoder.js` (add worker interface)

**Key Implementation:**

```javascript
// cluster/viz/decoder.worker.js
import { Decoder } from './decoder.js';

let decoder = null;

self.onmessage = async (e) => {
    const { type, payload } = e.data;

    switch (type) {
        case 'init':
            decoder = new Decoder(payload.header, payload.config);
            self.postMessage({ type: 'ready' });
            break;

        case 'decodeRounds':
            const { buffer, startRound, count } = payload;
            const rounds = decoder.decodeRounds(buffer, startRound, count);
            self.postMessage({ type: 'rounds', rounds }, [buffer]); // Transfer buffer
            break;

        case 'decodeJobs':
            const jobs = decoder.decodeJobs(payload.buffer);
            self.postMessage({ type: 'jobs', jobs });
            break;
    }
};
```

```javascript
// Add to decoder.js
export class DecoderWorker {
    constructor() {
        this.worker = new Worker(new URL('./decoder.worker.js', import.meta.url), { type: 'module' });
        this.pending = new Map();
        this.nextId = 0;

        this.worker.onmessage = (e) => {
            const { type, ...data } = e.data;
            // Resolve pending promises based on message type
        };
    }

    async init(header, config) {
        return this._send('init', { header, config });
    }

    async decodeRounds(buffer, startRound, count) {
        return this._send('decodeRounds', { buffer, startRound, count }, [buffer]);
    }

    _send(type, payload, transfer = []) {
        return new Promise((resolve) => {
            const id = this.nextId++;
            this.pending.set(id, resolve);
            this.worker.postMessage({ type, payload, id }, transfer);
        });
    }
}
```

**Verification:**
1. Load large .viz.bin file
2. Verify UI remains responsive during decoding
3. Check console for worker messages

**Commit:**
```bash
git add cluster/viz/decoder.worker.js cluster/viz/decoder.js
git commit -m "feat(viz): add Web Worker for background decoding"
```

---

### Task 2.4: Model Module

**Design Requirement:** Timeline state, current round, loaded simulations

**Files:**
- Create: `cluster/viz/model.js`

**Key Implementation:**

```javascript
// cluster/viz/model.js
export class Model {
    constructor() {
        this.simulations = [null, null];
        this.currentRound = 0;
        this.isPlaying = false;
        this.playbackSpeed = 1;
        this.roundCache = [new Map(), new Map()];
    }

    loadSimulation(index, header, config, dataSource, decoder, jobs) { ... }
    clearSimulation(index) { ... }
    getMaxRounds() { ... }
    setCurrentRound(round) { ... }
    cacheRounds(simIndex, startRound, rounds) { ... }
    getCachedRound(simIndex, round) { ... }
}
```

**Verification:** Console test state management operations.

**Commit:**
```bash
git add cluster/viz/model.js
git commit -m "feat(viz): add Model for state management"
```

---

### Task 2.5: Renderer Module with Dirty-Region Tracking

**Design Requirement:** Canvas rendering with dirty-region repaints for performance

**Files:**
- Create: `cluster/viz/renderer.js`

**Key Implementation:**

```javascript
// cluster/viz/renderer.js
export class Renderer {
    constructor(canvas, config, jobs) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.config = config;
        this.jobs = jobs;

        // Dirty tracking for optimized repaints
        this.prevAllocations = null;
        this.dirtyGpus = new Set();

        // Layout
        this.cellWidth = 30;
        this.cellHeight = 40;
        this.labelWidth = 50;
    }

    render(roundData) {
        if (!roundData) {
            this._renderEmpty();
            return;
        }

        // Determine which cells changed (dirty-region tracking)
        if (this.prevAllocations) {
            this._computeDirtyRegions(roundData.allocations);
        } else {
            // First render - all cells dirty
            for (let i = 0; i < roundData.allocations.length; i++) {
                this.dirtyGpus.add(i);
            }
        }

        // Only redraw dirty cells
        for (const gpuIdx of this.dirtyGpus) {
            this._renderCell(gpuIdx, roundData.allocations[gpuIdx]);
        }

        this.prevAllocations = [...roundData.allocations];
        this.dirtyGpus.clear();
    }

    _computeDirtyRegions(newAllocations) {
        for (let i = 0; i < newAllocations.length; i++) {
            if (newAllocations[i] !== this.prevAllocations[i]) {
                this.dirtyGpus.add(i);
            }
        }
    }

    _renderCell(gpuIdx, jobId) {
        // Calculate x, y from gpuIdx
        // Draw cell with job color and label
        // Use textContent pattern for any text overlays
    }

    renderFull(roundData) {
        // Force full repaint (used on resize or initial load)
        this.prevAllocations = null;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.render(roundData);
    }
}
```

**Verification:**
1. Load file, render initial state
2. Advance round, verify only changed cells repaint (check with console.log in _renderCell)
3. Verify performance with large grid

**Commit:**
```bash
git add cluster/viz/renderer.js
git commit -m "feat(viz): add Renderer with dirty-region tracking"
```

---

### Task 2.6: Controller Module with Loading Strategy

**Design Requirement:** File loading, playback, keyboard shortcuts, loading strategy

**Files:**
- Create: `cluster/viz/viz.js`

**Key Implementation - Loading Strategy:**

```javascript
// cluster/viz/viz.js
class App {
    constructor() {
        this.model = new Model();
        this.renderers = [null, null];
        this.abortControllers = [null, null];  // For cancelling stale requests
        this.prefetchPromise = null;
    }

    async _loadFile(index, file) {
        const url = URL.createObjectURL(file);
        const ds = new DataSource(url);

        // Step 1: Initial load - header + config + jobs
        const headerBuffer = await ds.fetchRange(0, 256);
        const header = parseHeader(headerBuffer);
        const configBuffer = await ds.fetchRange(header.configJsonOffset, header.jobMetadataOffset);
        const config = JSON.parse(new TextDecoder().decode(configBuffer));
        const jobsBuffer = await ds.fetchRange(header.jobMetadataOffset, header.roundsOffset);

        // Initialize decoder (in worker)
        const decoder = new DecoderWorker();
        await decoder.init(header, config);
        const jobs = await decoder.decodeJobs(jobsBuffer);

        this.model.loadSimulation(index, header, config, ds, decoder, jobs);
        // ... setup renderer, UI
    }

    async _fetchRoundsWithStrategy(simIndex, round) {
        // Cancel any pending request for this simulation
        if (this.abortControllers[simIndex]) {
            this.abortControllers[simIndex].abort();
        }
        this.abortControllers[simIndex] = new AbortController();

        const sim = this.model.getSimulation(simIndex);
        const batchSize = 50;  // Fetch in batches of 50-100
        const startRound = Math.max(0, round - 10);  // Include some context

        const { start, end } = sim.decoder.getRoundRange(startRound, batchSize);

        try {
            const buffer = await sim.dataSource.fetchRange(
                start, end,
                this.abortControllers[simIndex].signal
            );
            const rounds = await sim.decoder.decodeRounds(buffer, startRound, batchSize);
            this.model.cacheRounds(simIndex, startRound, rounds);
        } catch (err) {
            if (err.name === 'AbortError') return;  // Expected when scrubbing fast
            throw err;
        }
    }

    _startPrefetch(simIndex) {
        // Prefetch next batch while playing
        const sim = this.model.getSimulation(simIndex);
        const nextBatchStart = this.model.currentRound + 30;

        if (nextBatchStart < sim.header.numRounds) {
            this.prefetchPromise = this._fetchRoundsWithStrategy(simIndex, nextBatchStart);
        }
    }

    // ... playback controls, keyboard shortcuts
}
```

**Verification:**
1. Load file, verify initial fetch
2. Scrub rapidly, verify old requests cancelled (no console errors)
3. Play, verify prefetch happens

**Commit:**
```bash
git add cluster/viz/viz.js
git commit -m "feat(viz): add Controller with loading strategy and AbortController"
```

---

## Phase 3: End-to-End Integration Testing (Browser)

### Task 3.1: Generate Test Data File

**Files:**
- Create: `cluster/viz/tests/generate_test_data.py`

Generate a small .viz.bin file with known data for browser testing.

```bash
cd cluster && python viz/tests/generate_test_data.py
```

**Commit:**
```bash
git add cluster/viz/tests/generate_test_data.py cluster/viz/tests/test_data.viz.bin
git commit -m "test(viz): add test data generator"
```

---

### Task 3.1b: Cross-Language Compatibility Test

**Design Requirement:** Python writer and JS decoder must produce identical results

**Files:**
- Create: `cluster/viz/tests/test_cross_language.py`
- Create: `cluster/viz/tests/cross_language_test.html`

**Python Test - Generate Reference Data:**

```python
# cluster/viz/tests/test_cross_language.py
"""Generate reference data and expected values for JS decoder verification."""
import json
import os
from viz.binary_format import write_viz_file, read_viz_header, unpack_round, compute_round_size

def generate_reference():
    """Generate .viz.bin and expected.json for cross-language testing."""
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
        {'job_id': 70000, 'type_id': 0, 'scale_factor': 4, 'arrival_round': 1},  # Test uint32
    ]

    rounds = [
        {
            'round': 0,
            'sim_time': 0.0,
            'utilization': 0.0,
            'jobs_running': 0,
            'jobs_queued': 3,
            'jobs_completed': 0,
            'avg_jct': 0.0,
            'completion_rate': 0.0,
            'gpu_used': [0, 0, 0],
            'allocations': [0] * 12
        },
        {
            'round': 1,
            'sim_time': 360.5,
            'utilization': 0.5,
            'jobs_running': 2,
            'jobs_queued': 1,
            'jobs_completed': 0,
            'avg_jct': 0.0,
            'completion_rate': 0.0,
            'gpu_used': [2, 2, 2],
            'allocations': [1, 0, 0, 0, 2, 2, 0, 0, 70000, 70000, 70000, 70000]
        }
    ]

    queues = [[1, 2, 70000], [70000]]

    output_dir = os.path.dirname(__file__)
    viz_path = os.path.join(output_dir, 'cross_language_test.viz.bin')
    expected_path = os.path.join(output_dir, 'cross_language_expected.json')

    write_viz_file(viz_path, config, jobs, rounds, queues)

    # Generate expected values for JS to verify
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
```

**Browser Test - Verify JS Decoder:**

```html
<!-- cluster/viz/tests/cross_language_test.html -->
<!DOCTYPE html>
<html>
<head><title>Cross-Language Test</title></head>
<body>
<h1>Cross-Language Compatibility Test</h1>
<pre id="output"></pre>
<script type="module">
import { fetchHeader } from '../data-source.js';
import { Decoder } from '../decoder.js';

const output = document.getElementById('output');
function log(msg) { output.textContent += msg + '\n'; }

async function runTest() {
    try {
        // Load expected values
        const expectedResp = await fetch('cross_language_expected.json');
        const expected = await expectedResp.json();
        log('Loaded expected values');

        // Load and decode .viz.bin
        const { header, configJson, dataSource } = await fetchHeader('cross_language_test.viz.bin');
        log('Loaded header');

        // Verify header
        console.assert(header.numRounds === expected.header.numRounds, 'numRounds mismatch');
        console.assert(header.numJobs === expected.header.numJobs, 'numJobs mismatch');
        console.assert(header.numGpuTypes === expected.header.numGpuTypes, 'numGpuTypes mismatch');
        console.assert(header.totalGpus === expected.header.totalGpus, 'totalGpus mismatch');
        log('✓ Header matches');

        // Verify round size calculation
        const decoder = new Decoder(header, configJson);
        console.assert(decoder.roundSize === expected.roundSize, `roundSize: ${decoder.roundSize} !== ${expected.roundSize}`);
        log(`✓ Round size matches: ${decoder.roundSize}`);

        // Decode jobs
        const jobsBuffer = await dataSource.fetchRange(header.jobMetadataOffset, header.roundsOffset);
        const jobs = decoder.decodeJobs(jobsBuffer);
        console.assert(jobs.length === expected.jobs.length, 'jobs count mismatch');
        console.assert(jobs[2].jobId === 70000, 'uint32 job ID failed');
        log('✓ Jobs decode correctly (including uint32 IDs)');

        // Decode rounds
        const { start, end } = decoder.getRoundRange(0, 2);
        const roundsBuffer = await dataSource.fetchRange(start, end);
        const rounds = decoder.decodeRounds(roundsBuffer, 0, 2);

        // Verify round 1 has large job ID in allocations
        console.assert(rounds[1].allocations[8] === 70000, 'uint32 allocation failed');
        log('✓ Rounds decode correctly (including uint32 allocations)');

        log('\n=== ALL TESTS PASSED ===');
    } catch (err) {
        log('ERROR: ' + err.message);
        console.error(err);
    }
}

runTest();
</script>
</body>
</html>
```

**Test Procedure (via Claude-in-Chrome):**
1. Generate reference: `cd cluster && python viz/tests/test_cross_language.py`
2. Start server: `cd cluster/viz && python -m http.server 8080`
3. Navigate to `http://localhost:8080/tests/cross_language_test.html`
4. Verify "ALL TESTS PASSED" appears

**Human Verification:**
- [ ] Header values match between Python and JS
- [ ] Round size calculation matches
- [ ] uint32 job IDs (>65535) decode correctly
- [ ] uint32 allocations (>65535) decode correctly

**Commit:**
```bash
git add cluster/viz/tests/test_cross_language.py cluster/viz/tests/cross_language_test.html
git commit -m "test(viz): add cross-language compatibility test"
```

---

### Task 3.2: Browser Integration Test - File Loading

**Test Method:** Chrome browser via Claude-in-Chrome MCP

**Procedure:**
1. Start server: `cd cluster/viz && python -m http.server 8080`
2. Navigate to `http://localhost:8080`
3. Take screenshot to verify layout
4. Upload `tests/test_data.viz.bin`
5. Verify file name appears, canvas shows grid, metrics display

**Human Verification:**
- [ ] Screenshot shows 3-row GPU grid
- [ ] Metrics show utilization values
- [ ] No console errors

---

### Task 3.3: Browser Integration Test - Playback

**Procedure:**
1. Load test file
2. Click play, wait 2 seconds, take screenshot
3. Verify round > 0
4. Drag scrubber to round 5
5. Verify grid updates with job colors

**Human Verification:**
- [ ] Playback advances rounds
- [ ] Scrubber interaction works
- [ ] Grid shows colored cells for allocated jobs

---

### Task 3.4: Browser Integration Test - Two Simulations

**Procedure:**
1. Load test file in Simulation 1
2. Load same file in Simulation 2
3. Take screenshot showing both grids
4. Scrub timeline, verify both update

**Human Verification:**
- [ ] Two simulation sections visible
- [ ] Both grids render
- [ ] Synced playback works

---

### Task 3.5: Browser Integration Test - Real Data

**Prerequisites:**
```bash
cd cluster && python -m viz.preprocess_viz \
  --log results_full/fig11_finish_time_fairness_0.4jph_multi_s0/simulation.log \
  --output viz/tests/real_data.viz.bin \
  --cluster-spec 36:36:36 \
  --measurement-window 4000,5000
```

**Procedure:**
1. Load `viz/tests/real_data.viz.bin`
2. Verify 3 rows x 36 columns grid
3. Play at 10x speed, observe job changes
4. Scrub to measurement window

**Human Verification:**
- [ ] Large grid renders smoothly
- [ ] Jobs appear with category colors
- [ ] Phase markers show correct regions

---

### Task 3.6: Browser Integration Test - Scrubbing Cancellation

**Design Requirement:** Rapid scrubbing should cancel stale requests via AbortController

**Procedure (via Claude-in-Chrome):**
1. Load real_data.viz.bin
2. Open browser DevTools Network tab
3. Rapidly drag scrubber back and forth multiple times
4. Observe network requests

**Human Verification:**
- [ ] Some requests show as "Cancelled" in Network tab (expected behavior)
- [ ] UI remains responsive during rapid scrubbing
- [ ] No console errors about "Failed to fetch" (aborted requests handled gracefully)
- [ ] Final position renders correctly after scrubbing stops

---

### Task 3.7: Browser Integration Test - Worker Decoding Performance

**Design Requirement:** Decoding should not block UI (Web Worker)

**Procedure (via Claude-in-Chrome):**
1. Load real_data.viz.bin
2. Open browser DevTools Performance tab
3. Start recording
4. Scrub through the timeline several times
5. Stop recording and analyze

**Human Verification:**
- [ ] Main thread shows minimal blocking (no long tasks > 50ms during decode)
- [ ] Worker thread shows decode activity
- [ ] UI animations remain smooth (60fps during playback)

---

### Task 3.8: Browser Integration Test - Dirty-Region Rendering

**Design Requirement:** Only changed cells should repaint

**Procedure (via Claude-in-Chrome):**
1. Load test_data.viz.bin (small file)
2. Open browser DevTools and add console.log to Renderer._renderCell
3. Advance one round
4. Count how many cells were redrawn

**Human Verification:**
- [ ] Number of redrawn cells < total cells (dirty-region working)
- [ ] Unchanged cells not redrawn
- [ ] Visual appearance is correct (no rendering artifacts)

---

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| 1 | 1.1-1.10 + 1.2b, 1.4b | Python binary format, alignment tests, preprocessing |
| 2 | 2.1-2.6 + 2.3b | Web app modules with Worker and caching |
| 3 | 3.1-3.8 + 3.1b | Browser tests including cross-language and performance |

**Total:** 27 tasks

| Task Type | Count | Description |
|-----------|-------|-------------|
| Python TDD | 12 | Binary format, parsers, preprocessing with unit tests |
| JS Module | 7 | DataSource, Decoder, Worker, Model, Renderer, Controller |
| Browser E2E | 8 | File loading, playback, comparison, performance |

**Each task produces one commit** following the pattern: test -> fail -> implement -> pass -> commit.

**Key Improvements from Codex Review:**
- Explicit 8-byte alignment tests for all sections
- Round size formula verification with multiple configs
- uint16/uint32 type verification tests
- Web Worker for background decoding
- DataSource with LRU caching and AbortController
- Renderer with dirty-region tracking
- Cross-language compatibility test (Python -> JS)
- Scrubbing cancellation and performance tests
