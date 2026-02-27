#!/usr/bin/env python3
"""One-time migration: convert manifest.json from old schema to new 7-field schema.

Changes:
- Splits 'algorithm' into 'scheduler' + 'placement'
- Renames figures to paper references (fig9 -> gavel-fig9, fgd-placement -> fgd-fig7, etc.)
- Converts named loads (high-load -> 7.0jph, etc.)
- Removes 'algorithm' field
- Drops entries with no valid figure mapping (workbench, unknown)
- Rebuilds labels in new format

This script is idempotent: entries already in new schema are left unchanged.
"""
import json
from collections import defaultdict
from pathlib import Path

from experiment_schema import (
    ALGORITHM_MIGRATION, FIGURE_MIGRATION, LOAD_MIGRATION,
    validate_filters, build_manifest_entry,
)


def migrate_entry(exp):
    """Migrate a single experiment entry. Returns new entry dict or None to skip."""
    filters = exp.get('filters', {})
    file = exp['file']
    rounds = exp.get('rounds', 0)
    complete = exp.get('complete', True)

    # Already migrated? (has scheduler + placement, no algorithm)
    if 'scheduler' in filters and 'placement' in filters and 'algorithm' not in filters:
        try:
            return build_manifest_entry(file, filters, rounds, complete)
        except ValueError:
            return None

    # Need migration: must have algorithm (or be a workbench entry)
    algorithm = filters.get('algorithm')
    if algorithm is None:
        return None

    if algorithm not in ALGORITHM_MIGRATION:
        return None
    scheduler, placement = ALGORITHM_MIGRATION[algorithm]

    old_figure = filters.get('figure', '')
    figure = FIGURE_MIGRATION.get(old_figure)
    if figure is None:
        return None

    load = filters.get('load', '')
    load = LOAD_MIGRATION.get(load, load)

    new_filters = {
        'date': filters.get('date', ''),
        'trace': filters.get('trace', ''),
        'figure': figure,
        'scheduler': scheduler,
        'placement': placement,
        'load': load,
        'seed': filters.get('seed', ''),
    }

    try:
        return build_manifest_entry(file, new_filters, rounds, complete)
    except ValueError as e:
        print(f"  SKIP {file}: {e}")
        return None


def main():
    manifest_path = Path(__file__).parent.parent / 'data' / 'manifest.json'
    with open(manifest_path) as f:
        manifest = json.load(f)

    old_experiments = manifest['experiments']
    new_experiments = []
    skipped = []

    for exp in old_experiments:
        result = migrate_entry(exp)
        if result is None:
            skipped.append(exp.get('label', exp.get('file', '?')))
        else:
            new_experiments.append(result)

    manifest['experiments'] = new_experiments

    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')

    print(f"Migrated {len(new_experiments)} experiments, skipped {len(skipped)}")

    if skipped:
        print(f"\n=== Skipped ({len(skipped)}) ===")
        for label in skipped:
            print(f"  {label}")

    # Summary by figure
    by_fig = defaultdict(list)
    for e in new_experiments:
        by_fig[e['filters']['figure']].append(e)

    print()
    for fig in sorted(by_fig):
        exps = by_fig[fig]
        scheds = sorted(set(e['filters']['scheduler'] for e in exps))
        places = sorted(set(e['filters']['placement'] for e in exps))
        print(f"  {fig}: {len(exps)} exps, schedulers={scheds}, placements={places}")

    # Check for dupes
    labels = [e['label'] for e in new_experiments]
    dupes = set(l for l in labels if labels.count(l) > 1)
    if dupes:
        print(f"\nWARNING: {len(dupes)} duplicate labels")
        for d in sorted(dupes):
            print(f"  ({labels.count(d)}x) {d}")
    else:
        print(f"\nNo duplicate labels.")


if __name__ == '__main__':
    main()
