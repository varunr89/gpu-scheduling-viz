// Canvas-based empirical CDF chart for JCT distribution
// Plots sorted durations as step function: (JCT, fraction of jobs <= JCT)

const PADDING = { top: 28, right: 12, bottom: 42, left: 50 };
const GRID_COLOR = 'rgba(255,255,255,0.07)';
const AXIS_COLOR = '#555';
const TEXT_COLOR = '#a0a0b0';

export class CDFChart {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} opts
     * @param {string} opts.title
     * @param {string} [opts.xLabel]
     */
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.title = opts.title || '';
        this.xLabel = opts.xLabel || '';
        // Each curve: { label, color, dash, durations[] }
        this.curves = [];

        // Crosshair hover state
        this._hoverX = null;

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

    setData(curves) {
        this.curves = curves;
    }

    render() {
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        ctx.clearRect(0, 0, w, h);

        const px = PADDING.left;
        const py = PADDING.top;
        const pw = w - PADDING.left - PADDING.right;
        const ph = h - PADDING.top - PADDING.bottom;

        // Sort durations and compute CDF for each curve
        const cdfCurves = [];
        let globalMinX = Infinity, globalMaxX = -Infinity;

        for (const curve of this.curves) {
            if (curve.durations.length < 1) continue;
            const sorted = [...curve.durations].sort((a, b) => a - b);
            cdfCurves.push({ ...curve, sorted });
            if (sorted[0] < globalMinX) globalMinX = sorted[0];
            if (sorted[sorted.length - 1] > globalMaxX) globalMaxX = sorted[sorted.length - 1];
        }

        if (cdfCurves.length === 0) {
            ctx.fillStyle = TEXT_COLOR;
            ctx.font = '11px -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('No completed jobs yet', w / 2, h / 2);
            this._drawTitle(ctx, px);
            this._lastLayout = null;
            return;
        }

        // Add small margin on x-axis
        const xRange = globalMaxX - globalMinX || 1;
        globalMinX = Math.max(0, globalMinX - xRange * 0.02);
        globalMaxX = globalMaxX + xRange * 0.02;

        // Save layout for crosshair
        this._lastLayout = { px, py, pw, ph, globalMinX, globalMaxX, cdfCurves };

        // Draw grid (Y-axis is 0-100%)
        this._drawGrid(ctx, px, py, pw, ph, globalMinX, globalMaxX);

        // Draw each CDF curve
        for (const curve of cdfCurves) {
            this._drawCurve(ctx, curve, px, py, pw, ph, globalMinX, globalMaxX);
        }

        // Title
        this._drawTitle(ctx, px);

        // Legend
        this._drawLegend(ctx, px, py + ph + 18, pw, cdfCurves);

        // Save snapshot for crosshair overlay
        this._snapshot = ctx.getImageData(0, 0, w, h);

        // Draw crosshair if hovering
        this._drawCrosshair();
    }

    _drawGrid(ctx, px, py, pw, ph, xMin, xMax) {
        ctx.strokeStyle = GRID_COLOR;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.font = '10px monospace';
        ctx.fillStyle = TEXT_COLOR;

        // Y-axis (0-100%)
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const yTicks = 5;
        for (let i = 0; i <= yTicks; i++) {
            const frac = i / yTicks;
            const y = py + ph - frac * ph;
            ctx.beginPath();
            ctx.moveTo(px, y);
            ctx.lineTo(px + pw, y);
            ctx.stroke();
            ctx.fillText(`${(frac * 100).toFixed(0)}%`, px - 4, y);
        }

        // X-axis
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const xTicks = 5;
        for (let i = 0; i <= xTicks; i++) {
            const frac = i / xTicks;
            const x = px + frac * pw;
            const val = xMin + frac * (xMax - xMin);
            ctx.fillText(val.toFixed(1) + 'h', x, py + ph + 4);
        }

        // Axis lines
        ctx.strokeStyle = AXIS_COLOR;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px, py + ph);
        ctx.lineTo(px + pw, py + ph);
        ctx.stroke();
    }

    _drawCurve(ctx, curve, px, py, pw, ph, xMin, xMax) {
        const sorted = curve.sorted;
        const n = sorted.length;
        const xRange = xMax - xMin || 1;

        ctx.strokeStyle = curve.color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash(curve.dash || []);

        ctx.beginPath();
        // Start at (minX, 0)
        const startX = px + ((sorted[0] - xMin) / xRange) * pw;
        ctx.moveTo(startX, py + ph);

        for (let i = 0; i < n; i++) {
            const x = px + ((sorted[i] - xMin) / xRange) * pw;
            const yFrac = (i + 1) / n;
            const y = py + ph - yFrac * ph;
            // Step: horizontal then vertical
            if (i > 0) {
                const prevY = py + ph - (i / n) * ph;
                ctx.lineTo(x, prevY);
            }
            ctx.lineTo(x, y);
        }

        // Extend to right edge at 100%
        ctx.lineTo(px + pw, py);
        ctx.stroke();

        // Fill under curve
        if (curve.fill) {
            ctx.lineTo(px + pw, py + ph);
            ctx.lineTo(startX, py + ph);
            ctx.closePath();
            ctx.fillStyle = curve.fill;
            ctx.fill();
        }

        ctx.setLineDash([]);
    }

    _drawCrosshair() {
        const layout = this._lastLayout;
        if (!layout) return;

        const ctx = this.ctx;

        if (this._hoverX == null) {
            if (this._snapshot) {
                ctx.putImageData(this._snapshot, 0, 0);
            }
            return;
        }

        const { px, py, pw, ph, globalMinX, globalMaxX, cdfCurves } = layout;

        if (this._hoverX < px || this._hoverX > px + pw) return;

        const xRange = globalMaxX - globalMinX || 1;
        const frac = (this._hoverX - px) / pw;
        const xVal = globalMinX + frac * xRange;

        if (this._snapshot) {
            ctx.putImageData(this._snapshot, 0, 0);
        }

        // Vertical crosshair line
        const crossX = this._hoverX;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(crossX, py);
        ctx.lineTo(crossX, py + ph);
        ctx.stroke();
        ctx.setLineDash([]);

        // Find CDF value at xVal for each curve using binary search
        const entries = [];
        for (const curve of cdfCurves) {
            const sorted = curve.sorted;
            // Count how many values <= xVal
            let lo = 0, hi = sorted.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (sorted[mid] <= xVal) lo = mid + 1;
                else hi = mid;
            }
            const cdfVal = lo / sorted.length;
            const dotY = py + ph - cdfVal * ph;

            entries.push({
                label: curve.label,
                color: curve.color,
                formatted: `${(cdfVal * 100).toFixed(1)}%`,
                dotY
            });

            ctx.fillStyle = curve.color;
            ctx.beginPath();
            ctx.arc(crossX, dotY, 3, 0, Math.PI * 2);
            ctx.fill();
        }

        if (entries.length === 0) { ctx.restore(); return; }

        // Tooltip
        ctx.font = '10px monospace';
        const lineHeight = 14;
        const tooltipPad = 6;
        const swatchSize = 8;
        const swatchGap = 5;

        const xLabel = xVal.toFixed(1) + 'h';

        let maxTextW = ctx.measureText(xLabel).width;
        for (const e of entries) {
            const tw = ctx.measureText(`${e.label}: ${e.formatted}`).width;
            if (tw > maxTextW) maxTextW = tw;
        }
        const tooltipW = swatchSize + swatchGap + maxTextW + tooltipPad * 2;
        const tooltipH = lineHeight * (entries.length + 1) + tooltipPad * 2;

        let tx = crossX + 10;
        if (tx + tooltipW > px + pw) {
            tx = crossX - tooltipW - 10;
        }
        let ty = py + 10;
        if (ty + tooltipH > py + ph) {
            ty = py + ph - tooltipH;
        }

        ctx.fillStyle = 'rgba(22, 33, 62, 0.92)';
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(tx, ty, tooltipW, tooltipH, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#888';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(xLabel, tx + tooltipPad, ty + tooltipPad);

        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const ey = ty + tooltipPad + lineHeight * (i + 1);

            ctx.fillStyle = e.color;
            ctx.fillRect(tx + tooltipPad, ey + 2, swatchSize, swatchSize);

            ctx.fillStyle = '#d0d0d0';
            ctx.fillText(`${e.label}: ${e.formatted}`, tx + tooltipPad + swatchSize + swatchGap, ey);
        }

        ctx.restore();
    }

    _drawTitle(ctx, px) {
        ctx.fillStyle = '#4ecca3';
        ctx.font = 'bold 11px -apple-system, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(this.title, px, 4);
    }

    _drawLegend(ctx, startX, y, availableWidth, curves) {
        ctx.font = '9px -apple-system, sans-serif';
        ctx.textBaseline = 'top';

        const lineLen = 14;
        const gap = 6;
        const itemGap = 14;

        const items = [];
        for (const c of curves) {
            const textW = ctx.measureText(c.label).width;
            items.push({ curve: c, width: lineLen + gap + textW });
        }
        const totalW = items.reduce((a, it) => a + it.width, 0) + itemGap * (items.length - 1);
        let x = startX + Math.max(0, (availableWidth - totalW) / 2);

        for (const it of items) {
            const c = it.curve;
            ctx.strokeStyle = c.color;
            ctx.lineWidth = 2;
            ctx.setLineDash(c.dash || []);
            ctx.beginPath();
            ctx.moveTo(x, y + 5);
            ctx.lineTo(x + lineLen, y + 5);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = TEXT_COLOR;
            ctx.textAlign = 'left';
            ctx.fillText(c.label, x + lineLen + gap, y);
            x += it.width + itemGap;
        }
    }
}
