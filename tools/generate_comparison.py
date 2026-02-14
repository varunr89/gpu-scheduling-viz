#!/usr/bin/env python3
"""Generate comparison JSON from full_cmp experiment result files.

Reads full_cmp_*.json result files and produces a comparison.json
suitable for the visualizer's cross-experiment comparison charts.

Usage:
    python -m viz.tools.generate_comparison \
        --results-dir path/to/results \
        --output data/full_comparison.json
"""

import argparse
import json
import os
import sys
from collections import defaultdict


def parse_config_name(name):
    """Extract config type, load level, and seed from experiment name.

    Examples:
        'gavel_60jph_s0'    -> ('gavel', 60, 0)
        'fgd_85jph_s1'      -> ('fgd', 85, 1)
        'gavelfgd_110jph_s2' -> ('gavelfgd', 110, 2)
    """
    parts = name.rsplit('_', 2)
    if len(parts) != 3:
        return None, None, None
    config = parts[0]
    load_str = parts[1].replace('jph', '')
    seed_str = parts[2].replace('s', '')
    try:
        load = int(load_str)
        seed = int(seed_str)
    except ValueError:
        return None, None, None
    return config, load, seed


def main():
    parser = argparse.ArgumentParser(description='Generate comparison JSON')
    parser.add_argument('--results-dir', required=True,
                        help='Directory containing full_cmp_*.json files')
    parser.add_argument('--output', required=True,
                        help='Output JSON file path')
    parser.add_argument('--prefix', default='full_cmp_',
                        help='Result file prefix (default: full_cmp_)')
    args = parser.parse_args()

    # Collect all result files
    results = []
    for fname in sorted(os.listdir(args.results_dir)):
        if fname.startswith(args.prefix) and fname.endswith('.json'):
            fpath = os.path.join(args.results_dir, fname)
            with open(fpath) as f:
                data = json.load(f)
            # Result files contain a list with one dict
            if isinstance(data, list) and len(data) > 0:
                data = data[0]
            results.append(data)

    if not results:
        print(f'No result files found in {args.results_dir}', file=sys.stderr)
        sys.exit(1)

    print(f'Loaded {len(results)} result files')

    # Group by config and load
    # Structure: grouped[config][load] = [{ seed, avg_jct, ... }, ...]
    grouped = defaultdict(lambda: defaultdict(list))
    configs_seen = set()
    loads_seen = set()

    for r in results:
        name = r.get('name', '')
        config, load, seed = parse_config_name(name)
        if config is None:
            print(f'  Skipping unrecognized name: {name}', file=sys.stderr)
            continue

        configs_seen.add(config)
        loads_seen.add(load)

        grouped[config][load].append({
            'seed': seed,
            'avg_jct_hours': round(r['avg_jct'] / 3600, 2) if r.get('avg_jct') else None,
            'completed_jobs': r.get('num_completed_jobs', 0),
            'failed_jobs': r.get('num_failed_jobs', 0),
            'saturated': r.get('saturated', False),
            'wall_time_hours': round(r['wall_time_seconds'] / 3600, 2) if r.get('wall_time_seconds') else None,
        })

    loads = sorted(loads_seen)
    configs = sorted(configs_seen)

    print(f'Configs: {configs}')
    print(f'Loads: {loads}')

    # Build aggregated output
    comparison = {
        'description': 'Full comparison: Gavel vs FGD vs Gavel+FGD',
        'loads': loads,
        'configs': configs,
        'config_labels': {
            'fgd': 'FGD-only',
            'gavel': 'Gavel',
            'gavelfgd': 'Gavel+FGD',
        },
        'config_colors': {
            'gavel': '#4a9eff',
            'fgd': '#ff6b6b',
            'gavelfgd': '#4ecca3',
        },
        'metrics': {}
    }

    for config in configs:
        config_data = {
            'avg_jct': [],         # per load: { mean, min, max, seeds[] }
            'completed_jobs': [],
            'saturated': [],       # per load: fraction of seeds saturated
        }

        for load in loads:
            seeds = grouped[config][load]
            seeds.sort(key=lambda s: s['seed'])

            jcts = [s['avg_jct_hours'] for s in seeds if s['avg_jct_hours'] is not None]
            completed = [s['completed_jobs'] for s in seeds]
            sat_count = sum(1 for s in seeds if s['saturated'])

            if jcts:
                config_data['avg_jct'].append({
                    'mean': round(sum(jcts) / len(jcts), 2),
                    'min': round(min(jcts), 2),
                    'max': round(max(jcts), 2),
                    'seeds': jcts,
                })
            else:
                config_data['avg_jct'].append(None)

            if completed:
                config_data['completed_jobs'].append({
                    'mean': round(sum(completed) / len(completed)),
                    'min': min(completed),
                    'max': max(completed),
                    'seeds': completed,
                })
            else:
                config_data['completed_jobs'].append(None)

            config_data['saturated'].append(
                round(sat_count / len(seeds), 2) if seeds else 0
            )

        comparison['metrics'][config] = config_data

    # Write output
    os.makedirs(os.path.dirname(args.output) or '.', exist_ok=True)
    with open(args.output, 'w') as f:
        json.dump(comparison, f, indent=2)

    print(f'Written to {args.output}')


if __name__ == '__main__':
    main()
