#!/usr/bin/env python3
"""Standardize experiment labels and filters in manifest.json.

Label format: Date | Figure | Trace | Algorithm | Load | Seed | Roundsr

Adds 'figure' and 'algorithm' filters to all experiments.
"""

import json
import re
import sys
from pathlib import Path


def determine_figure_and_algorithm(exp):
    """Determine the figure group and algorithm for an experiment."""
    filters = exp['filters']
    label = exp['label']
    fname = exp['file']
    exp_type = filters['type']

    figure = None
    algorithm = None

    # --- gavel_replication type (30 experiments with policy filter) ---
    if exp_type == 'gavel_replication':
        figure = filters.get('figure', '').capitalize()
        # e.g. 'fig10' -> 'Fig10'
        if figure.startswith('Fig'):
            pass  # already good
        else:
            figure = 'Fig' + figure.lstrip('fig')

        policy = filters.get('policy', '')
        policy_map = {
            'max_min_fairness': 'MaxMinFairness',
            'max_min_fairness_perf': 'MaxMinFairness-Perf',
            'finish_time_fairness': 'FinishTimeFairness',
            'finish_time_fairness_perf': 'FinishTimeFairness-Perf',
        }
        algorithm = policy_map.get(policy, policy)
        return figure, algorithm

    # --- combined type (7 experiments) ---
    if exp_type == 'combined':
        figure = 'CombinedSweep'
        algorithm = 'Gavel+FGD'
        return figure, algorithm

    # --- fgd type (61 experiments) ---
    if exp_type == 'fgd':
        # Determine algorithm from label
        fgd_algo_map = [
            ('Baseline Strided', 'Baseline-Strided'),
            ('Gavel Strided', 'Gavel-Strided'),
            ('Gavel Random', 'Gavel-Random'),
            ('Gavel Bestfit', 'Gavel-Bestfit'),
            ('Gavel+FGD', 'Gavel+FGD'),
            ('FGD+Migration', 'FGD+Migration'),
            ('FGD-only', 'FGD-Only'),
            ('FIFO + FGD Placement', 'FIFO+FGD'),
            ('FIFO + Random Placement', 'FIFO+Random'),
            ('GPU Sharing Test', 'GPU-Sharing'),
            ('Load Sweep Test + GPU Sharing', 'LoadSweep+Sharing'),
            ('Load Sweep Test', 'LoadSweep-Test'),
        ]
        algorithm = label  # fallback
        for prefix, algo in fgd_algo_map:
            if label.startswith(prefix):
                algorithm = algo
                break

        # Determine figure group
        if algorithm in ('Baseline-Strided', 'Gavel-Strided', 'Gavel-Random',
                         'Gavel-Bestfit', 'Gavel+FGD'):
            figure = 'Placement'
        elif algorithm == 'FGD+Migration':
            figure = 'Migration'
        elif algorithm == 'FGD-Only':
            figure = 'LoadSweep'
        else:
            figure = 'DevTest'

        return figure, algorithm

    # --- gavel type (345 experiments) ---
    if exp_type == 'gavel':
        # Extract figure from filename or label
        fig_match = re.search(r'(fig\d+)', fname, re.IGNORECASE)
        if fig_match:
            fig_num = fig_match.group(1).lower()
            figure = 'Fig' + fig_num[3:]  # fig10 -> Fig10
        elif label.startswith('Fig'):
            fig_match2 = re.match(r'(Fig\d+)', label)
            if fig_match2:
                figure = fig_match2.group(1)

        # Extract algorithm
        # For gavel_replication/ folder files, extract from filename
        if fname.startswith('gavel_replication/'):
            # e.g. gavel_repl_fig10_max_min_fairness_packed_0.8jph_multi_s0.viz.bin
            # Extract policy from between fig\d+_ and _\d+\.?\d*jph
            policy_match = re.search(
                r'gavel_repl_fig\d+_(.+?)_\d+\.?\d*jph', fname)
            if policy_match:
                policy_str = policy_match.group(1)
                policy_algo_map = {
                    'max_min_fairness': 'Baseline',
                    'max_min_fairness_perf': 'Gavel',
                    'max_min_fairness_packed': 'Packed',
                    'finish_time_fairness': 'FIFO',
                    'finish_time_fairness_perf': 'Gavel',
                }
                algorithm = policy_algo_map.get(policy_str, policy_str)
        elif 'Repl' in label:
            # "Gavel Repl: Fig9 Perf 4.0jph s0" -> Gavel
            algorithm = 'Gavel'
        else:
            # Extract from label: "Fig10 Gavel High" or "Gavel 0.6jph"
            # Remove the Fig prefix if present
            stripped = re.sub(r'^Fig\d+\s+', '', label)
            # First word is the algorithm
            first_word = stripped.split()[0] if stripped else label
            if first_word in ('Gavel', 'Baseline', 'Packed', 'FIFO'):
                algorithm = first_word

        # Handle no-fig gavel experiments
        if figure is None:
            trace = filters.get('trace', '')
            if trace == 'alibaba':
                figure = 'LoadSweep'
            else:
                # Early philly experiments (perf_0.6jph, fairness_0.6jph)
                figure = 'DevTest'

        if algorithm is None:
            algorithm = label.split()[0]

        return figure, algorithm

    return figure or 'Unknown', algorithm or 'Unknown'


def build_label(exp, figure, algorithm):
    """Build standardized label: Date | Figure | Trace | Algorithm | Load | Seed | Roundsr"""
    filters = exp['filters']
    date = filters.get('date', '?')
    trace = filters.get('trace', '?').capitalize()
    load = filters.get('load', '?')
    seed = filters.get('seed', '?')
    rounds = exp.get('rounds', 0)
    return f"{date} | {figure} | {trace} | {algorithm} | {load} | {seed} | {rounds}r"


def main():
    manifest_path = Path(__file__).parent.parent / 'data' / 'manifest.json'
    with open(manifest_path) as f:
        manifest = json.load(f)

    experiments = manifest['experiments']
    changes = []

    for exp in experiments:
        old_label = exp['label']
        figure, algorithm = determine_figure_and_algorithm(exp)
        new_label = build_label(exp, figure, algorithm)

        # Add figure and algorithm to filters
        exp['filters']['figure'] = figure.lower()
        exp['filters']['algorithm'] = algorithm.lower()

        if old_label != new_label:
            changes.append((old_label, new_label))
        exp['label'] = new_label

    # Write updated manifest
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')

    print(f"Updated {len(changes)} labels out of {len(experiments)} experiments")
    print()

    # Show sample of changes per type
    print("=== Sample changes ===")
    shown = 0
    for old, new in changes:
        if shown < 20:
            print(f"  {old}")
            print(f"  -> {new}")
            print()
            shown += 1

    if len(changes) > 20:
        print(f"  ... and {len(changes) - 20} more")

    # Validate: check for duplicate labels
    labels = [e['label'] for e in experiments]
    dupes = [l for l in labels if labels.count(l) > 1]
    if dupes:
        print(f"\nWARNING: {len(set(dupes))} duplicate labels found:")
        for d in sorted(set(dupes)):
            count = labels.count(d)
            print(f"  ({count}x) {d}")


if __name__ == '__main__':
    main()
