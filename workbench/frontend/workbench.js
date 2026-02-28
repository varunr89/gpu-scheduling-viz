/**
 * GPU Scheduling Workbench -- Frontend
 *
 * Single-page app with three tabs: Design, Run, Analyze.
 * Communicates with the workbench backend via REST + WebSocket.
 */

// ================================================================
// Imports (ES module -- viz chart classes for live metrics)
// ================================================================
import { TimeSeriesChart } from '/src/timeseries.js?v=20260228';
import { CDFChart } from '/src/pdf-chart.js?v=20260228';

// ================================================================
// API Client
// ================================================================
const API_BASE = '/api';

export const api = {
    // -- Plugins / Simulators --
    async getSimulators() {
        const resp = await fetch(`${API_BASE}/plugins/simulators`);
        if (!resp.ok) throw new Error(`GET simulators: ${resp.status}`);
        return resp.json();
    },

    async getSchema(simulatorName) {
        const resp = await fetch(`${API_BASE}/plugins/simulators/${encodeURIComponent(simulatorName)}/schema`);
        if (!resp.ok) throw new Error(`GET schema: ${resp.status}`);
        return resp.json();
    },

    async getPresets(simulatorName) {
        const resp = await fetch(`${API_BASE}/plugins/simulators/${encodeURIComponent(simulatorName)}/presets`);
        if (!resp.ok) throw new Error(`GET presets: ${resp.status}`);
        return resp.json();
    },

    // -- Experiment Groups --
    async listGroups() {
        const resp = await fetch(`${API_BASE}/experiments`);
        if (!resp.ok) throw new Error(`GET experiments: ${resp.status}`);
        return resp.json();
    },

    async getGroup(id) {
        const resp = await fetch(`${API_BASE}/experiments/${encodeURIComponent(id)}`);
        if (!resp.ok) throw new Error(`GET group ${id}: ${resp.status}`);
        return resp.json();
    },

    async createGroup(data) {
        const resp = await fetch(`${API_BASE}/experiments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!resp.ok) throw new Error(`POST experiments: ${resp.status}`);
        return resp.json();
    },

    async deleteGroup(id) {
        const resp = await fetch(`${API_BASE}/experiments/${encodeURIComponent(id)}`, {
            method: 'DELETE',
        });
        if (!resp.ok) throw new Error(`DELETE group ${id}: ${resp.status}`);
    },

    // -- Individual Experiments --
    async listExperiments(groupId) {
        const resp = await fetch(`${API_BASE}/experiments/${encodeURIComponent(groupId)}/items`);
        if (!resp.ok) throw new Error(`GET items: ${resp.status}`);
        return resp.json();
    },

    // -- Run --
    async runGroup(id) {
        const resp = await fetch(`${API_BASE}/experiments/${encodeURIComponent(id)}/run`, {
            method: 'POST',
        });
        if (!resp.ok) throw new Error(`POST run: ${resp.status}`);
        return resp.json();
    },

    async cancelGroup(id) {
        const resp = await fetch(`${API_BASE}/experiments/${encodeURIComponent(id)}/cancel`, {
            method: 'POST',
        });
        if (!resp.ok) throw new Error(`POST cancel: ${resp.status}`);
        return resp.json();
    },

    // -- Export --
    async exportGroup(id) {
        const resp = await fetch(`${API_BASE}/experiments/${encodeURIComponent(id)}/export`, {
            method: 'POST',
        });
        if (!resp.ok) throw new Error(`POST export: ${resp.status}`);
        return resp.json();
    },

    // -- Clone --
    async cloneGroup(id) {
        const resp = await fetch(`${API_BASE}/experiments/${encodeURIComponent(id)}/clone`, {
            method: 'POST',
        });
        if (!resp.ok) throw new Error(`POST clone: ${resp.status}`);
        return resp.json();
    },

    // -- WebSocket stream --
    streamEvents(groupId) {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(
            `${protocol}//${location.host}${API_BASE}/experiments/${encodeURIComponent(groupId)}/stream`
        );
        return ws;
    },
};

// ================================================================
// Safe DOM Helpers
// ================================================================

/**
 * Create an element with optional attributes and children.
 * All text is set via textContent (safe against XSS).
 */
function el(tag, attrs = {}, ...children) {
    const elem = document.createElement(tag);
    for (const [key, val] of Object.entries(attrs)) {
        if (key === 'className') {
            elem.className = val;
        } else if (key === 'style' && typeof val === 'object') {
            Object.assign(elem.style, val);
        } else if (key.startsWith('on') && typeof val === 'function') {
            elem.addEventListener(key.slice(2).toLowerCase(), val);
        } else if (key === 'dataset') {
            for (const [dk, dv] of Object.entries(val)) {
                elem.dataset[dk] = dv;
            }
        } else {
            elem.setAttribute(key, val);
        }
    }
    for (const child of children) {
        if (typeof child === 'string') {
            elem.appendChild(document.createTextNode(child));
        } else if (child instanceof Node) {
            elem.appendChild(child);
        }
    }
    return elem;
}

/** Remove all children from a DOM element. */
function clearChildren(parent) {
    while (parent.firstChild) {
        parent.removeChild(parent.firstChild);
    }
}

/** Map status string to CSS class suffix. */
function statusClass(status) {
    const map = {
        draft: 'draft',
        pending: 'pending',
        running: 'running',
        complete: 'complete',
        completed: 'complete',
        error: 'error',
        interrupted: 'error',
    };
    return map[status] || 'draft';
}

// ================================================================
// LiveHeatmap -- Small inline GPU allocation heatmap
// ================================================================

class LiveHeatmap {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} gpuTypes - {typeName: count, ...}
     */
    constructor(canvas, gpuTypes) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.gpuTypes = gpuTypes;
        this.totalGpus = Object.values(gpuTypes).reduce((a, b) => a + b, 0);
        // Build ordered type list with offsets
        this.typeList = [];
        let offset = 0;
        for (const [name, count] of Object.entries(gpuTypes)) {
            this.typeList.push({ name, count, offset });
            offset += count;
        }
        // Color palette per type
        this._typeColors = [
            '#4ecca3', '#4a90d9', '#ffb347', '#d94a4a',
            '#9b59b6', '#e67e22', '#1abc9c', '#e74c3c',
        ];
        // Per-type utilization bars (set by parent)
        this.typeBarsEl = null;
        this.statsEl = null;
    }

    /**
     * Update heatmap from allocations dict and stats.
     * @param {object} allocations - {jobId: [gpuIdx, ...]}
     * @param {object} stats - {running, queued, completed}
     */
    update(allocations, stats) {
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Compute cell layout
        const cols = Math.ceil(Math.sqrt(this.totalGpus * (w / h)));
        const rows = Math.ceil(this.totalGpus / cols);
        const cellW = w / cols;
        const cellH = h / rows;

        // Build flat GPU -> typeIdx + allocated lookup
        const gpuType = new Uint8Array(this.totalGpus);
        const gpuAlloc = new Uint8Array(this.totalGpus); // 0=free, 1=used
        for (const t of this.typeList) {
            for (let i = 0; i < t.count; i++) {
                gpuType[t.offset + i] = this.typeList.indexOf(t);
            }
        }
        for (const [, gpuIndices] of Object.entries(allocations)) {
            for (const idx of gpuIndices) {
                if (idx < this.totalGpus) gpuAlloc[idx] = 1;
            }
        }

        // Draw cells
        for (let i = 0; i < this.totalGpus; i++) {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const x = col * cellW;
            const y = row * cellH;
            const typeIdx = gpuType[i];
            const baseColor = this._typeColors[typeIdx % this._typeColors.length];

            if (gpuAlloc[i]) {
                ctx.fillStyle = baseColor;
            } else {
                ctx.fillStyle = 'rgba(255,255,255,0.04)';
            }
            ctx.fillRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
        }

        // Update per-type utilization bars
        if (this.typeBarsEl) {
            for (let ti = 0; ti < this.typeList.length; ti++) {
                const t = this.typeList[ti];
                let used = 0;
                for (let i = 0; i < t.count; i++) {
                    if (gpuAlloc[t.offset + i]) used++;
                }
                const pct = t.count > 0 ? (used / t.count * 100) : 0;
                const barEl = this.typeBarsEl.children[ti];
                if (barEl) {
                    const fill = barEl.querySelector('.heatmap-type-fill');
                    const label = barEl.querySelector('.heatmap-type-pct');
                    if (fill) {
                        fill.style.width = pct.toFixed(0) + '%';
                        fill.style.background = this._typeColors[ti % this._typeColors.length];
                    }
                    if (label) {
                        clearChildren(label);
                        label.appendChild(document.createTextNode(
                            `${used}/${t.count} (${pct.toFixed(0)}%)`
                        ));
                    }
                }
            }
        }

        // Update stats
        if (this.statsEl && stats) {
            clearChildren(this.statsEl);
            this.statsEl.appendChild(el('span', {}, 'Running: ', el('strong', {}, String(stats.running || 0))));
            this.statsEl.appendChild(el('span', {}, 'Queued: ', el('strong', {}, String(stats.queued || 0))));
            this.statsEl.appendChild(el('span', {}, 'Completed: ', el('strong', {}, String(stats.completed || 0))));
        }
    }
}

// ================================================================
// LiveMetricsPanel -- Manages 6 charts + CDF + heatmap
// ================================================================

class LiveMetricsPanel {
    /**
     * @param {HTMLElement} container - Parent DOM element
     * @param {object} gpuTypes - {typeName: count} from cluster spec
     */
    constructor(container, gpuTypes) {
        this._container = container;
        this._gpuTypes = gpuTypes;

        // Accumulated data for derived charts
        this._jctWindow = [];      // Sliding window of last 100 JCTs
        this._allDurations = [];   // All JCT durations for CDF
        this._pendingBySf = {};    // {sf: seriesIdx} for stacked demand chart
        this._roundCount = 0;

        this._build();
    }

    _build() {
        const container = this._container;

        // -- 2x3 chart grid --
        const chartsGrid = el('div', { className: 'charts-grid' });

        // Chart definitions: each gets a canvas + TimeSeriesChart or CDFChart
        const chartDefs = [
            { key: 'utilization', title: 'Utilization', leftLabel: '%', leftPercent: true },
            { key: 'avgJct', title: 'Moving Avg JCT (hours)', leftLabel: 'hours' },
            { key: 'queueArrivals', title: 'Queue & Arrivals', leftLabel: 'jobs', rightLabel: 'arrivals' },
            { key: 'fragmentation', title: 'Fragmentation', leftLabel: '%', leftPercent: true },
            { key: 'pendingDemand', title: 'Pending GPU Demand', leftLabel: 'jobs' },
            { key: 'jctCdf', title: 'JCT CDF', xLabel: 'hours', isCdf: true },
        ];

        this._charts = {};
        this._canvases = {};
        this._seriesIndices = {};

        for (const def of chartDefs) {
            const canvas = el('canvas', { width: '570', height: '200' });

            const wrapper = el('div', { className: 'chart-wrapper' }, canvas);
            chartsGrid.appendChild(wrapper);
            this._canvases[def.key] = canvas;

            if (def.isCdf) {
                const chart = new CDFChart(canvas, { title: def.title, xLabel: def.xLabel });
                this._charts[def.key] = chart;
            } else {
                const chart = new TimeSeriesChart(canvas, {
                    title: def.title,
                    leftLabel: def.leftLabel || '',
                    rightLabel: def.rightLabel || '',
                    leftPercent: def.leftPercent || false,
                });
                this._charts[def.key] = chart;
            }
        }

        // Set up series for each TimeSeriesChart
        const util = this._charts.utilization;
        this._seriesIndices.utilOccupancy = util.addSeries({
            label: 'Occupancy', color: '#4ecca3', fill: 'rgba(78,204,163,0.15)',
        });

        const jct = this._charts.avgJct;
        this._seriesIndices.jctMovingAvg = jct.addSeries({
            label: '100-job MA', color: '#ffb347',
        });

        const qa = this._charts.queueArrivals;
        this._seriesIndices.queueDepth = qa.addSeries({
            label: 'Queue', color: '#4a90d9',
        });
        this._seriesIndices.arrivals = qa.addSeries({
            label: 'Arrivals', color: '#ff6b6b', yAxis: 'right',
        });

        const frag = this._charts.fragmentation;
        this._seriesIndices.fragRate = frag.addSeries({
            label: 'Frag Rate', color: '#e67e22',
        });
        this._seriesIndices.fragTotal = frag.addSeries({
            label: 'Frag/Total', color: '#9b59b6', dash: [4, 4],
        });

        // Pending demand: series added dynamically as new scale factors appear

        // -- Heatmap section --
        let heatmapSection = null;
        if (this._gpuTypes && Object.keys(this._gpuTypes).length > 0) {
            const totalGpus = Object.values(this._gpuTypes).reduce((a, b) => a + b, 0);
            // Size the canvas for the GPU count
            const heatH = totalGpus > 500 ? 160 : 120;
            const heatCanvas = el('canvas', { width: '800', height: String(heatH * 2) });
            heatCanvas.style.width = '100%';
            heatCanvas.style.height = heatH + 'px';

            this._heatmap = new LiveHeatmap(heatCanvas, this._gpuTypes);

            // Per-type utilization bars
            const typeBars = el('div', { className: 'heatmap-type-bars' });
            for (const t of this._heatmap.typeList) {
                const bar = el('div', { className: 'heatmap-type-bar' },
                    el('div', { className: 'heatmap-type-label' }, `${t.name} (${t.count})`),
                    el('div', { className: 'progress-bar', style: { height: '6px' } },
                        el('div', { className: 'heatmap-type-fill', style: { width: '0%' } }),
                    ),
                    el('div', { className: 'heatmap-type-pct' }, '0/' + t.count + ' (0%)'),
                );
                typeBars.appendChild(bar);
            }
            this._heatmap.typeBarsEl = typeBars;

            // Stats row
            const statsRow = el('div', { className: 'heatmap-stats' },
                el('span', {}, 'Running: ', el('strong', {}, '0')),
                el('span', {}, 'Queued: ', el('strong', {}, '0')),
                el('span', {}, 'Completed: ', el('strong', {}, '0')),
            );
            this._heatmap.statsEl = statsRow;

            heatmapSection = el('div', { className: 'experiment-section heatmap-section' },
                el('div', { className: 'experiment-section-title' }, 'GPU Heatmap'),
                el('div', { className: 'heatmap-container' }, heatCanvas, typeBars, statsRow),
            );
        }

        // -- Assemble --
        const chartsSection = el('div', { className: 'experiment-section' },
            el('div', { className: 'experiment-section-title' }, 'Live Metrics'),
            chartsGrid,
        );

        container.appendChild(chartsSection);
        if (heatmapSection) {
            container.appendChild(heatmapSection);
        }
    }

    /**
     * Push one round of metrics data from the WebSocket event.
     * @param {object} data - The event.data from a 'round' WebSocket event
     */
    pushRound(data) {
        const metrics = data?.metrics || {};
        const simTime = data?.elapsed_time || 0;
        this._roundCount++;

        // -- Utilization --
        const util = this._charts.utilization;
        util.pushPoint(this._seriesIndices.utilOccupancy, metrics.utilization || 0);
        util.pushSimTime(simTime);
        util.renderLive();

        // -- Queue & Arrivals --
        const qa = this._charts.queueArrivals;
        qa.pushPoint(this._seriesIndices.queueDepth, metrics.num_queued || 0);
        qa.pushPoint(this._seriesIndices.arrivals, metrics.arrivals_count || 0);
        qa.pushSimTime(simTime);
        qa.renderLive();

        // -- Fragmentation --
        const frag = this._charts.fragmentation;
        frag.pushPoint(this._seriesIndices.fragRate, metrics.frag_rate || 0);
        frag.pushPoint(this._seriesIndices.fragTotal, metrics.frag_total || 0);
        frag.pushSimTime(simTime);
        frag.renderLive();

        // -- JCT: accumulate completions --
        const completions = metrics.completions || [];
        for (const c of completions) {
            const durHours = c.duration / 3600;
            this._jctWindow.push(durHours);
            this._allDurations.push(durHours);
        }
        // Keep window at 100
        while (this._jctWindow.length > 100) this._jctWindow.shift();

        // Moving average
        const jctChart = this._charts.avgJct;
        const maValue = this._jctWindow.length > 0
            ? this._jctWindow.reduce((a, b) => a + b, 0) / this._jctWindow.length
            : 0;
        jctChart.pushPoint(this._seriesIndices.jctMovingAvg, maValue);
        jctChart.pushSimTime(simTime);
        jctChart.renderLive();

        // -- JCT CDF (re-render with updated durations) --
        if (this._allDurations.length > 0) {
            const cdfChart = this._charts.jctCdf;
            cdfChart.setData([{
                label: 'JCT',
                color: '#4ecca3',
                fill: 'rgba(78,204,163,0.1)',
                durations: this._allDurations,
            }]);
            cdfChart.render();
        }

        // -- Pending GPU Demand (stacked by scale factor) --
        const pendingDemand = metrics.pending_demand || {};
        const demandChart = this._charts.pendingDemand;
        // Ensure series exist for each scale factor
        const demandColors = ['#4ecca3', '#4a90d9', '#ffb347', '#d94a4a', '#9b59b6', '#e67e22'];
        for (const sfStr of Object.keys(pendingDemand)) {
            if (!(sfStr in this._pendingBySf)) {
                const sfNum = Number(sfStr);
                const colorIdx = Object.keys(this._pendingBySf).length;
                const idx = demandChart.addSeries({
                    label: `SF=${sfNum}`,
                    color: demandColors[colorIdx % demandColors.length],
                    fill: demandColors[colorIdx % demandColors.length] + '30',
                    stacked: true,
                });
                this._pendingBySf[sfStr] = idx;
                // Backfill with zeros for previous rounds
                for (let r = 0; r < this._roundCount - 1; r++) {
                    demandChart.series[idx].values.push(0);
                }
            }
        }
        // Push values for all known scale factors
        for (const [sfStr, seriesIdx] of Object.entries(this._pendingBySf)) {
            const val = pendingDemand[sfStr] || 0;
            demandChart.pushPoint(seriesIdx, val);
        }
        demandChart.pushSimTime(simTime);
        if (demandChart.maxRound > 1) {
            demandChart.renderLive();
        }

        // -- Heatmap --
        if (this._heatmap) {
            const allocations = data?.allocations || {};
            this._heatmap.update(allocations, {
                running: Object.keys(allocations).length,
                queued: metrics.num_queued || 0,
                completed: metrics.num_completed || 0,
            });
        }
    }

    /** Reset all charts for a new run. */
    reset() {
        this._jctWindow = [];
        this._allDurations = [];
        this._pendingBySf = {};
        this._roundCount = 0;
        for (const [key, chart] of Object.entries(this._charts)) {
            if (chart.reset) chart.reset();
        }
        this._seriesIndices = {};
        // Re-add core series
        const util = this._charts.utilization;
        this._seriesIndices.utilOccupancy = util.addSeries({
            label: 'Occupancy', color: '#4ecca3', fill: 'rgba(78,204,163,0.15)',
        });
        const jct = this._charts.avgJct;
        this._seriesIndices.jctMovingAvg = jct.addSeries({
            label: '100-job MA', color: '#ffb347',
        });
        const qa = this._charts.queueArrivals;
        this._seriesIndices.queueDepth = qa.addSeries({
            label: 'Queue', color: '#4a90d9',
        });
        this._seriesIndices.arrivals = qa.addSeries({
            label: 'Arrivals', color: '#ff6b6b', yAxis: 'right',
        });
        const frag = this._charts.fragmentation;
        this._seriesIndices.fragRate = frag.addSeries({
            label: 'Frag Rate', color: '#e67e22',
        });
        this._seriesIndices.fragTotal = frag.addSeries({
            label: 'Frag/Total', color: '#9b59b6', dash: [4, 4],
        });
    }
}

// ================================================================
// Sweep Expansion
// ================================================================

/**
 * Expand sweep fields and seeds into an array of individual configs.
 *
 * @param {Object} baseConfig - Base config with non-sweep values
 * @param {Array} sweepFields - [{key, from, to, step}, ...]
 * @param {number[]} seeds - Array of seed values
 * @returns {Object[]} Array of individual experiment configs
 */
function expandSweeps(baseConfig, sweepFields, seeds) {
    let configs = [{ ...baseConfig }];

    for (const sweep of sweepFields) {
        const newConfigs = [];
        for (const cfg of configs) {
            for (let v = sweep.from; v <= sweep.to + 0.001; v += sweep.step) {
                newConfigs.push({ ...cfg, [sweep.key]: Math.round(v * 1000) / 1000 });
            }
        }
        configs = newConfigs;
    }

    // Cross with seeds
    if (seeds.length > 0) {
        const seeded = [];
        for (const cfg of configs) {
            for (const seed of seeds) {
                seeded.push({ ...cfg, seed });
            }
        }
        configs = seeded;
    }

    return configs;
}

/**
 * Count the number of sweep values for a single sweep field.
 */
function countSweepValues(from, to, step) {
    if (step <= 0 || from > to) return 0;
    return Math.floor((to - from) / step + 1.001);
}

// ================================================================
// Schema Form Renderer
// ================================================================

/**
 * SchemaForm renders a JSON Schema as form fields.
 *
 * It maintains internal state for field values, sweep modes,
 * and computes the experiment count preview.
 */
class SchemaForm {
    /**
     * @param {Object} schema - JSON Schema (config_schema from the API)
     * @param {Object[]} policySpecs - Policy spec list from the API
     * @param {Object} presets - Cluster presets from the API
     * @param {Function} onUpdate - Called whenever form state changes
     */
    constructor(schema, policySpecs, presets, onUpdate) {
        this.schema = schema;
        this.policySpecs = policySpecs;
        this.presets = presets;
        this.onUpdate = onUpdate || (() => {});

        // Internal state
        this.values = {};       // key -> value
        this.sweepModes = {};   // key -> boolean (true = sweep mode)
        this.sweepValues = {};  // key -> {from, to, step}
        this.seeds = '0';       // comma-separated seed string
        this._container = null;

        // Initialize default values from schema
        this._initDefaults();
    }

    _initDefaults() {
        const props = this.schema.properties || {};
        for (const [key, propSchema] of Object.entries(props)) {
            if (propSchema.default !== undefined && propSchema.default !== null) {
                this.values[key] = propSchema.default;
            }
        }
    }

    /**
     * Reconstruct form state from saved experiment configs.
     *
     * Reverse-engineers sweep ranges and seed lists from the flat
     * list of per-experiment config dicts stored in the database.
     *
     * @param {Object[]} experiments - Array of experiment objects with .config and .policy
     */
    loadFromExperiments(experiments) {
        if (!experiments || experiments.length === 0) return;

        // Extract policy from the first experiment
        if (experiments[0].policy) {
            this.values['policy'] = experiments[0].policy;
        }

        // Collect all unique values per config key across experiments
        const keyValues = {};  // key -> Set of values
        for (const exp of experiments) {
            const cfg = exp.config || {};
            for (const [key, val] of Object.entries(cfg)) {
                if (key === 'policy' || key === 'seed') continue;
                if (!keyValues[key]) keyValues[key] = new Set();
                keyValues[key].add(val);
            }
        }

        // For each key, decide: single value or sweep
        for (const [key, valSet] of Object.entries(keyValues)) {
            const vals = [...valSet];
            if (vals.length === 1) {
                // Single value -- set as base config
                this.values[key] = vals[0];
            } else if (vals.length > 1 && vals.every(v => typeof v === 'number')) {
                // Multiple numeric values -- reconstruct as sweep only if
                // they form a strict arithmetic progression (equal spacing).
                const sorted = vals.slice().sort((a, b) => a - b);
                const diffs = [];
                for (let i = 1; i < sorted.length; i++) {
                    diffs.push(Math.round((sorted[i] - sorted[i - 1]) * 1000) / 1000);
                }
                const positiveDiffs = diffs.filter(d => d > 0);
                const step = positiveDiffs.length > 0 ? positiveDiffs[0] : 1;
                const isArithmetic = positiveDiffs.every(d => Math.abs(d - step) < 0.001);

                if (isArithmetic && positiveDiffs.length > 0) {
                    this.sweepModes[key] = true;
                    this.sweepValues[key] = {
                        from: sorted[0],
                        to: sorted[sorted.length - 1],
                        step,
                    };
                } else {
                    // Non-uniform spacing -- use first experiment's value
                    this.values[key] = vals[0];
                }
            } else {
                // Multiple non-numeric values -- use first experiment's value
                this.values[key] = vals[0];
            }
        }

        // Extract seed values
        const seedSet = new Set();
        for (const exp of experiments) {
            const seed = (exp.config || {}).seed;
            if (seed !== undefined && seed !== null) {
                seedSet.add(seed);
            }
        }
        if (seedSet.size > 0) {
            this.seeds = [...seedSet].sort((a, b) => a - b).join(', ');
        }
    }

    /**
     * Build the complete form DOM and return the container element.
     */
    render() {
        this._container = el('div', { className: 'schema-form' });
        this._renderFields();
        return this._container;
    }

    _renderFields() {
        if (!this._container) return;
        clearChildren(this._container);

        const props = this.schema.properties || {};
        const required = new Set(this.schema.required || []);

        // Group fields by category for better UX
        const categories = this._categorizeFields(props);

        for (const cat of categories) {
            const section = el('div', { className: 'experiment-section' },
                el('div', { className: 'experiment-section-title' }, cat.title),
            );

            for (const key of cat.keys) {
                const propSchema = props[key];
                if (!propSchema) continue;
                const fieldEl = this._renderField(key, propSchema, required.has(key));
                section.appendChild(fieldEl);
            }

            this._container.appendChild(section);
        }

        // Seed list section
        this._container.appendChild(this._renderSeedSection());

        // Preview section
        this._container.appendChild(this._renderPreview());
    }

    /**
     * Organize schema properties into logical categories.
     */
    _categorizeFields(props) {
        const categories = [
            {
                title: 'Scheduling',
                keys: ['policy', 'solver'],
            },
            {
                title: 'Cluster',
                keys: ['cluster_preset', 'cluster_spec', 'gpus_per_node'],
            },
            {
                title: 'Workload',
                keys: ['mode', 'workload_mode', 'num_total_jobs', 'lam',
                       'window_start', 'window_end', 'generate_multi_gpu_jobs'],
            },
            {
                title: 'Simulation',
                keys: ['time_per_iteration', 'max_simulated_time', 'max_wall_time',
                       'seed', 'log_level'],
            },
            {
                title: 'Extensions',
                keys: ['enable_fgd', 'fgd_placement_mode', 'enable_migration_penalty',
                       'enable_gpu_sharing', 'completion_rate_threshold'],
            },
        ];

        // Collect any keys not in the predefined categories
        const assignedKeys = new Set(categories.flatMap(c => c.keys));
        const extraKeys = Object.keys(props).filter(k => !assignedKeys.has(k));
        if (extraKeys.length > 0) {
            categories.push({ title: 'Other', keys: extraKeys });
        }

        // Filter out categories where none of the keys exist in the schema
        return categories
            .map(cat => ({
                ...cat,
                keys: cat.keys.filter(k => k in props),
            }))
            .filter(cat => cat.keys.length > 0);
    }

    /**
     * Render a single form field based on its JSON Schema type.
     */
    _renderField(key, propSchema, isRequired) {
        // Skip seed -- it's handled separately in the seed section
        if (key === 'seed') return el('div');

        // Skip cluster_spec -- it's shown as part of the cluster_preset field
        if (key === 'cluster_spec') return el('div');

        const type = this._resolveType(propSchema);
        const group = el('div', { className: 'form-group' });

        // Label
        const labelText = this._formatLabel(key) + (isRequired ? ' *' : '');
        const label = el('label', { className: 'form-label', for: `field-${key}` }, labelText);
        group.appendChild(label);

        // Description hint
        if (propSchema.description) {
            group.appendChild(el('div', { className: 'form-hint' }, propSchema.description));
        }

        // Special handling for cluster_preset: show as dropdown with GPU breakdown
        if (key === 'cluster_preset') {
            group.appendChild(this._renderClusterPresetField(key, propSchema));
            return group;
        }

        // Field input
        if (propSchema.enum) {
            group.appendChild(this._renderSelect(key, propSchema));
        } else if (type === 'boolean') {
            group.appendChild(this._renderCheckbox(key, propSchema));
        } else if (type === 'integer' || type === 'number') {
            group.appendChild(this._renderNumericField(key, propSchema, type));
        } else if (type === 'string') {
            group.appendChild(this._renderTextInput(key, propSchema));
        } else if (type === 'object') {
            group.appendChild(this._renderObjectField(key, propSchema));
        } else {
            // Fallback: text input
            group.appendChild(this._renderTextInput(key, propSchema));
        }

        return group;
    }

    /**
     * Resolve the type from a schema property, handling union types like ["integer", "null"].
     */
    _resolveType(propSchema) {
        const t = propSchema.type;
        if (Array.isArray(t)) {
            // Pick the first non-null type
            return t.find(x => x !== 'null') || 'string';
        }
        return t || 'string';
    }

    /**
     * Format a snake_case key as a human-readable label.
     */
    _formatLabel(key) {
        return key
            .replace(/_/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());
    }

    // ----------------------------------------------------------
    // Field Renderers
    // ----------------------------------------------------------

    _renderSelect(key, propSchema) {
        const select = el('select', {
            className: 'form-select',
            id: `field-${key}`,
            onChange: (e) => {
                this.values[key] = e.target.value;
                this._notifyUpdate();
            },
        });

        // Blank option if not required and no default
        if (!this.schema.required?.includes(key) && this.values[key] === undefined) {
            select.appendChild(el('option', { value: '' }, '-- Select --'));
        }

        for (const val of propSchema.enum) {
            const opt = el('option', { value: val }, val);
            if (this.values[key] === val) {
                opt.selected = true;
            }
            select.appendChild(opt);
        }

        // For the policy field, show the description below
        if (key === 'policy') {
            const wrapper = el('div');
            wrapper.appendChild(select);
            const descEl = el('div', {
                className: 'form-hint policy-description',
                style: { marginTop: '0.35rem' },
            });
            this._updatePolicyDescription(descEl, this.values[key]);

            select.addEventListener('change', () => {
                this._updatePolicyDescription(descEl, this.values[key]);
            });

            wrapper.appendChild(descEl);
            return wrapper;
        }

        return select;
    }

    _renderClusterPresetField(key, propSchema) {
        const wrapper = el('div');
        const presetNames = Object.keys(this.presets);

        const select = el('select', {
            className: 'form-select',
            id: `field-${key}`,
            onChange: (e) => {
                this.values[key] = e.target.value || undefined;
                // Re-render the GPU breakdown
                clearChildren(breakdownDiv);
                if (e.target.value && this.presets[e.target.value]) {
                    breakdownDiv.appendChild(this._renderClusterBreakdown(this.presets[e.target.value]));
                }
                this._notifyUpdate();
            },
        });

        select.appendChild(el('option', { value: '' }, '-- Select a cluster preset --'));
        for (const name of presetNames) {
            const opt = el('option', { value: name }, name);
            if (this.values[key] === name) opt.selected = true;
            select.appendChild(opt);
        }

        wrapper.appendChild(select);

        // GPU breakdown area
        const breakdownDiv = el('div');
        if (this.values[key] && this.presets[this.values[key]]) {
            breakdownDiv.appendChild(this._renderClusterBreakdown(this.presets[this.values[key]]));
        }
        wrapper.appendChild(breakdownDiv);

        return wrapper;
    }

    _renderClusterBreakdown(preset) {
        const container = el('div', { className: 'cluster-spec-field' });
        const grid = el('div', { className: 'gpu-type-grid mt-sm' });

        for (const [gpuType, count] of Object.entries(preset.gpu_types)) {
            grid.appendChild(
                el('div', { className: 'gpu-type-card' },
                    el('span', { className: 'gpu-type-name' }, gpuType),
                    el('span', { className: 'gpu-type-count' }, String(count)),
                )
            );
        }
        container.appendChild(grid);

        const totalGpus = Object.values(preset.gpu_types).reduce((a, b) => a + b, 0);
        container.appendChild(
            el('div', { className: 'text-muted mt-sm', style: { fontSize: '0.78rem' } },
                `Total: ${totalGpus} GPUs` +
                (preset.gpus_per_node ? ` (${preset.gpus_per_node} per node)` : ' (flat)'),
            )
        );

        return container;
    }

    _updatePolicyDescription(descEl, policyName) {
        clearChildren(descEl);
        if (!policyName) return;
        const spec = this.policySpecs.find(p => p.name === policyName);
        if (spec && spec.description) {
            descEl.appendChild(document.createTextNode(spec.description));
        }
    }

    _renderCheckbox(key, propSchema) {
        const currentVal = this.values[key] !== undefined ? this.values[key] : (propSchema.default || false);
        this.values[key] = currentVal;

        const labelSpan = el('span', {}, currentVal ? 'Enabled' : 'Disabled');

        const checkbox = el('input', {
            type: 'checkbox',
            id: `field-${key}`,
            onChange: (e) => {
                this.values[key] = e.target.checked;
                clearChildren(labelSpan);
                labelSpan.appendChild(document.createTextNode(e.target.checked ? 'Enabled' : 'Disabled'));
                this._notifyUpdate();
            },
        });
        if (currentVal) checkbox.checked = true;

        return el('label', { className: 'form-check' },
            checkbox,
            labelSpan,
        );
    }

    _renderNumericField(key, propSchema, type) {
        const container = el('div', { className: 'numeric-field-container' });
        const isSweepable = true;
        const isSweep = !!this.sweepModes[key];

        // Sweep toggle
        if (isSweepable) {
            const toggleLabel = el('label', { className: 'form-check sweep-toggle' });

            const toggleCheckbox = el('input', {
                type: 'checkbox',
                onChange: (e) => {
                    this.sweepModes[key] = e.target.checked;
                    if (e.target.checked && !this.sweepValues[key]) {
                        const defVal = this.values[key] !== undefined ? this.values[key] : 0;
                        this.sweepValues[key] = { from: defVal, to: defVal, step: 1 };
                    }
                    this._renderFields();
                    this._notifyUpdate();
                },
            });
            if (isSweep) toggleCheckbox.checked = true;

            toggleLabel.appendChild(toggleCheckbox);
            toggleLabel.appendChild(el('span', { className: 'sweep-toggle-text' }, 'Sweep'));
            container.appendChild(toggleLabel);
        }

        if (isSweep) {
            container.appendChild(this._renderSweepInputs(key, propSchema, type));
        } else {
            container.appendChild(this._renderSingleNumericInput(key, propSchema, type));
        }

        return container;
    }

    _renderSingleNumericInput(key, propSchema, type) {
        const currentVal = this.values[key] !== undefined ? this.values[key] : (propSchema.default ?? '');

        const input = el('input', {
            type: 'number',
            className: 'form-input',
            id: `field-${key}`,
            value: String(currentVal),
            onChange: (e) => {
                const raw = e.target.value;
                if (raw === '') {
                    delete this.values[key];
                } else {
                    this.values[key] = type === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
                }
                this._notifyUpdate();
            },
        });

        if (propSchema.minimum !== undefined) input.setAttribute('min', propSchema.minimum);
        if (propSchema.maximum !== undefined) input.setAttribute('max', propSchema.maximum);
        if (type === 'integer') input.setAttribute('step', '1');

        return input;
    }

    _renderSweepInputs(key, propSchema, type) {
        const sweep = this.sweepValues[key] || { from: 0, to: 0, step: 1 };
        this.sweepValues[key] = sweep;

        const step = type === 'integer' ? '1' : 'any';
        const count = countSweepValues(sweep.from, sweep.to, sweep.step);

        const makeInput = (label, field) => {
            const input = el('input', {
                type: 'number',
                className: 'form-input form-input-compact',
                value: String(sweep[field]),
                step: step,
                onChange: (e) => {
                    const raw = e.target.value;
                    sweep[field] = type === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
                    this.sweepValues[key] = sweep;
                    // Update the count preview
                    const countEl = container.querySelector('.sweep-count');
                    if (countEl) {
                        const newCount = countSweepValues(sweep.from, sweep.to, sweep.step);
                        clearChildren(countEl);
                        countEl.appendChild(document.createTextNode(`${newCount} value${newCount !== 1 ? 's' : ''}`));
                    }
                    this._notifyUpdate();
                },
            });
            if (propSchema.minimum !== undefined && field === 'from') {
                input.setAttribute('min', propSchema.minimum);
            }
            return el('div', { className: 'sweep-field' },
                el('label', { className: 'form-label' }, label),
                input,
            );
        };

        const container = el('div', { className: 'sweep-inputs' },
            el('div', { className: 'form-row' },
                makeInput('From', 'from'),
                makeInput('To', 'to'),
                makeInput('Step', 'step'),
            ),
            el('div', { className: 'sweep-count tag tag-accent' },
                `${count} value${count !== 1 ? 's' : ''}`,
            ),
        );

        return container;
    }

    _renderTextInput(key, propSchema) {
        const currentVal = this.values[key] !== undefined ? this.values[key] : (propSchema.default || '');

        return el('input', {
            type: 'text',
            className: 'form-input',
            id: `field-${key}`,
            value: String(currentVal),
            placeholder: propSchema.default ? `Default: ${propSchema.default}` : '',
            onChange: (e) => {
                const raw = e.target.value.trim();
                if (raw === '') {
                    delete this.values[key];
                } else {
                    this.values[key] = raw;
                }
                this._notifyUpdate();
            },
        });
    }

    _renderObjectField(key, propSchema) {
        // Generic object: show a JSON text area
        const currentVal = this.values[key] !== undefined
            ? JSON.stringify(this.values[key], null, 2)
            : '';

        const textarea = el('textarea', {
            className: 'form-input code-block',
            id: `field-${key}`,
            style: { minHeight: '80px', fontFamily: 'var(--wb-font-mono)', fontSize: '0.78rem' },
            onChange: (e) => {
                try {
                    this.values[key] = JSON.parse(e.target.value);
                } catch {
                    // Invalid JSON -- ignore until valid
                }
                this._notifyUpdate();
            },
        });
        textarea.value = currentVal;

        return textarea;
    }

    // ----------------------------------------------------------
    // Seed Section
    // ----------------------------------------------------------

    _renderSeedSection() {
        const section = el('div', { className: 'experiment-section' },
            el('div', { className: 'experiment-section-title' }, 'Seeds'),
        );

        section.appendChild(
            el('div', { className: 'form-hint mb-sm' },
                'Comma-separated list of random seeds. Each experiment config is run once per seed.',
            ),
        );

        const input = el('input', {
            type: 'text',
            className: 'form-input',
            id: 'field-seeds',
            value: this.seeds,
            placeholder: '0, 1, 2',
            onChange: (e) => {
                this.seeds = e.target.value;
                this._notifyUpdate();
            },
            onInput: (e) => {
                this.seeds = e.target.value;
                this._notifyUpdate();
            },
        });

        section.appendChild(input);
        return section;
    }

    // ----------------------------------------------------------
    // Preview
    // ----------------------------------------------------------

    _renderPreview() {
        const section = el('div', { className: 'experiment-section preview-section' },
            el('div', { className: 'experiment-section-title' }, 'Experiment Preview'),
        );

        const stats = this._computePreviewStats();

        const previewCard = el('div', { className: 'card' },
            el('div', { className: 'card-body' },
                el('div', { className: 'preview-stat-row' },
                    this._buildPreviewStat(String(stats.sweepCombinations), 'Config Combinations'),
                    this._buildPreviewStat(String(stats.seedCount), 'Seeds'),
                    this._buildPreviewStat(String(stats.totalExperiments), 'Total Experiments'),
                ),
            ),
        );

        if (stats.sweepDetails.length > 0) {
            const detailsDiv = el('div', { className: 'preview-sweep-details mt-sm' });
            for (const detail of stats.sweepDetails) {
                detailsDiv.appendChild(
                    el('div', { className: 'tag tag-accent', style: { marginRight: '0.35rem', marginBottom: '0.25rem' } },
                        `${detail.key}: ${detail.count} values (${detail.from} to ${detail.to}, step ${detail.step})`,
                    ),
                );
            }
            previewCard.querySelector('.card-body').appendChild(detailsDiv);
        }

        section.appendChild(previewCard);
        return section;
    }

    _buildPreviewStat(value, label) {
        return el('div', { className: 'preview-stat' },
            el('div', { className: 'preview-stat-value' }, value),
            el('div', { className: 'preview-stat-label' }, label),
        );
    }

    _computePreviewStats() {
        const seeds = this._parseSeeds();
        const sweepDetails = [];
        let sweepCombinations = 1;

        for (const [key, sweep] of Object.entries(this.sweepValues)) {
            if (!this.sweepModes[key]) continue;
            const count = countSweepValues(sweep.from, sweep.to, sweep.step);
            if (count > 0) {
                sweepCombinations *= count;
                sweepDetails.push({
                    key: this._formatLabel(key),
                    count,
                    from: sweep.from,
                    to: sweep.to,
                    step: sweep.step,
                });
            }
        }

        return {
            sweepCombinations,
            seedCount: seeds.length,
            totalExperiments: sweepCombinations * seeds.length,
            sweepDetails,
        };
    }

    // ----------------------------------------------------------
    // Data Extraction
    // ----------------------------------------------------------

    /**
     * Parse the seed string into an array of integers.
     */
    _parseSeeds() {
        return this.seeds
            .split(',')
            .map(s => s.trim())
            .filter(s => s !== '' && !isNaN(parseInt(s, 10)))
            .map(s => parseInt(s, 10));
    }

    /**
     * Build the base config from current form values (non-sweep fields).
     */
    getBaseConfig() {
        const config = {};
        const props = this.schema.properties || {};

        for (const [key, propSchema] of Object.entries(props)) {
            if (key === 'seed') continue; // Seeds handled separately
            if (this.sweepModes[key]) continue; // Sweep fields handled by expansion

            if (this.values[key] !== undefined) {
                config[key] = this.values[key];
            }
        }

        return config;
    }

    /**
     * Get the active sweep fields.
     */
    getActiveSweeps() {
        const sweeps = [];
        for (const [key, isActive] of Object.entries(this.sweepModes)) {
            if (!isActive) continue;
            const sweep = this.sweepValues[key];
            if (sweep) {
                sweeps.push({ key, from: sweep.from, to: sweep.to, step: sweep.step });
            }
        }
        return sweeps;
    }

    /**
     * Expand all sweeps and seeds into individual experiment configs.
     */
    expandAll() {
        const baseConfig = this.getBaseConfig();
        const sweeps = this.getActiveSweeps();
        const seeds = this._parseSeeds();
        return expandSweeps(baseConfig, sweeps, seeds);
    }

    /**
     * Generate experiment specs suitable for the CreateGroupRequest.
     * Each spec: { name, policy, config }
     */
    generateExperimentSpecs() {
        const configs = this.expandAll();
        const policy = this.values['policy'] || 'fifo';

        return configs.map((config, idx) => {
            // Build a descriptive name
            const parts = [policy];
            for (const sweep of this.getActiveSweeps()) {
                parts.push(`${sweep.key}=${config[sweep.key]}`);
            }
            if (config.seed !== undefined) {
                parts.push(`seed=${config.seed}`);
            }
            const name = parts.join('_');

            return {
                name,
                policy,
                config: { ...config, policy },
            };
        });
    }

    // ----------------------------------------------------------
    // Callbacks
    // ----------------------------------------------------------

    _notifyUpdate() {
        // Re-render the preview section if possible
        const previewEl = this._container?.querySelector('.preview-section');
        if (previewEl) {
            const newPreview = this._renderPreview();
            previewEl.replaceWith(newPreview);
        }
        this.onUpdate();
    }
}

// ================================================================
// Workbench Controller
// ================================================================
class Workbench {
    constructor() {
        this.currentTab = 'design';
        this.groups = [];
        this.selectedDesignGroupId = null;
        this.selectedRunGroupId = null;
        this._currentSchemaForm = null;
        this._simulatorsCache = null;

        // Run tab state
        this._activeWs = null;
        this._liveMetricsPanel = null;
        this._runExperiments = [];       // experiment list for current group
        this._experimentRows = new Map(); // experiment_id -> {row, statusBadge, progressFill, progressLabel, timeCell}
        this._completedCount = 0;
        this._failedCount = 0;
        this._runningCount = 0;
        this._runStatEls = {};           // {total, pending, running, complete} -> DOM elements
        this._runBtnRun = null;
        this._runBtnCancel = null;
        this._runBtnExport = null;
        this._isRunning = false;

        this._bindTabNav();
        this._bindNewGroup();
        this._init();
    }

    // ----------------------------------------------------------
    // Tab Navigation
    // ----------------------------------------------------------

    _bindTabNav() {
        document.querySelectorAll('.nav-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                this.switchTab(btn.dataset.tab);
            });
        });
    }

    switchTab(tabName) {
        this.currentTab = tabName;

        // Update nav-tab active states
        document.querySelectorAll('.nav-tab').forEach(b => {
            b.classList.toggle('active', b.dataset.tab === tabName);
        });

        // Update tab-panel visibility
        document.querySelectorAll('.tab-panel').forEach(p => {
            p.classList.toggle('active', p.id === `tab-${tabName}`);
        });

        // Refresh sidebar content when switching tabs
        if (tabName === 'design') {
            this._refreshDesignSidebar();
        } else if (tabName === 'run') {
            this._refreshRunSidebar();
        }
    }

    // ----------------------------------------------------------
    // Initialization
    // ----------------------------------------------------------

    async _init() {
        await this._refreshDesignSidebar();
    }

    // ----------------------------------------------------------
    // New Group Button
    // ----------------------------------------------------------

    _bindNewGroup() {
        const btn = document.getElementById('btn-new-group');
        if (btn) {
            btn.addEventListener('click', () => this._showNewGroupDialog());
        }
    }

    async _showNewGroupDialog() {
        // Fetch simulators for the dropdown
        let simulators = [];
        try {
            simulators = await this._getSimulators();
        } catch (err) {
            console.error('Failed to fetch simulators:', err);
        }

        // Build modal
        const overlay = el('div', { className: 'modal-overlay' });

        const nameInput = el('input', {
            type: 'text',
            className: 'form-input',
            id: 'new-group-name',
            placeholder: 'e.g. Fig 9 Replication',
        });

        const simSelect = el('select', {
            className: 'form-select',
            id: 'new-group-simulator',
        });

        if (simulators.length === 0) {
            simSelect.appendChild(el('option', { value: 'Gavel' }, 'Gavel (default)'));
        } else {
            for (const sim of simulators) {
                simSelect.appendChild(el('option', { value: sim.name }, sim.name));
            }
        }

        const closeModal = () => overlay.remove();

        const createBtn = el('button', {
            className: 'btn btn-primary',
            onClick: async () => {
                const name = nameInput.value.trim();
                if (!name) {
                    nameInput.focus();
                    return;
                }
                const simulator = simSelect.value;
                closeModal();
                await this._createNewGroup(name, simulator);
            },
        }, 'Create');

        const cancelBtn = el('button', {
            className: 'btn btn-ghost',
            onClick: closeModal,
        }, 'Cancel');

        const modal = el('div', { className: 'modal-content' },
            el('button', { className: 'modal-close', onClick: closeModal }, '\u00D7'),
            el('div', { className: 'modal-title' }, 'New Experiment Group'),
            el('div', { className: 'modal-body' },
                el('div', { className: 'form-group' },
                    el('label', { className: 'form-label', for: 'new-group-name' }, 'Group Name *'),
                    nameInput,
                ),
                el('div', { className: 'form-group' },
                    el('label', { className: 'form-label', for: 'new-group-simulator' }, 'Simulator'),
                    simSelect,
                    el('div', { className: 'form-hint' },
                        'Select the simulator engine to use for this experiment group.',
                    ),
                ),
            ),
            el('div', { className: 'modal-footer' },
                cancelBtn,
                createBtn,
            ),
        );

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Close on overlay click (not the modal itself)
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });

        // Focus the name input
        nameInput.focus();

        // Allow Enter key to submit
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') createBtn.click();
        });
    }

    async _createNewGroup(name, simulator) {
        // Create a group with no experiments initially.
        // The user will fill in the form and then save.
        // We need to create the group shell first.
        try {
            const group = await api.createGroup({
                name,
                simulator,
                experiments: [],
            });
            this.groups.push(group);
            this._renderDesignSidebar();
            this._selectDesignGroup(group.id);
        } catch (err) {
            console.error('Failed to create group:', err);
        }
    }

    async _getSimulators() {
        if (this._simulatorsCache) return this._simulatorsCache;
        try {
            this._simulatorsCache = await api.getSimulators();
            return this._simulatorsCache;
        } catch {
            return [];
        }
    }

    // ----------------------------------------------------------
    // Design Tab -- Sidebar
    // ----------------------------------------------------------

    async _refreshDesignSidebar() {
        try {
            this.groups = await api.listGroups();
        } catch {
            // Backend not available -- keep whatever we have (likely [])
            this.groups = this.groups.length ? this.groups : [];
        }
        this._renderDesignSidebar();
    }

    _renderDesignSidebar() {
        const list = document.getElementById('design-group-list');
        if (!list) return;

        clearChildren(list);

        if (!this.groups.length) {
            list.appendChild(
                el('div', { className: 'empty-state' }, 'No experiments yet. Click "+ New" to create one.')
            );
            return;
        }

        for (const g of this.groups) {
            const isActive = g.id === this.selectedDesignGroupId;
            const item = el('div', {
                className: `group-item ${isActive ? 'active' : ''}`,
                dataset: { id: g.id },
                onClick: () => this._selectDesignGroup(g.id),
            },
                el('span', { className: 'group-name' }, g.name),
                el('span', { className: `group-badge status-${statusClass(g.status)}` }, g.status),
            );
            list.appendChild(item);
        }
    }

    async _selectDesignGroup(groupId) {
        this.selectedDesignGroupId = groupId;

        // Update active class in sidebar
        const list = document.getElementById('design-group-list');
        if (list) {
            list.querySelectorAll('.group-item').forEach(item => {
                item.classList.toggle('active', item.dataset.id === groupId);
            });
        }

        // Update main panel
        const main = document.getElementById('design-main');
        if (!main) return;

        const group = this.groups.find(g => g.id === groupId);
        if (!group) {
            clearChildren(main);
            main.appendChild(
                el('div', { className: 'empty-state-large' },
                    el('h2', {}, 'Group not found'),
                )
            );
            return;
        }

        clearChildren(main);

        // Show loading state
        main.appendChild(
            el('div', { className: 'loading-overlay' },
                el('div', { className: 'spinner' }),
                el('span', {}, 'Loading schema...'),
            )
        );

        // Fetch schema, presets, policy specs, and group detail (for experiments)
        const simulatorName = group.simulator || 'Gavel';
        let schema, policySpecs, presets, groupDetail;
        try {
            const [schemaData, presetsData, detail] = await Promise.all([
                api.getSchema(simulatorName),
                api.getPresets(simulatorName),
                api.getGroup(groupId),
            ]);
            schema = schemaData.config_schema;
            policySpecs = schemaData.policy_specs || [];
            presets = presetsData;
            groupDetail = detail;
        } catch (err) {
            console.error('Failed to fetch group data:', err);
            clearChildren(main);
            main.appendChild(
                el('div', { className: 'experiment-detail' },
                    el('h2', {}, group.name),
                    el('div', { className: 'card' },
                        el('div', { className: 'card-body' },
                            el('p', { className: 'text-red' },
                                'Failed to load group data. Is the backend running?',
                            ),
                            el('p', { className: 'text-muted mt-sm', style: { fontSize: '0.78rem' } },
                                String(err),
                            ),
                        ),
                    ),
                ),
            );
            return;
        }

        // Build the form, passing saved experiments for pre-population
        clearChildren(main);
        const experiments = groupDetail.experiments || [];
        this._renderDesignForm(main, group, schema, policySpecs, presets, experiments);
    }

    _renderDesignForm(container, group, schema, policySpecs, presets, experiments = []) {
        const detail = el('div', { className: 'experiment-detail' });

        // Header
        detail.appendChild(el('h2', {}, group.name));
        detail.appendChild(
            el('div', { className: 'flex items-center gap-sm mb-md' },
                el('span', { className: `group-badge status-${statusClass(group.status)}` }, group.status),
                el('span', { className: 'text-muted text-mono', style: { fontSize: '0.7rem' } },
                    `${group.simulator || 'Gavel'} | ${group.id}`),
            ),
        );

        // Create the schema form and pre-populate from saved experiments
        const form = new SchemaForm(schema, policySpecs, presets, () => {
            // Update preview on any change -- handled internally by SchemaForm
        });
        if (experiments.length > 0) {
            form.loadFromExperiments(experiments);
        }
        this._currentSchemaForm = form;

        const formEl = form.render();
        detail.appendChild(formEl);

        // Action buttons
        const saveBtn = el('button', {
            className: 'btn btn-primary',
            onClick: () => this._saveGroup(group),
        }, 'Save');

        const saveAndRunBtn = el('button', {
            className: 'btn btn-success',
            onClick: () => this._saveAndRun(group),
        }, 'Save & Go to Run');

        detail.appendChild(
            el('div', { className: 'form-actions' },
                el('div', { className: 'btn-group' }, saveBtn, saveAndRunBtn),
            ),
        );

        container.appendChild(detail);
    }

    async _saveGroup(group) {
        if (!this._currentSchemaForm) return;

        const specs = this._currentSchemaForm.generateExperimentSpecs();
        if (specs.length === 0) {
            console.warn('No experiments to save (check seeds and config)');
            return;
        }

        try {
            // Delete the current (empty) group and recreate with experiments
            await api.deleteGroup(group.id);
            const newGroup = await api.createGroup({
                name: group.name,
                simulator: group.simulator || 'Gavel',
                experiments: specs,
            });

            // Refresh
            await this._refreshDesignSidebar();
            this._selectDesignGroup(newGroup.id);
        } catch (err) {
            console.error('Failed to save group:', err);
        }
    }

    async _saveAndRun(group) {
        if (!this._currentSchemaForm) return;

        const specs = this._currentSchemaForm.generateExperimentSpecs();
        if (specs.length === 0) {
            console.warn('No experiments to save (check seeds and config)');
            return;
        }

        try {
            // Delete the current (empty) group and recreate with experiments
            await api.deleteGroup(group.id);
            const newGroup = await api.createGroup({
                name: group.name,
                simulator: group.simulator || 'Gavel',
                experiments: specs,
            });

            // Refresh sidebar and switch to Run tab
            await this._refreshDesignSidebar();
            this.switchTab('run');
            this._selectRunGroup(newGroup.id);
        } catch (err) {
            console.error('Failed to save and run group:', err);
        }
    }

    // ----------------------------------------------------------
    // Run Tab -- Sidebar
    // ----------------------------------------------------------

    _refreshRunSidebar() {
        const list = document.getElementById('run-group-list');
        if (!list) return;

        clearChildren(list);

        if (!this.groups.length) {
            list.appendChild(
                el('div', { className: 'empty-state' }, 'No experiments to run. Design some first.')
            );
            return;
        }

        for (const g of this.groups) {
            const isActive = g.id === this.selectedRunGroupId;
            const item = el('div', {
                className: `group-item ${isActive ? 'active' : ''}`,
                dataset: { id: g.id },
                onClick: () => this._selectRunGroup(g.id),
            },
                el('span', { className: 'group-name' }, g.name),
                el('span', { className: `group-badge status-${statusClass(g.status)}` }, g.status),
            );
            list.appendChild(item);
        }
    }

    // ----------------------------------------------------------
    // Run Tab -- Main Panel
    // ----------------------------------------------------------

    async _selectRunGroup(groupId) {
        // Clean up previous WebSocket if switching groups
        this._cleanupRunState();

        this.selectedRunGroupId = groupId;

        // Update active class in sidebar
        const list = document.getElementById('run-group-list');
        if (list) {
            list.querySelectorAll('.group-item').forEach(item => {
                item.classList.toggle('active', item.dataset.id === groupId);
            });
        }

        const main = document.getElementById('run-main');
        if (!main) return;

        const group = this.groups.find(g => g.id === groupId);
        if (!group) {
            clearChildren(main);
            main.appendChild(
                el('div', { className: 'empty-state-large' },
                    el('h2', {}, 'Group not found'),
                )
            );
            return;
        }

        // Fetch group details (includes experiments list)
        let groupDetail;
        try {
            groupDetail = await api.getGroup(groupId);
        } catch (err) {
            console.error('Failed to fetch group details:', err);
            clearChildren(main);
            main.appendChild(
                el('div', { className: 'empty-state-large' },
                    el('h2', {}, 'Failed to load group'),
                    el('p', {}, 'Could not connect to the backend.'),
                )
            );
            return;
        }

        this._runExperiments = groupDetail.experiments || [];
        this._completedCount = 0;
        this._failedCount = 0;
        this._runningCount = 0;
        this._experimentRows = new Map();

        clearChildren(main);

        // -- Header with status badge --
        const statusBadge = el('span', {
            className: `status-badge status-${statusClass(group.status)}`,
        }, group.status || 'draft');
        this._runHeaderBadge = statusBadge;

        // -- Action buttons --
        this._runBtnRun = el('button', {
            className: 'btn btn-success',
            onClick: () => this._runGroup(group.id),
        }, 'Run All');

        this._runBtnCancel = el('button', {
            className: 'btn btn-danger',
            disabled: 'disabled',
            onClick: () => this._cancelGroup(),
        }, 'Cancel');

        this._runBtnExport = el('button', {
            className: 'btn btn-primary',
            disabled: 'disabled',
            onClick: () => this._exportGroup(group.id),
        }, 'Export to Analyze');

        // Disable run if already complete; enable export if complete
        const isComplete = group.status === 'complete' || group.status === 'completed';
        const isRunning = group.status === 'running';
        if (isComplete) {
            this._runBtnRun.disabled = true;
            this._runBtnExport.disabled = false;
        }
        if (isRunning) {
            this._runBtnRun.disabled = true;
            this._runBtnCancel.disabled = false;
        }

        this._runBtnClone = el('button', {
            className: 'btn btn-secondary',
            onClick: () => this._cloneAndRerun(group.id),
        }, 'Clone');

        const controls = el('div', { className: 'run-controls' },
            this._runBtnRun,
            this._runBtnCancel,
            this._runBtnExport,
            this._runBtnClone,
        );

        // -- Summary stat cards --
        const totalCount = this._runExperiments.length;
        this._runStatEls = {};

        const statTotal = this._buildRunStat(String(totalCount), 'Total');
        this._runStatEls.total = statTotal.querySelector('.run-stat-value');

        const statPending = this._buildRunStat(String(totalCount), 'Pending', 'text-yellow');
        this._runStatEls.pending = statPending.querySelector('.run-stat-value');

        const statRunning = this._buildRunStat('0', 'Running', 'text-accent');
        this._runStatEls.running = statRunning.querySelector('.run-stat-value');

        const statComplete = this._buildRunStat('0', 'Complete', 'text-green');
        this._runStatEls.complete = statComplete.querySelector('.run-stat-value');

        const summary = el('div', { className: 'run-summary' },
            statTotal, statPending, statRunning, statComplete,
        );

        // -- Live metrics panel (6 charts + heatmap) --
        // Resolve cluster spec for the heatmap from experiment config
        let gpuTypes = {};
        if (this._runExperiments.length > 0) {
            const firstConfig = this._runExperiments[0].config || {};
            if (firstConfig.cluster_spec) {
                gpuTypes = firstConfig.cluster_spec;
            } else if (firstConfig.cluster_preset) {
                // Map preset names to GPU types
                const presetMap = {
                    'Philly 108': { v100: 36, p100: 36, k80: 36 },
                    'Alibaba 6200': { G2: 4392, T4: 840, G3: 312, P100: 264, V100M32: 200, V100M16: 192 },
                };
                gpuTypes = presetMap[firstConfig.cluster_preset] || { v100: 36, p100: 36, k80: 36 };
            } else {
                gpuTypes = { v100: 36, p100: 36, k80: 36 };
            }
        }

        const liveMetricsContainer = el('div');
        this._liveMetricsPanel = new LiveMetricsPanel(liveMetricsContainer, gpuTypes);

        // -- Experiment list table --
        const tableHead = el('thead', {},
            el('tr', {},
                el('th', {}, 'Name'),
                el('th', {}, 'Policy'),
                el('th', {}, 'Status'),
                el('th', { style: { minWidth: '140px' } }, 'Progress'),
                el('th', {}, 'Time'),
            ),
        );

        const tableBody = el('tbody', {});
        for (let i = 0; i < this._runExperiments.length; i++) {
            const exp = this._runExperiments[i];
            const expId = exp.id || exp.experiment_id || `exp-${i}`;
            const expName = exp.name || expId;
            const expPolicy = exp.config?.policy || exp.policy || '--';
            const expStatus = exp.status || 'pending';

            const badgeEl = el('span', {
                className: `status-badge status-${statusClass(expStatus)}`,
            }, expStatus);

            const progressFill = el('div', { className: 'progress-fill', style: { width: '0%' } });
            const progressBar = el('div', { className: 'progress-bar' }, progressFill);
            const progressLabel = el('span', { className: 'progress-label' }, '0%');
            const progressCell = el('div', { className: 'progress-labeled' }, progressBar, progressLabel);

            const timeCell = el('span', { className: 'text-mono text-muted' }, '--');

            const row = el('tr', { className: 'experiment-row' },
                el('td', { className: 'run-experiment-name' }, expName),
                el('td', {}, expPolicy),
                el('td', {}, badgeEl),
                el('td', {}, progressCell),
                el('td', {}, timeCell),
            );

            tableBody.appendChild(row);

            this._experimentRows.set(expId, {
                row,
                idx: i,
                statusBadge: badgeEl,
                progressFill,
                progressLabel,
                timeCell,
                startTime: null,
                lastRound: 0,
                totalRounds: null,
            });
        }

        const table = el('table', { className: 'experiment-table' }, tableHead, tableBody);
        const tableContainer = el('div', { className: 'table-container' }, table);

        // -- Section labels --
        const listSection = el('div', { className: 'experiment-section' },
            el('div', { className: 'experiment-section-title' }, 'Experiments'),
            tableContainer,
        );

        // -- Assemble monitor --
        const monitor = el('div', { className: 'run-monitor' },
            el('div', { className: 'run-header' },
                el('div', { className: 'flex items-center gap-sm' },
                    el('h2', {}, group.name),
                    statusBadge,
                ),
                controls,
            ),
            summary,
            liveMetricsContainer,
            listSection,
        );

        main.appendChild(monitor);

        // If group is already running, reconnect WebSocket
        if (isRunning) {
            this._connectWebSocket(groupId);
        }

        // Update stats for experiments that already have a status
        this._recalcStatsFromExperiments();
    }

    _buildRunStat(value, label, valueClass = '') {
        return el('div', { className: 'run-stat' },
            el('div', { className: `run-stat-value ${valueClass}` }, String(value)),
            el('div', { className: 'run-stat-label' }, label),
        );
    }

    // ----------------------------------------------------------
    // Run Tab -- Run / Cancel / Export
    // ----------------------------------------------------------

    async _runGroup(groupId) {
        // Update button states
        this._updateRunControls(true);

        // Connect WebSocket -- the server-side stream handler runs all
        // pending experiments and pushes events back.  We do NOT call the
        // REST ``runGroup`` endpoint first because that would transition
        // experiment statuses to "queued"/"running" before the WebSocket
        // handler gets a chance to pick them up, causing a race where the
        // WS sees "no pending experiments" and closes immediately.
        this._connectWebSocket(groupId);
    }

    _connectWebSocket(groupId) {
        if (this._activeWs) {
            this._activeWs.close();
            this._activeWs = null;
        }

        try {
            const ws = api.streamEvents(groupId);
            this._activeWs = ws;

            ws.onmessage = (evt) => {
                try {
                    const event = JSON.parse(evt.data);
                    this._handleRunEvent(event);
                } catch (parseErr) {
                    console.warn('Failed to parse WebSocket event:', parseErr);
                }
            };

            ws.onerror = (err) => {
                console.error('WebSocket error:', err);
            };

            ws.onclose = () => {
                this._activeWs = null;
                this._refreshRunView();
            };
        } catch (err) {
            console.error('Failed to connect WebSocket:', err);
        }
    }

    _cancelGroup() {
        if (this._activeWs) {
            try {
                this._activeWs.send(JSON.stringify({ type: 'cancel' }));
            } catch (err) {
                console.warn('Failed to send cancel via WebSocket:', err);
            }
        }

        // Also call REST endpoint as a fallback
        if (this.selectedRunGroupId) {
            api.cancelGroup(this.selectedRunGroupId).catch(err => {
                console.error('Failed to cancel group:', err);
            });
        }

        this._updateRunControls(false);
        this._showToast('Cancellation requested', 'warning');
    }

    async _exportGroup(groupId) {
        try {
            const result = await api.exportGroup(groupId);
            this._showToast('Exported successfully. Switching to Analyze tab.', 'success');
            // Reload the viz iframe so it picks up the updated manifest,
            // then switch to the Analyze tab.
            const iframe = document.getElementById('viz-iframe');
            if (iframe) iframe.src = iframe.src;
            setTimeout(() => this.switchTab('analyze'), 500);
        } catch (err) {
            console.error('Export failed:', err);
            this._showToast('Export failed: ' + err.message, 'error');
        }
    }

    async _cloneAndRerun(groupId) {
        try {
            const newGroup = await api.cloneGroup(groupId);
            this._showToast(`Cloned as "${newGroup.name}"`, 'success');
            // Refresh sidebars and select the new group in the Run tab
            await this._refreshDesignSidebar();
            this._refreshRunSidebar();
            this._selectRunGroup(newGroup.id);
        } catch (err) {
            console.error('Clone failed:', err);
            this._showToast('Clone failed: ' + err.message, 'error');
        }
    }

    // ----------------------------------------------------------
    // Run Tab -- WebSocket Event Handler
    // ----------------------------------------------------------

    _handleRunEvent(event) {
        switch (event.type) {
            case 'round': {
                const expId = event.experiment_id;

                // Push all metrics to the live panel
                if (this._liveMetricsPanel) {
                    this._liveMetricsPanel.pushRound(event.data);
                }

                // Update experiment row
                if (expId) {
                    this._updateExperimentStatus(expId, 'running', event.data?.round_num, event.data?.elapsed_time);
                }
                break;
            }

            case 'complete': {
                const expId = event.experiment_id;
                if (expId) {
                    this._updateExperimentStatus(expId, 'completed');
                    this._completedCount++;
                    this._updateSummaryStats();
                }
                break;
            }

            case 'error': {
                const expId = event.experiment_id;
                if (expId) {
                    const msg = event.data?.message || 'Unknown error';
                    this._updateExperimentStatus(expId, 'failed', null, null, msg);
                    this._failedCount++;
                    this._updateSummaryStats();
                }
                break;
            }

            case 'group_complete': {
                this._updateRunControls(false);
                this._updateSummaryStats();
                this._showToast('All experiments finished.', 'success');
                // Refresh sidebar badges
                this._refreshDesignSidebar().then(() => this._refreshRunSidebar());
                break;
            }
        }
    }

    // ----------------------------------------------------------
    // Run Tab -- UI Update Helpers
    // ----------------------------------------------------------

    _updateExperimentStatus(expId, status, roundNum, elapsedTime, errorMsg) {
        const entry = this._experimentRows.get(expId);
        if (!entry) return;

        // Update status badge
        entry.statusBadge.className = `status-badge status-${statusClass(status)}`;
        clearChildren(entry.statusBadge);
        entry.statusBadge.appendChild(document.createTextNode(status));

        // Track running count
        if (status === 'running' && !entry.startTime) {
            entry.startTime = Date.now();
            this._runningCount++;
        }
        if (status === 'completed' || status === 'failed') {
            if (entry.startTime) {
                this._runningCount = Math.max(0, this._runningCount - 1);
            }
        }

        // Update progress
        if (roundNum !== undefined && roundNum !== null) {
            entry.lastRound = roundNum;
            // Estimate progress: if we have total_rounds, use it; else use round_num heuristically
            const totalRounds = entry.totalRounds || 1000; // default assumption
            const pct = Math.min(100, Math.round((roundNum / totalRounds) * 100));
            entry.progressFill.style.width = pct + '%';
            clearChildren(entry.progressLabel);
            entry.progressLabel.appendChild(document.createTextNode(pct + '%'));
        }

        if (status === 'completed') {
            entry.progressFill.style.width = '100%';
            entry.progressFill.classList.add('progress-success');
            clearChildren(entry.progressLabel);
            entry.progressLabel.appendChild(document.createTextNode('100%'));
        } else if (status === 'failed') {
            entry.progressFill.classList.add('progress-danger');
        }

        // Update wall time
        if (elapsedTime !== undefined && elapsedTime !== null) {
            clearChildren(entry.timeCell);
            entry.timeCell.appendChild(document.createTextNode(this._formatWallTime(elapsedTime)));
        } else if (entry.startTime && (status === 'completed' || status === 'failed')) {
            const elapsed = (Date.now() - entry.startTime) / 1000;
            clearChildren(entry.timeCell);
            entry.timeCell.appendChild(document.createTextNode(this._formatWallTime(elapsed)));
        }

        // Update summary stats
        this._updateSummaryStats();
    }

    _updateSummaryStats() {
        const total = this._runExperiments.length;
        const completed = this._completedCount;
        const failed = this._failedCount;
        const running = this._runningCount;
        const pending = Math.max(0, total - completed - failed - running);

        if (this._runStatEls.total) {
            clearChildren(this._runStatEls.total);
            this._runStatEls.total.appendChild(document.createTextNode(String(total)));
        }
        if (this._runStatEls.pending) {
            clearChildren(this._runStatEls.pending);
            this._runStatEls.pending.appendChild(document.createTextNode(String(pending)));
        }
        if (this._runStatEls.running) {
            clearChildren(this._runStatEls.running);
            this._runStatEls.running.appendChild(document.createTextNode(String(running)));
        }
        if (this._runStatEls.complete) {
            clearChildren(this._runStatEls.complete);
            this._runStatEls.complete.appendChild(document.createTextNode(String(completed + failed)));
        }
    }

    _recalcStatsFromExperiments() {
        // Recount based on experiment statuses from the fetched data
        this._completedCount = 0;
        this._failedCount = 0;
        this._runningCount = 0;

        for (const exp of this._runExperiments) {
            const s = exp.status || 'pending';
            if (s === 'complete' || s === 'completed') this._completedCount++;
            else if (s === 'error' || s === 'failed') this._failedCount++;
            else if (s === 'running') this._runningCount++;
        }

        this._updateSummaryStats();
    }

    _updateRunControls(isRunning) {
        this._isRunning = isRunning;

        if (this._runBtnRun) {
            this._runBtnRun.disabled = isRunning;
        }
        if (this._runBtnCancel) {
            this._runBtnCancel.disabled = !isRunning;
        }
        if (this._runBtnExport) {
            // Enable export only when not running
            this._runBtnExport.disabled = isRunning;
        }
        if (this._runHeaderBadge) {
            const status = isRunning ? 'running' : 'complete';
            this._runHeaderBadge.className = `status-badge status-${statusClass(status)}`;
            clearChildren(this._runHeaderBadge);
            this._runHeaderBadge.appendChild(document.createTextNode(status));
        }
    }

    _refreshRunView() {
        // Called when WebSocket closes -- refresh the view
        if (this.selectedRunGroupId) {
            this._refreshDesignSidebar().then(() => {
                this._refreshRunSidebar();
            });
        }
    }

    _cleanupRunState() {
        if (this._activeWs) {
            this._activeWs.close();
            this._activeWs = null;
        }
        if (this._liveMetricsPanel) {
            this._liveMetricsPanel.reset();
        }
        this._liveMetricsPanel = null;
        this._experimentRows = new Map();
        this._runExperiments = [];
        this._completedCount = 0;
        this._failedCount = 0;
        this._runningCount = 0;
        this._isRunning = false;
    }

    // ----------------------------------------------------------
    // Run Tab -- Utilities
    // ----------------------------------------------------------

    _formatWallTime(seconds) {
        if (seconds === null || seconds === undefined) return '--';
        const s = Math.round(seconds);
        if (s < 60) return s + 's';
        if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return h + 'h ' + m + 'm';
    }

    _showToast(message, type = 'info') {
        // Find or create toast container
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = el('div', { className: 'toast-container' });
            document.body.appendChild(container);
        }

        const toast = el('div', { className: `toast toast-${type}` }, message);
        container.appendChild(toast);

        // Auto-remove after 4 seconds
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }
}

// ================================================================
// Bootstrap
// ================================================================
const workbench = new Workbench();
