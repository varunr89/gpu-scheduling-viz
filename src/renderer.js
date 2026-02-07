// Job category colors
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

const EMPTY_COLOR = '#2c3e50';
const LABEL_WIDTH = 60;
// Default cell dimensions (used for small clusters)
const DEFAULT_CELL_WIDTH = 28;
const DEFAULT_CELL_HEIGHT = 36;
const DEFAULT_CELL_GAP = 2;
const ROW_GAP = 8;
// Target canvas width for auto-scaling (excluding label)
const TARGET_PLOT_WIDTH = 1200;

export class Renderer {
    constructor(canvas, config, jobs) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.config = config;
        this.jobs = jobs;
        this.jobMap = new Map();
        for (const job of jobs) {
            this.jobMap.set(job.jobId, job);
        }

        this.prevAllocations = null;
        this.dirtyGpus = new Set();
        this.hoveredGpu = -1;
        this.hoveredJobId = -1;
        this.prevHoveredJobId = -1;

        this._computeCellDimensions();
        this._setupCanvas();
        this._setupHover();
    }

    _computeCellDimensions() {
        const maxGpus = Math.max(...this.config.gpu_types.map(t => t.count));
        // Scale cell width to fit TARGET_PLOT_WIDTH, with a floor of 1px
        const idealWidth = TARGET_PLOT_WIDTH / maxGpus;
        if (idealWidth >= DEFAULT_CELL_WIDTH + DEFAULT_CELL_GAP) {
            // Small cluster: use default large cells
            this.cellWidth = DEFAULT_CELL_WIDTH;
            this.cellHeight = DEFAULT_CELL_HEIGHT;
            this.cellGap = DEFAULT_CELL_GAP;
        } else if (idealWidth >= 4) {
            // Medium cluster: shrink cells, keep small gap
            this.cellGap = 1;
            this.cellWidth = Math.max(3, Math.floor(idealWidth - this.cellGap));
            this.cellHeight = Math.max(6, Math.round(this.cellWidth * 1.3));
        } else {
            // Large cluster (Alibaba-scale): pixel dots, no gap
            this.cellGap = 0;
            this.cellWidth = Math.max(1, Math.floor(idealWidth));
            this.cellHeight = Math.max(2, this.cellWidth * 2);
        }
        this.showLabels = this.cellWidth >= 8;
    }

    _setupCanvas() {
        const maxGpus = Math.max(...this.config.gpu_types.map(t => t.count));
        const numRows = this.config.gpu_types.length;
        this.canvas.width = LABEL_WIDTH + maxGpus * (this.cellWidth + this.cellGap);
        this.canvas.height = numRows * (this.cellHeight + ROW_GAP) + ROW_GAP;
    }

    _setupHover() {
        this.canvas.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            this._handleHover(x, y);
        });
        this.canvas.addEventListener('mouseleave', () => {
            const oldJobId = this.hoveredJobId;
            this.hoveredJobId = -1;
            this.prevHoveredJobId = -1;
            this.hoveredGpu = -1;
            if (oldJobId > 0 && this.prevAllocations) {
                this._repaintJobCells(oldJobId);
            }
        });
    }

    _handleHover(x, y) {
        // Determine which GPU cell the mouse is over
        let gpuIndex = 0;
        for (let row = 0; row < this.config.gpu_types.length; row++) {
            const gy = ROW_GAP + row * (this.cellHeight + ROW_GAP);
            const count = this.config.gpu_types[row].count;
            for (let col = 0; col < count; col++) {
                const gx = LABEL_WIDTH + col * (this.cellWidth + this.cellGap);
                if (x >= gx && x < gx + this.cellWidth && y >= gy && y < gy + this.cellHeight) {
                    const jobId = this.prevAllocations ? this.prevAllocations[gpuIndex] : 0;
                    if (jobId !== this.hoveredJobId) {
                        const oldJobId = this.hoveredJobId;
                        this.prevHoveredJobId = oldJobId;
                        this.hoveredJobId = jobId;
                        this.hoveredGpu = gpuIndex;
                        if (this.prevAllocations) {
                            // Repaint only the cells for the old and new highlighted jobs
                            if (oldJobId > 0) this._repaintJobCells(oldJobId);
                            if (jobId > 0) this._repaintJobCells(jobId);
                        }
                    }
                    return;
                }
                gpuIndex++;
            }
        }
    }

    _repaintJobCells(jobId) {
        if (!this.prevAllocations) return;
        for (let i = 0; i < this.prevAllocations.length; i++) {
            if (this.prevAllocations[i] === jobId) {
                this._renderCell(i, jobId);
            }
        }
    }

    _getJobColor(jobId) {
        if (jobId === 0) return EMPTY_COLOR;
        const job = this.jobMap.get(jobId);
        if (!job) return CATEGORY_COLORS.other;
        const jobType = this.config.job_types.find(t => t.id === job.typeId);
        if (!jobType) return CATEGORY_COLORS.other;
        return CATEGORY_COLORS[jobType.category] || CATEGORY_COLORS.other;
    }

    _getJobLabel(jobId) {
        if (jobId === 0) return '';
        const job = this.jobMap.get(jobId);
        if (!job) return `J${jobId}`;
        const jobType = this.config.job_types.find(t => t.id === job.typeId);
        if (!jobType) return `J${jobId}`;
        // Abbreviate: "ResNet-18 (batch size 64)" -> "RN18"
        const name = jobType.name;
        if (name.startsWith('ResNet-18')) return 'RN18';
        if (name.startsWith('ResNet-50')) return 'RN50';
        if (name.startsWith('VGG')) return 'VGG';
        if (name.startsWith('Inception')) return 'Inc';
        if (name.startsWith('Transformer')) return 'TF';
        if (name.startsWith('LM')) return 'LM';
        if (name.startsWith('Recommendation')) return 'Rec';
        if (name.startsWith('CycleGAN')) return 'GAN';
        if (name.startsWith('A3C')) return 'A3C';
        if (name.startsWith('CIFAR')) return 'CIF';
        if (name.startsWith('DeepSpeech')) return 'DS';
        return name.substring(0, 4);
    }

    render(roundData) {
        if (!roundData) { this._renderEmpty(); return; }

        if (this.prevAllocations) {
            this.dirtyGpus.clear();
            for (let i = 0; i < roundData.allocations.length; i++) {
                if (roundData.allocations[i] !== this.prevAllocations[i]) {
                    this.dirtyGpus.add(i);
                }
            }
        } else {
            for (let i = 0; i < roundData.allocations.length; i++) {
                this.dirtyGpus.add(i);
            }
        }

        for (const gpuIdx of this.dirtyGpus) {
            this._renderCell(gpuIdx, roundData.allocations[gpuIdx]);
        }

        this.prevAllocations = [...roundData.allocations];
        this.dirtyGpus.clear();
    }

    renderFull(roundData) {
        this.prevAllocations = null;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this._renderLabels();
        if (roundData) this.render(roundData);
    }

    _renderEmpty() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this._renderLabels();
        let gpuIndex = 0;
        for (let row = 0; row < this.config.gpu_types.length; row++) {
            for (let col = 0; col < this.config.gpu_types[row].count; col++) {
                this._renderCell(gpuIndex, 0);
                gpuIndex++;
            }
        }
    }

    _renderLabels() {
        this.ctx.fillStyle = '#bbb';
        const fontSize = Math.max(8, Math.min(12, this.cellHeight - 2));
        this.ctx.font = `${fontSize}px monospace`;
        this.ctx.textBaseline = 'middle';
        for (let row = 0; row < this.config.gpu_types.length; row++) {
            const y = ROW_GAP + row * (this.cellHeight + ROW_GAP) + this.cellHeight / 2;
            this.ctx.fillText(this.config.gpu_types[row].name.toUpperCase(), 4, y);
        }
    }

    _renderCell(gpuIndex, jobId) {
        const { row, col } = this._gpuToRowCol(gpuIndex);
        const x = LABEL_WIDTH + col * (this.cellWidth + this.cellGap);
        const y = ROW_GAP + row * (this.cellHeight + ROW_GAP);

        const color = this._getJobColor(jobId);
        this.ctx.fillStyle = color;
        this.ctx.fillRect(x, y, this.cellWidth, this.cellHeight);

        // Highlight if hovered job (only when cells are large enough)
        if (this.hoveredJobId > 0 && jobId === this.hoveredJobId && this.cellWidth >= 4) {
            this.ctx.strokeStyle = '#fff';
            this.ctx.lineWidth = this.cellWidth >= 10 ? 2 : 1;
            this.ctx.strokeRect(x + 1, y + 1, this.cellWidth - 2, this.cellHeight - 2);
        }

        // Label (only when cells are large enough to read)
        if (this.showLabels) {
            const label = this._getJobLabel(jobId);
            if (label) {
                this.ctx.fillStyle = '#fff';
                const labelSize = Math.max(7, Math.min(9, this.cellWidth - 4));
                this.ctx.font = `${labelSize}px monospace`;
                this.ctx.textAlign = 'center';
                this.ctx.textBaseline = 'middle';
                this.ctx.fillText(label, x + this.cellWidth / 2, y + this.cellHeight / 2);
            }
        }
    }

    _gpuToRowCol(gpuIndex) {
        let idx = 0;
        for (let row = 0; row < this.config.gpu_types.length; row++) {
            const count = this.config.gpu_types[row].count;
            if (gpuIndex < idx + count) {
                return { row, col: gpuIndex - idx };
            }
            idx += count;
        }
        return { row: 0, col: 0 };
    }
}
