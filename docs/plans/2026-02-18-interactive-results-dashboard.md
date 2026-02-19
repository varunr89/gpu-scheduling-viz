# Interactive Results Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an interactive "Results" tab to the viz tool that shows aggregate experiment results (Gavel Figs 9/10/11 and FGD Figs 7a/7b/9a/9b) driven by cascading filters, with click-to-drill-down into per-experiment views.

**Architecture:** Extend `manifest.json` from a flat experiment array to `{experiments: [...], results: {...}}`. A Python build script pre-aggregates CSV/JSON results into the manifest. A new `ResultsChart` class (canvas-based, similar to `TimeSeriesChart`) renders scatter+line plots with error bars and paper reference overlays. The existing filter system gains cascading behavior (hide unavailable options). Clicking a data point loads the corresponding `.viz.bin` into the per-experiment viewer.

**Tech Stack:** Vanilla JS (ES modules), HTML5 Canvas, Python 3 (build script)

---

### Task 1: Build Results Manifest Script

**Files:**
- Create: `tools/build_results_manifest.py`
- Modify: `data/manifest.json`

**Context:**
- Gavel CSV: `../../gavel/experiments/combined/results/gavel_replication_combined.csv` (312 rows, columns: name, figure, policy, jobs_per_hr, seed, jct_sec, saturated, wall_time_sec, num_completed, multi_gpu)
- FGD JSON: `../../gavel/experiments/fgd-standalone/results/full_run/all_results.json` (18 result objects: 6 policies x 3 seeds, each with 911-point `curve` array)
- Gavel paper reference: `../../gavel/experiments/gavel-replication/scripts/paper_reference_curves.json`
- FGD paper reference: `../../gavel/experiments/fgd-standalone/paper_reference_curves.json`
- Current manifest: `data/manifest.json` (flat array of 413 experiment entries with `filters` objects)

**Step 1: Write the build script**

Create `tools/build_results_manifest.py` that:

1. Reads the current `data/manifest.json` (the experiment entries array)
2. Reads the Gavel CSV and computes per-(figure, policy, jobs_per_hr) stats:
   - Mean JCT (hours) across non-saturated seeds
   - Std JCT across seeds (0 if only one seed)
   - List of `.viz.bin` file paths matching each (figure, policy, rate, seed) combo
   - Skip saturated experiments (same logic as plot script)
3. Reads the FGD JSON and computes per-(figure, policy, demand_pct) stats:
   - Interpolate each policy's 911-point curve to common x-axis (demand_pct 0-130, step 1)
   - Mean/std across 3 seeds at each x-point
   - FGD figures map: fig7a = frag_ratio*100 (frag rate %), fig7b = fragmentation/6212*100 (frag/total %), fig9a = (1-alloc_ratio)*100 (unallocated GPU %), fig9b = occupied_nodes
   - No per-point `.viz.bin` files for FGD (the standalone eval doesn't produce .viz.bin per demand point; it's a single sweep)
4. Reads both paper reference JSONs
5. Writes `data/manifest.json` as:

```json
{
  "experiments": [ ...existing 413 entries unchanged... ],
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
            "marker": "square",
            "data": [
              {"x": 0.4, "y": 25.1, "std": 1.2, "n": 3, "files": ["gavel_replication/...s0.viz.bin", "...s1.viz.bin", "...s2.viz.bin"]}
            ]
          },
          "max_min_fairness_perf": {
            "label": "Gavel",
            "color": "#2ecc71",
            "marker": "circle",
            "data": [...]
          }
        },
        "reference": {
          "x": [0.5, 1.0, ...],
          "curves": {
            "baseline": {"label": "Baseline (paper)", "color": "#e74c3c", "values": [22, 24, ...]},
            "gavel": {"label": "Gavel (paper)", "color": "#2ecc71", "values": [16, 18, ...]}
          }
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
        "curves": {
          "random": {"label": "Random", "color": "#e74c3c", "data": [{"x": 0, "y": 15.0, "std": 0.3}, ...]},
          "gpuclustering": {"label": "Clustering", "color": "#f39c12", "data": [...]},
          "fgd": {"label": "FGD", "color": "#2ecc71", "data": [...]}
        },
        "reference": {
          "x": [0, 10, 20, ...],
          "curves": {
            "random": {"label": "Random (paper)", "color": "#e74c3c", "values": [15, 15, 16, ...]},
            "clustering": {"label": "Clustering (paper)", "color": "#f39c12", "values": [15, 15, 15, ...]},
            "fgd": {"label": "FGD (paper)", "color": "#2ecc71", "values": [14, 14, 14, ...]}
          }
        }
      },
      "fig7b": { ... },
      "fig9a": { ... },
      "fig9b": { ... }
    }
  }
}
```

For Gavel file matching: the manifest experiment entries have `filters.load` (e.g. "0.4jph") and `filters.seed` (e.g. "s0"). Match by constructing the expected filename pattern: `gavel_replication/gavel_repl_{fig}_{policy}_{rate}jph_{type}_s{seed}.viz.bin` where type is "single" for fig9 and "multi" for fig10/fig11.

For FGD curves, subsample to ~50 points (every 2% of demand) to keep the manifest manageable. Include all 6 policies: random, gpuclustering, dotprod, gpupacking, bestfit, fgd.

FGD policy colors:
- random: #e74c3c (red)
- gpuclustering: #f39c12 (orange)
- dotprod: #9b59b6 (purple)
- gpupacking: #3498db (blue)
- bestfit: #1abc9c (teal)
- fgd: #2ecc71 (green)

Gavel policy display:
- fig9: max_min_fairness (Baseline, red, square), max_min_fairness_perf (Gavel, green, circle)
- fig10: max_min_fairness (Baseline, red, square), max_min_fairness_perf (Gavel, green, circle)
- fig11: finish_time_fairness (Baseline, red, square), finish_time_fairness_perf (Gavel, green, circle)

**Step 2: Run the script and verify**

```bash
cd /Users/varunr/projects/courses/stanford/cs244c/gpu-scheduling-viz
python3 tools/build_results_manifest.py
```

Expected: prints summary of curves generated, writes updated `data/manifest.json`. Verify with:

```bash
python3 -c "
import json
with open('data/manifest.json') as f:
    m = json.load(f)
print('experiments:', len(m['experiments']))
print('gavel figures:', list(m['results']['gavel'].keys()))
print('fgd figures:', list(m['results']['fgd'].keys()))
for fig, data in m['results']['gavel'].items():
    for pol, curve in data['curves'].items():
        print(f'  {fig}/{pol}: {len(curve[\"data\"])} points')
"
```

**Step 3: Commit**

```bash
git add tools/build_results_manifest.py data/manifest.json
git commit -m "feat: add build_results_manifest script with pre-aggregated result curves"
```

---

### Task 2: Cascading Filters

**Files:**
- Modify: `src/viz.js:366-500` (the `_loadDefaultData` filter builder and `_updateExperimentList`)

**Context:**
- The manifest is now `{experiments: [...], results: {...}}` so references to `this.manifest` that iterate experiments need updating to `this.manifestExperiments`
- `_activeFilters` is `[{date: Set, type: Set, trace: Set, load: Set, seed: Set}, ...]`
- Filters are shared between both pickers (same tag buttons), but each picker has independent active selections

**Step 1: Update manifest loading**

In `_loadDefaultData` (line ~359), change:
```js
this.manifest = await resp.json();
```
to:
```js
const manifestData = await resp.json();
// Support both old (array) and new (object) manifest formats
if (Array.isArray(manifestData)) {
    this.manifestExperiments = manifestData;
    this.manifestResults = {};
} else {
    this.manifestExperiments = manifestData.experiments || [];
    this.manifestResults = manifestData.results || {};
}
console.log(`Loaded manifest: ${this.manifestExperiments.length} experiments`);
```

Then update all references to `this.manifest` throughout the file to `this.manifestExperiments`. Search and replace occurrences:
- Line ~370: `for (const exp of this.manifest)` -> `for (const exp of this.manifestExperiments)`
- Line ~440: `const filtered = this.manifest.filter(` -> `const filtered = this.manifestExperiments.filter(`
- Line ~459: `filtered.some(e =>` already uses local `filtered`, no change needed

**Step 2: Add cascading filter logic**

After all filter group buttons are built (after the `for (const group of this._filterGroups)` loop, around line ~440), add a method `_updateFilterAvailability(simIndex)` that:

1. Iterates `this.manifestExperiments` to find which experiments match the current filter selections (ignoring one group at a time)
2. For each group, computes the set of values that would produce non-zero results
3. Hides buttons whose value is not in the available set
4. Adds a count badge showing how many experiments match

Add this method to the Controller class:

```js
_updateFilterAvailability(simIndex) {
    const activeFilters = this._activeFilters[simIndex];
    const container = this.expTagContainers[simIndex];
    const groups = container.querySelectorAll('.exp-filter-group');

    groups.forEach((groupEl, groupIdx) => {
        const group = this._filterGroups[groupIdx];
        const buttons = groupEl.querySelectorAll('.exp-tag');

        // For this group, compute available values by filtering
        // with all OTHER groups' selections (not this one)
        const available = new Map(); // value -> count
        for (const exp of this.manifestExperiments) {
            const f = exp.filters || {};
            let matches = true;
            for (const otherGroup of this._filterGroups) {
                if (otherGroup === group) continue;
                const selected = activeFilters[otherGroup];
                if (selected.size === 0) continue;
                if (!selected.has(f[otherGroup])) { matches = false; break; }
            }
            if (matches) {
                const val = f[group];
                available.set(val, (available.get(val) || 0) + 1);
            }
        }

        buttons.forEach(btn => {
            const val = btn.dataset.value;
            const count = available.get(val) || 0;
            if (count === 0 && !btn.classList.contains('active')) {
                btn.style.display = 'none';
            } else {
                btn.style.display = '';
                // Update count badge
                btn.textContent = count > 0 ? `${val} (${count})` : val;
            }
        });
    });
}
```

Call `_updateFilterAvailability(i)` at the end of every filter button click handler (after `_updateExperimentList(i)`), and also after the initial filter build.

**Step 3: Verify cascading works**

Open http://localhost:8080/stanford/cs244c/gpu-scheduling-viz/ in browser.
- Click "philly" under Trace. Verify: alibaba-only load values (60jph, 180jph, 360jph) disappear. Type "combined" disappears.
- Click "gavel" under Type. Verify: only gavel replication rates remain in Load.
- Click "alibaba" under Trace (deselect philly first). Verify: Philly-only rates disappear.

**Step 4: Commit**

```bash
git add src/viz.js
git commit -m "feat: cascading filters hide unavailable options with counts"
```

---

### Task 3: Results Tab HTML and CSS

**Files:**
- Modify: `index.html:77-80` (tab bar) and after line 126 (add results tab content)
- Modify: `src/viz.css` (add results tab styles)

**Step 1: Add Results tab button and content to index.html**

In the tab bar (line 77-80), add a third tab button:
```html
<nav id="tab-bar" class="tab-bar" hidden>
    <button class="tab-btn active" data-tab="charts">Charts</button>
    <button class="tab-btn" data-tab="heatmap">Heatmap & Metrics</button>
    <button class="tab-btn" data-tab="results">Results</button>
</nav>
```

After the tab-charts closing div (line 126), add:
```html
<!-- Tab: Results -->
<div id="tab-results" class="tab-content" hidden>
    <section id="results-section" class="sim-section">
        <div class="results-header">
            <h2 class="sim-title">Aggregate Results</h2>
        </div>
        <div id="results-empty" class="results-empty">
            Select a type and trace to view aggregate results.
        </div>
        <div id="results-charts" class="results-charts"></div>
    </section>
</div>
```

**Step 2: Add CSS for results tab**

Add to `src/viz.css` (after the `.tab-content[hidden]` rule, around line 362):

```css
/* Results Tab */
.results-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
}

.results-empty {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--text-secondary);
    font-size: 0.9rem;
}

.results-charts {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}

.results-chart-container {
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
    overflow: hidden;
    position: relative;
}

.results-chart-container canvas {
    display: block;
    width: 100%;
    cursor: crosshair;
}

.results-chart-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--accent);
    padding: 0.5rem 0.75rem 0.25rem;
}
```

**Step 3: Update tab switching in viz.js**

In `_cacheElements` (around line 101), add:
```js
this.tabResults = document.getElementById('tab-results');
this.resultsSection = document.getElementById('results-section');
this.resultsEmpty = document.getElementById('results-empty');
this.resultsChartsContainer = document.getElementById('results-charts');
```

In `_switchTab` (line ~502-516), add the results tab toggle:
```js
this.tabCharts.hidden = (tab !== 'charts');
this.tabHeatmap.hidden = (tab !== 'heatmap');
this.tabResults.hidden = (tab !== 'results');

if (tab === 'results') {
    this._renderResultsTab();
}
```

**Step 4: Commit**

```bash
git add index.html src/viz.css src/viz.js
git commit -m "feat: add Results tab shell (HTML, CSS, tab switching)"
```

---

### Task 4: ResultsChart Canvas Renderer

**Files:**
- Create: `src/results-chart.js`

**Context:**
- Similar to `TimeSeriesChart` but specialized for scatter+line plots with error bars
- X-axis: numeric (jobs/hr or demand %)
- Y-axis: numeric (JCT hours or fragmentation %)
- Multiple series (policies), each with data points + optional std error bars
- Paper reference overlay (dashed lines)
- Hover crosshair with tooltip
- Click handler that reports the clicked data point

**Step 1: Create the ResultsChart class**

Create `src/results-chart.js` with:
- Constructor: takes canvas element and opts (`title`, `xLabel`, `yLabel`, `onClick` callback)
- `setData(curves, reference)`: curves = array of `{key, label, color, marker, data: [{x,y,std,files}]}`, reference = `{x: [], curves: {key: {label, color, values}}}`
- `render()`: full canvas render: grid, reference curves (dashed, alpha 0.4), data curves (solid with error band), markers, title, legend
- `_computeRanges()`: min/max across all data + reference, yMin always 0, yMax padded 10%
- `_drawGrid()`: 5 Y-ticks, 6 X-ticks, axis labels
- `_drawReferenceCurve()`: dashed line, 40% alpha, skip null values
- `_drawDataCurve()`: shaded error band (alpha 0.12), solid line, markers (circle/square/triangle)
- `_drawLegend()`: horizontal centered legend with line swatches
- `_drawCrosshair()`: vertical crosshair line + tooltip with nearest point values per curve
- `_handleClick()`: find nearest data point, call onClick callback

Marker rendering:
- circle: `ctx.arc(sx, sy, 4, 0, Math.PI * 2)`
- square: `ctx.fillRect(sx - 4, sy - 4, 8, 8)`
- triangle: 3-point path `(sx, sy-5), (sx-4, sy+4), (sx+4, sy+4)`

Error band: draw upper edge (y+std) forward, then lower edge (y-std) backward, close path, fill at alpha 0.12.

**Step 2: Verify the module loads**

Add a temporary `console.log` in `viz.js` to test the import:
```js
import { ResultsChart } from './results-chart.js';
console.log('ResultsChart loaded');
```

Open the page, check the console for the log message, then remove it.

**Step 3: Commit**

```bash
git add src/results-chart.js
git commit -m "feat: add ResultsChart canvas renderer with error bars, reference overlay, click handler"
```

---

### Task 5: Results Tab Rendering Logic

**Files:**
- Modify: `src/viz.js` (add `_renderResultsTab` method and wire up click-to-drill-down)

**Context:**
- `this.manifestResults` contains `{gavel: {fig9: {...}, ...}, fgd: {fig7a: {...}, ...}}`
- `this._activeFilters[0]` has the current filter selections (use picker 0 for results tab)
- Results tab should show Gavel figures when type filter includes "gavel", FGD figures when it includes "fgd"
- Both can show simultaneously if both types are selected (or neither is selected)

**Step 1: Add import and chart storage**

At the top of `viz.js`, add the import:
```js
import { ResultsChart } from './results-chart.js';
```

In the constructor, add:
```js
this._resultsCharts = []; // active ResultsChart instances
```

**Step 2: Implement _renderResultsTab**

Add this method to the Controller class. When clearing the container, use DOM removal instead of setting content directly:

```js
_renderResultsTab() {
    const container = this.resultsChartsContainer;
    const emptyMsg = this.resultsEmpty;

    // Clear previous charts using safe DOM removal
    while (container.firstChild) {
        container.removeChild(container.firstChild);
    }
    this._resultsCharts = [];

    // Determine which result sets to show based on active filter selections
    // Use picker 0's filters as the "global" filter for results
    const typeFilter = this._activeFilters[0].type;
    const showGavel = typeFilter.size === 0 || typeFilter.has('gavel');
    const showFgd = typeFilter.size === 0 || typeFilter.has('fgd');

    const sections = [];
    if (showGavel && this.manifestResults.gavel) {
        for (const [figKey, figData] of Object.entries(this.manifestResults.gavel)) {
            sections.push({ key: figKey, ...figData });
        }
    }
    if (showFgd && this.manifestResults.fgd) {
        for (const [figKey, figData] of Object.entries(this.manifestResults.fgd)) {
            sections.push({ key: figKey, ...figData });
        }
    }

    if (sections.length === 0) {
        emptyMsg.style.display = '';
        return;
    }
    emptyMsg.style.display = 'none';

    for (const section of sections) {
        // Create container
        const wrapper = document.createElement('div');
        wrapper.className = 'results-chart-container';

        const canvas = document.createElement('canvas');
        const containerWidth = container.clientWidth || 900;
        canvas.width = Math.min(containerWidth, 1200);
        canvas.height = 280;
        wrapper.appendChild(canvas);
        container.appendChild(wrapper);

        // Build curve data for ResultsChart
        const curves = [];
        for (const [policyKey, curveData] of Object.entries(section.curves)) {
            curves.push({
                key: policyKey,
                label: curveData.label,
                color: curveData.color,
                marker: curveData.marker || 'circle',
                data: curveData.data,
            });
        }

        const chart = new ResultsChart(canvas, {
            title: section.title,
            xLabel: section.x_label,
            yLabel: section.y_label,
            onClick: (point, curve) => this._onResultsClick(point, curve),
        });
        chart.setData(curves, section.reference || null);
        chart.render();
        this._resultsCharts.push(chart);
    }
}
```

**Step 3: Implement click-to-drill-down**

```js
_onResultsClick(point, curve) {
    if (!point.files || point.files.length === 0) return;

    // Load the first seed's file into Sim 1
    const file = point.files[0];
    const simIndex = 0;

    // Fetch and load the .viz.bin
    fetch(`data/${file}`)
        .then(resp => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return resp.arrayBuffer();
        })
        .then(buf => {
            this._loadFromBuffer(simIndex, buf);
            this.expSelects[simIndex].value = file;
            // Switch to Charts tab to see the per-experiment view
            this._switchTab('charts');
            console.log(`Drilled down to ${file}`);
        })
        .catch(err => {
            console.warn(`Failed to load ${file}:`, err.message);
        });
}
```

**Step 4: Wire up filter changes to re-render results**

In the filter button click handler (inside `_loadDefaultData`), after calling `this._updateExperimentList(i)` and `this._updateFilterAvailability(i)`, add:

```js
if (this.activeTab === 'results') {
    this._renderResultsTab();
}
```

**Step 5: Verify end-to-end**

1. Open the viz tool, click the "Results" tab
2. With no filters: should show all 7 figures (3 Gavel + 4 FGD) stacked vertically
3. Click "gavel" filter: should show only Figs 9/10/11
4. Click "fgd" filter: should show only Figs 7a/7b/9a/9b
5. Click a data point on a Gavel curve: should load the .viz.bin and switch to Charts tab
6. Hover over charts: should show crosshair tooltips

**Step 6: Commit**

```bash
git add src/viz.js
git commit -m "feat: Results tab rendering with filter-driven figure display and click-to-drill-down"
```

---

### Task 6: Polish and Integration Testing

**Files:**
- Modify: `src/viz.js` (minor fixes)
- Modify: `src/viz.css` (responsive adjustments)

**Step 1: Handle edge cases**

- In `_renderResultsTab`, handle the case where `this.manifestResults` is empty (e.g. old manifest format) -- show "No results data available" message
- Ensure the Results tab is visible even when no experiments are loaded (currently tab bar is hidden when no sims loaded)

In `_updateTabLayout` (line ~518), change:
```js
this.tabBar.hidden = (loadedCount === 0);
```
to:
```js
// Always show tab bar if we have results data, even without loaded experiments
this.tabBar.hidden = (loadedCount === 0 && Object.keys(this.manifestResults || {}).length === 0);
```

**Step 2: Full integration test**

Test in browser:
1. Load page -- tab bar should be visible (even before loading a sim)
2. Click Results tab -- all figures shown
3. Toggle filters -- figures update, unavailable options hidden
4. Click a Gavel data point -- loads experiment, switches to Charts tab
5. Go back to Results tab -- charts still rendered
6. Test FGD figures -- reference curves overlay correctly
7. Resize window -- charts resize appropriately

**Step 3: Final commit**

```bash
git add src/viz.js src/viz.css
git commit -m "fix: Results tab polish - edge cases, responsive canvas, tab visibility"
```

---

### Summary of all tasks

| Task | Description | Files |
|------|-------------|-------|
| 1 | Build results manifest script | `tools/build_results_manifest.py`, `data/manifest.json` |
| 2 | Cascading filters | `src/viz.js` |
| 3 | Results tab HTML/CSS shell | `index.html`, `src/viz.css`, `src/viz.js` |
| 4 | ResultsChart canvas renderer | `src/results-chart.js` |
| 5 | Results tab rendering + drill-down | `src/viz.js` |
| 6 | Polish and integration testing | `src/viz.js`, `src/viz.css` |
