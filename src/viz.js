// GPU Scheduling Visualizer - Main Controller
import { DataSource } from './data-source.js';
import { decodeHeader, decodeConfigJson, decodeJobs, Decoder } from './decoder.js';
import { Model } from './model.js';
import { TimeSeriesChart } from './timeseries.js';
import { CDFChart } from './pdf-chart.js';
import { HeatmapModal } from './heatmap-modal.js';
import { buildWorkload, computeRoundMetrics } from './fragmentation.js';
import { ResultsChart } from './results-chart.js';

const MIN_ROUNDS = 1000;

class Controller {
    constructor() {
        this.model = new Model();
        this.roundsData = [null, null];   // Full decoded rounds per sim
        this.queueIndices = [null, null];  // Queue index arrays per sim
        this.sharingIndices = [null, null]; // Sharing index arrays per sim (v2)
        this.buffers = [null, null];       // Raw ArrayBuffers per sim
        this.playAnimId = null;
        this.lastFrameTime = 0;
        // Chart data (precomputed on sim load)
        this.chartData = [null, null];  // Per-sim: { occupancy[], effectiveUtil[], movingJct[], queueLen[], completedJobs[] }
        // Grouped filters: OR within group, AND between groups
        this._filterGroups = ['date', 'type', 'trace', 'figure', 'load', 'seed'];
        this._activeFilters = [
            { date: new Set(), type: new Set(), trace: new Set(), load: new Set(), seed: new Set() },
            { date: new Set(), type: new Set(), trace: new Set(), load: new Set(), seed: new Set() },
        ];
        this._resultsCharts = []; // Active ResultsChart instances for Results tab

        this._cacheElements();
        this._bindEvents();
        this.heatmapModal = new HeatmapModal();
        this.model.onChange((event, data) => this._onModelChange(event, data));

        console.log('GPU Scheduling Visualizer loaded');

        // Auto-load default demo data if available
        this._loadDefaultData();
    }

    _cacheElements() {
        // Experiment pickers
        this.expPickers = [
            document.getElementById('exp-picker-1'),
            document.getElementById('exp-picker-2')
        ];
        this.expSelects = [
            this.expPickers[0].querySelector('.exp-picker-select'),
            this.expPickers[1].querySelector('.exp-picker-select')
        ];
        this.expTagContainers = [
            this.expPickers[0].querySelector('.exp-picker-tags'),
            this.expPickers[1].querySelector('.exp-picker-tags')
        ];

        // Playback buttons
        this.btnFirst = document.getElementById('btn-first');
        this.btnPrev = document.getElementById('btn-prev');
        this.btnPlay = document.getElementById('btn-play');
        this.btnNext = document.getElementById('btn-next');
        this.btnLast = document.getElementById('btn-last');
        this.speedSelect = document.getElementById('speed-select');

        // Timeline
        this.scrubber = document.getElementById('timeline-scrubber');
        this.timelineCurrent = document.getElementById('timeline-current');
        this.timelineTotal = document.getElementById('timeline-total');

        // Allocation bar containers
        this.allocBars = [
            document.getElementById('alloc-bars-1'),
            document.getElementById('alloc-bars-2')
        ];

        // Sim sections
        this.simSection1 = document.getElementById('sim-1');
        this.simSection2 = document.getElementById('sim-2');

        // Metrics
        this.metrics = {};
        for (const idx of [1, 2]) {
            this.metrics[idx] = {
                util: document.getElementById(`metric-util-${idx}`),
                utilBreakdown: document.getElementById(`metric-util-breakdown-${idx}`),
                running: document.getElementById(`metric-running-${idx}`),
                runningBreakdown: document.getElementById(`metric-running-breakdown-${idx}`),
                queued: document.getElementById(`metric-queued-${idx}`),
                queuedBreakdown: document.getElementById(`metric-queued-breakdown-${idx}`),
                completed: document.getElementById(`metric-completed-${idx}`),
                jct: document.getElementById(`metric-jct-${idx}`),
                fragRate: document.getElementById(`metric-fragrate-${idx}`),
                fragTotal: document.getElementById(`metric-fragtotal-${idx}`),
                unalloc: document.getElementById(`metric-unalloc-${idx}`),
                nodes: document.getElementById(`metric-nodes-${idx}`),
                pending: document.getElementById(`metric-pending-${idx}`),
                pendingBreakdown: document.getElementById(`metric-pending-breakdown-${idx}`)
            };
        }

        // Tab bar
        this.tabBar = document.getElementById('tab-bar');
        this.tabBtns = this.tabBar.querySelectorAll('.tab-btn');
        this.tabCharts = document.getElementById('tab-charts');
        this.tabHeatmap = document.getElementById('tab-heatmap');
        this.activeTab = 'charts';
        this.tabResults = document.getElementById('tab-results');
        this.resultsEmpty = document.getElementById('results-empty');
        this.resultsChartsContainer = document.getElementById('results-charts');

        // Queue lists
        this.queueList1 = document.getElementById('queue-list-1');
        this.queueList2 = document.getElementById('queue-list-2');

        // Charts section
        this.chartsSection = document.getElementById('charts-section');
        this.rollingWindowControls = document.getElementById('rolling-window-controls');
        this.rollingWindowInput = document.getElementById('rolling-window-size');
        this.pdfWindowInput = document.getElementById('pdf-window-size');
        this.pdfWindowSize = 1000;

        // Initialize chart instances
        this.utilChart = new TimeSeriesChart(
            document.getElementById('chart-utilization'),
            { title: 'Utilization', leftLabel: '%', leftPercent: true }
        );
        this.jctChart = new TimeSeriesChart(
            document.getElementById('chart-jct'),
            { title: 'Moving Avg JCT (100 jobs)', leftLabel: 'hours' }
        );
        this.queueChart = new TimeSeriesChart(
            document.getElementById('chart-queue'),
            { title: 'Queue & Arrivals', leftLabel: 'jobs' }
        );
        this.pdfChart = new CDFChart(
            document.getElementById('chart-jct-pdf'),
            { title: 'JCT CDF (last 1000 jobs)', xLabel: 'hours' }
        );
        this.fragChart = new TimeSeriesChart(
            document.getElementById('chart-fragmentation'),
            { title: 'Fragmentation (FGD)', leftLabel: '%', leftPercent: true }
        );
        this.pendingChart = new TimeSeriesChart(
            document.getElementById('chart-pending'),
            { title: 'Pending GPU Demand', leftLabel: 'GPUs' }
        );
    }

    _bindEvents() {
        // Experiment picker selects
        for (let i = 0; i < 2; i++) {
            this.expSelects[i].addEventListener('change', (e) => this._onExperimentSelected(i, e));
        }

        // Playback
        this.btnFirst.addEventListener('click', () => this.model.setCurrentRound(0));
        this.btnPrev.addEventListener('click', () => this._stepBackward());
        this.btnPlay.addEventListener('click', () => this._togglePlayback());
        this.btnNext.addEventListener('click', () => this._stepForward());
        this.btnLast.addEventListener('click', () => {
            this.model.setCurrentRound(this.model.getMaxRounds() - 1);
        });

        // Speed
        this.speedSelect.addEventListener('change', (e) => {
            this.model.playbackSpeed = parseFloat(e.target.value);
        });

        // Scrubber
        this.scrubber.addEventListener('input', (e) => {
            this.model.setCurrentRound(parseInt(e.target.value, 10));
        });

        // Chart view mode
        this._tsCharts = [this.utilChart, this.jctChart, this.queueChart, this.fragChart, this.pendingChart];
        document.querySelectorAll('input[name="chart-view"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                const mode = e.target.value;
                this._tsCharts.forEach(c => { c.viewMode = mode; });
                this.rollingWindowControls.hidden = (mode !== 'rolling');
                this._tsCharts.forEach(c => c.render(this.model.currentRound));
            });
        });

        // Rolling window size
        this.rollingWindowInput.addEventListener('change', (e) => {
            const val = Math.max(10, parseInt(e.target.value, 10) || 100);
            e.target.value = val;
            this._tsCharts.forEach(c => { c.rollingWindowRounds = val; });
            this._tsCharts.forEach(c => c.render(this.model.currentRound));
        });

        // PDF window size
        this.pdfWindowInput.addEventListener('change', (e) => {
            const val = Math.max(10, parseInt(e.target.value, 10) || 1000);
            e.target.value = val;
            this.pdfWindowSize = val;
            this.pdfChart.title = `JCT CDF (last ${val} jobs)`;
            this._pdfCount0 = -1;
            this._pdfCount1 = -1;
            this._updatePDFChart();
        });

        // Tab switching
        this.tabBtns.forEach(btn => {
            btn.addEventListener('click', () => this._switchTab(btn.dataset.tab));
        });

        // Heatmap expand buttons
        document.querySelectorAll('.heatmap-expand-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._openHeatmapModal(parseInt(btn.dataset.sim, 10));
            });
        });

        // Help modal
        const helpModal = document.getElementById('help-modal');
        const btnHelp = document.getElementById('btn-help');
        const modalClose = document.getElementById('modal-close');

        btnHelp.addEventListener('click', () => { helpModal.hidden = false; });
        modalClose.addEventListener('click', () => { helpModal.hidden = true; });
        helpModal.addEventListener('click', (e) => {
            if (e.target === helpModal) helpModal.hidden = true;
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Close modal on Escape
            if (e.code === 'Escape' && !helpModal.hidden) {
                helpModal.hidden = true;
                return;
            }

            // Ignore if user is typing in an input or modal is open
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            if (!helpModal.hidden) return;

            // When heatmap modal is open, only allow playback controls
            if (this.heatmapModal && this.heatmapModal.isOpen) {
                if (!['Space', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.code)) return;
            }

            switch (e.code) {
                case 'Space':
                    e.preventDefault();
                    this._togglePlayback();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    this._stepBackward();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    this._stepForward();
                    break;
                case 'Home':
                    e.preventDefault();
                    this.model.setCurrentRound(0);
                    break;
                case 'End':
                    e.preventDefault();
                    this.model.setCurrentRound(this.model.getMaxRounds() - 1);
                    break;
                case 'Digit1':
                    e.preventDefault();
                    this._switchTab('charts');
                    break;
                case 'Digit2':
                    e.preventDefault();
                    this._switchTab('heatmap');
                    break;
            }
        });
    }

    async _onExperimentSelected(simIndex, event) {
        const file = event.target.value;
        if (!file) {
            this.model.clearSimulation(simIndex);
            return;
        }

        try {
            const resp = await fetch(`data/${file}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const arrayBuffer = await resp.arrayBuffer();
            this._loadFromBuffer(simIndex, arrayBuffer);
            console.log(`Loaded ${file} into Sim ${simIndex + 1}`);
        } catch (err) {
            console.error(`Failed to load ${file}:`, err);
        }
    }

    _loadFromBuffer(simIndex, arrayBuffer) {
        this.buffers[simIndex] = arrayBuffer;

        const header = decodeHeader(arrayBuffer);
        const config = decodeConfigJson(
            arrayBuffer,
            header.configJsonOffset,
            header.jobMetadataOffset
        );
        const jobs = decodeJobs(arrayBuffer, header.jobMetadataOffset, header.numJobs);
        const decoder = new Decoder(header, config);

        const rounds = decoder.decodeRounds(
            arrayBuffer,
            header.roundsOffset,
            header.numRounds
        );
        this.roundsData[simIndex] = rounds;

        if (header.indexOffset > 0 && header.queueOffset > 0) {
            this.queueIndices[simIndex] = decoder.decodeQueueIndex(
                arrayBuffer,
                header.indexOffset,
                header.numRounds
            );
        }

        // V2: decode sharing index if present
        if (decoder.hasSharing()) {
            this.sharingIndices[simIndex] = decoder.decodeSharingIndex(arrayBuffer);
        } else {
            this.sharingIndices[simIndex] = null;
        }

        const blob = new Blob([arrayBuffer]);
        const blobUrl = URL.createObjectURL(blob);
        const dataSource = new DataSource(blobUrl);

        // Build lookup maps once for O(1) access during rendering
        const jobMap = new Map();
        for (const j of jobs) jobMap.set(j.jobId, j);
        const typeMap = new Map();
        for (const jt of config.job_types) typeMap.set(jt.id, jt);

        this.model.loadSimulation(simIndex, {
            header, config, dataSource, decoder, jobs, jobMap, typeMap
        });
    }

    _openHeatmapModal(simIndex) {
        const sim = this.model.getSimulation(simIndex);
        if (!sim || !this.roundsData[simIndex]) return;

        const round = Math.min(this.model.currentRound, sim.header.numRounds - 1);
        const roundData = this.roundsData[simIndex][round];
        if (!roundData) return;

        // Decode sharing data for this round if available
        let sharingMap = null;
        if (this.sharingIndices[simIndex]) {
            sharingMap = sim.decoder.decodeSharingRound(
                this.buffers[simIndex], this.sharingIndices[simIndex], round
            );
        }

        const policy = sim.config.policy || 'unknown';
        const title = `Simulation ${simIndex + 1} -- ${policy}`;
        this.heatmapModal.open(title, sim.config, sim.jobs, roundData.allocations, simIndex, sharingMap);
    }

    async _loadDefaultData() {
        // Load manifest and build experiment picker UI
        try {
            const resp = await fetch('data/manifest.json');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const manifestData = await resp.json();
            if (Array.isArray(manifestData)) {
                this.manifestExperiments = manifestData;
                this.manifestResults = {};
            } else {
                this.manifestExperiments = manifestData.experiments || [];
                this.manifestResults = manifestData.results || {};
            }
            console.log(`Loaded manifest: ${this.manifestExperiments.length} experiments`);
        } catch (err) {
            console.warn('Could not load manifest:', err.message);
            this.manifestExperiments = [];
            this.manifestResults = {};
            return;
        }

        // Collect unique values per filter group
        const groupValues = {};
        for (const group of this._filterGroups) {
            groupValues[group] = new Set();
        }
        for (const exp of this.manifestExperiments) {
            const f = exp.filters || {};
            for (const group of this._filterGroups) {
                if (f[group]) groupValues[group].add(f[group]);
            }
        }

        // Sort values within each group
        const groupLabels = { date: 'Date', type: 'Type', trace: 'Trace', load: 'Load', seed: 'Seed' };
        const sortedValues = {};
        for (const group of this._filterGroups) {
            const vals = [...groupValues[group]];
            if (group === 'load') {
                // Sort numerically: extract leading number, fall back to alpha
                vals.sort((a, b) => {
                    const na = parseFloat(a);
                    const nb = parseFloat(b);
                    if (!isNaN(na) && !isNaN(nb)) return na - nb;
                    if (!isNaN(na)) return -1;
                    if (!isNaN(nb)) return 1;
                    return a.localeCompare(b);
                });
            } else if (group === 'date') {
                vals.sort();
            } else {
                vals.sort();
            }
            sortedValues[group] = vals;
        }

        // Build grouped tag buttons for each picker
        for (let i = 0; i < 2; i++) {
            const container = this.expTagContainers[i];
            for (const group of this._filterGroups) {
                const row = document.createElement('div');
                row.className = 'exp-filter-group';
                const label = document.createElement('span');
                label.className = 'exp-filter-label';
                label.textContent = groupLabels[group];
                row.appendChild(label);

                const btnWrap = document.createElement('div');
                btnWrap.className = 'exp-filter-buttons';
                for (const val of sortedValues[group]) {
                    const btn = document.createElement('button');
                    btn.className = 'exp-tag';
                    btn.textContent = val;
                    btn.dataset.group = group;
                    btn.dataset.value = val;
                    btn.addEventListener('click', () => {
                        btn.classList.toggle('active');
                        if (btn.classList.contains('active')) {
                            this._activeFilters[i][group].add(val);
                        } else {
                            this._activeFilters[i][group].delete(val);
                        }
                        this._updateExperimentList(i);
                        this._updateFilterAvailability(i);
                        if (this.activeTab === 'results') { this._renderResultsTab(); }
                    });
                    btnWrap.appendChild(btn);
                }
                row.appendChild(btnWrap);
                container.appendChild(row);
            }
            this._updateExperimentList(i);
            this._updateFilterAvailability(i);
        }

        // Auto-load defaults
        const defaults = ['fig9_perf_high.viz.bin', 'fig9_mmf_high.viz.bin'];
        for (let i = 0; i < defaults.length; i++) {
            try {
                const resp = await fetch(`data/${defaults[i]}`);
                if (!resp.ok) continue;
                const arrayBuffer = await resp.arrayBuffer();
                this._loadFromBuffer(i, arrayBuffer);
                this.expSelects[i].value = defaults[i];
                console.log(`Auto-loaded ${defaults[i]}`);
            } catch (err) {
                console.warn(`Could not auto-load ${defaults[i]}:`, err.message);
            }
        }

        // Start at the beginning of the measurement phase
        const maxRounds = this.model.getMaxRounds();
        if (maxRounds > 6700) {
            this.model.setCurrentRound(6700);
        }
    }

    _updateExperimentList(simIndex) {
        const select = this.expSelects[simIndex];
        const activeFilters = this._activeFilters[simIndex];
        const currentValue = select.value;

        // Clear existing options
        while (select.options.length > 1) {
            select.remove(1);
        }

        // Filter manifest: OR within each group, AND between groups
        const filtered = this.manifestExperiments.filter(exp => {
            if ((exp.rounds || 0) < MIN_ROUNDS) return false;
            const f = exp.filters || {};
            for (const group of this._filterGroups) {
                const selected = activeFilters[group];
                if (selected.size === 0) continue; // no filter on this group
                if (!selected.has(f[group])) return false;
            }
            return true;
        });

        // Add matching experiments
        for (const exp of filtered) {
            const opt = document.createElement('option');
            opt.value = exp.file;
            const status = exp.complete ? '' : ' [partial]';
            opt.textContent = `${exp.label} (${exp.rounds}r)${status}`;
            if (!exp.complete) opt.className = 'partial';
            select.appendChild(opt);
        }

        // Restore previous selection if still in list
        if (currentValue && filtered.some(e => e.file === currentValue)) {
            select.value = currentValue;
        }
    }

    _updateFilterAvailability(simIndex) {
        const activeFilters = this._activeFilters[simIndex];
        const container = this.expTagContainers[simIndex];
        const groups = container.querySelectorAll('.exp-filter-group');

        groups.forEach((groupEl, groupIdx) => {
            const group = this._filterGroups[groupIdx];
            const buttons = groupEl.querySelectorAll('.exp-tag');

            const available = new Map();
            for (const exp of this.manifestExperiments) {
                if ((exp.rounds || 0) < MIN_ROUNDS) continue;
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
                    btn.textContent = count > 0 ? `${val} (${count})` : val;
                }
            });
        });
    }

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
                xRange: section.x_range || null,
                yRange: section.y_range || null,
                onClick: (point, curve) => this._onResultsClick(point, curve),
            });
            chart.setData(curves, section.reference || null);
            chart.render();
            this._resultsCharts.push(chart);
        }
    }

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

    _switchTab(tab) {
        if (tab === this.activeTab) return;
        this.activeTab = tab;

        // Update button active states
        this.tabBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });

        // Toggle tab content visibility
        this.tabCharts.hidden = (tab !== 'charts');
        this.tabHeatmap.hidden = (tab !== 'heatmap');
        this.tabResults.hidden = (tab !== 'results');

        if (tab === 'results' && this._renderResultsTab) {
            this._renderResultsTab();
        }

        // Bars are DOM-based so they stay current across tab switches
    }

    _updateTabLayout() {
        const sim0 = this.model.getSimulation(0);
        const sim1 = this.model.getSimulation(1);
        const loadedCount = (sim0 ? 1 : 0) + (sim1 ? 1 : 0);

        // Show/hide tab bar
        this.tabBar.hidden = (loadedCount === 0 && Object.keys(this.manifestResults || {}).length === 0);

        // Full-width vs comparison layout
        if (loadedCount === 1) {
            this.tabHeatmap.classList.add('single-sim');
        } else {
            this.tabHeatmap.classList.remove('single-sim');
        }
    }

    _onModelChange(event, data) {
        switch (event) {
            case 'simulationLoaded':
                this._onSimulationLoaded(data);
                break;
            case 'simulationCleared':
                this._onSimulationCleared(data);
                break;
            case 'roundChanged':
                this._onRoundChanged(data);
                break;
        }
    }

    _onSimulationLoaded(simIndex) {
        const sim = this.model.getSimulation(simIndex);
        const section = simIndex === 0 ? this.simSection1 : this.simSection2;

        // Show section
        section.hidden = false;

        // Build allocation bar rows for this sim
        this._buildAllocBarRows(simIndex, sim.config);

        // Update timeline max
        const maxRounds = this.model.getMaxRounds();
        this.scrubber.max = Math.max(0, maxRounds - 1);
        this.timelineTotal.textContent = `/ ${maxRounds}`;

        // Update sim title with config info
        const title = section.querySelector('.sim-title');
        const policy = sim.config.policy || 'unknown';
        title.textContent = `Simulation ${simIndex + 1} - ${policy}`;

        // Precompute chart data and show charts section
        this._precomputeChartData(simIndex);
        this.chartsSection.hidden = false;
        this._updateCharts();

        // Update tab layout (show tab bar, set single/comparison mode)
        this._updateTabLayout();

        // Render round 0
        this.model.setCurrentRound(this.model.currentRound);
    }

    _onSimulationCleared(simIndex) {
        const section = simIndex === 0 ? this.simSection1 : this.simSection2;
        section.hidden = true;
        // Clear bar rows and tooltip
        const container = this.allocBars[simIndex];
        if (container._tip) {
            container._tip.remove();
            container._tip = null;
        }
        container._rows = null;
        while (container.firstChild) container.removeChild(container.firstChild);
        this.roundsData[simIndex] = null;
        this.queueIndices[simIndex] = null;
        this.sharingIndices[simIndex] = null;
        this.buffers[simIndex] = null;
        this.chartData[simIndex] = null;

        // Hide charts if no sims loaded
        if (!this.chartData[0] && !this.chartData[1]) {
            this.chartsSection.hidden = true;
        } else {
            this._updateCharts();
        }

        // Update tab layout
        this._updateTabLayout();
    }

    _onRoundChanged(round) {
        // Update scrubber
        this.scrubber.value = round;
        this.timelineCurrent.textContent = round;

        // Update each loaded simulation
        for (let i = 0; i < 2; i++) {
            if (!this.model.getSimulation(i) || !this.roundsData[i]) continue;

            const sim = this.model.getSimulation(i);
            const clampedRound = Math.min(round, sim.header.numRounds - 1);
            const roundData = this.roundsData[i][clampedRound];

            if (!roundData) continue;

            // Decode sharing data for this round if available
            let roundSharingMap = null;
            if (this.sharingIndices[i]) {
                roundSharingMap = sim.decoder.decodeSharingRound(
                    this.buffers[i], this.sharingIndices[i], clampedRound
                );
            }

            // Update allocation bars
            this._updateAllocBars(i, sim, roundData, roundSharingMap);

            // Update metrics
            const metricIdx = i + 1;
            const m = this.metrics[metricIdx];
            const gpuTypes = sim.config.gpu_types;

            // Utilization -- compute GPU occupancy from gpu_used data
            // so headline matches breakdown
            const totalGpus = sim.header.totalGpus;
            let totalUsed = 0;
            this._clearChildren(m.utilBreakdown);
            for (let t = 0; t < gpuTypes.length; t++) {
                const gt = gpuTypes[t];
                const used = roundData.gpuUsed[t] || 0;
                totalUsed += used;
                const empty = gt.count - used;
                this._addBreakdownRow(m.utilBreakdown,
                    gt.name.toUpperCase(),
                    `${used}/${gt.count}`);
            }
            const occupancy = totalGpus > 0
                ? (totalUsed / totalGpus * 100).toFixed(1)
                : '0.0';
            m.util.textContent = `${occupancy}%`;
            // Show Gavel's effective utilization as extra context
            if (roundData.utilization > 0) {
                this._addBreakdownRow(m.utilBreakdown,
                    'Effective',
                    `${(roundData.utilization * 100).toFixed(1)}%`);
            }

            // Running -- count unique jobs from allocations when available,
            // otherwise fall back to telemetry jobsRunning count
            const runningByCategory = {};
            const seenJobs = new Set();
            for (const jobId of roundData.allocations) {
                if (jobId === 0 || seenJobs.has(jobId)) continue;
                seenJobs.add(jobId);
                const job = sim.jobMap.get(jobId);
                if (job) {
                    const jt = sim.typeMap.get(job.typeId);
                    const cat = jt ? jt.category : 'other';
                    runningByCategory[cat] = (runningByCategory[cat] || 0) + 1;
                }
            }
            const hasAllocData = sim.header.numJobs > 0;
            m.running.textContent = hasAllocData ? seenJobs.size : roundData.jobsRunning;
            this._clearChildren(m.runningBreakdown);
            for (const [cat, count] of Object.entries(runningByCategory).sort((a, b) => b[1] - a[1])) {
                this._addBreakdownRow(m.runningBreakdown, cat, String(count));
            }

            // Queued -- use decoded queue when available, fall back to
            // telemetry jobsQueued for telemetry-only files
            const queuedCount = this._updateQueuedBreakdown(i, clampedRound, m.queuedBreakdown);
            m.queued.textContent = hasAllocData ? queuedCount : roundData.jobsQueued;

            // Completed
            m.completed.textContent = roundData.jobsCompleted;

            // Avg JCT (always in hours)
            if (roundData.avgJct > 0) {
                const hours = roundData.avgJct / 3600;
                m.jct.textContent = `${hours.toFixed(1)}h`;
            } else {
                m.jct.textContent = '--';
            }

            // Fragmentation metrics (from precomputed chart data)
            const cd = this.chartData[i];
            if (cd && cd.fragRate.length > 0) {
                const r = Math.min(clampedRound, cd.fragRate.length - 1);
                m.fragRate.textContent = `${cd.fragRate[r].toFixed(1)}%`;
                m.fragTotal.textContent = `${cd.fragTotal[r].toFixed(1)}%`;

                // Unallocated GPU %
                const unallocPct = totalGpus > 0
                    ? ((totalGpus - totalUsed) / totalGpus * 100).toFixed(1)
                    : '0.0';
                m.unalloc.textContent = `${unallocPct}%`;

                // Occupied nodes
                m.nodes.textContent = cd.occupiedNodes[r];

                // Pending GPU demand with breakdown by scale factor
                let totalPending = 0;
                this._clearChildren(m.pendingBreakdown);
                for (const sf of cd.scaleFactors) {
                    const val = cd.pendingBySize[sf][r] || 0;
                    totalPending += val;
                    if (val > 0) {
                        this._addBreakdownRow(m.pendingBreakdown, `${sf}-GPU`, String(val));
                    }
                }
                m.pending.textContent = totalPending;
            }

            // Update queue
            this._updateQueue(i, clampedRound);
        }

        // Update charts
        if (this.chartData[0] || this.chartData[1]) {
            this.utilChart.render(round);
            this.jctChart.render(round);
            this.queueChart.render(round);
            this.fragChart.render(round);
            this.pendingChart.render(round);
            this._updatePDFChart();
        }

        // Update heatmap modal if open
        if (this.heatmapModal && this.heatmapModal.isOpen) {
            const si = this.heatmapModal.simIndex;
            if (this.roundsData[si]) {
                const sim = this.model.getSimulation(si);
                const cr = Math.min(round, sim.header.numRounds - 1);
                const rd = this.roundsData[si][cr];
                if (rd) {
                    let sharingMap = null;
                    if (this.sharingIndices[si]) {
                        sharingMap = sim.decoder.decodeSharingRound(
                            this.buffers[si], this.sharingIndices[si], cr
                        );
                    }
                    this.heatmapModal.update(rd.allocations, sharingMap);
                }
            }
        }
    }

    // -- Allocation Bars --

    _buildAllocBarRows(simIndex, config) {
        const container = this.allocBars[simIndex];
        while (container.firstChild) container.removeChild(container.firstChild);

        // Create a tooltip element (shared for this sim)
        const tip = document.createElement('div');
        tip.className = 'alloc-bar-tip';
        document.body.appendChild(tip);
        container._tip = tip;

        // One row per GPU type
        container._rows = [];
        for (const gt of config.gpu_types) {
            const row = document.createElement('div');
            row.className = 'alloc-bar-row';

            const label = document.createElement('span');
            label.className = 'alloc-bar-label';
            label.textContent = gt.name.toUpperCase();

            const track = document.createElement('div');
            track.className = 'alloc-bar-track';

            const pct = document.createElement('span');
            pct.className = 'alloc-bar-pct';
            pct.textContent = '--%';

            const idle = document.createElement('span');
            idle.className = 'alloc-bar-idle';
            idle.textContent = '';

            row.append(label, track, pct, idle);
            container.appendChild(row);
            container._rows.push({ track, pct, idle, count: gt.count });
        }
    }

    _updateAllocBars(simIndex, sim, roundData, sharingMap) {
        const container = this.allocBars[simIndex];
        if (!container._rows) return;

        const jobMap = sim.jobMap;
        const typeMap = sim.typeMap;
        const hasAllocData = sim.header.numJobs > 0;

        const gpuTypes = sim.config.gpu_types;
        const allocs = roundData.allocations;
        const tip = container._tip;
        let gpuOff = 0;

        for (let t = 0; t < gpuTypes.length; t++) {
            const gt = gpuTypes[t];
            const rowInfo = container._rows[t];

            // Count GPU utilization per category for this type.
            // With sharing, each occupied quarter = 0.25 GPU utilized.
            const byCat = {};
            let usedCount = 0;

            if (hasAllocData) {
                for (let g = 0; g < gt.count; g++) {
                    const globalIdx = gpuOff + g;
                    const slots = sharingMap ? sharingMap.get(globalIdx) : null;

                    if (slots) {
                        // Shared GPU: count occupied quarters
                        let occupiedQuarters = 0;
                        for (let s = 0; s < 4; s++) {
                            if (slots[s] !== 0) {
                                occupiedQuarters++;
                                const job = jobMap.get(slots[s]);
                                const jt = job ? typeMap.get(job.typeId) : null;
                                const cat = jt ? jt.category : 'other';
                                byCat[cat] = (byCat[cat] || 0) + 0.25;
                            }
                        }
                        usedCount += occupiedQuarters * 0.25;
                    } else {
                        // Non-shared GPU: full 1.0 or 0
                        const jobId = allocs[globalIdx];
                        if (jobId === 0) continue;
                        usedCount += 1;
                        const job = jobMap.get(jobId);
                        if (job) {
                            const jt = typeMap.get(job.typeId);
                            const cat = jt ? jt.category : 'other';
                            byCat[cat] = (byCat[cat] || 0) + 1;
                        } else {
                            byCat['other'] = (byCat['other'] || 0) + 1;
                        }
                    }
                }
            } else {
                // Telemetry-only: use gpuUsed aggregate count
                usedCount = roundData.gpuUsed[t] || 0;
                if (usedCount > 0) {
                    byCat['active'] = usedCount;
                }
            }
            gpuOff += gt.count;

            const idleCount = gt.count - usedCount;
            const pctVal = ((usedCount / gt.count) * 100).toFixed(0);
            rowInfo.pct.textContent = `${pctVal}%`;
            const idleStr = Number.isInteger(idleCount) ? idleCount : idleCount.toFixed(1);
            rowInfo.idle.textContent = `${idleStr} idle`;

            // Build segments sorted by count (largest first) for visual stability
            const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
            const track = rowInfo.track;

            // Reuse or create segment divs
            let segIdx = 0;
            for (const [cat, count] of cats) {
                const widthPct = (count / gt.count * 100).toFixed(2);
                let seg = track.children[segIdx];
                if (!seg) {
                    seg = document.createElement('div');
                    seg.className = 'alloc-bar-seg';
                    seg.addEventListener('mouseenter', (e) => {
                        tip.textContent = seg._tipText || '';
                        tip.style.display = 'block';
                    });
                    seg.addEventListener('mousemove', (e) => {
                        tip.style.left = (e.clientX + 12) + 'px';
                        tip.style.top = (e.clientY - 8) + 'px';
                    });
                    seg.addEventListener('mouseleave', () => {
                        tip.style.display = 'none';
                    });
                    track.appendChild(seg);
                }
                seg.style.width = widthPct + '%';
                seg.style.background = Controller.CATEGORY_COLORS[cat] || Controller.CATEGORY_COLORS.other;
                seg._tipText = `${cat}: ${count} GPU${count > 1 ? 's' : ''} (${(count / gt.count * 100).toFixed(0)}%)`;
                segIdx++;
            }

            // Remove extra segments
            while (track.children.length > segIdx) {
                track.removeChild(track.lastChild);
            }
        }
    }

    _updateQueue(simIndex, round) {
        const queueList = simIndex === 0 ? this.queueList1 : this.queueList2;
        const sim = this.model.getSimulation(simIndex);
        const buffer = this.buffers[simIndex];
        const queueIndex = this.queueIndices[simIndex];

        // Clear existing items
        while (queueList.firstChild) {
            queueList.removeChild(queueList.firstChild);
        }

        if (!queueIndex || !buffer || !sim) return;

        // Decode queue for this round
        // Queue index stores relative offsets from queue section start
        const relativeOffset = queueIndex[round];
        if (relativeOffset === undefined) return;
        const queueOffset = sim.header.queueOffset + relativeOffset;

        try {
            const queue = sim.decoder.decodeQueueEntry(buffer, queueOffset);

            for (const jobId of queue) {
                const li = document.createElement('li');
                li.className = 'queue-item';

                const job = sim.jobMap.get(jobId);
                let jobTypeName = `Job ${jobId}`;
                let category = '';
                let scaleFactor = 1;

                if (job) {
                    scaleFactor = job.scaleFactor || 1;
                    const jobType = sim.typeMap.get(job.typeId);
                    if (jobType) {
                        jobTypeName = jobType.name;
                        category = jobType.category || '';
                    }
                }

                if (category) {
                    li.classList.add(`job-${category}`);
                }

                const nameSpan = document.createElement('span');
                nameSpan.className = 'queue-job-name';
                nameSpan.textContent = jobTypeName;

                const gpuBadge = document.createElement('span');
                gpuBadge.className = 'queue-gpu-badge';
                gpuBadge.textContent = `${scaleFactor} GPU`;

                const idSpan = document.createElement('span');
                idSpan.className = 'queue-job-id';
                idSpan.textContent = `#${jobId}`;

                li.appendChild(nameSpan);
                li.appendChild(gpuBadge);
                li.appendChild(idSpan);
                queueList.appendChild(li);
            }
        } catch (err) {
            // Queue data may not be available for all rounds
            console.warn(`Queue decode failed for round ${round}:`, err.message);
        }
    }

    // Breakdown helpers

    _clearChildren(el) {
        while (el.firstChild) el.removeChild(el.firstChild);
    }

    _addBreakdownRow(container, label, value) {
        const row = document.createElement('div');
        row.className = 'bd-row';
        const labelSpan = document.createElement('span');
        labelSpan.className = 'bd-label';
        labelSpan.textContent = label;
        const valueSpan = document.createElement('span');
        valueSpan.className = 'bd-value';
        valueSpan.textContent = value;
        row.appendChild(labelSpan);
        row.appendChild(valueSpan);
        container.appendChild(row);
    }

    _updateQueuedBreakdown(simIndex, round, container) {
        this._clearChildren(container);
        const sim = this.model.getSimulation(simIndex);
        const buffer = this.buffers[simIndex];
        const queueIndex = this.queueIndices[simIndex];

        if (!queueIndex || !buffer || !sim) return 0;
        const relativeOffset = queueIndex[round];
        if (relativeOffset === undefined) return 0;
        const queueOffset = sim.header.queueOffset + relativeOffset;

        try {
            const queue = sim.decoder.decodeQueueEntry(buffer, queueOffset);
            const byCategory = {};
            for (const jobId of queue) {
                const job = sim.jobMap.get(jobId);
                if (job) {
                    const jt = sim.typeMap.get(job.typeId);
                    const cat = jt ? jt.category : 'other';
                    byCategory[cat] = (byCategory[cat] || 0) + 1;
                }
            }
            for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
                this._addBreakdownRow(container, cat, String(count));
            }
            return queue.length;
        } catch (err) {
            // Queue data may not be available
            return 0;
        }
    }

    // Chart methods

    _precomputeChartData(simIndex) {
        const sim = this.model.getSimulation(simIndex);
        const rounds = this.roundsData[simIndex];
        if (!sim || !rounds) return;

        const totalGpus = sim.header.totalGpus;
        const gpuTypes = sim.config.gpu_types;

        const occupancy = [];
        const effectiveUtil = [];
        const queueLen = [];
        const simTimes = [];

        for (const rd of rounds) {
            // GPU occupancy
            let used = 0;
            for (const u of rd.gpuUsed) used += u;
            occupancy.push((used / totalGpus) * 100);

            // Effective utilization (Gavel's throughput-weighted)
            effectiveUtil.push((rd.utilization || 0) * 100);

            // Queue length
            queueLen.push(rd.jobsQueued);

            // Simulated time (seconds)
            simTimes.push(rd.simTime || 0);
        }

        // Job arrivals per round (smoothed with 10-round moving average)
        const rawArrivals = new Array(rounds.length).fill(0);
        for (const job of sim.jobs) {
            if (job.arrivalRound >= 0 && job.arrivalRound < rounds.length) {
                rawArrivals[job.arrivalRound]++;
            }
        }
        const arrivalWindow = 10;
        const arrivalCounts = [];
        let arrivalSum = 0;
        for (let r = 0; r < rounds.length; r++) {
            arrivalSum += rawArrivals[r];
            if (r >= arrivalWindow) arrivalSum -= rawArrivals[r - arrivalWindow];
            const windowLen = Math.min(r + 1, arrivalWindow);
            arrivalCounts.push(arrivalSum / windowLen);
        }

        // Moving 100-job avg JCT from per-job completion data
        // Sort completed jobs by completionRound
        const completedJobs = sim.jobs
            .filter(j => j.completionRound > 0 && j.duration > 0)
            .sort((a, b) => a.completionRound - b.completionRound);

        // Build per-round moving avg JCT (100-job window, in hours)
        const movingJct = [];
        if (completedJobs.length > 0) {
            // Per-job granularity available
            let jobIdx = 0;
            const jctWindow = [];
            for (let r = 0; r < rounds.length; r++) {
                const roundNum = rounds[r].round;
                while (jobIdx < completedJobs.length && completedJobs[jobIdx].completionRound <= roundNum) {
                    jctWindow.push(completedJobs[jobIdx].duration / 3600);
                    jobIdx++;
                }
                const start = Math.max(0, jctWindow.length - 100);
                const slice = jctWindow.slice(start);
                if (slice.length > 0) {
                    movingJct.push(slice.reduce((a, b) => a + b, 0) / slice.length);
                } else {
                    movingJct.push(0);
                }
            }
        } else {
            // Fallback: use round-level avg_jct from telemetry (in hours)
            for (let r = 0; r < rounds.length; r++) {
                movingJct.push(rounds[r].avgJct / 3600);
            }
        }

        // Fragmentation metrics (FGD paper Fig 7 & 9)
        // Default gpus_per_node to 1 for backward compat with old .viz.bin files
        const fragGpuTypes = gpuTypes.map(gt => ({
            ...gt,
            gpus_per_node: gt.gpus_per_node || 1
        }));
        const fragRate = [];
        const fragTotal = [];
        const occupiedNodes = [];

        const workload = buildWorkload(sim.jobs);
        for (const rd of rounds) {
            const metrics = computeRoundMetrics(rd.allocations, fragGpuTypes, workload, totalGpus);
            fragRate.push(metrics.fragRate);
            fragTotal.push(metrics.fragTotal);
            occupiedNodes.push(metrics.occupiedNodes);
        }

        // Pending GPU demand by scale factor
        // Collect unique scale factors and sort them
        const scaleFactors = [...new Set(sim.jobs.map(j => j.scaleFactor || 1))].sort((a, b) => a - b);

        // Pre-sort jobs by arrivalRound for efficient scanning
        const jobsByArrival = [...sim.jobs].sort((a, b) => a.arrivalRound - b.arrivalRound);

        const pendingBySize = {};
        for (const sf of scaleFactors) {
            pendingBySize[sf] = new Array(rounds.length).fill(0);
        }

        for (let r = 0; r < rounds.length; r++) {
            const rd = rounds[r];
            const roundNum = rd.round;

            // Build set of running job IDs from allocations
            const runningIds = new Set();
            for (const jobId of rd.allocations) {
                if (jobId > 0) runningIds.add(jobId);
            }

            // Scan jobs to find queued ones (arrived, not completed, not running)
            for (const job of jobsByArrival) {
                if (job.arrivalRound > roundNum) break; // No more arrived jobs
                if (job.completionRound > 0 && job.completionRound <= roundNum) continue; // Completed
                if (runningIds.has(job.jobId)) continue; // Running
                const sf = job.scaleFactor || 1;
                if (pendingBySize[sf] !== undefined) {
                    pendingBySize[sf][r] += sf; // GPU-equivalents
                }
            }
        }

        this.chartData[simIndex] = {
            occupancy, effectiveUtil, movingJct, queueLen, arrivalCounts, simTimes, completedJobs,
            fragRate, fragTotal, occupiedNodes, pendingBySize, scaleFactors
        };
    }

    _updateCharts() {
        const colors = ['#4ecca3', '#4a9eff'];
        const labels = ['Sim 1', 'Sim 2'];

        const utilSeries = [];
        const jctSeries = [];
        const queueSeries = [];

        for (let i = 0; i < 2; i++) {
            const cd = this.chartData[i];
            if (!cd) continue;
            const dash = i === 1 ? [4, 3] : [];

            // Utilization chart: occupancy + effective
            utilSeries.push(
                { label: `Occ ${labels[i]}`, color: colors[i], dash, yAxis: 'left', values: cd.occupancy },
                { label: `Eff ${labels[i]}`, color: i === 0 ? '#ffb347' : '#ff8c00', dash, yAxis: 'left', values: cd.effectiveUtil }
            );

            // JCT chart (own chart now)
            const jctColors = ['#4a9eff', '#7fbaff'];
            jctSeries.push(
                { label: labels[i], color: jctColors[i], dash, yAxis: 'left', values: cd.movingJct }
            );

            // Queue chart: queue length + arrival counts
            const queueColors = ['#c56cf0', '#ff6b9d'];
            const arrivalColors = ['#ffb347', '#ff8c00'];
            queueSeries.push(
                { label: `Queue ${labels[i]}`, color: queueColors[i], dash, yAxis: 'left', values: cd.queueLen },
                { label: `Arrivals ${labels[i]}`, color: arrivalColors[i], dash, yAxis: 'right', values: cd.arrivalCounts }
            );
        }

        // Use longest simTimes for x-axis labels
        let longestSimTimes = null;
        for (let i = 0; i < 2; i++) {
            const cd = this.chartData[i];
            if (cd && cd.simTimes && (!longestSimTimes || cd.simTimes.length > longestSimTimes.length)) {
                longestSimTimes = cd.simTimes;
            }
        }

        // Fragmentation chart: Frag Rate % and Frag/Total % per sim
        const fragSeries = [];
        for (let i = 0; i < 2; i++) {
            const cd = this.chartData[i];
            if (!cd || cd.fragRate.length === 0) continue;
            const dash = i === 1 ? [4, 3] : [];
            const fragRateColors = ['#e74c3c', '#ff6b6b'];
            const fragTotalColors = ['#f39c12', '#ffb347'];
            fragSeries.push(
                { label: `Frag Rate ${labels[i]}`, color: fragRateColors[i], dash, yAxis: 'left', values: cd.fragRate },
                { label: `Frag/Total ${labels[i]}`, color: fragTotalColors[i], dash, yAxis: 'left', values: cd.fragTotal }
            );
        }

        // Pending demand chart: stacked areas per scale factor per sim
        const pendingSeries = [];
        const areaColors = ['#3498db', '#2ecc71', '#e67e22', '#e74c3c', '#9b59b6', '#1abc9c'];
        for (let i = 0; i < 2; i++) {
            const cd = this.chartData[i];
            if (!cd) continue;
            // Only show stacked area for first sim if two are loaded (avoid visual confusion)
            if (i === 1 && this.chartData[0]) continue;
            for (let s = 0; s < cd.scaleFactors.length; s++) {
                const sf = cd.scaleFactors[s];
                const colorIdx = s % areaColors.length;
                pendingSeries.push({
                    label: `${sf}-GPU`,
                    color: areaColors[colorIdx],
                    fill: areaColors[colorIdx] + '66',
                    stacked: true,
                    yAxis: 'left',
                    values: cd.pendingBySize[sf]
                });
            }
        }

        this.utilChart.setData(utilSeries);
        this.utilChart.setSimTimes(longestSimTimes);
        this.utilChart.render(this.model.currentRound);

        this.jctChart.setData(jctSeries);
        this.jctChart.setSimTimes(longestSimTimes);
        this.jctChart.render(this.model.currentRound);

        this.queueChart.setData(queueSeries);
        this.queueChart.setSimTimes(longestSimTimes);
        this.queueChart.render(this.model.currentRound);

        this.fragChart.setData(fragSeries);
        this.fragChart.setSimTimes(longestSimTimes);
        this.fragChart.render(this.model.currentRound);

        this.pendingChart.setData(pendingSeries);
        this.pendingChart.setSimTimes(longestSimTimes);
        this.pendingChart.render(this.model.currentRound);

        // PDF chart
        this._updatePDFChart();
    }

    _updatePDFChart() {
        const colors = ['#4ecca3', '#4a9eff'];
        const labels = ['Sim 1', 'Sim 2'];
        const pdfCurves = [];

        // Track completed count to skip redundant KDE recomputation
        let needsRedraw = false;

        for (let i = 0; i < 2; i++) {
            const cd = this.chartData[i];
            if (!cd) continue;
            const rounds = this.roundsData[i];
            if (!rounds) continue;

            const clampedRound = Math.min(this.model.currentRound, rounds.length - 1);
            const roundNum = rounds[clampedRound].round;

            // Binary search for count of completed jobs by this round
            // (completedJobs is sorted by completionRound)
            let count = 0;
            for (let j = 0; j < cd.completedJobs.length; j++) {
                if (cd.completedJobs[j].completionRound <= roundNum) count++;
                else break;
            }

            // Check if count changed since last render
            const prevKey = `_pdfCount${i}`;
            if (this[prevKey] !== count) {
                this[prevKey] = count;
                needsRedraw = true;
            }

            // Get durations of last N jobs completed by current round (in hours)
            let durations;
            if (cd.completedJobs.length > 0) {
                const windowStart = Math.max(0, count - this.pdfWindowSize);
                durations = cd.completedJobs
                    .slice(windowStart, count)
                    .map(j => j.duration / 3600);
            } else {
                // Fallback: no per-job data, use round-level avg_jct
                const avgJct = rounds[clampedRound].avgJct;
                durations = avgJct > 0 ? [avgJct / 3600] : [];
                count = rounds[clampedRound].jobsCompleted;
            }

            const dash = i === 1 ? [4, 3] : [];
            const alpha = i === 0 ? '33' : '22';
            pdfCurves.push({
                label: labels[i],
                color: colors[i],
                fill: colors[i] + alpha,
                dash,
                durations
            });
        }

        if (needsRedraw || !this._pdfInitialized) {
            this._pdfInitialized = true;
            this.pdfChart.setData(pdfCurves);
            this.pdfChart.render();
        }
    }

    // Playback controls

    _togglePlayback() {
        if (this.model.isPlaying) {
            this._stopPlayback();
        } else {
            this._startPlayback();
        }
    }

    _startPlayback() {
        if (this.model.getMaxRounds() === 0) return;

        this.model.isPlaying = true;
        this.btnPlay.textContent = '\u23F8'; // pause symbol
        this.lastFrameTime = performance.now();
        this._playbackLoop();
    }

    _stopPlayback() {
        this.model.isPlaying = false;
        this.btnPlay.textContent = '\u25B6'; // play symbol
        if (this.playAnimId !== null) {
            cancelAnimationFrame(this.playAnimId);
            this.playAnimId = null;
        }
    }

    _playbackLoop() {
        if (!this.model.isPlaying) return;

        const now = performance.now();
        const elapsed = now - this.lastFrameTime;
        // Base rate: 10 rounds per second, scaled by speed
        const interval = 1000 / (10 * this.model.playbackSpeed);

        if (elapsed >= interval) {
            this.lastFrameTime = now;
            const nextRound = this.model.currentRound + 1;
            if (nextRound >= this.model.getMaxRounds()) {
                this._stopPlayback();
                return;
            }
            this.model.setCurrentRound(nextRound);
        }

        this.playAnimId = requestAnimationFrame(() => this._playbackLoop());
    }

    _stepForward() {
        this.model.setCurrentRound(this.model.currentRound + 1);
    }

    _stepBackward() {
        this.model.setCurrentRound(this.model.currentRound - 1);
    }
}

Controller.CATEGORY_COLORS = {
    resnet: '#3498db',
    vgg: '#2980b9',
    inception: '#2471a3',
    transformer: '#27ae60',
    language_model: '#e67e22',
    recommendation: '#e74c3c',
    cyclegan: '#e91e63',
    dcgan: '#9b59b6',
    cifar10: '#1abc9c',
    deepspeech: '#f06292',
    a3c: '#00bcd4',
    active: '#5dade2',
    other: '#95a5a6'
};

// Initialize on DOM ready
const controller = new Controller();
