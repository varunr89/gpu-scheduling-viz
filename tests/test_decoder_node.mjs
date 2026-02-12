// Cross-language compatibility test - runs in Node.js
// Verifies JS decoder matches Python binary format writer
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import decoder functions (need to handle DOM-free environment)
// We'll inline the key decoder logic since decoder.js uses no DOM APIs

const MAGIC = 'GPUVIZ01';
const HEADER_PACKED_SIZE = 64;
const JOB_METADATA_SIZE = 24;

function decodeHeader(buffer) {
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

function decodeJobs(buffer, offset, numJobs) {
    const jobs = [];
    const view = new DataView(buffer);
    for (let i = 0; i < numJobs; i++) {
        const o = offset + i * JOB_METADATA_SIZE;
        jobs.push({
            jobId: view.getUint32(o, true),
            typeId: view.getUint16(o + 4, true),
            scaleFactor: view.getUint8(o + 6),
            arrivalRound: view.getUint32(o + 8, true)
        });
    }
    return jobs;
}

function computeRoundSize(numGpuTypes, totalGpus) {
    const size = 28 + numGpuTypes * 2 + totalGpus * 4;
    return Math.ceil(size / 8) * 8;
}

function decodeRound(view, offset, numGpuTypes, totalGpus) {
    const round = {
        round: view.getUint32(offset, true),
        simTime: view.getFloat32(offset + 4, true),
        utilization: view.getFloat32(offset + 8, true),
        jobsRunning: view.getUint16(offset + 12, true),
        jobsQueued: view.getUint16(offset + 14, true),
        jobsCompleted: view.getUint32(offset + 16, true),
        avgJct: view.getFloat32(offset + 20, true),
        completionRate: view.getFloat32(offset + 24, true),
        gpuUsed: [],
        allocations: []
    };
    let off = offset + 28;
    for (let t = 0; t < numGpuTypes; t++) {
        round.gpuUsed.push(view.getUint16(off, true));
        off += 2;
    }
    for (let g = 0; g < totalGpus; g++) {
        round.allocations.push(view.getUint32(off, true));
        off += 4;
    }
    return round;
}

// Run tests
let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
    }
}

function assertEq(actual, expected, message) {
    if (actual === expected) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message} - expected ${expected}, got ${actual}`);
    }
}

console.log('Cross-Language Compatibility Test');
console.log('=================================');

// Load files
const binPath = join(__dirname, 'cross_language_test.viz.bin');
const expectedPath = join(__dirname, 'cross_language_expected.json');
const binBuffer = readFileSync(binPath);
const expected = JSON.parse(readFileSync(expectedPath, 'utf-8'));

const buffer = binBuffer.buffer.slice(binBuffer.byteOffset, binBuffer.byteOffset + binBuffer.byteLength);

// Test header
console.log('\n1. Header:');
const header = decodeHeader(buffer);
assertEq(header.numRounds, expected.header.numRounds, 'numRounds');
assertEq(header.numJobs, expected.header.numJobs, 'numJobs');
assertEq(header.numGpuTypes, expected.header.numGpuTypes, 'numGpuTypes');
assertEq(header.totalGpus, expected.header.totalGpus, 'totalGpus');
console.log(`   numRounds=${header.numRounds}, numJobs=${header.numJobs}, numGpuTypes=${header.numGpuTypes}, totalGpus=${header.totalGpus}`);

// Test round size
console.log('\n2. Round size:');
const roundSize = computeRoundSize(header.numGpuTypes, header.totalGpus);
assertEq(roundSize, expected.roundSize, 'roundSize');
console.log(`   roundSize=${roundSize} (expected ${expected.roundSize})`);

// Test jobs
console.log('\n3. Jobs:');
const jobs = decodeJobs(buffer, header.jobMetadataOffset, header.numJobs);
assertEq(jobs.length, expected.jobs.length, 'jobs count');
for (let i = 0; i < jobs.length; i++) {
    assertEq(jobs[i].jobId, expected.jobs[i].job_id, `job[${i}].jobId`);
    assertEq(jobs[i].typeId, expected.jobs[i].type_id, `job[${i}].typeId`);
    assertEq(jobs[i].scaleFactor, expected.jobs[i].scale_factor, `job[${i}].scaleFactor`);
    assertEq(jobs[i].arrivalRound, expected.jobs[i].arrival_round, `job[${i}].arrivalRound`);
}
console.log(`   Decoded ${jobs.length} jobs`);
assert(jobs[2].jobId === 70000, 'uint32 job ID (70000)');
console.log(`   Job ID >65535 test: jobId=${jobs[2].jobId}`);

// Test rounds
console.log('\n4. Rounds:');
const view = new DataView(buffer);
for (let r = 0; r < header.numRounds; r++) {
    const offset = header.roundsOffset + r * roundSize;
    const round = decodeRound(view, offset, header.numGpuTypes, header.totalGpus);
    const expRound = expected.rounds[r];

    assertEq(round.round, expRound.round, `round[${r}].round`);
    assert(Math.abs(round.simTime - expRound.sim_time) < 0.01, `round[${r}].simTime close`);
    assert(Math.abs(round.utilization - expRound.utilization) < 0.001, `round[${r}].utilization close`);
    assertEq(round.jobsRunning, expRound.jobs_running, `round[${r}].jobsRunning`);
    assertEq(round.jobsQueued, expRound.jobs_queued, `round[${r}].jobsQueued`);

    // Check gpu_used
    for (let t = 0; t < header.numGpuTypes; t++) {
        assertEq(round.gpuUsed[t], expRound.gpu_used[t], `round[${r}].gpuUsed[${t}]`);
    }

    // Check allocations
    for (let g = 0; g < header.totalGpus; g++) {
        assertEq(round.allocations[g], expRound.allocations[g], `round[${r}].allocations[${g}]`);
    }

    console.log(`   Round ${r}: simTime=${round.simTime.toFixed(1)}, util=${round.utilization.toFixed(3)}, running=${round.jobsRunning}`);
}

// Check uint32 allocation
assert(view.getUint32(header.roundsOffset + roundSize + 28 + 6 + 8 * 4, true) === 70000,
    'uint32 allocation (70000) at round 1, GPU 8');
console.log(`   Allocation >65535 test: GPU[8]=${view.getUint32(header.roundsOffset + roundSize + 28 + 6 + 8 * 4, true)}`);

// Summary
console.log('\n=================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
    console.log('ALL TESTS PASSED');
} else {
    process.exit(1);
}
