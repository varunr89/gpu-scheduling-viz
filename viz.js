// GPU Scheduling Visualizer - Main Controller
import { DataSource } from './data-source.js';
import { decodeHeader, decodeConfigJson, decodeJobs, Decoder } from './decoder.js';
import { Model } from './model.js';
import { Renderer } from './renderer.js';
import { TimeSeriesChart } from './timeseries.js';
import { CDFChart } from './pdf-chart.js';

class Controller {
    constructor() {
        this.model = new Model();
        this.renderers = [null, null];
        this.roundsData = [null, null];   // Full decoded rounds per sim
        this.queueIndices = [null, null];  // Queue index arrays per sim
        this.buffers = [null, null];       // Raw ArrayBuffers per sim
        this.playAnimId = null;
        this.lastFrameTime = 0;

        // Chart data (precomputed on sim load)
        this.chartData = [null, null];  // Per-sim: { occupancy[], effectiveUtil[], movingJct[], queueLen[], completedJobs[] }

        this._cacheElements();
        this._bindEvents();
        this.model.onChange((event, data) => this._onModelChange(event, data));

        console.log('GPU Scheduling Visualizer loaded');
    }

    _cacheElements() {
        // File inputs
        this.fileInput1 = document.getElementById('file-input-1');
        this.fileInput2 = document.getElementById('file-input-2');

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

        // Canvases
        this.canvas1 = document.getElementById('gpu-canvas-1');
        this.canvas2 = document.getElementById('gpu-canvas-2');

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
                jct: document.getElementById(`metric-jct-${idx}`)
            };
        }

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
    }

    _bindEvents() {
        // File inputs
        this.fileInput1.addEventListener('change', (e) => this._onFileSelected(0, e));
        this.fileInput2.addEventListener('change', (e) => this._onFileSelected(1, e));

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
        this._tsCharts = [this.utilChart, this.jctChart, this.queueChart];
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

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Ignore if user is typing in an input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

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
            }
        });
    }

    async _onFileSelected(simIndex, event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            // Read entire file into ArrayBuffer (local file, no range requests)
            const arrayBuffer = await file.arrayBuffer();
            this.buffers[simIndex] = arrayBuffer;

            // Decode header
            const header = decodeHeader(arrayBuffer);

            // Decode config JSON (extends from configJsonOffset to jobMetadataOffset)
            const config = decodeConfigJson(
                arrayBuffer,
                header.configJsonOffset,
                header.jobMetadataOffset
            );

            // Decode job metadata
            const jobs = decodeJobs(arrayBuffer, header.jobMetadataOffset, header.numJobs);

            // Create decoder
            const decoder = new Decoder(header, config);

            // Decode all rounds from the buffer
            const roundCount = header.numRounds;
            const rounds = decoder.decodeRounds(
                arrayBuffer,
                header.roundsOffset,
                roundCount
            );
            this.roundsData[simIndex] = rounds;

            // Decode queue index if present
            if (header.indexOffset > 0 && header.queueOffset > 0) {
                this.queueIndices[simIndex] = decoder.decodeQueueIndex(
                    arrayBuffer,
                    header.indexOffset,
                    header.numRounds
                );
            }

            // Create a DataSource (for potential HTTP use later)
            const blobUrl = URL.createObjectURL(file);
            const dataSource = new DataSource(blobUrl);

            // Load into model
            this.model.loadSimulation(simIndex, {
                header, config, dataSource, decoder, jobs
            });
        } catch (err) {
            console.error(`Failed to load simulation ${simIndex + 1}:`, err);
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
        const canvas = simIndex === 0 ? this.canvas1 : this.canvas2;
        const section = simIndex === 0 ? this.simSection1 : this.simSection2;

        // Show section
        section.hidden = false;

        // Create renderer
        this.renderers[simIndex] = new Renderer(canvas, sim.config, sim.jobs);
        this.renderers[simIndex].renderFull(null);

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

        // Render round 0
        this.model.setCurrentRound(this.model.currentRound);
    }

    _onSimulationCleared(simIndex) {
        const section = simIndex === 0 ? this.simSection1 : this.simSection2;
        section.hidden = true;
        this.renderers[simIndex] = null;
        this.roundsData[simIndex] = null;
        this.queueIndices[simIndex] = null;
        this.buffers[simIndex] = null;
        this.chartData[simIndex] = null;

        // Hide charts if no sims loaded
        if (!this.chartData[0] && !this.chartData[1]) {
            this.chartsSection.hidden = true;
        } else {
            this._updateCharts();
        }
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

            // Render GPU grid
            if (this.renderers[i]) {
                this.renderers[i].render(roundData);
            }

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

            // Running -- count unique jobs from allocations so it matches breakdown
            const runningByCategory = {};
            const seenJobs = new Set();
            for (const jobId of roundData.allocations) {
                if (jobId === 0 || seenJobs.has(jobId)) continue;
                seenJobs.add(jobId);
                const job = sim.jobs.find(j => j.jobId === jobId);
                if (job) {
                    const jt = sim.config.job_types.find(t => t.id === job.typeId);
                    const cat = jt ? jt.category : 'other';
                    runningByCategory[cat] = (runningByCategory[cat] || 0) + 1;
                }
            }
            m.running.textContent = seenJobs.size;
            this._clearChildren(m.runningBreakdown);
            for (const [cat, count] of Object.entries(runningByCategory).sort((a, b) => b[1] - a[1])) {
                this._addBreakdownRow(m.runningBreakdown, cat, String(count));
            }

            // Queued -- use decoded queue length so it matches breakdown
            const queuedCount = this._updateQueuedBreakdown(i, clampedRound, m.queuedBreakdown);
            m.queued.textContent = queuedCount;

            // Completed
            m.completed.textContent = roundData.jobsCompleted;

            // Avg JCT (always in hours)
            if (roundData.avgJct > 0) {
                const hours = roundData.avgJct / 3600;
                m.jct.textContent = `${hours.toFixed(1)}h`;
            } else {
                m.jct.textContent = '--';
            }

            // Update queue
            this._updateQueue(i, clampedRound);
        }

        // Update charts
        if (this.chartData[0] || this.chartData[1]) {
            this.utilChart.render(round);
            this.jctChart.render(round);
            this.queueChart.render(round);
            this._updatePDFChart();
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

                const job = sim.jobs.find(j => j.jobId === jobId);
                let jobTypeName = `Job ${jobId}`;
                let category = '';
                let scaleFactor = 1;

                if (job) {
                    scaleFactor = job.scaleFactor || 1;
                    const jobType = sim.config.job_types.find(t => t.id === job.typeId);
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
                const job = sim.jobs.find(j => j.jobId === jobId);
                if (job) {
                    const jt = sim.config.job_types.find(t => t.id === job.typeId);
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
        let jobIdx = 0;
        const jctWindow = [];
        for (let r = 0; r < rounds.length; r++) {
            const roundNum = rounds[r].round;
            // Add jobs completed by this round
            while (jobIdx < completedJobs.length && completedJobs[jobIdx].completionRound <= roundNum) {
                jctWindow.push(completedJobs[jobIdx].duration / 3600); // seconds -> hours
                jobIdx++;
            }
            // Sliding window: last 100 jobs
            const start = Math.max(0, jctWindow.length - 100);
            const slice = jctWindow.slice(start);
            if (slice.length > 0) {
                const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
                movingJct.push(avg);
            } else {
                movingJct.push(0);
            }
        }

        this.chartData[simIndex] = { occupancy, effectiveUtil, movingJct, queueLen, arrivalCounts, simTimes, completedJobs };
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

        this.utilChart.setData(utilSeries);
        this.utilChart.setSimTimes(longestSimTimes);
        this.utilChart.render(this.model.currentRound);

        this.jctChart.setData(jctSeries);
        this.jctChart.setSimTimes(longestSimTimes);
        this.jctChart.render(this.model.currentRound);

        this.queueChart.setData(queueSeries);
        this.queueChart.setSimTimes(longestSimTimes);
        this.queueChart.render(this.model.currentRound);

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
            const windowStart = Math.max(0, count - this.pdfWindowSize);
            const durations = cd.completedJobs
                .slice(windowStart, count)
                .map(j => j.duration / 3600);

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

// Initialize on DOM ready
const controller = new Controller();
