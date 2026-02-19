// Canvas-based scatter+line chart for aggregate experiment results
// Supports error bands, paper reference overlays, hover crosshair, click-to-drill-down

const PADDING = { top: 32, right: 16, bottom: 42, left: 55 };
const GRID_COLOR = 'rgba(255,255,255,0.07)';
const AXIS_COLOR = '#555';
const TEXT_COLOR = '#a0a0b0';

export class ResultsChart {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} opts
     * @param {string} [opts.title]
     * @param {string} [opts.xLabel]
     * @param {string} [opts.yLabel]
     * @param {function} [opts.onClick] - (point, curve) => void
     */
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.title = opts.title || '';
        this.xLabel = opts.xLabel || '';
        this.yLabel = opts.yLabel || '';
        this.onClick = opts.onClick || null;

        // Data
        this.curves = [];
        this.reference = null;

        // Crosshair hover state
        this._hoverX = null;
        this._snapshot = null;
        this._lastLayout = null;

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
        canvas.addEventListener('click', (e) => {
            if (!this.onClick) return;
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const pixelX = (e.clientX - rect.left) * scaleX;
            this._handleClick(pixelX);
        });
    }

    /**
     * Set chart data.
     * @param {Array} curves - [{key, label, color, marker, data: [{x, y, std, files}]}]
     * @param {object|null} reference - {x: number[], curves: {[key]: {label, color, values: (number|null)[]}}} or null
     */
    setData(curves, reference = null) {
        this.curves = curves;
        this.reference = reference;
    }

    render() {
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        ctx.clearRect(0, 0, w, h);

        const plotX = PADDING.left;
        const plotY = PADDING.top;
        const plotW = w - PADDING.left - PADDING.right;
        const plotH = h - PADDING.top - PADDING.bottom;

        // Compute axis ranges from all data (curves + reference)
        const { xMin, xMax, yMax } = this._computeRanges();

        if (xMin >= xMax) {
            this._lastLayout = null;
            return;
        }

        const yMin = 0;
        const yTop = yMax * 1.1;

        this._lastLayout = { plotX, plotY, plotW, plotH, xMin, xMax, yMin, yTop };

        // Draw grid, axes, and labels
        this._drawGrid(ctx, plotX, plotY, plotW, plotH, xMin, xMax, yMin, yTop);

        // Draw reference curves (behind data)
        if (this.reference) {
            this._drawReference(ctx, plotX, plotY, plotW, plotH, xMin, xMax, yMin, yTop);
        }

        // Draw data curves (on top)
        for (const curve of this.curves) {
            this._drawDataCurve(ctx, curve, plotX, plotY, plotW, plotH, xMin, xMax, yMin, yTop);
        }

        // Title
        this._drawTitle(ctx, plotX);

        // Axis labels
        this._drawAxisLabels(ctx, plotX, plotY, plotW, plotH);

        // Legend
        this._drawLegend(ctx, plotX, plotY + plotH + 18, plotW);

        // Save snapshot for crosshair overlay
        this._snapshot = ctx.getImageData(0, 0, w, h);

        // Draw crosshair if hovering
        this._drawCrosshair();
    }

    _computeRanges() {
        let xMin = Infinity, xMax = -Infinity, yMax = -Infinity;

        // Data curves
        for (const curve of this.curves) {
            for (const pt of curve.data) {
                if (pt.x < xMin) xMin = pt.x;
                if (pt.x > xMax) xMax = pt.x;
                const upper = pt.y + (pt.std || 0);
                if (upper > yMax) yMax = upper;
            }
        }

        // Reference curves
        if (this.reference) {
            const refX = this.reference.x;
            for (const xVal of refX) {
                if (xVal < xMin) xMin = xVal;
                if (xVal > xMax) xMax = xVal;
            }
            for (const key of Object.keys(this.reference.curves)) {
                const refCurve = this.reference.curves[key];
                for (const val of refCurve.values) {
                    if (val != null && val > yMax) yMax = val;
                }
            }
        }

        if (yMax <= 0) yMax = 1;
        if (xMin === Infinity) { xMin = 0; xMax = 1; }

        return { xMin, xMax, yMax };
    }

    _drawGrid(ctx, px, py, pw, ph, xMin, xMax, yMin, yTop) {
        ctx.strokeStyle = GRID_COLOR;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.font = '10px monospace';
        ctx.fillStyle = TEXT_COLOR;

        const xRange = xMax - xMin || 1;
        const yRange = yTop - yMin || 1;

        // Y-axis: 5 ticks
        const yTicks = 5;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let i = 0; i <= yTicks; i++) {
            const frac = i / yTicks;
            const y = py + ph - frac * ph;
            const val = yMin + frac * yRange;

            ctx.strokeStyle = GRID_COLOR;
            ctx.beginPath();
            ctx.moveTo(px, y);
            ctx.lineTo(px + pw, y);
            ctx.stroke();

            ctx.fillStyle = TEXT_COLOR;
            ctx.fillText(this._formatNumber(val), px - 4, y);
        }

        // X-axis: 6 ticks
        const xTicks = 6;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let i = 0; i <= xTicks; i++) {
            const frac = i / xTicks;
            const x = px + frac * pw;
            const val = xMin + frac * xRange;

            ctx.strokeStyle = GRID_COLOR;
            ctx.beginPath();
            ctx.moveTo(x, py);
            ctx.lineTo(x, py + ph);
            ctx.stroke();

            ctx.fillStyle = TEXT_COLOR;
            ctx.fillText(this._formatNumber(val), x, py + ph + 4);
        }

        // Axis lines
        ctx.strokeStyle = AXIS_COLOR;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px, py + ph);
        ctx.lineTo(px + pw, py + ph);
        ctx.stroke();
    }

    _drawReference(ctx, px, py, pw, ph, xMin, xMax, yMin, yTop) {
        const refX = this.reference.x;
        const xRange = xMax - xMin || 1;
        const yRange = yTop - yMin || 1;

        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;

        for (const key of Object.keys(this.reference.curves)) {
            const refCurve = this.reference.curves[key];
            ctx.strokeStyle = refCurve.color;
            ctx.beginPath();

            let penDown = false;
            for (let i = 0; i < refX.length; i++) {
                const val = refCurve.values[i];
                if (val == null) {
                    // Break the line on null values
                    penDown = false;
                    continue;
                }
                const sx = px + ((refX[i] - xMin) / xRange) * pw;
                const sy = py + ph - ((val - yMin) / yRange) * ph;

                if (!penDown) {
                    ctx.moveTo(sx, sy);
                    penDown = true;
                } else {
                    ctx.lineTo(sx, sy);
                }
            }
            ctx.stroke();
        }

        ctx.restore();
    }

    _drawDataCurve(ctx, curve, px, py, pw, ph, xMin, xMax, yMin, yTop) {
        const data = curve.data;
        if (data.length === 0) return;

        const xRange = xMax - xMin || 1;
        const yRange = yTop - yMin || 1;

        // Map data points to screen coordinates
        const screenPts = data.map(pt => ({
            sx: px + ((pt.x - xMin) / xRange) * pw,
            sy: py + ph - ((pt.y - yMin) / yRange) * ph,
            upperY: py + ph - (((pt.y + (pt.std || 0)) - yMin) / yRange) * ph,
            lowerY: py + ph - ((Math.max(0, pt.y - (pt.std || 0)) - yMin) / yRange) * ph,
            pt
        }));

        // Error band (shaded region)
        const hasStd = data.some(pt => pt.std > 0);
        if (hasStd) {
            ctx.beginPath();
            // Upper edge forward
            ctx.moveTo(screenPts[0].sx, screenPts[0].upperY);
            for (let i = 1; i < screenPts.length; i++) {
                ctx.lineTo(screenPts[i].sx, screenPts[i].upperY);
            }
            // Lower edge backward
            for (let i = screenPts.length - 1; i >= 0; i--) {
                ctx.lineTo(screenPts[i].sx, screenPts[i].lowerY);
            }
            ctx.closePath();

            // Parse color for alpha fill
            ctx.fillStyle = this._colorWithAlpha(curve.color, 0.12);
            ctx.fill();
        }

        // Solid line connecting points
        ctx.strokeStyle = curve.color;
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(screenPts[0].sx, screenPts[0].sy);
        for (let i = 1; i < screenPts.length; i++) {
            ctx.lineTo(screenPts[i].sx, screenPts[i].sy);
        }
        ctx.stroke();

        // Markers at each point
        ctx.fillStyle = curve.color;
        for (const sp of screenPts) {
            this._drawMarker(ctx, sp.sx, sp.sy, curve.marker || 'circle');
        }
    }

    _drawMarker(ctx, x, y, marker) {
        ctx.beginPath();
        switch (marker) {
            case 'square':
                ctx.fillRect(x - 4, y - 4, 8, 8);
                return;
            case 'triangle':
                ctx.moveTo(x, y - 5);
                ctx.lineTo(x - 4, y + 4);
                ctx.lineTo(x + 4, y + 4);
                ctx.closePath();
                ctx.fill();
                return;
            case 'circle':
            default:
                ctx.arc(x, y, 4, 0, 2 * Math.PI);
                ctx.fill();
                return;
        }
    }

    _drawTitle(ctx, px) {
        ctx.fillStyle = '#4ecca3';
        ctx.font = 'bold 11px -apple-system, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(this.title, px, 4);
    }

    _drawAxisLabels(ctx, px, py, pw, ph) {
        ctx.font = '10px -apple-system, sans-serif';
        ctx.fillStyle = TEXT_COLOR;

        // X-axis label centered below ticks
        if (this.xLabel) {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(this.xLabel, px + pw / 2, py + ph + 24);
        }

        // Y-axis label rotated vertically on left
        if (this.yLabel) {
            ctx.save();
            ctx.translate(12, py + ph / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(this.yLabel, 0, 0);
            ctx.restore();
        }
    }

    _drawLegend(ctx, startX, y, availableWidth) {
        ctx.font = '9px -apple-system, sans-serif';
        ctx.textBaseline = 'top';

        const lineLen = 14;
        const gap = 6;
        const itemGap = 16;

        // Build legend items: data curves + reference curves
        const items = [];

        for (const curve of this.curves) {
            const textW = ctx.measureText(curve.label).width;
            items.push({
                label: curve.label,
                color: curve.color,
                dash: [],
                width: lineLen + gap + textW
            });
        }

        if (this.reference) {
            for (const key of Object.keys(this.reference.curves)) {
                const refCurve = this.reference.curves[key];
                const textW = ctx.measureText(refCurve.label).width;
                items.push({
                    label: refCurve.label,
                    color: refCurve.color,
                    dash: [6, 4],
                    width: lineLen + gap + textW
                });
            }
        }

        if (items.length === 0) return;

        const totalW = items.reduce((a, it) => a + it.width, 0) + itemGap * (items.length - 1);
        let x = startX + Math.max(0, (availableWidth - totalW) / 2);

        for (const it of items) {
            // Line swatch
            ctx.strokeStyle = it.color;
            ctx.lineWidth = 2;
            ctx.setLineDash(it.dash);
            ctx.beginPath();
            ctx.moveTo(x, y + 5);
            ctx.lineTo(x + lineLen, y + 5);
            ctx.stroke();
            ctx.setLineDash([]);
            // Label
            ctx.fillStyle = TEXT_COLOR;
            ctx.textAlign = 'left';
            ctx.fillText(it.label, x + lineLen + gap, y);
            x += it.width + itemGap;
        }
    }

    _drawCrosshair() {
        const layout = this._lastLayout;
        if (!layout) return;

        const ctx = this.ctx;

        // If not hovering, restore clean snapshot
        if (this._hoverX == null) {
            if (this._snapshot) {
                ctx.putImageData(this._snapshot, 0, 0);
            }
            return;
        }

        const { plotX, plotY, plotW, plotH, xMin, xMax, yMin, yTop } = layout;

        // Check if hover is within plot area
        if (this._hoverX < plotX || this._hoverX > plotX + plotW) return;

        const xRange = xMax - xMin || 1;
        const yRange = yTop - yMin || 1;
        const threshold = xRange * 0.08; // 8% of x-range

        // Convert pixel to data x
        const frac = (this._hoverX - plotX) / plotW;
        const xVal = xMin + frac * xRange;

        // Restore base chart snapshot before drawing overlay
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
        ctx.moveTo(crossX, plotY);
        ctx.lineTo(crossX, plotY + plotH);
        ctx.stroke();
        ctx.setLineDash([]);

        // Collect nearest data point from each curve within threshold
        const entries = [];

        for (const curve of this.curves) {
            const nearest = this._findNearest(curve.data, xVal, threshold);
            if (!nearest) continue;

            const sx = plotX + ((nearest.x - xMin) / xRange) * plotW;
            const sy = plotY + plotH - ((nearest.y - yMin) / yRange) * plotH;

            // Highlight dot
            ctx.fillStyle = curve.color;
            ctx.beginPath();
            ctx.arc(sx, sy, 4, 0, Math.PI * 2);
            ctx.fill();

            const formatted = nearest.std > 0
                ? `${this._formatNumber(nearest.y)} +/- ${this._formatNumber(nearest.std)}`
                : this._formatNumber(nearest.y);

            entries.push({
                label: curve.label,
                color: curve.color,
                formatted,
                dotY: sy
            });
        }

        // Also show reference values at this x
        if (this.reference) {
            const refX = this.reference.x;
            // Find nearest reference x
            let bestIdx = -1, bestDist = Infinity;
            for (let i = 0; i < refX.length; i++) {
                const dist = Math.abs(refX[i] - xVal);
                if (dist < bestDist && dist <= threshold) {
                    bestDist = dist;
                    bestIdx = i;
                }
            }
            if (bestIdx >= 0) {
                for (const key of Object.keys(this.reference.curves)) {
                    const refCurve = this.reference.curves[key];
                    const val = refCurve.values[bestIdx];
                    if (val == null) continue;

                    const sy = plotY + plotH - ((val - yMin) / yRange) * plotH;

                    ctx.fillStyle = refCurve.color;
                    ctx.beginPath();
                    ctx.arc(crossX, sy, 3, 0, Math.PI * 2);
                    ctx.fill();

                    entries.push({
                        label: refCurve.label,
                        color: refCurve.color,
                        formatted: this._formatNumber(val),
                        dotY: sy
                    });
                }
            }
        }

        if (entries.length === 0) { ctx.restore(); return; }

        // Tooltip
        ctx.font = '10px monospace';
        const lineHeight = 14;
        const tooltipPad = 6;
        const swatchSize = 8;
        const swatchGap = 5;

        const xHeader = `x = ${this._formatNumber(xVal)}`;

        let maxTextW = ctx.measureText(xHeader).width;
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

        // Draw x header
        ctx.fillStyle = '#888';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(xHeader, tx + tooltipPad, ty + tooltipPad);

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

    _handleClick(pixelX) {
        const layout = this._lastLayout;
        if (!layout) return;

        const { plotX, plotW, xMin, xMax } = layout;
        if (pixelX < plotX || pixelX > plotX + plotW) return;

        const xRange = xMax - xMin || 1;
        const threshold = xRange * 0.10; // 10% of x-range
        const frac = (pixelX - plotX) / plotW;
        const xVal = xMin + frac * xRange;

        // Find the single nearest data point across all curves
        let bestPoint = null;
        let bestCurve = null;
        let bestDist = Infinity;

        for (const curve of this.curves) {
            for (const pt of curve.data) {
                const dist = Math.abs(pt.x - xVal);
                if (dist < bestDist && dist <= threshold) {
                    bestDist = dist;
                    bestPoint = pt;
                    bestCurve = curve;
                }
            }
        }

        if (bestPoint && bestCurve) {
            this.onClick(bestPoint, bestCurve);
        }
    }

    /**
     * Find the nearest data point to xVal within the given threshold.
     */
    _findNearest(data, xVal, threshold) {
        let best = null, bestDist = Infinity;
        for (const pt of data) {
            const dist = Math.abs(pt.x - xVal);
            if (dist < bestDist) {
                bestDist = dist;
                best = pt;
            }
        }
        return (best && bestDist <= threshold) ? best : null;
    }

    /**
     * Format a number for display: use integer if large, 1 decimal if moderate, 2 if small.
     */
    _formatNumber(val) {
        if (Math.abs(val) >= 100) return val.toFixed(0);
        if (Math.abs(val) >= 1) return val.toFixed(1);
        return val.toFixed(2);
    }

    /**
     * Convert a CSS color string to the same color with a specified alpha.
     * Handles hex (#rrggbb, #rgb) and named colors via a canvas fallback.
     */
    _colorWithAlpha(color, alpha) {
        if (color.startsWith('#')) {
            let hex = color.slice(1);
            if (hex.length === 3) {
                hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
            }
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            return `rgba(${r},${g},${b},${alpha})`;
        }
        if (color.startsWith('rgb')) {
            // rgba(...) or rgb(...)
            const match = color.match(/[\d.]+/g);
            if (match && match.length >= 3) {
                return `rgba(${match[0]},${match[1]},${match[2]},${alpha})`;
            }
        }
        // Fallback: use a temp canvas to parse the color
        const tmpCtx = document.createElement('canvas').getContext('2d');
        tmpCtx.fillStyle = color;
        const parsed = tmpCtx.fillStyle; // browser normalizes to #rrggbb or rgba
        return this._colorWithAlpha(parsed, alpha);
    }
}
