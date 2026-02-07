import { Decoder, decodeHeader, decodeConfigJson, decodeJobs } from './decoder.js';

let decoder = null;

self.onmessage = (e) => {
    const { type, id, payload } = e.data;
    try {
        switch (type) {
            case 'init': {
                decoder = new Decoder(payload.header, payload.config);
                self.postMessage({ type: 'result', id, result: { ready: true } });
                break;
            }
            case 'decodeRounds': {
                const rounds = decoder.decodeRounds(payload.buffer, 0, payload.count);
                self.postMessage({ type: 'result', id, result: rounds });
                break;
            }
            case 'decodeJobs': {
                const jobs = decodeJobs(payload.buffer, 0, payload.numJobs);
                self.postMessage({ type: 'result', id, result: jobs });
                break;
            }
        }
    } catch (err) {
        self.postMessage({ type: 'error', id, error: err.message });
    }
};
