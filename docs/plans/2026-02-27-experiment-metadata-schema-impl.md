# Experiment Metadata Schema Enforcement -- Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enforce a validated 7-field schema on all experiment metadata, splitting `algorithm` into `scheduler` + `placement`, using paper-referenced figure names, and validating at conversion time.

**Architecture:** A new `tools/experiment_schema.py` module is the single source of truth for allowed filter values and validation logic. All scripts that write to `manifest.json` import from it. A one-time migration script rewrites the existing 774 entries. The viz tool JS updates its filter groups to match.

**Tech Stack:** Python 3.9+ (no new deps), vanilla JS (existing viz.js)

---

### Task 1: Create `experiment_schema.py` with validation

**Files:**
- Create: `tools/experiment_schema.py`
- Test: `tests/test_experiment_schema.py`

**Step 1: Write failing tests for the schema module**

Create `tests/test_experiment_schema.py`:

```python
import pytest
from viz.tools.experiment_schema import (
    TRACES, FIGURES, SCHEDULERS, PLACEMENTS,
    validate_filters, build_manifest_entry,
)


class TestAllowedValues:
    def test_traces(self):
        assert TRACES == {'philly', 'alibaba'}

    def test_figures(self):
        assert FIGURES == {'gavel-fig9', 'gavel-fig10', 'gavel-fig11', 'fgd-fig7', 'fgd-fig9'}

    def test_schedulers(self):
        assert SCHEDULERS == {'mmf', 'fifo', 'gavel', 'packed'}

    def test_placements(self):
        assert PLACEMENTS == {'strided', 'random', 'bestfit', 'fgd'}


class TestValidateFilters:
    def test_valid_filters(self):
        filters = {
            'date': '2026-02-07',
            'trace': 'alibaba',
            'figure': 'fgd-fig7',
            'scheduler': 'gavel',
            'placement': 'random',
            'load': '60jph',
            'seed': 's0',
        }
        result = validate_filters(filters)
        assert result == filters

    def test_rejects_bad_trace(self):
        filters = {
            'date': '2026-02-07', 'trace': 'azure', 'figure': 'fgd-fig7',
            'scheduler': 'gavel', 'placement': 'random', 'load': '60jph', 'seed': 's0',
        }
        with pytest.raises(ValueError, match='trace'):
            validate_filters(filters)

    def test_rejects_bad_figure(self):
        filters = {
            'date': '2026-02-07', 'trace': 'alibaba', 'figure': 'fgd-placement',
            'scheduler': 'gavel', 'placement': 'random', 'load': '60jph', 'seed': 's0',
        }
        with pytest.raises(ValueError, match='figure'):
            validate_filters(filters)

    def test_rejects_bad_scheduler(self):
        filters = {
            'date': '2026-02-07', 'trace': 'alibaba', 'figure': 'fgd-fig7',
            'scheduler': 'baseline', 'placement': 'random', 'load': '60jph', 'seed': 's0',
        }
        with pytest.raises(ValueError, match='scheduler'):
            validate_filters(filters)

    def test_rejects_bad_placement(self):
        filters = {
            'date': '2026-02-07', 'trace': 'alibaba', 'figure': 'fgd-fig7',
            'scheduler': 'gavel', 'placement': 'packed', 'load': '60jph', 'seed': 's0',
        }
        with pytest.raises(ValueError, match='placement'):
            validate_filters(filters)

    def test_rejects_named_load(self):
        filters = {
            'date': '2026-02-07', 'trace': 'alibaba', 'figure': 'fgd-fig7',
            'scheduler': 'gavel', 'placement': 'random', 'load': 'high-load', 'seed': 's0',
        }
        with pytest.raises(ValueError, match='load'):
            validate_filters(filters)

    def test_rejects_bad_date(self):
        filters = {
            'date': 'Feb 7 2026', 'trace': 'alibaba', 'figure': 'fgd-fig7',
            'scheduler': 'gavel', 'placement': 'random', 'load': '60jph', 'seed': 's0',
        }
        with pytest.raises(ValueError, match='date'):
            validate_filters(filters)

    def test_rejects_bad_seed(self):
        filters = {
            'date': '2026-02-07', 'trace': 'alibaba', 'figure': 'fgd-fig7',
            'scheduler': 'gavel', 'placement': 'random', 'load': '60jph', 'seed': 'seed0',
        }
        with pytest.raises(ValueError, match='seed'):
            validate_filters(filters)

    def test_rejects_missing_field(self):
        filters = {
            'date': '2026-02-07', 'trace': 'alibaba', 'figure': 'fgd-fig7',
            'scheduler': 'gavel', 'placement': 'random', 'load': '60jph',
            # missing seed
        }
        with pytest.raises(ValueError, match='seed'):
            validate_filters(filters)

    def test_rejects_old_algorithm_field(self):
        """Catch accidental use of the old schema."""
        filters = {
            'date': '2026-02-07', 'trace': 'alibaba', 'figure': 'fgd-fig7',
            'algorithm': 'gavel-random', 'load': '60jph', 'seed': 's0',
        }
        with pytest.raises(ValueError, match='algorithm'):
            validate_filters(filters)

    def test_decimal_load(self):
        filters = {
            'date': '2026-02-07', 'trace': 'philly', 'figure': 'gavel-fig9',
            'scheduler': 'mmf', 'placement': 'strided', 'load': '0.8jph', 'seed': 's1',
        }
        assert validate_filters(filters) == filters


class TestBuildManifestEntry:
    def test_builds_entry(self):
        entry = build_manifest_entry(
            file='fgd_replication/fgd_repl_fgd_bestfit_100jph_s1.viz.bin',
            filters={
                'date': '2026-02-21', 'trace': 'alibaba', 'figure': 'fgd-fig7',
                'scheduler': 'mmf', 'placement': 'bestfit', 'load': '100jph', 'seed': 's1',
            },
            rounds=453,
            complete=True,
        )
        assert entry['file'] == 'fgd_replication/fgd_repl_fgd_bestfit_100jph_s1.viz.bin'
        assert entry['rounds'] == 453
        assert entry['complete'] is True
        assert entry['filters']['scheduler'] == 'mmf'
        assert entry['filters']['placement'] == 'bestfit'
        # Label format: Date | Figure | Trace | Scheduler/Placement | Load | Seed | Roundsr
        assert '| Alibaba |' in entry['label']
        assert '| Mmf/Bestfit |' in entry['label']
        assert '| 453r' in entry['label']

    def test_build_entry_validates(self):
        with pytest.raises(ValueError):
            build_manifest_entry(
                file='test.viz.bin',
                filters={
                    'date': '2026-02-21', 'trace': 'alibaba', 'figure': 'bad-figure',
                    'scheduler': 'mmf', 'placement': 'strided', 'load': '60jph', 'seed': 's0',
                },
                rounds=100, complete=True,
            )
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/varunr/projects/courses/stanford/cs244c && python -m pytest gpu-scheduling-viz/tests/test_experiment_schema.py -v`
Expected: FAIL (module does not exist)

**Step 3: Write the schema module**

Create `tools/experiment_schema.py`:

```python
"""Experiment metadata schema -- single source of truth for filter validation.

All scripts that write to manifest.json must import from here.
"""
import re

# Canonical allowed values
TRACES = {'philly', 'alibaba'}
FIGURES = {'gavel-fig9', 'gavel-fig10', 'gavel-fig11', 'fgd-fig7', 'fgd-fig9'}
SCHEDULERS = {'mmf', 'fifo', 'gavel', 'packed'}
PLACEMENTS = {'strided', 'random', 'bestfit', 'fgd'}

REQUIRED_FIELDS = {'date', 'trace', 'figure', 'scheduler', 'placement', 'load', 'seed'}

_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
_LOAD_RE = re.compile(r'^\d+(\.\d+)?jph$')
_SEED_RE = re.compile(r'^s\d+$')

# Maps for migrating old algorithm field to (scheduler, placement)
ALGORITHM_MIGRATION = {
    'gavel': ('gavel', 'strided'),
    'baseline': ('mmf', 'strided'),
    'gavel-random': ('gavel', 'random'),
    'gavel-bestfit': ('gavel', 'bestfit'),
    'gavel+fgd': ('gavel', 'fgd'),
    'fgd': ('mmf', 'fgd'),
    'bestfit': ('mmf', 'bestfit'),
    'random': ('mmf', 'random'),
    'strided': ('mmf', 'strided'),
    'fifo': ('fifo', 'strided'),
    'packed': ('packed', 'strided'),
}

FIGURE_MIGRATION = {
    'fig9': 'gavel-fig9',
    'fig10': 'gavel-fig10',
    'fig11': 'gavel-fig11',
    'fgd-placement': 'fgd-fig7',
    'fgd-replication': 'fgd-fig7',
    'fgd-replication-fifo': 'fgd-fig7',
    'fgd-scale': 'fgd-fig9',
}

LOAD_MIGRATION = {
    'low-load': '1.0jph',
    'mid-load': '4.0jph',
    'high-load': '7.0jph',
}


def validate_filters(filters):
    """Validate experiment filters dict. Returns the dict unchanged, or raises ValueError."""
    if 'algorithm' in filters:
        raise ValueError(
            f"Old 'algorithm' field found (value: {filters['algorithm']!r}). "
            f"Use 'scheduler' + 'placement' instead. "
            f"See ALGORITHM_MIGRATION for mappings."
        )

    for field in REQUIRED_FIELDS:
        if field not in filters:
            raise ValueError(f"Missing required field '{field}'. Required: {sorted(REQUIRED_FIELDS)}")

    f = filters
    if f['trace'] not in TRACES:
        raise ValueError(f"Invalid trace {f['trace']!r}. Allowed: {sorted(TRACES)}")
    if f['figure'] not in FIGURES:
        raise ValueError(f"Invalid figure {f['figure']!r}. Allowed: {sorted(FIGURES)}")
    if f['scheduler'] not in SCHEDULERS:
        raise ValueError(f"Invalid scheduler {f['scheduler']!r}. Allowed: {sorted(SCHEDULERS)}")
    if f['placement'] not in PLACEMENTS:
        raise ValueError(f"Invalid placement {f['placement']!r}. Allowed: {sorted(PLACEMENTS)}")
    if not _DATE_RE.match(f['date']):
        raise ValueError(f"Invalid date {f['date']!r}. Expected YYYY-MM-DD format.")
    if not _LOAD_RE.match(f['load']):
        raise ValueError(f"Invalid load {f['load']!r}. Expected '<number>jph' (e.g. '60jph', '0.8jph').")
    if not _SEED_RE.match(f['seed']):
        raise ValueError(f"Invalid seed {f['seed']!r}. Expected 's<N>' (e.g. 's0', 's1').")

    return filters


def build_manifest_entry(file, filters, rounds, complete):
    """Build a validated manifest entry with auto-generated label.

    Args:
        file: Relative path to .viz.bin file (e.g. 'fgd_replication/foo.viz.bin')
        filters: Dict with all 7 required fields
        rounds: Number of simulation rounds
        complete: Whether the simulation completed
    Returns:
        Dict ready to append to manifest['experiments']
    """
    validate_filters(filters)

    f = filters
    label = (
        f"{f['date']} | {f['figure']} | {f['trace'].capitalize()} | "
        f"{f['scheduler'].capitalize()}/{f['placement'].capitalize()} | "
        f"{f['load']} | {f['seed']} | {rounds}r"
    )
    return {
        'file': file,
        'label': label,
        'filters': dict(filters),
        'rounds': rounds,
        'complete': complete,
    }
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/varunr/projects/courses/stanford/cs244c && python -m pytest gpu-scheduling-viz/tests/test_experiment_schema.py -v`
Expected: All 14 tests PASS

**Step 5: Commit**

```bash
cd /Users/varunr/projects/courses/stanford/cs244c/gpu-scheduling-viz
git add tools/experiment_schema.py tests/test_experiment_schema.py
git commit -m "Add experiment_schema module with validation and migration maps"
```

---

### Task 2: Migrate existing manifest entries

**Files:**
- Modify: `tools/standardize_labels.py` (complete rewrite -- becomes migration script)
- Test: Run migration, then validate output

**Step 1: Write a test that validates the migrated manifest**

Add to `tests/test_experiment_schema.py`:

```python
class TestMigrationMaps:
    """Verify migration maps cover all old values in the manifest."""

    def test_all_old_algorithms_mapped(self):
        old_algos = {
            'gavel', 'baseline', 'gavel-random', 'gavel-bestfit', 'gavel+fgd',
            'fgd', 'bestfit', 'random', 'strided', 'fifo', 'packed',
        }
        from viz.tools.experiment_schema import ALGORITHM_MIGRATION
        assert old_algos == set(ALGORITHM_MIGRATION.keys())

    def test_all_old_figures_mapped(self):
        old_figs = {
            'fig9', 'fig10', 'fig11', 'fgd-placement',
            'fgd-replication', 'fgd-replication-fifo', 'fgd-scale',
        }
        from viz.tools.experiment_schema import FIGURE_MIGRATION
        assert old_figs == set(FIGURE_MIGRATION.keys())

    def test_all_named_loads_mapped(self):
        from viz.tools.experiment_schema import LOAD_MIGRATION
        assert set(LOAD_MIGRATION.keys()) == {'low-load', 'mid-load', 'high-load'}

    def test_algorithm_targets_are_valid(self):
        from viz.tools.experiment_schema import ALGORITHM_MIGRATION, SCHEDULERS, PLACEMENTS
        for algo, (sched, place) in ALGORITHM_MIGRATION.items():
            assert sched in SCHEDULERS, f"{algo} -> scheduler {sched!r} not in SCHEDULERS"
            assert place in PLACEMENTS, f"{algo} -> placement {place!r} not in PLACEMENTS"

    def test_figure_targets_are_valid(self):
        from viz.tools.experiment_schema import FIGURE_MIGRATION, FIGURES
        for old, new in FIGURE_MIGRATION.items():
            assert new in FIGURES, f"{old} -> {new!r} not in FIGURES"
```

**Step 2: Run tests to verify they pass**

Run: `cd /Users/varunr/projects/courses/stanford/cs244c && python -m pytest gpu-scheduling-viz/tests/test_experiment_schema.py::TestMigrationMaps -v`
Expected: PASS (maps are already correct from Task 1)

**Step 3: Rewrite `standardize_labels.py` as a one-time migration**

Replace the entire contents of `tools/standardize_labels.py` with:

```python
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
    REQUIRED_FIELDS, validate_filters, build_manifest_entry,
)


def migrate_entry(exp):
    """Migrate a single experiment entry. Returns new entry dict or None to skip."""
    filters = exp.get('filters', {})
    file = exp['file']
    rounds = exp.get('rounds', 0)
    complete = exp.get('complete', True)

    # Already migrated? (has scheduler + placement, no algorithm)
    if 'scheduler' in filters and 'placement' in filters and 'algorithm' not in filters:
        # Validate and rebuild label
        try:
            return build_manifest_entry(file, filters, rounds, complete)
        except ValueError:
            return None  # skip invalid

    # Need migration: must have algorithm (or be a workbench entry)
    algorithm = filters.get('algorithm')
    if algorithm is None:
        return None  # skip entries without algorithm (workbench, etc.)

    # Map algorithm -> (scheduler, placement)
    if algorithm not in ALGORITHM_MIGRATION:
        return None  # unknown algorithm, skip
    scheduler, placement = ALGORITHM_MIGRATION[algorithm]

    # Map figure
    old_figure = filters.get('figure', '')
    figure = FIGURE_MIGRATION.get(old_figure)
    if figure is None:
        return None  # unknown figure, skip

    # Map load
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
    # Run from tools/ directory so relative import works
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
```

**Step 4: Run the migration**

Run: `cd /Users/varunr/projects/courses/stanford/cs244c/gpu-scheduling-viz/tools && python standardize_labels.py`
Expected output: `Migrated ~773 experiments, skipped 1` (the workbench entry).

**Step 5: Validate the migrated manifest**

Run: `cd /Users/varunr/projects/courses/stanford/cs244c && python -c "
import json
from viz.tools.experiment_schema import validate_filters
with open('gpu-scheduling-viz/data/manifest.json') as f:
    m = json.load(f)
errors = 0
for e in m['experiments']:
    try:
        validate_filters(e['filters'])
    except ValueError as err:
        print(f'INVALID: {e[\"file\"]}: {err}')
        errors += 1
print(f'{len(m[\"experiments\"])} entries, {errors} errors')
"`
Expected: `~773 entries, 0 errors`

**Step 6: Verify no old `algorithm` field remains**

Run: `cd /Users/varunr/projects/courses/stanford/cs244c && python -c "
import json
with open('gpu-scheduling-viz/data/manifest.json') as f:
    m = json.load(f)
bad = [e['file'] for e in m['experiments'] if 'algorithm' in e.get('filters', {})]
print(f'{len(bad)} entries still have algorithm field')
"`
Expected: `0 entries still have algorithm field`

**Step 7: Commit**

```bash
cd /Users/varunr/projects/courses/stanford/cs244c/gpu-scheduling-viz
git add tools/standardize_labels.py data/manifest.json tests/test_experiment_schema.py
git commit -m "Migrate manifest to 7-field schema (scheduler + placement)"
```

---

### Task 3: Update `update_manifest_fgd_repl.py` to use schema

**Files:**
- Modify: `tools/update_manifest_fgd_repl.py`

**Step 1: Update the script to import and use `build_manifest_entry`**

In `tools/update_manifest_fgd_repl.py`, make these changes:

1. Add import at top (after existing imports):
```python
from experiment_schema import build_manifest_entry
```

2. Replace the PLACEMENT_LABELS dict (lines 28-33):
```python
# No longer needed -- placement values are lowercase schema values
```

3. Replace `SCHED_LABELS` and `FIGURE_NAMES` (lines 84-85):
```python
SCHED_TO_SCHEDULER = {'mmf': 'mmf', 'fifo': 'fifo'}
```

4. Replace the entry-building block (lines 102-115) with:
```python
        entry = build_manifest_entry(
            file=f"fgd_replication/{viz_file.name}",
            filters={
                'date': '2026-02-21',
                'trace': 'alibaba',
                'figure': 'fgd-fig7',
                'scheduler': SCHED_TO_SCHEDULER.get(sched, sched),
                'placement': placement,
                'load': f'{rate}jph',
                'seed': f's{seed}',
            },
            rounds=rounds,
            complete=True,
        )
```

5. Update the filter check on line 81 to match new figure name:
```python
        if e.get('filters', {}).get('figure') != 'fgd-fig7'
        # (keep all non-fgd-fig7 entries, then also filter by date to only remove
        #  the 2026-02-21 entries we're regenerating)
```

Actually, simpler: remove entries matching both `figure=fgd-fig7` AND `date=2026-02-21`:
```python
    manifest['experiments'] = [
        e for e in manifest['experiments']
        if not (e.get('filters', {}).get('figure') == 'fgd-fig7'
                and e.get('filters', {}).get('date') == '2026-02-21')
    ]
```

**Step 2: Run the script to verify it works**

Run: `cd /Users/varunr/projects/courses/stanford/cs244c/gpu-scheduling-viz && python tools/update_manifest_fgd_repl.py`
Expected: `Added N FGD replication entries to manifest.json`

**Step 3: Validate manifest after update**

Run: `cd /Users/varunr/projects/courses/stanford/cs244c && python -c "
import json
from viz.tools.experiment_schema import validate_filters
with open('gpu-scheduling-viz/data/manifest.json') as f:
    m = json.load(f)
for e in m['experiments']:
    validate_filters(e['filters'])
print(f'All {len(m[\"experiments\"])} entries valid')
"`

**Step 4: Commit**

```bash
cd /Users/varunr/projects/courses/stanford/cs244c/gpu-scheduling-viz
git add tools/update_manifest_fgd_repl.py data/manifest.json
git commit -m "Update update_manifest_fgd_repl to use experiment_schema"
```

---

### Task 4: Update `build_results_manifest.py` to use new field names

**Files:**
- Modify: `tools/build_results_manifest.py`

The results section of the manifest uses its own structure (keyed by `gavel`/`fgd` with sub-figures). It doesn't use the experiment `filters` at all -- it reads from Gavel CSV and FGD JSON results files. However, any future updates should use consistent naming.

**Step 1: Check if `build_results_manifest.py` references the old filter field names**

It does not reference experiment filters directly. The `results` section has its own figure keys (`fig9`, `fig10`, `fig11`, `fig7a`, `fig7b`, `fig9a`, `fig9b`) that are display-oriented, not filter-oriented. These are consumed by the results dashboard JS, not the experiment picker.

**Decision:** Leave `build_results_manifest.py` unchanged for now. The results section serves a different purpose (chart rendering config) and its keys (`fig9`, `fig7a`) are internal to the results dashboard, not filter values. Renaming them would require updating the results dashboard JS with no functional benefit.

**Step 2: Add a comment at the top noting the distinction**

Add after the module docstring (line 8):

```python
# NOTE: The results section uses its own figure keys (fig9, fig7a, etc.) that are
# display-oriented for the results dashboard. These are NOT the same as experiment
# filter figure values (gavel-fig9, fgd-fig7, etc.) defined in experiment_schema.py.
```

**Step 3: Commit**

```bash
cd /Users/varunr/projects/courses/stanford/cs244c/gpu-scheduling-viz
git add tools/build_results_manifest.py
git commit -m "Add note distinguishing results keys from experiment filter schema"
```

---

### Task 5: Update `preprocess_viz.py` to accept and validate metadata

**Files:**
- Modify: `tools/preprocess_viz.py:222-521` (function signature + CLI)
- Modify: `tests/test_preprocess_viz.py` (update existing test)

**Step 1: Write a test for metadata validation in preprocess_simulation**

Add to `tests/test_preprocess_viz.py`:

```python
def test_preprocess_rejects_bad_metadata():
    """preprocess_simulation should reject invalid metadata when provided."""
    import pytest
    with tempfile.TemporaryDirectory() as tmpdir:
        log_path = os.path.join(tmpdir, 'simulation.log')
        output_path = os.path.join(tmpdir, 'output.viz.bin')
        with open(log_path, 'w') as f:
            f.write(SAMPLE_LOG)
        with pytest.raises(ValueError, match='figure'):
            preprocess_simulation(
                log_path=log_path, output_path=output_path,
                cluster_spec="4:4:4", measurement_window=(0, 100),
                metadata={
                    'date': '2026-02-07', 'trace': 'philly',
                    'figure': 'bad-figure',  # invalid
                    'scheduler': 'mmf', 'placement': 'strided',
                    'load': '1.0jph', 'seed': 's0',
                },
            )
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/varunr/projects/courses/stanford/cs244c && python -m pytest gpu-scheduling-viz/tests/test_preprocess_viz.py::test_preprocess_rejects_bad_metadata -v`
Expected: FAIL (metadata param does not exist)

**Step 3: Add `metadata` parameter to `preprocess_simulation`**

In `tools/preprocess_viz.py`:

1. Add import at top (after line 9):
```python
from viz.tools.experiment_schema import validate_filters
```

2. Add `metadata=None` parameter to `preprocess_simulation` (line 222):
```python
def preprocess_simulation(
    log_path: str,
    output_path: str,
    cluster_spec: str = "36:36:36",
    measurement_window: Tuple[int, int] = (4000, 5000),
    policy: str = "unknown",
    gpus_per_node: int = 1,
    max_rounds: int = 0,
    metadata: dict = None,
) -> None:
```

3. Add validation at the start of the function (after the docstring, before line 242):
```python
    if metadata is not None:
        validate_filters(metadata)
```

4. Add metadata CLI args to `__main__` block (after line 499, before `args = parser.parse_args()`):
```python
    parser.add_argument('--figure', help='Figure reference (e.g. gavel-fig9, fgd-fig7)')
    parser.add_argument('--scheduler', help='Scheduler (mmf, fifo, gavel, packed)')
    parser.add_argument('--placement', help='Placement (strided, random, bestfit, fgd)')
    parser.add_argument('--trace', help='Trace (philly, alibaba)')
    parser.add_argument('--date', help='Experiment date (YYYY-MM-DD)')
    parser.add_argument('--seed', help='Seed (s0, s1, s2)')
    parser.add_argument('--load', help='Load (e.g. 60jph, 0.8jph)')
```

5. Build metadata dict in `__main__` (before the `preprocess_simulation` call):
```python
    metadata = None
    if args.figure:  # if any metadata field provided, require all
        metadata = {
            'date': args.date, 'trace': args.trace, 'figure': args.figure,
            'scheduler': args.scheduler, 'placement': args.placement,
            'load': args.load, 'seed': args.seed,
        }
```

6. Pass to `preprocess_simulation`:
```python
        metadata=metadata,
```

**Step 4: Run tests**

Run: `cd /Users/varunr/projects/courses/stanford/cs244c && python -m pytest gpu-scheduling-viz/tests/test_preprocess_viz.py -v`
Expected: All tests PASS (existing tests unaffected since metadata=None by default)

**Step 5: Commit**

```bash
cd /Users/varunr/projects/courses/stanford/cs244c/gpu-scheduling-viz
git add tools/preprocess_viz.py tests/test_preprocess_viz.py
git commit -m "Add metadata validation to preprocess_simulation"
```

---

### Task 6: Update `batch_convert_viz.py` to pass metadata

**Files:**
- Modify: `/Users/varunr/projects/courses/stanford/cs244c/gavel/experiments/combined/scripts/batch_convert_viz.py`

This file lives in the gavel repo but calls `preprocess_simulation`. It should pass validated metadata.

**Step 1: Update the script**

1. Add import:
```python
from viz.tools.experiment_schema import build_manifest_entry
```

2. After building the `policy` variable (line 84), build metadata:
```python
        # Build metadata for schema validation
        placement = exp.get('fgd_placement_mode', 'strided')
        scheduler = 'fifo' if exp.get('scheduler') == 'fifo' else 'mmf'
        if exp.get('use_gavel', False):
            scheduler = 'gavel'
```

3. Pass metadata to `preprocess_simulation` (requires knowing figure, date, trace, load, seed from the config -- these must be provided by the caller or the config).

**Decision:** This is a batch script run manually. Rather than inferring all 7 fields from the config (which may not have all of them), the simpler approach is to add CLI args `--figure`, `--scheduler-default`, `--trace`, `--date` to the batch script. The per-experiment fields (placement, load, seed) come from the config.

This is a straightforward but config-specific change. Defer to implementation time to wire up the exact config field names.

**Step 2: Commit**

```bash
cd /Users/varunr/projects/courses/stanford/cs244c/gavel
git add experiments/combined/scripts/batch_convert_viz.py
git commit -m "Pass experiment metadata through batch_convert_viz"
```

---

### Task 7: Update viz.js filter groups

**Files:**
- Modify: `src/viz.js` (lines 31-34, 406-418, and all `algorithm` references)

**Step 1: Update `_filterGroups` and `_activeFilters`**

At line 31, change:
```javascript
this._filterGroups = ['date', 'trace', 'figure', 'scheduler', 'placement', 'load', 'seed'];
```

At lines 32-34, update `_activeFilters` init:
```javascript
this._activeFilters = [
    { date: new Set(), trace: new Set(), figure: new Set(), scheduler: new Set(), placement: new Set(), load: new Set(), seed: new Set() },
    { date: new Set(), trace: new Set(), figure: new Set(), scheduler: new Set(), placement: new Set(), load: new Set(), seed: new Set() },
];
```

**Step 2: Update `groupLabels` (line 406)**

```javascript
const groupLabels = { date: 'Date', trace: 'Trace', figure: 'Figure', scheduler: 'Sched', placement: 'Place', load: 'Load', seed: 'Seed' };
```

**Step 3: Update `groupHelp` (lines 407-418)**

Replace the `algorithm` help object with two objects:

```javascript
const groupHelp = {
    scheduler: {
        'mmf': 'Max-min fairness -- default fair-share scheduling',
        'gavel': 'Gavel -- optimized heterogeneity-aware scheduling',
        'fifo': 'First-in-first-out scheduling (Tiresias)',
        'packed': 'Max-min fairness with job packing across GPU types',
    },
    placement: {
        'strided': 'Round-robin GPU assignment (default)',
        'random': 'Random GPU placement',
        'bestfit': 'Best-fit bin packing',
        'fgd': 'Fragmentation Gradient Descent placement',
    },
};
```

**Step 4: Verify in browser**

Open `index.html` in browser, check that:
- Filter chips show 7 groups: Date, Trace, Figure, Sched, Place, Load, Seed
- Clicking chips filters experiments correctly
- Help popups work for Sched and Place groups
- Experiment dropdown populates with filtered results

**Step 5: Commit**

```bash
cd /Users/varunr/projects/courses/stanford/cs244c/gpu-scheduling-viz
git add src/viz.js
git commit -m "Update filter UI from algorithm to scheduler + placement"
```

---

### Task 8: Run full test suite and validate end-to-end

**Step 1: Run all Python tests**

Run: `cd /Users/varunr/projects/courses/stanford/cs244c && python -m pytest gpu-scheduling-viz/tests/ -v`
Expected: All tests PASS

**Step 2: Validate entire manifest**

Run: `cd /Users/varunr/projects/courses/stanford/cs244c && python -c "
import json
from viz.tools.experiment_schema import validate_filters
with open('gpu-scheduling-viz/data/manifest.json') as f:
    m = json.load(f)
for e in m['experiments']:
    validate_filters(e['filters'])
print(f'All {len(m[\"experiments\"])} entries valid')
assert not any('algorithm' in e.get('filters', {}) for e in m['experiments']), 'Old algorithm field found!'
print('No old algorithm fields. Schema enforcement complete.')
"`

**Step 3: Visual verification in browser**

Open `gpu-scheduling-viz/index.html` and verify filters work.
