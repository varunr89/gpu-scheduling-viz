# Experiment Metadata Schema Enforcement

**Date:** 2026-02-27
**Status:** Approved

## Problem

The manifest.json has 774 experiments with inconsistent metadata. The `algorithm` field conflates scheduling policy and placement strategy (e.g., `gavel-random` vs `bestfit`). Figure names mix conventions (`fig9` vs `fgd-placement` vs `fgd-replication-fifo`). Load values use both numeric (`60jph`) and named (`high-load`) formats. A workbench-generated entry uses a completely different filter schema. This prevents reliable filtering in the viz tool.

## Schema

7 filter fields (splitting the old `algorithm` into `scheduler` + `placement`):

| Field       | Allowed Values                                                   | Format            |
|-------------|------------------------------------------------------------------|-------------------|
| `date`      | Any valid date                                                   | `YYYY-MM-DD`      |
| `trace`     | `philly`, `alibaba`                                              | lowercase enum     |
| `figure`    | `gavel-fig9`, `gavel-fig10`, `gavel-fig11`, `fgd-fig7`, `fgd-fig9` | paper reference |
| `scheduler` | `mmf`, `fifo`, `gavel`, `packed`                                 | lowercase enum     |
| `placement` | `strided`, `random`, `bestfit`, `fgd`                            | lowercase enum     |
| `load`      | Numeric with jph suffix                                          | `<number>jph`      |
| `seed`      | Seed identifier                                                  | `s<N>`             |

### Figure Mapping

| Old Value            | New Value      | Meaning                        |
|----------------------|----------------|--------------------------------|
| `fig9`               | `gavel-fig9`   | Single-GPU JCT vs load         |
| `fig10`              | `gavel-fig10`  | Multi-GPU JCT vs load          |
| `fig11`              | `gavel-fig11`  | Makespan vs load               |
| `fgd-placement`      | `fgd-fig7`     | Placement comparison @ load    |
| `fgd-replication`    | `fgd-fig7`     | Same (MMF scheduler)           |
| `fgd-replication-fifo` | `fgd-fig7`   | Same (FIFO scheduler)          |
| `fgd-scale`          | `fgd-fig9`     | Load sweep / scale behavior    |

### Algorithm-to-Scheduler/Placement Mapping

| Old `algorithm`  | New `scheduler` | New `placement` |
|------------------|-----------------|-----------------|
| `gavel`          | `gavel`         | `strided`       |
| `baseline`       | `mmf`           | `strided`       |
| `gavel-random`   | `gavel`         | `random`        |
| `gavel-bestfit`  | `gavel`         | `bestfit`       |
| `gavel+fgd`      | `gavel`         | `fgd`           |
| `fgd`            | `mmf`           | `fgd`           |
| `bestfit`        | `mmf`           | `bestfit`       |
| `random`         | `mmf`           | `random`        |
| `strided`        | `mmf`           | `strided`       |
| `fifo`           | `fifo`          | `strided`       |
| `packed`         | `packed`        | `strided`       |

### Named Load Mapping

| Old Value    | New Value |
|--------------|-----------|
| `low-load`   | `1.0jph`  |
| `mid-load`   | `4.0jph`  |
| `high-load`  | `7.0jph`  |

### Label Format

`Date | Figure | Trace | Scheduler/Placement | Load | Seed | Roundsr`

Example: `2026-02-07 | fgd-fig7 | Alibaba | Gavel/Random | 60jph | s0 | 4766r`

## Enforcement Architecture

### New module: `tools/experiment_schema.py`

Single source of truth for allowed values and validation.

- `TRACES`, `FIGURES`, `SCHEDULERS`, `PLACEMENTS` -- canonical value sets
- `validate_filters(filters)` -- validates all fields, raises `ValueError` on invalid data
- `build_manifest_entry(file, filters, rounds, complete)` -- validates then builds entry with auto-generated label

### Enforcement points

1. **`preprocess_viz.py`** -- `preprocess_simulation()` gains metadata params (`figure`, `scheduler`, `placement`, `trace`, `date`, `seed`, `load`). Calls `validate_filters()` before writing.

2. **`update_manifest_fgd_repl.py`** -- parses filenames into new schema fields, calls `build_manifest_entry()`.

3. **`standardize_labels.py`** -- becomes a one-time migration script. Rewrites all 774 existing entries using the mappings above.

4. **Workbench** -- any workbench-generated experiments must pass through `validate_filters()`.

### JS changes

`viz.js` filter groups change from `['date', 'trace', 'figure', 'algorithm', 'load', 'seed']` to `['date', 'trace', 'figure', 'scheduler', 'placement', 'load', 'seed']`. Filter chip labels update. No JS-side validation needed -- Python enforces at write time.

## Migration Strategy

1. Create `tools/experiment_schema.py` with canonical values and validation
2. Update `standardize_labels.py` to migrate all 774 entries to new schema
3. Run migration, verify no entries retain the old `algorithm` field
4. Update `update_manifest_fgd_repl.py` to use `experiment_schema`
5. Update `preprocess_viz.py` to accept and validate new metadata params
6. Update `viz.js` filter groups and label rendering
7. Update `build_results_manifest.py` to use new field names
