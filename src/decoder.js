// Binary format decoder for .viz.bin files
// Format: little-endian throughout, 8-byte aligned sections

const MAGIC = 'GPUVIZ01';
const HEADER_SIZE = 256;
const HEADER_PACKED_SIZE = 64;
const JOB_METADATA_SIZE = 24;

export function decodeHeader(buffer) {
    const view = new DataView(buffer);
    const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
    if (magic !== MAGIC) throw new Error(`Invalid magic: ${magic}`);

    return {
        magic,
        version: view.getUint32(8, true),
        numRounds: view.getUint32(12, true),
        numJobs: view.getUint32(16, true),
        numGpuTypes: view.getUint8(20),
        totalGpus: view.getUint16(21, true),
        jobMetadataOffset: Number(view.getBigUint64(24, true)),
        roundsOffset: Number(view.getBigUint64(32, true)),
        queueOffset: Number(view.getBigUint64(40, true)),
        indexOffset: Number(view.getBigUint64(48, true)),
        configJsonOffset: Number(view.getBigUint64(56, true))
    };
}

export function decodeConfigJson(buffer, offset, endOffset) {
    // Find the end of JSON (null terminator or section end)
    const bytes = new Uint8Array(buffer, offset, endOffset - offset);
    let len = bytes.length;
    while (len > 0 && bytes[len - 1] === 0) len--;
    const jsonStr = new TextDecoder().decode(bytes.subarray(0, len));
    return JSON.parse(jsonStr);
}

export function decodeJobs(buffer, offset, numJobs) {
    const jobs = [];
    const view = new DataView(buffer);
    for (let i = 0; i < numJobs; i++) {
        const o = offset + i * JOB_METADATA_SIZE;
        jobs.push({
            jobId: view.getUint32(o, true),
            typeId: view.getUint16(o + 4, true),
            scaleFactor: view.getUint8(o + 6),
            arrivalRound: view.getUint32(o + 8, true),
            completionRound: view.getUint32(o + 12, true),
            duration: view.getFloat32(o + 16, true)
        });
    }
    return jobs;
}

export class Decoder {
    constructor(header, config) {
        this.header = header;
        this.config = config;
        this.roundSize = this._computeRoundSize();
    }

    _computeRoundSize() {
        const size = 28 + this.header.numGpuTypes * 2 + this.header.totalGpus * 4;
        return Math.ceil(size / 8) * 8;
    }

    getRoundRange(startRound, count) {
        const start = this.header.roundsOffset + startRound * this.roundSize;
        const end = start + count * this.roundSize;
        return { start, end };
    }

    decodeRounds(buffer, bufferOffset, count) {
        const rounds = [];
        const view = new DataView(buffer);
        for (let i = 0; i < count; i++) {
            const o = bufferOffset + i * this.roundSize;
            const round = {
                round: view.getUint32(o, true),
                simTime: view.getFloat32(o + 4, true),
                utilization: view.getFloat32(o + 8, true),
                jobsRunning: view.getUint16(o + 12, true),
                jobsQueued: view.getUint16(o + 14, true),
                jobsCompleted: view.getUint32(o + 16, true),
                avgJct: view.getFloat32(o + 20, true),
                completionRate: view.getFloat32(o + 24, true),
                gpuUsed: [],
                allocations: []
            };

            let off = o + 28;
            for (let t = 0; t < this.header.numGpuTypes; t++) {
                round.gpuUsed.push(view.getUint16(off, true));
                off += 2;
            }
            for (let g = 0; g < this.header.totalGpus; g++) {
                round.allocations.push(view.getUint32(off, true));
                off += 4;
            }
            rounds.push(round);
        }
        return rounds;
    }

    decodeQueueEntry(buffer, offset) {
        const view = new DataView(buffer);
        const length = view.getUint16(offset, true);
        const queue = [];
        for (let i = 0; i < length; i++) {
            queue.push(view.getUint32(offset + 2 + i * 4, true));
        }
        return queue;
    }

    decodeQueueIndex(buffer, offset, numRounds) {
        const view = new DataView(buffer);
        const index = [];
        for (let i = 0; i < numRounds; i++) {
            index.push(Number(view.getBigUint64(offset + i * 8, true)));
        }
        return index;
    }
}
