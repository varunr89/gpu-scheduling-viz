# tests/test_binary_format.py
import pytest
from viz.tools.binary_format import MAGIC, VERSION, HEADER_SIZE, align_to_8, pack_header, unpack_header

def test_magic_number_is_8_bytes():
    assert len(MAGIC) == 8
    assert MAGIC == b"GPUVIZ01"

def test_version_is_2():
    assert VERSION == 2

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


# Task 1.2b: Section alignment verification tests
def test_header_offsets_are_8_byte_aligned():
    header = pack_header(
        num_rounds=1000, num_jobs=500, num_gpu_types=3, total_gpus=108,
        job_metadata_offset=256, rounds_offset=1024, queue_offset=50000,
        index_offset=60000, config_json_offset=256
    )
    unpacked = unpack_header(header)
    assert unpacked['config_json_offset'] % 8 == 0
    assert unpacked['job_metadata_offset'] % 8 == 0
    assert unpacked['rounds_offset'] % 8 == 0
    assert unpacked['queue_offset'] % 8 == 0
    assert unpacked['index_offset'] % 8 == 0


# Task 1.3: Job metadata tests
from viz.tools.binary_format import pack_job_metadata, unpack_job_metadata, JOB_METADATA_SIZE

def test_job_metadata_size_is_24():
    assert JOB_METADATA_SIZE == 24

def test_pack_job_metadata():
    job = {'job_id': 42, 'type_id': 5, 'scale_factor': 4, 'arrival_round': 100}
    packed = pack_job_metadata(job)
    assert len(packed) == 24

def test_job_metadata_roundtrip():
    jobs = [
        {'job_id': 0, 'type_id': 0, 'scale_factor': 1, 'arrival_round': 0,
         'completion_round': 0, 'duration': 0.0},
        {'job_id': 65536, 'type_id': 25, 'scale_factor': 8, 'arrival_round': 9999,
         'completion_round': 500, 'duration': 3600.5},
    ]
    for job in jobs:
        packed = pack_job_metadata(job)
        unpacked = unpack_job_metadata(packed)
        assert unpacked['job_id'] == job['job_id']
        assert unpacked['type_id'] == job['type_id']
        assert unpacked['scale_factor'] == job['scale_factor']
        assert unpacked['arrival_round'] == job['arrival_round']
        assert unpacked['completion_round'] == job['completion_round']
        assert abs(unpacked['duration'] - job['duration']) < 0.01


# Task 1.4: Round data tests
from viz.tools.binary_format import compute_round_size, pack_round, unpack_round

def test_compute_round_size():
    size = compute_round_size(num_gpu_types=3, total_gpus=108)
    assert size == 472  # 28 + 6 + 432 = 466 -> aligned to 472

def test_pack_round():
    round_data = {
        'round': 42, 'sim_time': 3600.5, 'utilization': 0.95,
        'jobs_running': 50, 'jobs_queued': 5, 'jobs_completed': 100,
        'avg_jct': 7200.0, 'completion_rate': 2.5,
        'gpu_used': [36, 34, 32], 'allocations': [0] * 108
    }
    packed = pack_round(round_data, num_gpu_types=3, total_gpus=108)
    assert len(packed) == 472

def test_round_roundtrip():
    round_data = {
        'round': 100, 'sim_time': 86400.0, 'utilization': 0.87,
        'jobs_running': 45, 'jobs_queued': 10, 'jobs_completed': 500,
        'avg_jct': 14400.0, 'completion_rate': 5.2,
        'gpu_used': [30, 28, 25], 'allocations': [i % 100 for i in range(108)]
    }
    packed = pack_round(round_data, num_gpu_types=3, total_gpus=108)
    unpacked = unpack_round(packed, num_gpu_types=3, total_gpus=108)

    assert unpacked['round'] == round_data['round']
    assert abs(unpacked['sim_time'] - round_data['sim_time']) < 0.01
    assert unpacked['gpu_used'] == round_data['gpu_used']
    assert unpacked['allocations'] == round_data['allocations']


# Task 1.4b: Round size formula verification with multiple configs and data types
def test_compute_round_size_multiple_configs():
    test_cases = [
        (3, 108, 472),   # 28 + 6 + 432 = 466 -> 472
        (3, 12, 88),     # 28 + 6 + 48 = 82 -> 88
        (1, 4, 48),      # 28 + 2 + 16 = 46 -> 48
        (5, 500, 2040),  # 28 + 10 + 2000 = 2038 -> 2040
    ]
    for num_gpu_types, total_gpus, expected in test_cases:
        actual = compute_round_size(num_gpu_types, total_gpus)
        raw_size = 28 + 2 * num_gpu_types + 4 * total_gpus
        assert actual == align_to_8(raw_size)
        assert actual == expected


def test_gpu_used_is_uint16():
    round_data = {
        'round': 0, 'sim_time': 0.0, 'utilization': 0.9,
        'jobs_running': 500, 'jobs_queued': 100, 'jobs_completed': 1000,
        'avg_jct': 3600.0, 'completion_rate': 10.0,
        'gpu_used': [300, 400, 500],  # Values > 255 require uint16
        'allocations': [0] * 12
    }
    packed = pack_round(round_data, num_gpu_types=3, total_gpus=12)
    unpacked = unpack_round(packed, num_gpu_types=3, total_gpus=12)
    assert unpacked['gpu_used'] == [300, 400, 500]


def test_allocations_is_uint32():
    round_data = {
        'round': 0, 'sim_time': 0.0, 'utilization': 0.5,
        'jobs_running': 4, 'jobs_queued': 0, 'jobs_completed': 0,
        'avg_jct': 0.0, 'completion_rate': 0.0,
        'gpu_used': [2, 2, 0],
        'allocations': [70000, 80000, 90000, 100000, 0, 0, 0, 0, 0, 0, 0, 0]  # > 65535
    }
    packed = pack_round(round_data, num_gpu_types=3, total_gpus=12)
    unpacked = unpack_round(packed, num_gpu_types=3, total_gpus=12)
    assert unpacked['allocations'][:4] == [70000, 80000, 90000, 100000]


# Task 1.5: Queue data section tests
from viz.tools.binary_format import pack_queue_entry, unpack_queue_entry, pack_queue_index, unpack_queue_index


def test_pack_queue_entry_empty():
    packed = pack_queue_entry([])
    assert len(packed) == 2


def test_pack_queue_entry_with_jobs():
    queue = [10, 20, 30, 40, 50]
    packed = pack_queue_entry(queue)
    assert len(packed) == 22  # 2 + 5*4


def test_queue_entry_roundtrip():
    queues = [[], [1], [100, 200, 300], list(range(1000))]
    for queue in queues:
        packed = pack_queue_entry(queue)
        unpacked = unpack_queue_entry(packed)
        assert unpacked == queue


def test_pack_queue_index():
    offsets = [0, 100, 250, 500]
    packed = pack_queue_index(offsets)
    assert len(packed) == 32  # 4 * 8


def test_queue_index_roundtrip():
    offsets = [0, 100, 250, 500]
    packed = pack_queue_index(offsets)
    unpacked = unpack_queue_index(packed, 4)
    assert unpacked == offsets


# Task 1.6: Complete binary file writer tests
import tempfile
import os
from viz.tools.binary_format import write_viz_file, read_viz_header


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
    queues = [[0]]

    with tempfile.NamedTemporaryFile(suffix='.viz.bin', delete=False) as f:
        path = f.name
    try:
        write_viz_file(path, config, jobs, rounds, queues)
        assert os.path.exists(path)
        assert os.path.getsize(path) > 256
        header = read_viz_header(path)
        assert header['magic'] == MAGIC
        assert header['version'] == VERSION
        assert header['num_rounds'] == 1
        assert header['num_jobs'] == 1
        assert header['num_gpu_types'] == 3
        assert header['total_gpus'] == 108
    finally:
        os.unlink(path)


# V2 sharing section tests
from viz.tools.binary_format import pack_sharing_round, unpack_sharing_round


def test_pack_sharing_round_empty():
    packed = pack_sharing_round([])
    assert len(packed) == 2  # Just the uint16 count
    entries = unpack_sharing_round(packed)
    assert entries == []


def test_sharing_round_roundtrip():
    entries = [
        (100, [42, 42, 0, 0]),     # Half-GPU job + idle
        (200, [10, 20, 10, 0]),    # Two jobs sharing + idle quarter
        (300, [5, 5, 5, 5]),       # Shouldn't normally appear but test it
    ]
    packed = pack_sharing_round(entries)
    unpacked = unpack_sharing_round(packed)
    assert len(unpacked) == 3
    for i, (gpu_idx, slots) in enumerate(unpacked):
        assert gpu_idx == entries[i][0]
        assert slots == entries[i][1]


def test_write_viz_file_with_sharing():
    config = {
        'gpu_types': [{'name': 'v100', 'count': 4}],
        'measurement_window': {'start_job': 0, 'end_job': 10},
        'job_types': [{'id': 0, 'name': 'ResNet-18', 'category': 'resnet'}]
    }
    jobs = [{'job_id': 1, 'type_id': 0, 'scale_factor': 1, 'arrival_round': 0}]
    rounds = [{
        'round': 0, 'sim_time': 0.0, 'utilization': 0.5,
        'jobs_running': 1, 'jobs_queued': 0, 'jobs_completed': 0,
        'avg_jct': 0.0, 'completion_rate': 0.0,
        'gpu_used': [2], 'allocations': [1, 0, 0, 0]
    }]
    queues = [[]]
    sharing = [
        [(0, [1, 1, 0, 0])],  # GPU 0: half occupied
    ]

    with tempfile.NamedTemporaryFile(suffix='.viz.bin', delete=False) as f:
        path = f.name
    try:
        write_viz_file(path, config, jobs, rounds, queues, sharing=sharing)
        header = read_viz_header(path)
        assert header['version'] == 2
        assert header['sharing_data_offset'] > 0
        assert header['sharing_index_offset'] > 0
        assert header['sharing_data_offset'] % 8 == 0
    finally:
        os.unlink(path)


def test_write_viz_file_no_sharing_has_zero_offsets():
    config = {
        'gpu_types': [{'name': 'v100', 'count': 4}],
        'measurement_window': {'start_job': 0, 'end_job': 10},
        'job_types': [{'id': 0, 'name': 'ResNet-18', 'category': 'resnet'}]
    }
    jobs = [{'job_id': 1, 'type_id': 0, 'scale_factor': 1, 'arrival_round': 0}]
    rounds = [{
        'round': 0, 'sim_time': 0.0, 'utilization': 1.0,
        'jobs_running': 1, 'jobs_queued': 0, 'jobs_completed': 0,
        'avg_jct': 0.0, 'completion_rate': 0.0,
        'gpu_used': [4], 'allocations': [1, 1, 1, 1]
    }]
    queues = [[]]

    with tempfile.NamedTemporaryFile(suffix='.viz.bin', delete=False) as f:
        path = f.name
    try:
        write_viz_file(path, config, jobs, rounds, queues)
        header = read_viz_header(path)
        assert header['sharing_data_offset'] == 0
        assert header['sharing_index_offset'] == 0
    finally:
        os.unlink(path)


def test_header_v2_sharing_offsets_roundtrip():
    packed = pack_header(
        num_rounds=100, num_jobs=50, num_gpu_types=3, total_gpus=108,
        job_metadata_offset=256, rounds_offset=1024, queue_offset=50000,
        index_offset=60000, config_json_offset=200,
        sharing_data_offset=70000, sharing_index_offset=80000
    )
    unpacked = unpack_header(packed)
    assert unpacked['sharing_data_offset'] == 70000
    assert unpacked['sharing_index_offset'] == 80000
