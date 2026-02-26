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
// Sweep Expansion
// ================================================================

/**
 * Expand sweep fields and seeds into an array of individual configs.
 *
 * @param {Object} baseConfig - Base config with non-sweep values
 * @param {Array} sweepFields - [{key, from, to, step}, ...]
 * @param {number[]} seeds - Array of seed values
 * @returns {Object[]} Array of individual experiment configs
 */
function expandSweeps(baseConfig, sweepFields, seeds) {
    let configs = [{ ...baseConfig }];

    for (const sweep of sweepFields) {
        const newConfigs = [];
        for (const cfg of configs) {
            for (let v = sweep.from; v <= sweep.to + 0.001; v += sweep.step) {
                newConfigs.push({ ...cfg, [sweep.key]: Math.round(v * 1000) / 1000 });
            }
        }
        configs = newConfigs;
    }

    // Cross with seeds
    if (seeds.length > 0) {
        const seeded = [];
        for (const cfg of configs) {
            for (const seed of seeds) {
                seeded.push({ ...cfg, seed });
            }
        }
        configs = seeded;
    }

    return configs;
}

/**
 * Count the number of sweep values for a single sweep field.
 */
function countSweepValues(from, to, step) {
    if (step <= 0 || from > to) return 0;
    return Math.floor((to - from) / step + 1.001);
}

// ================================================================
// Schema Form Renderer
// ================================================================

/**
 * SchemaForm renders a JSON Schema as form fields.
 *
 * It maintains internal state for field values, sweep modes,
 * and computes the experiment count preview.
 */
class SchemaForm {
    /**
     * @param {Object} schema - JSON Schema (config_schema from the API)
     * @param {Object[]} policySpecs - Policy spec list from the API
     * @param {Object} presets - Cluster presets from the API
     * @param {Function} onUpdate - Called whenever form state changes
     */
    constructor(schema, policySpecs, presets, onUpdate) {
        this.schema = schema;
        this.policySpecs = policySpecs;
        this.presets = presets;
        this.onUpdate = onUpdate || (() => {});

        // Internal state
        this.values = {};       // key -> value
        this.sweepModes = {};   // key -> boolean (true = sweep mode)
        this.sweepValues = {};  // key -> {from, to, step}
        this.seeds = '0';       // comma-separated seed string
        this._container = null;

        // Initialize default values from schema
        this._initDefaults();
    }

    _initDefaults() {
        const props = this.schema.properties || {};
        for (const [key, propSchema] of Object.entries(props)) {
            if (propSchema.default !== undefined && propSchema.default !== null) {
                this.values[key] = propSchema.default;
            }
        }
    }

    /**
     * Build the complete form DOM and return the container element.
     */
    render() {
        this._container = el('div', { className: 'schema-form' });
        this._renderFields();
        return this._container;
    }

    _renderFields() {
        if (!this._container) return;
        clearChildren(this._container);

        const props = this.schema.properties || {};
        const required = new Set(this.schema.required || []);

        // Group fields by category for better UX
        const categories = this._categorizeFields(props);

        for (const cat of categories) {
            const section = el('div', { className: 'experiment-section' },
                el('div', { className: 'experiment-section-title' }, cat.title),
            );

            for (const key of cat.keys) {
                const propSchema = props[key];
                if (!propSchema) continue;
                const fieldEl = this._renderField(key, propSchema, required.has(key));
                section.appendChild(fieldEl);
            }

            this._container.appendChild(section);
        }

        // Seed list section
        this._container.appendChild(this._renderSeedSection());

        // Preview section
        this._container.appendChild(this._renderPreview());
    }

    /**
     * Organize schema properties into logical categories.
     */
    _categorizeFields(props) {
        const categories = [
            {
                title: 'Scheduling',
                keys: ['policy', 'solver'],
            },
            {
                title: 'Cluster',
                keys: ['cluster_preset', 'cluster_spec', 'gpus_per_node'],
            },
            {
                title: 'Workload',
                keys: ['mode', 'workload_mode', 'num_total_jobs', 'lam',
                       'window_start', 'window_end', 'generate_multi_gpu_jobs'],
            },
            {
                title: 'Simulation',
                keys: ['time_per_iteration', 'max_simulated_time', 'max_wall_time',
                       'seed', 'log_level'],
            },
            {
                title: 'Extensions',
                keys: ['enable_fgd', 'fgd_placement_mode', 'enable_migration_penalty',
                       'enable_gpu_sharing', 'completion_rate_threshold'],
            },
        ];

        // Collect any keys not in the predefined categories
        const assignedKeys = new Set(categories.flatMap(c => c.keys));
        const extraKeys = Object.keys(props).filter(k => !assignedKeys.has(k));
        if (extraKeys.length > 0) {
            categories.push({ title: 'Other', keys: extraKeys });
        }

        // Filter out categories where none of the keys exist in the schema
        return categories
            .map(cat => ({
                ...cat,
                keys: cat.keys.filter(k => k in props),
            }))
            .filter(cat => cat.keys.length > 0);
    }

    /**
     * Render a single form field based on its JSON Schema type.
     */
    _renderField(key, propSchema, isRequired) {
        // Skip seed -- it's handled separately in the seed section
        if (key === 'seed') return el('div');

        // Skip cluster_spec -- it's shown as part of the cluster_preset field
        if (key === 'cluster_spec') return el('div');

        const type = this._resolveType(propSchema);
        const group = el('div', { className: 'form-group' });

        // Label
        const labelText = this._formatLabel(key) + (isRequired ? ' *' : '');
        const label = el('label', { className: 'form-label', for: `field-${key}` }, labelText);
        group.appendChild(label);

        // Description hint
        if (propSchema.description) {
            group.appendChild(el('div', { className: 'form-hint' }, propSchema.description));
        }

        // Special handling for cluster_preset: show as dropdown with GPU breakdown
        if (key === 'cluster_preset') {
            group.appendChild(this._renderClusterPresetField(key, propSchema));
            return group;
        }

        // Field input
        if (propSchema.enum) {
            group.appendChild(this._renderSelect(key, propSchema));
        } else if (type === 'boolean') {
            group.appendChild(this._renderCheckbox(key, propSchema));
        } else if (type === 'integer' || type === 'number') {
            group.appendChild(this._renderNumericField(key, propSchema, type));
        } else if (type === 'string') {
            group.appendChild(this._renderTextInput(key, propSchema));
        } else if (type === 'object') {
            group.appendChild(this._renderObjectField(key, propSchema));
        } else {
            // Fallback: text input
            group.appendChild(this._renderTextInput(key, propSchema));
        }

        return group;
    }

    /**
     * Resolve the type from a schema property, handling union types like ["integer", "null"].
     */
    _resolveType(propSchema) {
        const t = propSchema.type;
        if (Array.isArray(t)) {
            // Pick the first non-null type
            return t.find(x => x !== 'null') || 'string';
        }
        return t || 'string';
    }

    /**
     * Format a snake_case key as a human-readable label.
     */
    _formatLabel(key) {
        return key
            .replace(/_/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());
    }

    // ----------------------------------------------------------
    // Field Renderers
    // ----------------------------------------------------------

    _renderSelect(key, propSchema) {
        const select = el('select', {
            className: 'form-select',
            id: `field-${key}`,
            onChange: (e) => {
                this.values[key] = e.target.value;
                this._notifyUpdate();
            },
        });

        // Blank option if not required and no default
        if (!this.schema.required?.includes(key) && this.values[key] === undefined) {
            select.appendChild(el('option', { value: '' }, '-- Select --'));
        }

        for (const val of propSchema.enum) {
            const opt = el('option', { value: val }, val);
            if (this.values[key] === val) {
                opt.selected = true;
            }
            select.appendChild(opt);
        }

        // For the policy field, show the description below
        if (key === 'policy') {
            const wrapper = el('div');
            wrapper.appendChild(select);
            const descEl = el('div', {
                className: 'form-hint policy-description',
                style: { marginTop: '0.35rem' },
            });
            this._updatePolicyDescription(descEl, this.values[key]);

            select.addEventListener('change', () => {
                this._updatePolicyDescription(descEl, this.values[key]);
            });

            wrapper.appendChild(descEl);
            return wrapper;
        }

        return select;
    }

    _renderClusterPresetField(key, propSchema) {
        const wrapper = el('div');
        const presetNames = Object.keys(this.presets);

        const select = el('select', {
            className: 'form-select',
            id: `field-${key}`,
            onChange: (e) => {
                this.values[key] = e.target.value || undefined;
                // Re-render the GPU breakdown
                clearChildren(breakdownDiv);
                if (e.target.value && this.presets[e.target.value]) {
                    breakdownDiv.appendChild(this._renderClusterBreakdown(this.presets[e.target.value]));
                }
                this._notifyUpdate();
            },
        });

        select.appendChild(el('option', { value: '' }, '-- Select a cluster preset --'));
        for (const name of presetNames) {
            const opt = el('option', { value: name }, name);
            if (this.values[key] === name) opt.selected = true;
            select.appendChild(opt);
        }

        wrapper.appendChild(select);

        // GPU breakdown area
        const breakdownDiv = el('div');
        if (this.values[key] && this.presets[this.values[key]]) {
            breakdownDiv.appendChild(this._renderClusterBreakdown(this.presets[this.values[key]]));
        }
        wrapper.appendChild(breakdownDiv);

        return wrapper;
    }

    _renderClusterBreakdown(preset) {
        const container = el('div', { className: 'cluster-spec-field' });
        const grid = el('div', { className: 'gpu-type-grid mt-sm' });

        for (const [gpuType, count] of Object.entries(preset.gpu_types)) {
            grid.appendChild(
                el('div', { className: 'gpu-type-card' },
                    el('span', { className: 'gpu-type-name' }, gpuType),
                    el('span', { className: 'gpu-type-count' }, String(count)),
                )
            );
        }
        container.appendChild(grid);

        const totalGpus = Object.values(preset.gpu_types).reduce((a, b) => a + b, 0);
        container.appendChild(
            el('div', { className: 'text-muted mt-sm', style: { fontSize: '0.78rem' } },
                `Total: ${totalGpus} GPUs` +
                (preset.gpus_per_node ? ` (${preset.gpus_per_node} per node)` : ' (flat)'),
            )
        );

        return container;
    }

    _updatePolicyDescription(descEl, policyName) {
        clearChildren(descEl);
        if (!policyName) return;
        const spec = this.policySpecs.find(p => p.name === policyName);
        if (spec && spec.description) {
            descEl.appendChild(document.createTextNode(spec.description));
        }
    }

    _renderCheckbox(key, propSchema) {
        const currentVal = this.values[key] !== undefined ? this.values[key] : (propSchema.default || false);
        this.values[key] = currentVal;

        const labelSpan = el('span', {}, currentVal ? 'Enabled' : 'Disabled');

        const checkbox = el('input', {
            type: 'checkbox',
            id: `field-${key}`,
            onChange: (e) => {
                this.values[key] = e.target.checked;
                clearChildren(labelSpan);
                labelSpan.appendChild(document.createTextNode(e.target.checked ? 'Enabled' : 'Disabled'));
                this._notifyUpdate();
            },
        });
        if (currentVal) checkbox.checked = true;

        return el('label', { className: 'form-check' },
            checkbox,
            labelSpan,
        );
    }

    _renderNumericField(key, propSchema, type) {
        const container = el('div', { className: 'numeric-field-container' });
        const isSweepable = true;
        const isSweep = !!this.sweepModes[key];

        // Sweep toggle
        if (isSweepable) {
            const toggleLabel = el('label', { className: 'form-check sweep-toggle' });

            const toggleCheckbox = el('input', {
                type: 'checkbox',
                onChange: (e) => {
                    this.sweepModes[key] = e.target.checked;
                    if (e.target.checked && !this.sweepValues[key]) {
                        const defVal = this.values[key] !== undefined ? this.values[key] : 0;
                        this.sweepValues[key] = { from: defVal, to: defVal, step: 1 };
                    }
                    this._renderFields();
                    this._notifyUpdate();
                },
            });
            if (isSweep) toggleCheckbox.checked = true;

            toggleLabel.appendChild(toggleCheckbox);
            toggleLabel.appendChild(el('span', { className: 'sweep-toggle-text' }, 'Sweep'));
            container.appendChild(toggleLabel);
        }

        if (isSweep) {
            container.appendChild(this._renderSweepInputs(key, propSchema, type));
        } else {
            container.appendChild(this._renderSingleNumericInput(key, propSchema, type));
        }

        return container;
    }

    _renderSingleNumericInput(key, propSchema, type) {
        const currentVal = this.values[key] !== undefined ? this.values[key] : (propSchema.default ?? '');

        const input = el('input', {
            type: 'number',
            className: 'form-input',
            id: `field-${key}`,
            value: String(currentVal),
            onChange: (e) => {
                const raw = e.target.value;
                if (raw === '') {
                    delete this.values[key];
                } else {
                    this.values[key] = type === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
                }
                this._notifyUpdate();
            },
        });

        if (propSchema.minimum !== undefined) input.setAttribute('min', propSchema.minimum);
        if (propSchema.maximum !== undefined) input.setAttribute('max', propSchema.maximum);
        if (type === 'integer') input.setAttribute('step', '1');

        return input;
    }

    _renderSweepInputs(key, propSchema, type) {
        const sweep = this.sweepValues[key] || { from: 0, to: 0, step: 1 };
        this.sweepValues[key] = sweep;

        const step = type === 'integer' ? '1' : 'any';
        const count = countSweepValues(sweep.from, sweep.to, sweep.step);

        const makeInput = (label, field) => {
            const input = el('input', {
                type: 'number',
                className: 'form-input form-input-compact',
                value: String(sweep[field]),
                step: step,
                onChange: (e) => {
                    const raw = e.target.value;
                    sweep[field] = type === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
                    this.sweepValues[key] = sweep;
                    // Update the count preview
                    const countEl = container.querySelector('.sweep-count');
                    if (countEl) {
                        const newCount = countSweepValues(sweep.from, sweep.to, sweep.step);
                        clearChildren(countEl);
                        countEl.appendChild(document.createTextNode(`${newCount} value${newCount !== 1 ? 's' : ''}`));
                    }
                    this._notifyUpdate();
                },
            });
            if (propSchema.minimum !== undefined && field === 'from') {
                input.setAttribute('min', propSchema.minimum);
            }
            return el('div', { className: 'sweep-field' },
                el('label', { className: 'form-label' }, label),
                input,
            );
        };

        const container = el('div', { className: 'sweep-inputs' },
            el('div', { className: 'form-row' },
                makeInput('From', 'from'),
                makeInput('To', 'to'),
                makeInput('Step', 'step'),
            ),
            el('div', { className: 'sweep-count tag tag-accent' },
                `${count} value${count !== 1 ? 's' : ''}`,
            ),
        );

        return container;
    }

    _renderTextInput(key, propSchema) {
        const currentVal = this.values[key] !== undefined ? this.values[key] : (propSchema.default || '');

        return el('input', {
            type: 'text',
            className: 'form-input',
            id: `field-${key}`,
            value: String(currentVal),
            placeholder: propSchema.default ? `Default: ${propSchema.default}` : '',
            onChange: (e) => {
                const raw = e.target.value.trim();
                if (raw === '') {
                    delete this.values[key];
                } else {
                    this.values[key] = raw;
                }
                this._notifyUpdate();
            },
        });
    }

    _renderObjectField(key, propSchema) {
        // Generic object: show a JSON text area
        const currentVal = this.values[key] !== undefined
            ? JSON.stringify(this.values[key], null, 2)
            : '';

        const textarea = el('textarea', {
            className: 'form-input code-block',
            id: `field-${key}`,
            style: { minHeight: '80px', fontFamily: 'var(--wb-font-mono)', fontSize: '0.78rem' },
            onChange: (e) => {
                try {
                    this.values[key] = JSON.parse(e.target.value);
                } catch {
                    // Invalid JSON -- ignore until valid
                }
                this._notifyUpdate();
            },
        });
        textarea.value = currentVal;

        return textarea;
    }

    // ----------------------------------------------------------
    // Seed Section
    // ----------------------------------------------------------

    _renderSeedSection() {
        const section = el('div', { className: 'experiment-section' },
            el('div', { className: 'experiment-section-title' }, 'Seeds'),
        );

        section.appendChild(
            el('div', { className: 'form-hint mb-sm' },
                'Comma-separated list of random seeds. Each experiment config is run once per seed.',
            ),
        );

        const input = el('input', {
            type: 'text',
            className: 'form-input',
            id: 'field-seeds',
            value: this.seeds,
            placeholder: '0, 1, 2',
            onChange: (e) => {
                this.seeds = e.target.value;
                this._notifyUpdate();
            },
            onInput: (e) => {
                this.seeds = e.target.value;
                this._notifyUpdate();
            },
        });

        section.appendChild(input);
        return section;
    }

    // ----------------------------------------------------------
    // Preview
    // ----------------------------------------------------------

    _renderPreview() {
        const section = el('div', { className: 'experiment-section preview-section' },
            el('div', { className: 'experiment-section-title' }, 'Experiment Preview'),
        );

        const stats = this._computePreviewStats();

        const previewCard = el('div', { className: 'card' },
            el('div', { className: 'card-body' },
                el('div', { className: 'preview-stat-row' },
                    this._buildPreviewStat(String(stats.sweepCombinations), 'Config Combinations'),
                    this._buildPreviewStat(String(stats.seedCount), 'Seeds'),
                    this._buildPreviewStat(String(stats.totalExperiments), 'Total Experiments'),
                ),
            ),
        );

        if (stats.sweepDetails.length > 0) {
            const detailsDiv = el('div', { className: 'preview-sweep-details mt-sm' });
            for (const detail of stats.sweepDetails) {
                detailsDiv.appendChild(
                    el('div', { className: 'tag tag-accent', style: { marginRight: '0.35rem', marginBottom: '0.25rem' } },
                        `${detail.key}: ${detail.count} values (${detail.from} to ${detail.to}, step ${detail.step})`,
                    ),
                );
            }
            previewCard.querySelector('.card-body').appendChild(detailsDiv);
        }

        section.appendChild(previewCard);
        return section;
    }

    _buildPreviewStat(value, label) {
        return el('div', { className: 'preview-stat' },
            el('div', { className: 'preview-stat-value' }, value),
            el('div', { className: 'preview-stat-label' }, label),
        );
    }

    _computePreviewStats() {
        const seeds = this._parseSeeds();
        const sweepDetails = [];
        let sweepCombinations = 1;

        for (const [key, sweep] of Object.entries(this.sweepValues)) {
            if (!this.sweepModes[key]) continue;
            const count = countSweepValues(sweep.from, sweep.to, sweep.step);
            if (count > 0) {
                sweepCombinations *= count;
                sweepDetails.push({
                    key: this._formatLabel(key),
                    count,
                    from: sweep.from,
                    to: sweep.to,
                    step: sweep.step,
                });
            }
        }

        return {
            sweepCombinations,
            seedCount: seeds.length,
            totalExperiments: sweepCombinations * seeds.length,
            sweepDetails,
        };
    }

    // ----------------------------------------------------------
    // Data Extraction
    // ----------------------------------------------------------

    /**
     * Parse the seed string into an array of integers.
     */
    _parseSeeds() {
        return this.seeds
            .split(',')
            .map(s => s.trim())
            .filter(s => s !== '' && !isNaN(parseInt(s, 10)))
            .map(s => parseInt(s, 10));
    }

    /**
     * Build the base config from current form values (non-sweep fields).
     */
    getBaseConfig() {
        const config = {};
        const props = this.schema.properties || {};

        for (const [key, propSchema] of Object.entries(props)) {
            if (key === 'seed') continue; // Seeds handled separately
            if (this.sweepModes[key]) continue; // Sweep fields handled by expansion

            if (this.values[key] !== undefined) {
                config[key] = this.values[key];
            }
        }

        return config;
    }

    /**
     * Get the active sweep fields.
     */
    getActiveSweeps() {
        const sweeps = [];
        for (const [key, isActive] of Object.entries(this.sweepModes)) {
            if (!isActive) continue;
            const sweep = this.sweepValues[key];
            if (sweep) {
                sweeps.push({ key, from: sweep.from, to: sweep.to, step: sweep.step });
            }
        }
        return sweeps;
    }

    /**
     * Expand all sweeps and seeds into individual experiment configs.
     */
    expandAll() {
        const baseConfig = this.getBaseConfig();
        const sweeps = this.getActiveSweeps();
        const seeds = this._parseSeeds();
        return expandSweeps(baseConfig, sweeps, seeds);
    }

    /**
     * Generate experiment specs suitable for the CreateGroupRequest.
     * Each spec: { name, policy, config }
     */
    generateExperimentSpecs() {
        const configs = this.expandAll();
        const policy = this.values['policy'] || 'fifo';

        return configs.map((config, idx) => {
            // Build a descriptive name
            const parts = [policy];
            for (const sweep of this.getActiveSweeps()) {
                parts.push(`${sweep.key}=${config[sweep.key]}`);
            }
            if (config.seed !== undefined) {
                parts.push(`seed=${config.seed}`);
            }
            const name = parts.join('_');

            return {
                name,
                policy,
                config: { ...config, policy },
            };
        });
    }

    // ----------------------------------------------------------
    // Callbacks
    // ----------------------------------------------------------

    _notifyUpdate() {
        // Re-render the preview section if possible
        const previewEl = this._container?.querySelector('.preview-section');
        if (previewEl) {
            const newPreview = this._renderPreview();
            previewEl.replaceWith(newPreview);
        }
        this.onUpdate();
    }
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
        this._currentSchemaForm = null;
        this._simulatorsCache = null;

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

    async _showNewGroupDialog() {
        // Fetch simulators for the dropdown
        let simulators = [];
        try {
            simulators = await this._getSimulators();
        } catch (err) {
            console.error('Failed to fetch simulators:', err);
        }

        // Build modal
        const overlay = el('div', { className: 'modal-overlay' });

        const nameInput = el('input', {
            type: 'text',
            className: 'form-input',
            id: 'new-group-name',
            placeholder: 'e.g. Fig 9 Replication',
        });

        const simSelect = el('select', {
            className: 'form-select',
            id: 'new-group-simulator',
        });

        if (simulators.length === 0) {
            simSelect.appendChild(el('option', { value: 'Gavel' }, 'Gavel (default)'));
        } else {
            for (const sim of simulators) {
                simSelect.appendChild(el('option', { value: sim.name }, sim.name));
            }
        }

        const closeModal = () => overlay.remove();

        const createBtn = el('button', {
            className: 'btn btn-primary',
            onClick: async () => {
                const name = nameInput.value.trim();
                if (!name) {
                    nameInput.focus();
                    return;
                }
                const simulator = simSelect.value;
                closeModal();
                await this._createNewGroup(name, simulator);
            },
        }, 'Create');

        const cancelBtn = el('button', {
            className: 'btn btn-ghost',
            onClick: closeModal,
        }, 'Cancel');

        const modal = el('div', { className: 'modal-content' },
            el('button', { className: 'modal-close', onClick: closeModal }, '\u00D7'),
            el('div', { className: 'modal-title' }, 'New Experiment Group'),
            el('div', { className: 'modal-body' },
                el('div', { className: 'form-group' },
                    el('label', { className: 'form-label', for: 'new-group-name' }, 'Group Name *'),
                    nameInput,
                ),
                el('div', { className: 'form-group' },
                    el('label', { className: 'form-label', for: 'new-group-simulator' }, 'Simulator'),
                    simSelect,
                    el('div', { className: 'form-hint' },
                        'Select the simulator engine to use for this experiment group.',
                    ),
                ),
            ),
            el('div', { className: 'modal-footer' },
                cancelBtn,
                createBtn,
            ),
        );

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Close on overlay click (not the modal itself)
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });

        // Focus the name input
        nameInput.focus();

        // Allow Enter key to submit
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') createBtn.click();
        });
    }

    async _createNewGroup(name, simulator) {
        // Create a group with no experiments initially.
        // The user will fill in the form and then save.
        // We need to create the group shell first.
        try {
            const group = await api.createGroup({
                name,
                simulator,
                experiments: [],
            });
            this.groups.push(group);
            this._renderDesignSidebar();
            this._selectDesignGroup(group.id);
        } catch (err) {
            console.error('Failed to create group:', err);
        }
    }

    async _getSimulators() {
        if (this._simulatorsCache) return this._simulatorsCache;
        try {
            this._simulatorsCache = await api.getSimulators();
            return this._simulatorsCache;
        } catch {
            return [];
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

    async _selectDesignGroup(groupId) {
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

        // Show loading state
        main.appendChild(
            el('div', { className: 'loading-overlay' },
                el('div', { className: 'spinner' }),
                el('span', {}, 'Loading schema...'),
            )
        );

        // Fetch schema, presets, and policy specs
        const simulatorName = group.simulator || 'Gavel';
        let schema, policySpecs, presets;
        try {
            const [schemaData, presetsData] = await Promise.all([
                api.getSchema(simulatorName),
                api.getPresets(simulatorName),
            ]);
            schema = schemaData.config_schema;
            policySpecs = schemaData.policy_specs || [];
            presets = presetsData;
        } catch (err) {
            console.error('Failed to fetch schema/presets:', err);
            clearChildren(main);
            main.appendChild(
                el('div', { className: 'experiment-detail' },
                    el('h2', {}, group.name),
                    el('div', { className: 'card' },
                        el('div', { className: 'card-body' },
                            el('p', { className: 'text-red' },
                                'Failed to load simulator schema. Is the backend running?',
                            ),
                            el('p', { className: 'text-muted mt-sm', style: { fontSize: '0.78rem' } },
                                String(err),
                            ),
                        ),
                    ),
                ),
            );
            return;
        }

        // Build the form
        clearChildren(main);
        this._renderDesignForm(main, group, schema, policySpecs, presets);
    }

    _renderDesignForm(container, group, schema, policySpecs, presets) {
        const detail = el('div', { className: 'experiment-detail' });

        // Header
        detail.appendChild(el('h2', {}, group.name));
        detail.appendChild(
            el('div', { className: 'flex items-center gap-sm mb-md' },
                el('span', { className: `group-badge status-${statusClass(group.status)}` }, group.status),
                el('span', { className: 'text-muted text-mono', style: { fontSize: '0.7rem' } },
                    `${group.simulator || 'Gavel'} | ${group.id}`),
            ),
        );

        // Create the schema form
        const form = new SchemaForm(schema, policySpecs, presets, () => {
            // Update preview on any change -- handled internally by SchemaForm
        });
        this._currentSchemaForm = form;

        const formEl = form.render();
        detail.appendChild(formEl);

        // Action buttons
        const saveBtn = el('button', {
            className: 'btn btn-primary',
            onClick: () => this._saveGroup(group),
        }, 'Save');

        const saveAndRunBtn = el('button', {
            className: 'btn btn-success',
            onClick: () => this._saveAndRun(group),
        }, 'Save & Go to Run');

        detail.appendChild(
            el('div', { className: 'form-actions' },
                el('div', { className: 'btn-group' }, saveBtn, saveAndRunBtn),
            ),
        );

        container.appendChild(detail);
    }

    async _saveGroup(group) {
        if (!this._currentSchemaForm) return;

        const specs = this._currentSchemaForm.generateExperimentSpecs();
        if (specs.length === 0) {
            console.warn('No experiments to save (check seeds and config)');
            return;
        }

        try {
            // Delete the current (empty) group and recreate with experiments
            await api.deleteGroup(group.id);
            const newGroup = await api.createGroup({
                name: group.name,
                simulator: group.simulator || 'Gavel',
                experiments: specs,
            });

            // Refresh
            await this._refreshDesignSidebar();
            this._selectDesignGroup(newGroup.id);
        } catch (err) {
            console.error('Failed to save group:', err);
        }
    }

    async _saveAndRun(group) {
        if (!this._currentSchemaForm) return;

        const specs = this._currentSchemaForm.generateExperimentSpecs();
        if (specs.length === 0) {
            console.warn('No experiments to save (check seeds and config)');
            return;
        }

        try {
            // Delete the current (empty) group and recreate with experiments
            await api.deleteGroup(group.id);
            const newGroup = await api.createGroup({
                name: group.name,
                simulator: group.simulator || 'Gavel',
                experiments: specs,
            });

            // Refresh sidebar and switch to Run tab
            await this._refreshDesignSidebar();
            this.switchTab('run');
            this._selectRunGroup(newGroup.id);
        } catch (err) {
            console.error('Failed to save and run group:', err);
        }
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
