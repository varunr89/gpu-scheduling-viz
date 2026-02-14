// Cross-experiment comparison charts
// Renders static bar/line charts for comparing metrics across load levels

const PAD = { top: 32, right: 20, bottom: 50, left: 60 };
const GRID_COLOR = 'rgba(255,255,255,0.07)';
const AXIS_COLOR = '#555';
const TEXT_COLOR = '#a0a0b0';
const BG_PRIMARY = '#1a1a2e';

export class ComparisonChart {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} opts
     * @param {string} opts.title
     * @param {string} [opts.yLabel]
     * @param {boolean} [opts.logScale] - Use log scale for y-axis
     */
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.title = opts.title || '';
        this.yLabel = opts.yLabel || '';
        this.logScale = opts.logScale || false;
        this.data = null; // Set via setData()

        this._hoverX = null;
        this._snapshot = null;

        canvas.addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            this._hoverX = (e.clientX - rect.left) * scaleX;
            this._drawCrosshair();
        });
        canvas.addEventListener('mouseleave', () => {
            this._hoverX = null;
            this._drawCrosshair();
        });
    }

    /**
     * @param {object} data
     * @param {number[]} data.loads - x-axis values (jph)
     * @param {object[]} data.series - [{ label, color, values: [{mean,min,max}], dash? }]
     */
    setData(data) {
        this.data = data;
    }

    render() {
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;

        ctx.clearRect(0, 0, w, h);
        if (!this.data || !this.data.loads.length) return;

        const { loads, series } = this.data;
        const plotW = w - PAD.left - PAD.right;
        const plotH = h - PAD.top - PAD.bottom;

        // Compute y range from all data
        let yMin = Infinity, yMax = -Infinity;
        for (const s of series) {
            for (const v of s.values) {
                if (v === null) continue;
                if (v.min < yMin) yMin = v.min;
                if (v.max > yMax) yMax = v.max;
            }
        }
        // Add 10% padding
        const yRange = yMax - yMin || 1;
        yMin = Math.max(0, yMin - yRange * 0.05);
        yMax = yMax + yRange * 0.1;

        // X positions: evenly spaced
        const xStep = plotW / (loads.length - 1 || 1);
        const xPos = loads.map((_, i) => PAD.left + i * xStep);

        // Y mapping
        const yMap = (val) => PAD.top + plotH - ((val - yMin) / (yMax - yMin)) * plotH;

        // Background
        ctx.fillStyle = BG_PRIMARY;
        ctx.fillRect(0, 0, w, h);

        // Grid lines (5 horizontal)
        ctx.strokeStyle = GRID_COLOR;
        ctx.lineWidth = 1;
        const yTicks = 5;
        for (let i = 0; i <= yTicks; i++) {
            const val = yMin + (yMax - yMin) * (i / yTicks);
            const y = yMap(val);
            ctx.beginPath();
            ctx.moveTo(PAD.left, y);
            ctx.lineTo(w - PAD.right, y);
            ctx.stroke();

            // Y labels
            ctx.fillStyle = TEXT_COLOR;
            ctx.font = '11px -apple-system, sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            let label;
            if (yMax > 10000) {
                label = (val / 1000).toFixed(0) + 'K';
            } else {
                label = val.toFixed(1);
            }
            ctx.fillText(label, PAD.left - 6, y);
        }

        // X axis labels
        ctx.fillStyle = TEXT_COLOR;
        ctx.font = '11px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let i = 0; i < loads.length; i++) {
            ctx.fillText(loads[i] + '', xPos[i], PAD.top + plotH + 6);
        }

        // X axis label
        ctx.fillStyle = TEXT_COLOR;
        ctx.font = '12px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Load (jobs/hour)', PAD.left + plotW / 2, h - 6);

        // Title
        ctx.fillStyle = '#e0e0e0';
        ctx.font = 'bold 13px -apple-system, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(this.title, PAD.left, 14);

        // Y label
        if (this.yLabel) {
            ctx.fillStyle = TEXT_COLOR;
            ctx.font = '11px -apple-system, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(this.yLabel, PAD.left - 6, PAD.top - 8);
        }

        // Draw error bands (min-max shading)
        for (const s of series) {
            ctx.fillStyle = s.color + '18'; // 10% opacity
            ctx.beginPath();
            let started = false;
            // Forward pass (max)
            for (let i = 0; i < s.values.length; i++) {
                const v = s.values[i];
                if (v === null) continue;
                const x = xPos[i];
                const y = yMap(v.max);
                if (!started) { ctx.moveTo(x, y); started = true; }
                else ctx.lineTo(x, y);
            }
            // Backward pass (min)
            for (let i = s.values.length - 1; i >= 0; i--) {
                const v = s.values[i];
                if (v === null) continue;
                ctx.lineTo(xPos[i], yMap(v.min));
            }
            ctx.closePath();
            ctx.fill();
        }

        // Draw lines (mean values)
        for (const s of series) {
            ctx.strokeStyle = s.color;
            ctx.lineWidth = 2.5;
            if (s.dash) ctx.setLineDash(s.dash);
            else ctx.setLineDash([]);

            ctx.beginPath();
            let started = false;
            for (let i = 0; i < s.values.length; i++) {
                const v = s.values[i];
                if (v === null) continue;
                const x = xPos[i];
                const y = yMap(v.mean);
                if (!started) { ctx.moveTo(x, y); started = true; }
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.setLineDash([]);

            // Draw dots at each data point
            for (let i = 0; i < s.values.length; i++) {
                const v = s.values[i];
                if (v === null) continue;
                ctx.fillStyle = s.color;
                ctx.beginPath();
                ctx.arc(xPos[i], yMap(v.mean), 3.5, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Draw seed points as small marks
        for (const s of series) {
            ctx.fillStyle = s.color + '88';
            for (let i = 0; i < s.values.length; i++) {
                const v = s.values[i];
                if (v === null || !v.seeds) continue;
                for (const seedVal of v.seeds) {
                    ctx.beginPath();
                    ctx.arc(xPos[i], yMap(seedVal), 1.8, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        // Legend
        const legendY = PAD.top + plotH + 28;
        let legendX = PAD.left;
        ctx.font = '11px -apple-system, sans-serif';
        for (const s of series) {
            // Color swatch
            ctx.fillStyle = s.color;
            ctx.fillRect(legendX, legendY - 4, 14, 3);
            legendX += 18;
            // Label
            ctx.fillStyle = TEXT_COLOR;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(s.label, legendX, legendY);
            legendX += ctx.measureText(s.label).width + 20;
        }

        // Save snapshot for crosshair
        this._snapshot = ctx.getImageData(0, 0, w, h);
        this._layout = { xPos, yMap, yMin, yMax, plotW, plotH, loads, series };
    }

    _drawCrosshair() {
        if (!this._snapshot || !this._layout) return;
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;

        ctx.putImageData(this._snapshot, 0, 0);

        if (this._hoverX === null) return;

        const { xPos, yMap, loads, series, plotH } = this._layout;

        // Find nearest load index
        let nearestIdx = 0;
        let nearestDist = Infinity;
        for (let i = 0; i < xPos.length; i++) {
            const d = Math.abs(this._hoverX - xPos[i]);
            if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
        }

        if (nearestDist > 30) return; // Too far from any data point

        const x = xPos[nearestIdx];

        // Vertical line
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x, PAD.top);
        ctx.lineTo(x, PAD.top + plotH);
        ctx.stroke();
        ctx.setLineDash([]);

        // Tooltip box
        const lines = [`${loads[nearestIdx]} jph`];
        for (const s of series) {
            const v = s.values[nearestIdx];
            if (v === null) continue;
            let valStr;
            if (v.mean > 10000) {
                valStr = (v.mean / 1000).toFixed(1) + 'K';
            } else {
                valStr = v.mean.toFixed(1);
            }
            lines.push(`${s.label}: ${valStr}`);
        }

        ctx.font = '11px -apple-system, sans-serif';
        const lineHeight = 15;
        const boxW = Math.max(...lines.map(l => ctx.measureText(l).width)) + 16;
        const boxH = lines.length * lineHeight + 8;
        let boxX = x + 12;
        if (boxX + boxW > w - 5) boxX = x - boxW - 12;
        const boxY = PAD.top + 10;

        ctx.fillStyle = 'rgba(0,0,0,0.88)';
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxW, boxH, 4);
        ctx.fill();
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        for (let i = 0; i < lines.length; i++) {
            ctx.fillStyle = i === 0 ? '#e0e0e0' : series[i - 1]?.color || TEXT_COLOR;
            ctx.fillText(lines[i], boxX + 8, boxY + 4 + i * lineHeight);
        }

        // Highlight dots
        for (const s of series) {
            const v = s.values[nearestIdx];
            if (v === null) continue;
            ctx.strokeStyle = s.color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, yMap(v.mean), 5, 0, Math.PI * 2);
            ctx.stroke();
        }
    }
}


/**
 * Saturation chart: stacked bar showing fraction of seeds saturated per load.
 */
export class SaturationChart {
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.title = opts.title || 'Saturation';
        this.data = null;
    }

    /**
     * @param {object} data
     * @param {number[]} data.loads
     * @param {object[]} data.series - [{ label, color, values: number[] (0-1) }]
     */
    setData(data) {
        this.data = data;
    }

    render() {
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;

        ctx.clearRect(0, 0, w, h);
        if (!this.data || !this.data.loads.length) return;

        const { loads, series } = this.data;
        const plotW = w - PAD.left - PAD.right;
        const plotH = h - PAD.top - PAD.bottom;

        // Background
        ctx.fillStyle = BG_PRIMARY;
        ctx.fillRect(0, 0, w, h);

        // Bar geometry
        const groupWidth = plotW / loads.length;
        const barWidth = Math.min(groupWidth * 0.22, 20);
        const totalBarsWidth = series.length * barWidth + (series.length - 1) * 2;

        // Grid
        ctx.strokeStyle = GRID_COLOR;
        ctx.lineWidth = 1;
        for (let i = 0; i <= 3; i++) {
            const frac = i / 3;
            const y = PAD.top + plotH - frac * plotH;
            ctx.beginPath();
            ctx.moveTo(PAD.left, y);
            ctx.lineTo(w - PAD.right, y);
            ctx.stroke();

            ctx.fillStyle = TEXT_COLOR;
            ctx.font = '11px -apple-system, sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText((frac * 3).toFixed(0) + '/3', PAD.left - 6, y);
        }

        // Title
        ctx.fillStyle = '#e0e0e0';
        ctx.font = 'bold 13px -apple-system, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(this.title, PAD.left, 14);

        // Y label
        ctx.fillStyle = TEXT_COLOR;
        ctx.font = '11px -apple-system, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('seeds', PAD.left - 6, PAD.top - 8);

        // Draw bars
        for (let li = 0; li < loads.length; li++) {
            const groupCenter = PAD.left + (li + 0.5) * groupWidth;

            for (let si = 0; si < series.length; si++) {
                const s = series[si];
                const val = s.values[li]; // 0-1 fraction
                const satSeeds = Math.round(val * 3);
                const barH = (satSeeds / 3) * plotH;
                const barX = groupCenter - totalBarsWidth / 2 + si * (barWidth + 2);
                const barY = PAD.top + plotH - barH;

                // Bar fill
                ctx.fillStyle = s.color + 'cc';
                ctx.fillRect(barX, barY, barWidth, barH);

                // Bar border
                ctx.strokeStyle = s.color;
                ctx.lineWidth = 1;
                ctx.strokeRect(barX, barY, barWidth, barH);
            }

            // X label
            ctx.fillStyle = TEXT_COLOR;
            ctx.font = '11px -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(loads[li] + '', groupCenter, PAD.top + plotH + 6);
        }

        // X axis label
        ctx.fillStyle = TEXT_COLOR;
        ctx.font = '12px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Load (jobs/hour)', PAD.left + plotW / 2, h - 6);

        // Legend
        const legendY = PAD.top + plotH + 28;
        let legendX = PAD.left;
        ctx.font = '11px -apple-system, sans-serif';
        for (const s of series) {
            ctx.fillStyle = s.color + 'cc';
            ctx.fillRect(legendX, legendY - 5, 12, 10);
            legendX += 16;
            ctx.fillStyle = TEXT_COLOR;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(s.label, legendX, legendY);
            legendX += ctx.measureText(s.label).width + 20;
        }
    }
}
