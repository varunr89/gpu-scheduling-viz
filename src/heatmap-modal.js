// Fullscreen GPU allocation heatmap viewer with zoom/pan

const CATEGORY_COLORS = {
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
    other: '#95a5a6'
};

const EMPTY_COLOR = '#0d1117';
const BG_COLOR = '#0f1219';

export class HeatmapModal {
    constructor() {
        this.simIndex = -1;
        this.config = null;
        this.jobs = null;
        this.jobMap = null;
        this.allocations = null;
        this.isOpen = false;

        this.cellSize = 6;
        this.minCell = 2;
        this.maxCell = 28;
        this.bandGap = 8;
        this.headerH = 18;

        this._layout = null;

        this._buildDOM();
        this._bindEvents();
    }

    // -- DOM construction --

    _buildDOM() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'heatmap-modal-overlay';
        this.overlay.hidden = true;

        const content = document.createElement('div');
        content.className = 'heatmap-modal-content';

        // Toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'heatmap-toolbar';

        this.titleEl = document.createElement('span');
        this.titleEl.className = 'heatmap-modal-title';

        const zoomGroup = document.createElement('div');
        zoomGroup.className = 'heatmap-zoom-group';

        this.btnZoomOut = this._mkBtn('\u2212', 'Zoom out (-)');
        this.zoomLabel = document.createElement('span');
        this.zoomLabel.className = 'heatmap-zoom-label';
        this.btnZoomIn = this._mkBtn('+', 'Zoom in (+)');
        this.btnFit = this._mkBtn('Fit', 'Fit to view (0)');

        zoomGroup.append(this.btnZoomOut, this.zoomLabel, this.btnZoomIn, this.btnFit);

        this.btnClose = document.createElement('button');
        this.btnClose.className = 'modal-close';
        this.btnClose.textContent = '\u00D7';

        toolbar.append(this.titleEl, zoomGroup, this.btnClose);

        // Scrollable canvas container
        this.scrollBox = document.createElement('div');
        this.scrollBox.className = 'heatmap-scroll';

        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.scrollBox.appendChild(this.canvas);

        // Legend (populated on open)
        this.legendEl = document.createElement('div');
        this.legendEl.className = 'heatmap-legend';

        // Tooltip
        this.tooltip = document.createElement('div');
        this.tooltip.className = 'heatmap-tip';
        this.tooltip.hidden = true;

        content.append(toolbar, this.scrollBox, this.legendEl, this.tooltip);
        this.overlay.appendChild(content);
        document.body.appendChild(this.overlay);
    }

    _mkBtn(label, title) {
        const b = document.createElement('button');
        b.className = 'heatmap-zoom-btn';
        b.textContent = label;
        b.title = title;
        return b;
    }

    // -- Events --

    _bindEvents() {
        this.btnClose.addEventListener('click', () => this.close());
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
        });

        this.btnZoomIn.addEventListener('click', () => this._zoom(2));
        this.btnZoomOut.addEventListener('click', () => this._zoom(-2));
        this.btnFit.addEventListener('click', () => this._fitToView());

        this.canvas.addEventListener('mousemove', (e) => this._onHover(e));
        this.canvas.addEventListener('mouseleave', () => { this.tooltip.hidden = true; });

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            this._zoom(e.deltaY < 0 ? 1 : -1);
        }, { passive: false });

        document.addEventListener('keydown', (e) => {
            if (!this.isOpen) return;
            switch (e.code) {
                case 'Escape':
                    e.preventDefault();
                    this.close();
                    break;
                case 'Equal': case 'NumpadAdd':
                    e.preventDefault();
                    this._zoom(2);
                    break;
                case 'Minus': case 'NumpadSubtract':
                    e.preventDefault();
                    this._zoom(-2);
                    break;
                case 'Digit0':
                    e.preventDefault();
                    this._fitToView();
                    break;
            }
        });
    }

    // -- Public API --

    open(title, config, jobs, allocations, simIndex) {
        this.simIndex = simIndex;
        this.config = config;
        this.allocations = allocations;
        this.jobs = jobs;
        this.jobMap = new Map();
        for (const j of jobs) this.jobMap.set(j.jobId, j);

        this.titleEl.textContent = title || 'GPU Allocation Heatmap';
        this._buildLegend();

        this.isOpen = true;
        this.overlay.hidden = false;

        // Wait for layout, then fit and render
        requestAnimationFrame(() => this._fitToView());
    }

    close() {
        this.isOpen = false;
        this.overlay.hidden = true;
        this.tooltip.hidden = true;
    }

    update(allocations) {
        if (!this.isOpen) return;
        this.allocations = allocations;
        this._render();
    }

    // -- Legend --

    _buildLegend() {
        while (this.legendEl.firstChild) this.legendEl.removeChild(this.legendEl.firstChild);

        const seen = new Set();
        for (const jt of this.config.job_types) {
            const cat = jt.category || 'other';
            if (seen.has(cat)) continue;
            seen.add(cat);
            this._addLegendItem(cat, CATEGORY_COLORS[cat] || CATEGORY_COLORS.other);
        }
        this._addLegendItem('idle', EMPTY_COLOR);
    }

    _addLegendItem(label, color) {
        const item = document.createElement('span');
        item.className = 'heatmap-legend-item';

        const swatch = document.createElement('span');
        swatch.className = 'heatmap-legend-swatch';
        swatch.style.background = color;
        if (color === EMPTY_COLOR) {
            swatch.style.border = '1px solid #333';
        }

        item.appendChild(swatch);
        item.appendChild(document.createTextNode(label));
        this.legendEl.appendChild(item);
    }

    // -- Zoom --

    _zoom(delta) {
        const prev = this.cellSize;
        this.cellSize = Math.max(this.minCell, Math.min(this.maxCell, this.cellSize + delta));
        if (this.cellSize !== prev) {
            this.zoomLabel.textContent = `${this.cellSize}px`;
            this._render();
        }
    }

    _fitToView() {
        if (!this.config) return;
        const W = this.scrollBox.clientWidth;
        const H = this.scrollBox.clientHeight;
        if (W === 0 || H === 0) return;

        // Find largest cell size where everything fits without scrolling
        let best = this.minCell;
        for (let cs = this.maxCell; cs >= this.minCell; cs--) {
            const wrapCols = Math.max(1, Math.floor(W / cs));
            let h = 0;
            for (const gt of this.config.gpu_types) {
                h += this.headerH + Math.ceil(gt.count / wrapCols) * cs + this.bandGap;
            }
            if (h <= H) {
                best = cs;
                break;
            }
        }

        this.cellSize = best;
        this.zoomLabel.textContent = `${this.cellSize}px`;
        this._render();
    }

    // -- Layout & Rendering --

    _computeLayout() {
        const W = this.scrollBox.clientWidth;
        const cs = this.cellSize;
        const wrapCols = Math.max(1, Math.floor(W / cs));

        const bands = [];
        let y = 0;
        let gpuOff = 0;

        for (const gt of this.config.gpu_types) {
            const rows = Math.ceil(gt.count / wrapCols);
            bands.push({ name: gt.name, count: gt.count, rows, y, gpuOff, wrapCols });
            y += this.headerH + rows * cs + this.bandGap;
            gpuOff += gt.count;
        }

        return { bands, width: wrapCols * cs, height: y, wrapCols };
    }

    _render() {
        if (!this.config || !this.allocations) return;

        const layout = this._computeLayout();
        this._layout = layout;
        const cs = this.cellSize;
        const dpr = window.devicePixelRatio || 1;

        this.canvas.width = layout.width * dpr;
        this.canvas.height = layout.height * dpr;
        this.canvas.style.width = layout.width + 'px';
        this.canvas.style.height = layout.height + 'px';

        const ctx = this.ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Background
        ctx.fillStyle = BG_COLOR;
        ctx.fillRect(0, 0, layout.width, layout.height);

        const gap = cs > 4 ? 0.5 : 0;

        for (const band of layout.bands) {
            // Header: type name + utilization
            ctx.fillStyle = '#999';
            ctx.font = 'bold 11px -apple-system, sans-serif';
            ctx.textBaseline = 'bottom';

            let usedCount = 0;
            for (let i = 0; i < band.count; i++) {
                if (this.allocations[band.gpuOff + i] !== 0) usedCount++;
            }
            const pct = ((usedCount / band.count) * 100).toFixed(0);
            const idleCount = band.count - usedCount;
            ctx.fillText(
                `${band.name.toUpperCase()}  ${usedCount}/${band.count} (${pct}%)  ${idleCount} idle`,
                2,
                band.y + this.headerH - 3
            );

            // Cells
            const cellY0 = band.y + this.headerH;
            for (let i = 0; i < band.count; i++) {
                const col = i % band.wrapCols;
                const row = Math.floor(i / band.wrapCols);
                const x = col * cs;
                const y = cellY0 + row * cs;
                const jobId = this.allocations[band.gpuOff + i];

                ctx.fillStyle = this._color(jobId);
                ctx.fillRect(x, y, cs - gap, cs - gap);
            }
        }
    }

    _color(jobId) {
        if (jobId === 0) return EMPTY_COLOR;
        const job = this.jobMap.get(jobId);
        if (!job) return CATEGORY_COLORS.other;
        const jt = this.config.job_types.find(t => t.id === job.typeId);
        if (!jt) return CATEGORY_COLORS.other;
        return CATEGORY_COLORS[jt.category] || CATEGORY_COLORS.other;
    }

    // -- Hover tooltip --

    _onHover(e) {
        if (!this._layout) return;

        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const cs = this.cellSize;

        for (const band of this._layout.bands) {
            const cellY0 = band.y + this.headerH;
            const cellYEnd = cellY0 + band.rows * cs;

            if (my < cellY0 || my >= cellYEnd || mx < 0) continue;

            const col = Math.floor(mx / cs);
            const row = Math.floor((my - cellY0) / cs);
            const idx = row * band.wrapCols + col;

            if (col >= band.wrapCols || idx >= band.count) continue;

            const jobId = this.allocations[band.gpuOff + idx];
            let text = `${band.name.toUpperCase()} #${idx}`;

            if (jobId === 0) {
                text += ' -- idle';
            } else {
                const job = this.jobMap.get(jobId);
                if (job) {
                    const jt = this.config.job_types.find(t => t.id === job.typeId);
                    text += ` -- Job ${jobId}`;
                    if (jt) text += ` (${jt.name})`;
                    if (job.scaleFactor) text += ` [${job.scaleFactor} GPU]`;
                } else {
                    text += ` -- Job ${jobId}`;
                }
            }

            this.tooltip.textContent = text;
            this.tooltip.hidden = false;

            const contentRect = this.overlay.querySelector('.heatmap-modal-content').getBoundingClientRect();
            this.tooltip.style.left = (e.clientX - contentRect.left + 12) + 'px';
            this.tooltip.style.top = (e.clientY - contentRect.top - 8) + 'px';
            return;
        }

        this.tooltip.hidden = true;
    }
}
