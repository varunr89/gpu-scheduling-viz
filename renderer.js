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
const CELL_WIDTH = 28;
const CELL_HEIGHT = 36;
const CELL_GAP = 2;
const ROW_GAP = 8;

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

        this._setupCanvas();
        this._setupHover();
    }

    _setupCanvas() {
        const maxGpus = Math.max(...this.config.gpu_types.map(t => t.count));
        const numRows = this.config.gpu_types.length;
        this.canvas.width = LABEL_WIDTH + maxGpus * (CELL_WIDTH + CELL_GAP);
        this.canvas.height = numRows * (CELL_HEIGHT + ROW_GAP) + ROW_GAP;
    }

    _setupHover() {
        this.canvas.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            this._handleHover(x, y);
        });
        this.canvas.addEventListener('mouseleave', () => {
            if (this.hoveredJobId >= 0) {
                this.hoveredJobId = -1;
                this.hoveredGpu = -1;
                if (this.prevAllocations) this.renderFull({ allocations: this.prevAllocations });
            }
        });
    }

    _handleHover(x, y) {
        // Determine which GPU cell the mouse is over
        let gpuIndex = 0;
        for (let row = 0; row < this.config.gpu_types.length; row++) {
            const gy = ROW_GAP + row * (CELL_HEIGHT + ROW_GAP);
            const count = this.config.gpu_types[row].count;
            for (let col = 0; col < count; col++) {
                const gx = LABEL_WIDTH + col * (CELL_WIDTH + CELL_GAP);
                if (x >= gx && x < gx + CELL_WIDTH && y >= gy && y < gy + CELL_HEIGHT) {
                    const jobId = this.prevAllocations ? this.prevAllocations[gpuIndex] : 0;
                    if (jobId !== this.hoveredJobId) {
                        this.hoveredJobId = jobId;
                        this.hoveredGpu = gpuIndex;
                        if (this.prevAllocations) this.renderFull({ allocations: this.prevAllocations });
                    }
                    return;
                }
                gpuIndex++;
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
        this.ctx.font = '12px monospace';
        this.ctx.textBaseline = 'middle';
        for (let row = 0; row < this.config.gpu_types.length; row++) {
            const y = ROW_GAP + row * (CELL_HEIGHT + ROW_GAP) + CELL_HEIGHT / 2;
            this.ctx.fillText(this.config.gpu_types[row].name.toUpperCase(), 4, y);
        }
    }

    _renderCell(gpuIndex, jobId) {
        const { row, col } = this._gpuToRowCol(gpuIndex);
        const x = LABEL_WIDTH + col * (CELL_WIDTH + CELL_GAP);
        const y = ROW_GAP + row * (CELL_HEIGHT + ROW_GAP);

        const color = this._getJobColor(jobId);
        this.ctx.fillStyle = color;
        this.ctx.fillRect(x, y, CELL_WIDTH, CELL_HEIGHT);

        // Highlight if hovered job
        if (this.hoveredJobId > 0 && jobId === this.hoveredJobId) {
            this.ctx.strokeStyle = '#fff';
            this.ctx.lineWidth = 2;
            this.ctx.strokeRect(x + 1, y + 1, CELL_WIDTH - 2, CELL_HEIGHT - 2);
        }

        // Label
        const label = this._getJobLabel(jobId);
        if (label) {
            this.ctx.fillStyle = '#fff';
            this.ctx.font = '9px monospace';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText(label, x + CELL_WIDTH / 2, y + CELL_HEIGHT / 2);
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
