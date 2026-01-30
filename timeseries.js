// Canvas-based time-series chart with dual Y-axes
// View modes: 'all' (progressive x-axis) or 'rolling' (sliding window)

const PADDING = { top: 28, right: 55, bottom: 42, left: 50 };
const GRID_COLOR = 'rgba(255,255,255,0.07)';
const AXIS_COLOR = '#555';
const TEXT_COLOR = '#a0a0b0';

export class TimeSeriesChart {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} opts
     * @param {string} opts.title
     * @param {string} [opts.leftLabel]
     * @param {string} [opts.rightLabel]
     * @param {boolean} [opts.leftPercent] - If true, left axis is 0-100%
     */
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.title = opts.title || '';
        this.leftLabel = opts.leftLabel || '';
        this.rightLabel = opts.rightLabel || '';
        this.leftPercent = opts.leftPercent || false;
        this.series = [];
        this.currentRound = 0;
        this.maxRound = 0;

        // View mode: 'all' = progressive axis, 'rolling' = sliding window
        this.viewMode = 'all';
        this.rollingWindowRounds = 100; // default rolling window size in rounds

        // Optional: simTime array for x-axis labels (index -> simulated seconds)
        this.simTimes = null;

        // Crosshair hover state
        this._hoverX = null; // pixel x within canvas, or null

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

    setData(series) {
        this.series = series;
        this.maxRound = 0;
        for (const s of series) {
            if (s.values.length > this.maxRound) {
                this.maxRound = s.values.length;
            }
        }
    }

    /**
     * Set simulated time array for x-axis labels.
     * @param {number[]} times - simTime in seconds, one per round
     */
    setSimTimes(times) {
        this.simTimes = times;
    }

    render(currentRound) {
        this.currentRound = Math.max(0, Math.min(currentRound, this.maxRound - 1));
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;

        ctx.clearRect(0, 0, w, h);

        if (this.maxRound <= 1 || this.series.length === 0) {
            this._lastLayout = null;
            return;
        }

        const plotX = PADDING.left;
        const plotY = PADDING.top;
        const plotW = w - PADDING.left - PADDING.right;
        const plotH = h - PADDING.top - PADDING.bottom;

        // Determine visible x-range based on view mode
        const xRange = this._computeXRange();

        // Compute axis ranges from visible data only
        const leftRange = this._computeRange('left', xRange);
        const rightRange = this._computeRange('right', xRange);

        // Save layout for crosshair overlay
        this._lastLayout = { plotX, plotY, plotW, plotH, xRange, leftRange, rightRange };

        this._drawGrid(ctx, plotX, plotY, plotW, plotH, leftRange, rightRange, xRange);

        for (const s of this.series) {
            const range = s.yAxis === 'right' ? rightRange : leftRange;
            this._drawSeries(ctx, s, plotX, plotY, plotW, plotH, range, xRange);
        }

        // Title
        ctx.fillStyle = '#4ecca3';
        ctx.font = 'bold 11px -apple-system, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(this.title, plotX, 4);

        // Legend (horizontal, below plot)
        this._drawLegend(ctx, plotX, plotY + plotH + 18, plotW);

        // Save snapshot for crosshair overlay
        this._snapshot = ctx.getImageData(0, 0, w, h);

        // Draw crosshair if hovering
        this._drawCrosshair();
    }

    /**
     * Compute the visible x-range { start, end } in round indices.
     */
    _computeXRange() {
        const cur = this.currentRound;

        if (this.viewMode === 'rolling') {
            const windowSize = this.rollingWindowRounds;
            const start = Math.max(0, cur - windowSize + 1);
            return { start, end: cur };
        }

        // 'all' mode: 0 to current round
        return { start: 0, end: cur };
    }

    _computeRange(axis, xRange) {
        let min = Infinity, max = -Infinity;
        for (const s of this.series) {
            if (s.yAxis !== axis) continue;
            const lo = Math.max(0, xRange.start);
            const hi = Math.min(s.values.length, xRange.end + 1);
            for (let i = lo; i < hi; i++) {
                if (s.values[i] < min) min = s.values[i];
                if (s.values[i] > max) max = s.values[i];
            }
        }
        if (min === Infinity) return { min: 0, max: 1 };
        const range = max - min || 1;
        min = Math.max(0, min - range * 0.05);
        max = max + range * 0.1;
        return { min, max };
    }

    _drawGrid(ctx, px, py, pw, ph, leftRange, rightRange, xRange) {
        ctx.strokeStyle = GRID_COLOR;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.font = '10px monospace';
        ctx.textBaseline = 'middle';

        const numTicks = 5;

        // Left Y-axis ticks
        ctx.textAlign = 'right';
        ctx.fillStyle = TEXT_COLOR;
        for (let i = 0; i <= numTicks; i++) {
            const frac = i / numTicks;
            const y = py + ph - frac * ph;
            const val = leftRange.min + frac * (leftRange.max - leftRange.min);

            ctx.beginPath();
            ctx.moveTo(px, y);
            ctx.lineTo(px + pw, y);
            ctx.stroke();

            const label = this.leftPercent
                ? `${val.toFixed(0)}%`
                : val.toFixed(1);
            ctx.fillText(label, px - 4, y);
        }

        // Right Y-axis ticks
        const hasRight = this.series.some(s => s.yAxis === 'right');
        if (hasRight) {
            ctx.textAlign = 'left';
            for (let i = 0; i <= numTicks; i++) {
                const frac = i / numTicks;
                const y = py + ph - frac * ph;
                const val = rightRange.min + frac * (rightRange.max - rightRange.min);
                ctx.fillText(val.toFixed(1), px + pw + 4, y);
            }
        }

        // X-axis ticks
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const xTicks = 5;
        const xSpan = xRange.end - xRange.start;
        for (let i = 0; i <= xTicks; i++) {
            const frac = i / xTicks;
            const x = px + frac * pw;
            const roundIdx = xRange.start + frac * xSpan;
            // Show simulated hours if available, else round number
            if (this.simTimes && Math.round(roundIdx) < this.simTimes.length) {
                const hours = this.simTimes[Math.round(roundIdx)] / 3600;
                ctx.fillText(hours.toFixed(0) + 'h', x, py + ph + 4);
            } else {
                ctx.fillText(String(Math.round(roundIdx)), x, py + ph + 4);
            }
        }

        // Axis lines
        ctx.strokeStyle = AXIS_COLOR;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px, py + ph);
        ctx.lineTo(px + pw, py + ph);
        ctx.stroke();
        if (hasRight) {
            ctx.beginPath();
            ctx.moveTo(px + pw, py);
            ctx.lineTo(px + pw, py + ph);
            ctx.stroke();
        }
    }

    _drawSeries(ctx, series, px, py, pw, ph, range, xRange) {
        const values = series.values;
        const xSpan = xRange.end - xRange.start;
        if (xSpan < 1) return;

        const drawStart = Math.max(0, xRange.start);
        const drawEnd = Math.min(values.length, xRange.end + 1);
        if (drawEnd - drawStart < 2) return;

        ctx.strokeStyle = series.color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash(series.dash || []);

        ctx.beginPath();
        let started = false;
        for (let i = drawStart; i < drawEnd; i++) {
            const x = px + ((i - xRange.start) / xSpan) * pw;
            const frac = (values[i] - range.min) / (range.max - range.min);
            const y = py + ph - frac * ph;
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }

    _drawCrosshair() {
        const layout = this._lastLayout;
        if (!layout) return;

        // If not hovering, restore clean snapshot and return
        if (this._hoverX == null) {
            if (this._snapshot) {
                this.ctx.putImageData(this._snapshot, 0, 0);
            }
            return;
        }

        const { plotX, plotY, plotW, plotH, xRange, leftRange, rightRange } = layout;
        const ctx = this.ctx;

        // Check if hover is within plot area
        if (this._hoverX < plotX || this._hoverX > plotX + plotW) return;

        const xSpan = xRange.end - xRange.start;
        if (xSpan < 1) return;

        // Convert pixel to round index
        const frac = (this._hoverX - plotX) / plotW;
        const roundIdx = Math.round(xRange.start + frac * xSpan);

        // Clamp to valid range
        if (roundIdx < xRange.start || roundIdx > xRange.end) return;

        // Restore base chart snapshot before drawing overlay
        if (this._snapshot) {
            ctx.putImageData(this._snapshot, 0, 0);
        }

        // Vertical crosshair line
        const crossX = plotX + ((roundIdx - xRange.start) / xSpan) * plotW;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(crossX, plotY);
        ctx.lineTo(crossX, plotY + plotH);
        ctx.stroke();
        ctx.setLineDash([]);

        // Collect values for each series at this round
        const entries = [];
        for (const s of this.series) {
            if (roundIdx < 0 || roundIdx >= s.values.length) continue;
            const val = s.values[roundIdx];
            const range = s.yAxis === 'right' ? rightRange : leftRange;
            const yFrac = (val - range.min) / (range.max - range.min);
            const dotY = plotY + plotH - yFrac * plotH;

            // Format value
            let formatted;
            if (this.leftPercent && s.yAxis !== 'right') {
                formatted = val.toFixed(1) + '%';
            } else {
                formatted = val < 10 ? val.toFixed(2) : val.toFixed(1);
            }

            entries.push({ label: s.label, color: s.color, val, formatted, dotY });

            // Draw dot on the line
            ctx.fillStyle = s.color;
            ctx.beginPath();
            ctx.arc(crossX, dotY, 3, 0, Math.PI * 2);
            ctx.fill();
        }

        if (entries.length === 0) { ctx.restore(); return; }

        // Tooltip background
        ctx.font = '10px monospace';
        const lineHeight = 14;
        const tooltipPad = 6;
        const swatchSize = 8;
        const swatchGap = 5;

        // X-axis label (simulated hours or round number)
        let xLabel;
        if (this.simTimes && roundIdx < this.simTimes.length) {
            const hours = this.simTimes[roundIdx] / 3600;
            xLabel = hours.toFixed(1) + 'h';
        } else {
            xLabel = 'R' + roundIdx;
        }

        // Measure tooltip width
        let maxTextW = ctx.measureText(xLabel).width;
        for (const e of entries) {
            const tw = ctx.measureText(`${e.label}: ${e.formatted}`).width;
            if (tw > maxTextW) maxTextW = tw;
        }
        const tooltipW = swatchSize + swatchGap + maxTextW + tooltipPad * 2;
        const tooltipH = lineHeight * (entries.length + 1) + tooltipPad * 2;

        // Position tooltip (flip side if near right edge)
        let tx = crossX + 10;
        if (tx + tooltipW > plotX + plotW) {
            tx = crossX - tooltipW - 10;
        }
        let ty = plotY + 10;
        if (ty + tooltipH > plotY + plotH) {
            ty = plotY + plotH - tooltipH;
        }

        // Draw tooltip bg
        ctx.fillStyle = 'rgba(22, 33, 62, 0.92)';
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(tx, ty, tooltipW, tooltipH, 4);
        ctx.fill();
        ctx.stroke();

        // Draw x-axis label
        ctx.fillStyle = '#888';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(xLabel, tx + tooltipPad, ty + tooltipPad);

        // Draw each entry
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const ey = ty + tooltipPad + lineHeight * (i + 1);

            // Color swatch
            ctx.fillStyle = e.color;
            ctx.fillRect(tx + tooltipPad, ey + 2, swatchSize, swatchSize);

            // Text
            ctx.fillStyle = '#d0d0d0';
            ctx.fillText(`${e.label}: ${e.formatted}`, tx + tooltipPad + swatchSize + swatchGap, ey);
        }

        ctx.restore();
    }

    _drawLegend(ctx, startX, y, availableWidth) {
        ctx.font = '9px -apple-system, sans-serif';
        ctx.textBaseline = 'top';

        // Measure total width to center the legend
        const items = [];
        const lineLen = 14;
        const gap = 6;
        const itemGap = 14;
        for (const s of this.series) {
            const textW = ctx.measureText(s.label).width;
            items.push({ series: s, width: lineLen + gap + textW });
        }
        const totalW = items.reduce((a, it) => a + it.width, 0) + itemGap * (items.length - 1);
        let x = startX + Math.max(0, (availableWidth - totalW) / 2);

        for (const it of items) {
            const s = it.series;
            // Line swatch
            ctx.strokeStyle = s.color;
            ctx.lineWidth = 2;
            ctx.setLineDash(s.dash || []);
            ctx.beginPath();
            ctx.moveTo(x, y + 5);
            ctx.lineTo(x + lineLen, y + 5);
            ctx.stroke();
            ctx.setLineDash([]);
            // Label
            ctx.fillStyle = TEXT_COLOR;
            ctx.textAlign = 'left';
            ctx.fillText(s.label, x + lineLen + gap, y);
            x += it.width + itemGap;
        }
    }
}
