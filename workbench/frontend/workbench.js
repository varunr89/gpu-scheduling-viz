/**
 * GPU Scheduling Workbench -- Frontend
 *
 * Single-page app with three tabs: Design, Run, Analyze.
 * Communicates with the workbench backend via REST + WebSocket.
 */

// ================================================================
// API Client
// ================================================================
const API_BASE = '/api';

export const api = {
    // -- Plugins / Simulators --
    async getSimulators() {
        const resp = await fetch(`${API_BASE}/plugins/simulators`);
        if (!resp.ok) throw new Error(`GET simulators: ${resp.status}`);
        return resp.json();
    },

    async getSchema(simulatorName) {
        const resp = await fetch(`${API_BASE}/plugins/simulators/${encodeURIComponent(simulatorName)}/schema`);
        if (!resp.ok) throw new Error(`GET schema: ${resp.status}`);
        return resp.json();
    },

    async getPresets(simulatorName) {
        const resp = await fetch(`${API_BASE}/plugins/simulators/${encodeURIComponent(simulatorName)}/presets`);
        if (!resp.ok) throw new Error(`GET presets: ${resp.status}`);
        return resp.json();
    },

    // -- Experiment Groups --
    async listGroups() {
        const resp = await fetch(`${API_BASE}/experiments`);
        if (!resp.ok) throw new Error(`GET experiments: ${resp.status}`);
        return resp.json();
    },

    async getGroup(id) {
        const resp = await fetch(`${API_BASE}/experiments/${encodeURIComponent(id)}`);
        if (!resp.ok) throw new Error(`GET group ${id}: ${resp.status}`);
        return resp.json();
    },

    async createGroup(data) {
        const resp = await fetch(`${API_BASE}/experiments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!resp.ok) throw new Error(`POST experiments: ${resp.status}`);
        return resp.json();
    },

    async deleteGroup(id) {
        const resp = await fetch(`${API_BASE}/experiments/${encodeURIComponent(id)}`, {
            method: 'DELETE',
        });
        if (!resp.ok) throw new Error(`DELETE group ${id}: ${resp.status}`);
    },

    // -- Individual Experiments --
    async listExperiments(groupId) {
        const resp = await fetch(`${API_BASE}/experiments/${encodeURIComponent(groupId)}/items`);
        if (!resp.ok) throw new Error(`GET items: ${resp.status}`);
        return resp.json();
    },

    // -- Run --
    async runGroup(id) {
        const resp = await fetch(`${API_BASE}/experiments/${encodeURIComponent(id)}/run`, {
            method: 'POST',
        });
        if (!resp.ok) throw new Error(`POST run: ${resp.status}`);
        return resp.json();
    },

    async cancelGroup(id) {
        const resp = await fetch(`${API_BASE}/experiments/${encodeURIComponent(id)}/cancel`, {
            method: 'POST',
        });
        if (!resp.ok) throw new Error(`POST cancel: ${resp.status}`);
        return resp.json();
    },

    // -- Export --
    async exportGroup(id) {
        const resp = await fetch(`${API_BASE}/experiments/${encodeURIComponent(id)}/export`, {
            method: 'POST',
        });
        if (!resp.ok) throw new Error(`POST export: ${resp.status}`);
        return resp.json();
    },

    // -- WebSocket stream --
    streamEvents(groupId) {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(
            `${protocol}//${location.host}${API_BASE}/experiments/${encodeURIComponent(groupId)}/stream`
        );
        return ws;
    },
};

// ================================================================
// Safe DOM Helpers
// ================================================================

/**
 * Create an element with optional attributes and children.
 * All text is set via textContent (safe against XSS).
 */
function el(tag, attrs = {}, ...children) {
    const elem = document.createElement(tag);
    for (const [key, val] of Object.entries(attrs)) {
        if (key === 'className') {
            elem.className = val;
        } else if (key === 'style' && typeof val === 'object') {
            Object.assign(elem.style, val);
        } else if (key.startsWith('on') && typeof val === 'function') {
            elem.addEventListener(key.slice(2).toLowerCase(), val);
        } else if (key === 'dataset') {
            for (const [dk, dv] of Object.entries(val)) {
                elem.dataset[dk] = dv;
            }
        } else {
            elem.setAttribute(key, val);
        }
    }
    for (const child of children) {
        if (typeof child === 'string') {
            elem.appendChild(document.createTextNode(child));
        } else if (child instanceof Node) {
            elem.appendChild(child);
        }
    }
    return elem;
}

/** Remove all children from a DOM element. */
function clearChildren(parent) {
    while (parent.firstChild) {
        parent.removeChild(parent.firstChild);
    }
}

/** Map status string to CSS class suffix. */
function statusClass(status) {
    const map = {
        draft: 'draft',
        pending: 'pending',
        running: 'running',
        complete: 'complete',
        completed: 'complete',
        error: 'error',
        interrupted: 'error',
    };
    return map[status] || 'draft';
}

// ================================================================
// Workbench Controller
// ================================================================
class Workbench {
    constructor() {
        this.currentTab = 'design';
        this.groups = [];
        this.selectedDesignGroupId = null;
        this.selectedRunGroupId = null;

        this._bindTabNav();
        this._bindNewGroup();
        this._init();
    }

    // ----------------------------------------------------------
    // Tab Navigation
    // ----------------------------------------------------------

    _bindTabNav() {
        document.querySelectorAll('.nav-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                this.switchTab(btn.dataset.tab);
            });
        });
    }

    switchTab(tabName) {
        this.currentTab = tabName;

        // Update nav-tab active states
        document.querySelectorAll('.nav-tab').forEach(b => {
            b.classList.toggle('active', b.dataset.tab === tabName);
        });

        // Update tab-panel visibility
        document.querySelectorAll('.tab-panel').forEach(p => {
            p.classList.toggle('active', p.id === `tab-${tabName}`);
        });

        // Refresh sidebar content when switching tabs
        if (tabName === 'design') {
            this._refreshDesignSidebar();
        } else if (tabName === 'run') {
            this._refreshRunSidebar();
        }
    }

    // ----------------------------------------------------------
    // Initialization
    // ----------------------------------------------------------

    async _init() {
        await this._refreshDesignSidebar();
    }

    // ----------------------------------------------------------
    // New Group Button
    // ----------------------------------------------------------

    _bindNewGroup() {
        const btn = document.getElementById('btn-new-group');
        if (btn) {
            btn.addEventListener('click', () => this._showNewGroupDialog());
        }
    }

    _showNewGroupDialog() {
        // For now, use a simple prompt. A future task will replace this
        // with a proper modal form that includes simulator selection.
        const name = prompt('Experiment group name:');
        if (!name || !name.trim()) return;
        this._createGroup(name.trim());
    }

    async _createGroup(name) {
        try {
            const group = await api.createGroup({ name, simulator: 'gavel' });
            this.groups.push(group);
            this._renderDesignSidebar();
            this._selectDesignGroup(group.id);
        } catch (err) {
            console.error('Failed to create group:', err);
            // Silently fail for now -- backend may not be running
        }
    }

    // ----------------------------------------------------------
    // Design Tab -- Sidebar
    // ----------------------------------------------------------

    async _refreshDesignSidebar() {
        try {
            this.groups = await api.listGroups();
        } catch {
            // Backend not available -- keep whatever we have (likely [])
            this.groups = this.groups.length ? this.groups : [];
        }
        this._renderDesignSidebar();
    }

    _renderDesignSidebar() {
        const list = document.getElementById('design-group-list');
        if (!list) return;

        clearChildren(list);

        if (!this.groups.length) {
            list.appendChild(
                el('div', { className: 'empty-state' }, 'No experiments yet. Click "+ New" to create one.')
            );
            return;
        }

        for (const g of this.groups) {
            const isActive = g.id === this.selectedDesignGroupId;
            const item = el('div', {
                className: `group-item ${isActive ? 'active' : ''}`,
                dataset: { id: g.id },
                onClick: () => this._selectDesignGroup(g.id),
            },
                el('span', { className: 'group-name' }, g.name),
                el('span', { className: `group-badge status-${statusClass(g.status)}` }, g.status),
            );
            list.appendChild(item);
        }
    }

    _selectDesignGroup(groupId) {
        this.selectedDesignGroupId = groupId;

        // Update active class in sidebar
        const list = document.getElementById('design-group-list');
        if (list) {
            list.querySelectorAll('.group-item').forEach(item => {
                item.classList.toggle('active', item.dataset.id === groupId);
            });
        }

        // Update main panel
        const main = document.getElementById('design-main');
        if (!main) return;

        const group = this.groups.find(g => g.id === groupId);
        if (!group) {
            clearChildren(main);
            main.appendChild(
                el('div', { className: 'empty-state-large' },
                    el('h2', {}, 'Group not found'),
                )
            );
            return;
        }

        clearChildren(main);

        const detail = el('div', { className: 'experiment-detail' },
            el('h2', {}, group.name),
            el('div', { className: 'flex items-center gap-sm mb-md' },
                el('span', { className: `group-badge status-${statusClass(group.status)}` }, group.status),
                el('span', { className: 'text-muted text-mono', style: { fontSize: '0.7rem' } }, group.id),
            ),
            el('p', { className: 'text-muted', style: { fontSize: '0.85rem' } },
                'Experiment configuration will appear here once the design form is implemented.',
            ),
        );

        main.appendChild(detail);
    }

    // ----------------------------------------------------------
    // Run Tab -- Sidebar
    // ----------------------------------------------------------

    _refreshRunSidebar() {
        const list = document.getElementById('run-group-list');
        if (!list) return;

        clearChildren(list);

        if (!this.groups.length) {
            list.appendChild(
                el('div', { className: 'empty-state' }, 'No experiments to run. Design some first.')
            );
            return;
        }

        for (const g of this.groups) {
            const isActive = g.id === this.selectedRunGroupId;
            const item = el('div', {
                className: `group-item ${isActive ? 'active' : ''}`,
                dataset: { id: g.id },
                onClick: () => this._selectRunGroup(g.id),
            },
                el('span', { className: 'group-name' }, g.name),
                el('span', { className: `group-badge status-${statusClass(g.status)}` }, g.status),
            );
            list.appendChild(item);
        }
    }

    _selectRunGroup(groupId) {
        this.selectedRunGroupId = groupId;

        // Update active class
        const list = document.getElementById('run-group-list');
        if (list) {
            list.querySelectorAll('.group-item').forEach(item => {
                item.classList.toggle('active', item.dataset.id === groupId);
            });
        }

        // Update main panel
        const main = document.getElementById('run-main');
        if (!main) return;

        const group = this.groups.find(g => g.id === groupId);
        if (!group) {
            clearChildren(main);
            main.appendChild(
                el('div', { className: 'empty-state-large' },
                    el('h2', {}, 'Group not found'),
                )
            );
            return;
        }

        clearChildren(main);

        const runAllBtn = el('button', {
            className: 'btn btn-success',
            dataset: { id: group.id },
            onClick: () => this._runGroup(group.id),
        }, 'Run All');

        const monitor = el('div', { className: 'run-monitor' },
            el('div', { className: 'run-header' },
                el('h2', {}, group.name),
                el('div', { className: 'btn-group' }, runAllBtn),
            ),
            el('div', { className: 'run-summary' },
                this._buildRunStat('--', 'Total'),
                this._buildRunStat('--', 'Pending', 'text-yellow'),
                this._buildRunStat('--', 'Running', 'text-accent'),
                this._buildRunStat('--', 'Complete', 'text-green'),
            ),
            el('p', { className: 'text-muted', style: { fontSize: '0.85rem' } },
                'Run monitoring and progress tracking will appear here once the run controller is implemented.',
            ),
        );

        main.appendChild(monitor);
    }

    _buildRunStat(value, label, valueClass = '') {
        return el('div', { className: 'run-stat' },
            el('div', { className: `run-stat-value ${valueClass}` }, value),
            el('div', { className: 'run-stat-label' }, label),
        );
    }

    async _runGroup(groupId) {
        try {
            await api.runGroup(groupId);
            await this._refreshDesignSidebar();
            this._refreshRunSidebar();
        } catch (err) {
            console.error('Failed to run group:', err);
        }
    }
}

// ================================================================
// Bootstrap
// ================================================================
const workbench = new Workbench();
