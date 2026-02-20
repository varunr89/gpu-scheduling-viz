#!/usr/bin/env python3
"""Standardize experiment labels and filters in manifest.json.

Label format: Date | Figure | Trace | Algorithm | Load | Seed | Roundsr

Changes:
- Drops 'type' filter (redundant with trace + figure)
- Merges gavel_replication into gavel
- Collapses algorithm to 8 values: Gavel, Baseline, FIFO, Packed,
  Gavel+FGD, Gavel-Random, Gavel-Bestfit, FGD
- Renames policy names to paper names (MaxMinFairness -> Baseline, etc.)
- Assigns clean figure names: Fig9, Fig10, Fig11, FGD-Placement, FGD-Scale
- Excludes DevTest and Migration experiments (data files kept, removed from manifest)
- Merges LoadSweep + CombinedSweep into FGD-Scale
"""

import json
import re
from pathlib import Path

# Figures to exclude from the manifest entirely
EXCLUDED_FIGURES = {'devtest', 'migration'}


def classify(exp):
    """Return (figure, algorithm) for an experiment, or None to exclude it."""
    filters = exp['filters']
    old_label = exp.get('_old_label', exp['label'])
    fname = exp['file']
    exp_type = filters.get('type', '')

    # --- Determine figure ---
    figure = None

    # gavel_replication type: has figure in filters already
    if exp_type == 'gavel_replication':
        raw_fig = filters.get('figure', '')
        figure = 'Fig' + raw_fig[3:] if raw_fig.startswith('fig') else raw_fig.capitalize()

    # combined type: load sweep on Alibaba
    elif exp_type == 'combined':
        figure = 'FGD-Scale'

    # fgd type: determine from old label
    elif exp_type == 'fgd':
        # Classify by what the experiment tests
        if any(old_label.startswith(p) for p in (
                'Baseline Strided', 'Gavel Strided', 'Gavel Random',
                'Gavel Bestfit', 'Gavel+FGD')):
            figure = 'FGD-Placement'
        elif old_label.startswith('FGD+Migration'):
            figure = 'Migration'  # will be excluded
        elif old_label.startswith('FGD-only'):
            figure = 'FGD-Scale'
        else:
            figure = 'DevTest'  # will be excluded

    # gavel type
    elif exp_type == 'gavel':
        # Try to get figure from filename
        fig_match = re.search(r'(fig\d+)', fname, re.IGNORECASE)
        if fig_match:
            fig_num = fig_match.group(1).lower()
            figure = 'Fig' + fig_num[3:]
        # Try from label
        elif old_label.startswith('Fig'):
            m = re.match(r'(Fig\d+)', old_label)
            if m:
                figure = m.group(1)
        # No figure info: classify by trace
        elif filters.get('trace') == 'alibaba':
            figure = 'FGD-Scale'
        else:
            figure = 'DevTest'  # will be excluded

    if figure is None:
        figure = 'Unknown'

    # Check exclusion
    if figure.lower() in EXCLUDED_FIGURES:
        return None

    # --- Determine algorithm ---
    algorithm = None

    if exp_type == 'gavel_replication':
        # Map policy names to paper names
        # max_min_fairness = Baseline (fig9/10), finish_time_fairness = FIFO (fig11)
        policy = filters.get('policy', '')
        algorithm = {
            'max_min_fairness': 'Baseline',
            'max_min_fairness_perf': 'Gavel',
            'finish_time_fairness': 'FIFO',
            'finish_time_fairness_perf': 'Gavel',
        }.get(policy, policy)

    elif exp_type == 'combined':
        algorithm = 'Gavel+FGD'

    elif exp_type == 'fgd':
        # Map from old label prefix
        for prefix, algo in [
            ('Baseline Strided', 'Baseline'),
            ('Gavel Strided', 'Gavel'),
            ('Gavel Random', 'Gavel-Random'),
            ('Gavel Bestfit', 'Gavel-Bestfit'),
            ('Gavel+FGD', 'Gavel+FGD'),
            ('FGD-only', 'FGD'),
        ]:
            if old_label.startswith(prefix):
                algorithm = algo
                break
        if algorithm is None:
            algorithm = old_label.split()[0]

    elif exp_type == 'gavel':
        # From gavel_replication/ folder files: extract policy from filename
        if fname.startswith('gavel_replication/'):
            policy_match = re.search(
                r'gavel_repl_fig\d+_(.+?)_\d+\.?\d*jph', fname)
            if policy_match:
                policy_str = policy_match.group(1)
                algorithm = {
                    'max_min_fairness': 'Baseline',
                    'max_min_fairness_perf': 'Gavel',
                    'max_min_fairness_packed': 'Packed',
                    'finish_time_fairness': 'FIFO',
                    'finish_time_fairness_perf': 'Gavel',
                }.get(policy_str, policy_str)
        elif 'Repl' in old_label:
            algorithm = 'Gavel'
        else:
            # From label: "Fig10 Gavel High" -> Gavel, "Gavel 60jph" -> Gavel
            stripped = re.sub(r'^Fig\d+\s+', '', old_label)
            first_word = stripped.split()[0] if stripped else ''
            if first_word in ('Gavel', 'Baseline', 'Packed', 'FIFO'):
                algorithm = first_word

        if algorithm is None:
            algorithm = old_label.split()[0]

    else:
        algorithm = 'Unknown'

    return figure, algorithm


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

    old_experiments = manifest['experiments']
    new_experiments = []
    excluded = []

    for exp in old_experiments:
        # Save old label for classification (labels were already standardized once)
        # Parse the old label to extract info if needed
        exp['_old_label'] = exp['label']
        result = classify(exp)

        if result is None:
            excluded.append(exp['label'])
            continue

        figure, algorithm = result
        new_label = build_label(exp, figure, algorithm)

        # Clean up filters: remove 'type', add/update figure and algorithm
        exp['filters'].pop('type', None)
        exp['filters']['figure'] = figure.lower()
        exp['filters']['algorithm'] = algorithm.lower()

        exp['label'] = new_label
        del exp['_old_label']
        new_experiments.append(exp)

    manifest['experiments'] = new_experiments

    # Write updated manifest
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')

    print(f"Kept {len(new_experiments)} experiments, excluded {len(excluded)}")
    print()

    if excluded:
        print(f"=== Excluded ({len(excluded)}) ===")
        for label in excluded:
            print(f"  {label}")
        print()

    # Show samples by figure
    from collections import defaultdict
    by_fig = defaultdict(list)
    for e in new_experiments:
        by_fig[e['filters']['figure']].append(e)

    for fig in sorted(by_fig):
        exps = by_fig[fig]
        algos = sorted(set(e['filters']['algorithm'] for e in exps))
        print(f"=== {fig} ({len(exps)} exps, algos: {algos}) ===")
        for e in exps[:2]:
            print(f"  {e['label']}")
        if len(exps) > 2:
            print(f"  ... and {len(exps) - 2} more")
        print()

    # Validate: check for duplicate labels
    labels = [e['label'] for e in new_experiments]
    dupes = set(l for l in labels if labels.count(l) > 1)
    if dupes:
        print(f"WARNING: {len(dupes)} duplicate labels found:")
        for d in sorted(dupes):
            print(f"  ({labels.count(d)}x) {d}")
    else:
        print("No duplicate labels.")


if __name__ == '__main__':
    main()
