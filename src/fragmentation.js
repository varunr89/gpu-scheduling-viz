// FGD Paper Fragmentation Calculator (ported from fgd_src/fgd.py)
// Simplified for Gavel: no CPU/memory constraints, whole-GPU allocations only.
// All fragmentation is "stranded" type: free GPUs on nodes that can't fit a task.

/**
 * Build node state from flat allocation array and GPU type config.
 * Groups GPUs into physical nodes based on gpus_per_node.
 *
 * @param {Uint32Array|number[]} allocations - Per-GPU job IDs (0 = free)
 * @param {Array<{count: number, gpus_per_node?: number}>} gpuTypes
 * @returns {Array<{freeGpus: number, totalGpus: number}>}
 */
export function buildNodes(allocations, gpuTypes) {
    const nodes = [];
    let gpuOff = 0;

    for (const gt of gpuTypes) {
        const perNode = gt.gpus_per_node || 1;
        const nodeCount = Math.ceil(gt.count / perNode);

        for (let n = 0; n < nodeCount; n++) {
            const start = gpuOff + n * perNode;
            const end = Math.min(start + perNode, gpuOff + gt.count);
            let free = 0;
            for (let g = start; g < end; g++) {
                if (allocations[g] === 0) free++;
            }
            nodes.push({ freeGpus: free, totalGpus: end - start });
        }
        gpuOff += gt.count;
    }

    return nodes;
}

/**
 * Build workload popularity distribution from job scale factors.
 * Returns map of scaleFactor -> popularity (normalized to sum=1).
 *
 * @param {Array<{scaleFactor: number}>} jobs
 * @returns {Map<number, number>} scaleFactor -> popularity
 */
export function buildWorkload(jobs) {
    const counts = new Map();
    for (const job of jobs) {
        const sf = job.scaleFactor || 1;
        counts.set(sf, (counts.get(sf) || 0) + 1);
    }

    const total = jobs.length || 1;
    const popularity = new Map();
    for (const [sf, count] of counts) {
        popularity.set(sf, count / total);
    }
    return popularity;
}

/**
 * Compute fragmentation of a single node for a single task type.
 * FGD formula (simplified for whole-GPU, no CPU/memory):
 *   - If task.gpuRequest > node.freeGpus: all free GPUs are stranded
 *   - Else: task fits, no fragmentation
 *
 * @param {{freeGpus: number, totalGpus: number}} node
 * @param {number} gpuRequest - Number of GPUs the task needs
 * @returns {number} Fragmented GPU count
 */
export function computeNodeFragmentation(node, gpuRequest) {
    if (gpuRequest > node.freeGpus) {
        return node.freeGpus; // All free GPUs are stranded
    }
    return 0; // Task fits, no fragmentation
}

/**
 * Compute cluster-wide fragmentation (GPU-equivalents).
 * F = SUM_nodes SUM_tasks popularity(task) * nodeFragmentation(node, task)
 *
 * @param {Array<{freeGpus: number, totalGpus: number}>} nodes
 * @param {Map<number, number>} workload - scaleFactor -> popularity
 * @returns {number} Total fragmented GPU-equivalents
 */
export function computeClusterFragmentation(nodes, workload) {
    let total = 0;
    for (const node of nodes) {
        if (node.freeGpus === 0) continue; // Fully occupied, no fragmentation
        for (const [gpuRequest, popularity] of workload) {
            total += popularity * computeNodeFragmentation(node, gpuRequest);
        }
    }
    return total;
}

/**
 * Compute all fragmentation metrics for a single round.
 *
 * @param {Uint32Array|number[]} allocations
 * @param {Array<{count: number, gpus_per_node?: number}>} gpuTypes
 * @param {Map<number, number>} workload
 * @param {number} totalGpus
 * @returns {{fragmentation: number, unallocatedGpus: number, fragRate: number, fragTotal: number, occupiedNodes: number}}
 */
export function computeRoundMetrics(allocations, gpuTypes, workload, totalGpus) {
    const nodes = buildNodes(allocations, gpuTypes);
    const fragmentation = computeClusterFragmentation(nodes, workload);

    let unallocatedGpus = 0;
    let occupiedNodes = 0;
    for (const node of nodes) {
        unallocatedGpus += node.freeGpus;
        if (node.freeGpus < node.totalGpus) occupiedNodes++;
    }

    const fragRate = unallocatedGpus > 0
        ? (fragmentation / unallocatedGpus) * 100
        : 0;
    const fragTotal = totalGpus > 0
        ? (fragmentation / totalGpus) * 100
        : 0;

    return { fragmentation, unallocatedGpus, fragRate, fragTotal, occupiedNodes };
}
