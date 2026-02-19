# Interactive Results Dashboard Design

**Date:** 2026-02-18
**Status:** Approved

## Overview

Add an interactive "Results" tab to the GPU scheduling viz tool that shows
aggregate experiment results (JCT-vs-rate for Gavel, fragmentation-vs-demand
for FGD) driven by the existing filter system. Filters become dynamic/cascading
so unavailable options are hidden. Clicking a data point loads the corresponding
experiment into the per-experiment viewer for drill-down.

## Requirements

1. **Results tab**: New tab alongside "Charts" and "Heatmap & Metrics"
2. **Gavel figures**: Figs 9, 10, 11 (JCT vs arrival rate), stacked vertically
3. **FGD figures**: Figs 7a, 7b, 9a, 9b (fragmentation metrics vs demand),
   stacked vertically
4. **Dynamic filters**: Selecting a value in one filter group hides values in
   other groups that would produce zero results. Show match counts.
5. **Click-to-drill-down**: Click a data point to load the corresponding
   .viz.bin into Sim 1 (shift+click for Sim 2)
6. **Paper reference overlay**: Dashed lines from digitized paper curves

## Data Model: Manifest Extension

The manifest changes from a flat array to a structured object:

```json
{
  "experiments": [ ...existing 413 entries... ],
  "results": {
    "gavel": {
      "fig9": {
        "title": "Figure 9: Single-GPU Jobs (Max-Min Fairness / LAS)",
        "x_label": "Input Job Rate (jobs/hr)",
        "y_label": "Average JCT (hours)",
        "curves": {
          "max_min_fairness": {
            "label": "Baseline",
            "color": "#e74c3c",
            "data": [
              {
                "x": 0.4,
                "y": 25.1,
                "std": 1.2,
                "files": [
                  "gavel_replication/gavel_repl_fig9_max_min_fairness_0.4jph_single_s0.viz.bin",
                  "gavel_replication/gavel_repl_fig9_max_min_fairness_0.4jph_single_s1.viz.bin",
                  "gavel_replication/gavel_repl_fig9_max_min_fairness_0.4jph_single_s2.viz.bin"
                ]
              }
            ]
          },
          "max_min_fairness_perf": {
            "label": "Gavel",
            "color": "#2ecc71",
            "data": [ ... ]
          }
        },
        "reference": {
          "x": [0.5, 1.0, 1.5, ...],
          "baseline": [24.0, 25.1, ...],
          "gavel": [23.5, 24.0, ...]
        }
      },
      "fig10": { ... },
      "fig11": { ... }
    },
    "fgd": {
      "fig7a": {
        "title": "Figure 7a: Fragmentation Rate vs Demand",
        "x_label": "Demand (% cluster capacity)",
        "y_label": "Fragmentation Rate (%)",
        "curves": { ... },
        "reference": { ... }
      },
      "fig7b": { ... },
      "fig9a": { ... },
      "fig9b": { ... }
    }
  }
}
```

Each data point includes `files` (the .viz.bin paths for that rate/seed combo)
to enable click-to-drill-down. Pre-aggregated mean and std across seeds.

A Python script generates this section from the existing CSV/JSON result files
and paper reference curves.

## Dynamic / Cascading Filters

Standard faceted search algorithm:

1. When any filter changes, compute the set of experiments matching current
   selections.
2. For each filter group G, temporarily ignore G's selection and count how many
   matching experiments have each value in G.
3. Hide buttons with zero matches. Show match counts on remaining buttons.
4. The same filter state drives both the experiment dropdown AND the results
   charts.

**Example cascade:**
- Select `philly` under Trace: hides `combined` in Type (no combined
  experiments on Philly). Hides Alibaba-only rates (60jph, 180jph, 360jph)
  in Load. Hides `2026-02-07` in Date (all Alibaba).
- Select `gavel` under Type: Load shows only 0.2-8.0 jph. Results tab shows
  Figs 9/10/11.

## Results Tab UI

### Layout

Vertically stacked subplots, one per figure. Full content width per chart.

When `gavel` + `philly` is selected:
```
+-----------------------------------------------------------+
|  Figure 9: Single-GPU Jobs (Max-Min Fairness / LAS)       |
|  JCT (hrs) vs Input Job Rate (jph)                        |
|  -- paper baseline  -- paper gavel                        |
|  o  our baseline    o  our gavel                          |
+-----------------------------------------------------------+
|  Figure 10: Multi-GPU Jobs (Max-Min Fairness / LAS)       |
|  ...                                                       |
+-----------------------------------------------------------+
|  Figure 11: Multi-GPU Jobs (Finish-Time Fairness)         |
|  ...                                                       |
+-----------------------------------------------------------+
```

When `fgd` + `alibaba` is selected:
```
+-----------------------------------------------------------+
|  Figure 7a: Fragmentation Rate vs Demand                  |
+-----------------------------------------------------------+
|  Figure 7b: Frag/Total vs Demand                          |
+-----------------------------------------------------------+
|  Figure 9a: Unallocated GPU % vs Demand                   |
+-----------------------------------------------------------+
|  Figure 9b: Occupied Nodes vs Demand                      |
+-----------------------------------------------------------+
```

### Chart rendering

Reuse the existing Canvas-based `TimeSeriesChart` class. Each subplot gets its
own Canvas element.

- **Our data:** Solid lines with markers. Shaded region for +/- std.
- **Paper reference:** Dashed lines, 40% alpha.
- **Hover:** Crosshair shows exact values at that x-coordinate across all
  curves.
- **Click:** Loads closest matching .viz.bin into Sim 1 (shift+click for
  Sim 2). Switches to Charts tab for per-experiment timeline.
- **Empty state:** "Select a type and trace to view aggregate results."

### Color scheme

Gavel:
- Baseline: #e74c3c (red), marker: square
- Gavel: #2ecc71 (green), marker: circle
- Packed: #3498db (blue), marker: triangle

FGD:
- Random: #e74c3c
- Clustering: #f39c12
- Dot-Product: #9b59b6
- GPU-Packing: #3498db
- Best-Fit: #1abc9c
- FGD: #2ecc71

## Files Changed

| File | Change |
|------|--------|
| `data/manifest.json` | Wrap experiments in `{experiments: [...], results: {...}}` |
| `src/viz.js` | Add Results tab, cascading filter logic, drill-down handler |
| `src/viz.css` | Results tab layout, chart container styles |
| `index.html` | Add Results tab button and content container |
| `tools/build_results_manifest.py` | New script: reads CSV/JSON, outputs results section |

## Pre-computation Script

`tools/build_results_manifest.py` reads:
- `gavel/experiments/combined/results/gavel_replication_combined.csv`
- `gavel/experiments/fgd-standalone/results/full_run/all_results.json`
- Paper reference JSONs for both Gavel and FGD

Outputs the `results` section of manifest.json. Run once after experiments
complete; re-run when new data arrives.

## Decisions

- **Vertical stacking** over side-by-side: more horizontal space per chart
- **Manifest-embedded data** over runtime CSV loading: single fetch, no parsing
- **Reuse TimeSeriesChart** over new chart library: consistent look, no deps
- **Faceted search** for cascading filters: standard UX pattern
- **Click-to-drill-down**: connects aggregate view to per-experiment detail
