# GPU Scheduling Visualizer

![Demo](docs/demo.gif)

Interactive visualization tool for GPU cluster scheduling experiments. Renders per-round heatmaps, time-series charts, CDF plots, and aggregated results from `.viz.bin` binary experiment files.

Built for the [Gavel + FGD](https://github.com/Turquoise-T/cs244c-GPU_fragment) project (CS244C, Stanford).

## Features

- **Heatmap view** -- Per-GPU allocation state across scheduling rounds, with drill-down modal
- **Time-series charts** -- Occupancy, effective utilization, moving-average JCT, queue length, completed jobs over simulated time
- **CDF charts** -- Job completion time distributions
- **Results tab** -- Aggregated experiment comparisons with filtering by figure, policy, and placement strategy
- **Experiment workbench** -- Design, run, and analyze experiment sweeps interactively
- **Side-by-side comparison** -- Load two simulations and compare them round-by-round
- **Supports arbitrary GPU types** -- Dynamic columns for heterogeneous clusters (V100, P100, K80, T4, etc.)

## Live Data

Experiment data (843 `.viz.bin` files) is hosted on Azure Blob Storage and loaded automatically. The manifest at `data/manifest.json` indexes all available experiments with metadata for filtering.

## Running Locally

```bash
# Any static HTTP server works
python3 -m http.server 8080

# Open in browser
open http://localhost:8080
```

By default, data is fetched from Azure Blob Storage. To use local `.viz.bin` files instead, add `?local` to the URL:

```
http://localhost:8080?local
```

This switches the data source from Azure to the local `data/` directory.

## Data Format

Experiment data is stored in `.viz.bin`, a compact binary format:

| Section | Contents |
|---------|----------|
| Header | Magic bytes, version, config offset, data offset |
| Config | JSON with cluster spec, policy, GPU types, experiment metadata |
| Rounds | Per-round GPU allocation arrays + job metadata |

The Python tools in `tools/` handle conversion from scheduler logs to `.viz.bin`:

```bash
# Convert a scheduler log to .viz.bin
python -m viz.tools.preprocess_viz input.log output.viz.bin

# Batch convert multiple experiments
python -m viz.tools.preprocess_viz --batch experiments/ output_dir/
```

## Project Structure

```
.
├── index.html                  # Entry point
├── src/
│   ├── viz.js                  # Main controller
│   ├── viz.css                 # Styles
│   ├── data-source.js          # Data loading + Azure/local switching
│   ├── decoder.js              # .viz.bin binary decoder
│   ├── decoder.worker.js       # Web Worker for background decoding
│   ├── model.js                # Data model
│   ├── renderer.js             # Canvas heatmap renderer
│   ├── timeseries.js           # Time-series chart component
│   ├── pdf-chart.js            # CDF chart component
│   ├── results-chart.js        # Aggregated results view
│   ├── fragmentation.js        # Fragmentation metrics computation
│   └── heatmap-modal.js        # Drill-down heatmap modal
├── workbench/
│   └── frontend/               # Experiment workbench UI
│       ├── workbench.html
│       ├── workbench.js
│       └── workbench.css
├── tools/                      # Python package (import via viz.tools.*)
│   ├── binary_format.py        # .viz.bin encoder/decoder
│   ├── log_parser.py           # Scheduler log parser
│   ├── preprocess_viz.py       # Log-to-binary conversion
│   ├── build_results_manifest.py  # Manifest generator
│   └── experiment_schema.py    # Experiment config validation
├── data/
│   └── manifest.json           # Experiment index (metadata + file paths)
└── docs/
    └── demo.gif                # Demo recording
```

## Related

- [Gavel + FGD Scheduler](https://github.com/Turquoise-T/cs244c-GPU_fragment) -- The scheduler that produces the experiment data visualized here
