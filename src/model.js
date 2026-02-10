export class Model {
    constructor() {
        this.simulations = [null, null];
        this.currentRound = 0;
        this.isPlaying = false;
        this.playbackSpeed = 1;
        this.listeners = [];
    }

    loadSimulation(index, { header, config, dataSource, decoder, jobs, jobMap, typeMap }) {
        this.simulations[index] = { header, config, dataSource, decoder, jobs, jobMap, typeMap };
        this._notify('simulationLoaded', index);
    }

    clearSimulation(index) {
        this.simulations[index] = null;
        this._notify('simulationCleared', index);
    }

    getSimulation(index) {
        return this.simulations[index];
    }

    getMaxRounds() {
        let max = 0;
        for (const sim of this.simulations) {
            if (sim) max = Math.max(max, sim.header.numRounds);
        }
        return max;
    }

    setCurrentRound(round) {
        this.currentRound = Math.max(0, Math.min(round, this.getMaxRounds() - 1));
        this._notify('roundChanged', this.currentRound);
    }

    onChange(listener) {
        this.listeners.push(listener);
    }

    _notify(event, data) {
        for (const listener of this.listeners) {
            listener(event, data);
        }
    }
}
