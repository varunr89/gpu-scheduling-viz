#!/usr/bin/env python3
"""Add FGD replication .viz.bin entries to manifest.json.

Reads binary headers to get round counts, builds labels and filters
matching the existing manifest conventions.

Usage:
    cd gpu-scheduling-viz
    python tools/update_manifest_fgd_repl.py
"""
import json
import os
import re
import struct
import sys
from pathlib import Path

# Add parent for viz.tools imports; add tools/ for sibling module imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from viz.tools.binary_format import unpack_header, HEADER_SIZE
from experiment_schema import build_manifest_entry

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
MANIFEST_PATH = DATA_DIR / "manifest.json"
FGD_REPL_DIR = DATA_DIR / "fgd_replication"

SCHED_TO_SCHEDULER = {'mmf': 'mmf', 'fifo': 'fifo'}


def read_round_count(viz_bin_path):
    """Read the number of rounds from a .viz.bin file header."""
    with open(viz_bin_path, 'rb') as f:
        header_data = f.read(HEADER_SIZE)
        header = unpack_header(header_data)
        return header.get('num_rounds', 0)


def parse_filename(filename):
    """Parse experiment viz.bin filenames into (scheduler, placement, rate, seed).

    Supported patterns after stripping 'fgd_repl_':
      fgd_<placement>_<rate>jph_s<seed>    -> scheduler='mmf'
      fifo_<placement>_<rate>jph_s<seed>   -> scheduler='fifo'
      fgd_test_<placement>_<rate>jph_s<seed> -> scheduler='mmf'
    """
    name = filename.replace('.viz.bin', '').replace('fgd_repl_', '')

    # MaxMinFairness experiments: fgd_<placement>_<rate>jph_s<seed>
    m = re.match(r'^fgd_(strided|random|bestfit|fgd)_(\d+)jph_s(\d+)$', name)
    if m:
        return 'mmf', m.group(1), m.group(2), m.group(3)

    # FIFO experiments: fifo_<placement>_<rate>jph_s<seed>
    m = re.match(r'^fifo_(strided|random|bestfit|fgd)_(\d+)jph_s(\d+)$', name)
    if m:
        return 'fifo', m.group(1), m.group(2), m.group(3)

    # Test runs: fgd_test_<placement>_<rate>jph_s<seed>
    m = re.match(r'^fgd_test_(strided|random|bestfit|fgd)_(\d+)jph_s(\d+)$', name)
    if m:
        return 'mmf', m.group(1), m.group(2), m.group(3)

    return None, None, None, None


def main():
    with open(MANIFEST_PATH) as f:
        manifest = json.load(f)

    existing_files = {e['file'] for e in manifest['experiments']}

    # Remove old fgd-replication entries (we'll regenerate them all)
    manifest['experiments'] = [
        e for e in manifest['experiments']
        if not (e.get('filters', {}).get('figure') == 'fgd-fig7'
                and e.get('filters', {}).get('date') == '2026-02-21')
    ]

    new_entries = []
    for viz_file in sorted(FGD_REPL_DIR.iterdir()):
        if not viz_file.name.endswith('.viz.bin'):
            continue

        sched, placement, rate, seed = parse_filename(viz_file.name)
        if placement is None:
            print(f"  Skipping unrecognized: {viz_file.name}")
            continue

        rounds = read_round_count(viz_file)
        scheduler = SCHED_TO_SCHEDULER.get(sched, sched)

        entry = build_manifest_entry(
            file=f"fgd_replication/{viz_file.name}",
            filters={
                'date': '2026-02-21',
                'trace': 'alibaba',
                'figure': 'fgd-fig7',
                'scheduler': scheduler,
                'placement': placement,
                'load': f'{rate}jph',
                'seed': f's{seed}',
            },
            rounds=rounds,
            complete=True,
        )
        new_entries.append(entry)

    manifest['experiments'].extend(new_entries)

    with open(MANIFEST_PATH, 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')

    print(f"Added {len(new_entries)} FGD replication entries to manifest.json")
    print(f"Total experiments in manifest: {len(manifest['experiments'])}")


if __name__ == '__main__':
    main()
