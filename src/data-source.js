// Range request fetching with LRU caching
export class DataSource {
    constructor(url) {
        this.url = url;
        this.cache = new Map();
        this.pendingRequests = new Map();
        this.maxCacheSize = 100;
    }

    async fetchRange(start, end, signal = null) {
        const cacheKey = `${start}-${end}`;
        if (this.cache.has(cacheKey)) {
            // LRU touch
            const data = this.cache.get(cacheKey);
            this.cache.delete(cacheKey);
            this.cache.set(cacheKey, data);
            return data;
        }
        if (this.pendingRequests.has(cacheKey)) {
            return this.pendingRequests.get(cacheKey);
        }
        const promise = this._fetch(start, end, signal);
        this.pendingRequests.set(cacheKey, promise);
        try {
            const data = await promise;
            if (this.cache.size >= this.maxCacheSize) {
                const oldest = this.cache.keys().next().value;
                this.cache.delete(oldest);
            }
            this.cache.set(cacheKey, data);
            return data;
        } finally {
            this.pendingRequests.delete(cacheKey);
        }
    }

    async _fetch(start, end, signal) {
        const response = await fetch(this.url, {
            headers: { 'Range': `bytes=${start}-${end - 1}` },
            signal
        });
        if (!response.ok && response.status !== 206) {
            throw new Error(`HTTP ${response.status}`);
        }
        return response.arrayBuffer();
    }

    async fetchAll(signal = null) {
        const response = await fetch(this.url, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
    }

    clearCache() {
        this.cache.clear();
    }
}
