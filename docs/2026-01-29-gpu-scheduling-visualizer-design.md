# GPU Scheduling Visualizer Design

**Date:** 2026-01-29
**Status:** Ready for implementation
**Reviewed:** Codex (gpt-5.2-codex) - architecture, performance, scalability

## Overview

A web-based visualization tool that animates GPU job scheduling simulations. Loads preprocessed simulation data and renders job allocations across a configurable GPU grid, with support for comparing two simulations side-by-side.

## Goals

1. Visualize how jobs are packed onto GPUs over time
2. Compare two scheduling algorithms/configurations
3. See utilization patterns and identify fragmentation
4. Support any cluster configuration (not hardcoded to 36:36:36)

## Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│  SIMULATION 1: [Load File...] filename.viz.bin              [Clear]    │
│  SIMULATION 2: [Load File...] filename.viz.bin              [Clear]    │
│                                                 Playback: [◀][▶][1x]   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  SIMULATION 1: filename                                                │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ V100 │ RN18│ LM5 │ TF32│ ... (N cells per GPU type)             │   │
│  │ P100 │ RN50│ RN50│     │ ...                                    │   │
│  │ K80  │ Rec │     │ LM20│ ...                                    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│  Util: 94.4% | V100: 28/36 (78%) | P100: 34/36 (94%) | K80: 32/36     │
│  Running: 52 | Queued: 3 | Completed: 27 | Avg JCT: 2.34 hrs          │
│                                                                         │
│  SIMULATION 2: filename (if loaded)                                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ ... (same structure, adapts to config)                          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│  Util: 96.2% | ...                                                     │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  ◀ ━━━━━━━━━━━━━━━━┃████████████████████████┃━━━━━━━━━━━━━━━━━━━━━━ ▶  │
│    WARM-UP         │     MEASUREMENT        │       COOLDOWN           │
│  Sim Time: 1.00 hrs | Round: 11 of 892                                 │
├───────────────────────────────┬─────────────────────────────────────────┤
│  QUEUE (Sim 1)                │  QUEUE (Sim 2)                          │
│  Job 61: LM-80 (1 GPU)        │  Job 63: ResNet-18 (8 GPU)              │
│    Waiting: 0.34 hrs          │    Waiting: 0.12 hrs                    │
└───────────────────────────────┴─────────────────────────────────────────┘
```

## GPU Grid Visualization

### Cell Display
- **Content:** Job type abbreviation (RN18, RN50, TF32, LM5, Rec, etc.)
- **Color:** By job category
  - ResNets: blue shades
  - Transformers: green shades
  - Language Models: orange shades
  - Recommendation: purple
  - CycleGAN: pink
- **Empty cell:** Light gray

### Multi-GPU Jobs
- Jobs spanning multiple GPUs share the same color
- Connected visually (border or highlight)
- Hover highlights all cells belonging to that job

### Hover Tooltip
```
Job 23: ResNet-50 (batch 64)
Scale: 4 GPUs
Running for: 0.34 hrs
```

## Timeline & Playback

### Scrubber
- Drag to any simulation time
- Click to jump
- Keyboard: left/right arrows step by one round

### Phase Markers
- **Warm-up** (light gray): Before measurement window starts
- **Measurement** (highlighted): Between start_job arrival and end_job completion
- **Cooldown** (light gray): After measurement window

### Controls
- Play/Pause (spacebar)
- Speed: 1x, 2x, 5x, 10x
- Step: |◀ ◀ ▶ ▶| (first, prev, next, last)

### Synced Playback
- Two simulations advance together on same sim_time
- Shorter simulation stays on final state when exceeded

## Metrics Panel

Per simulation, shown below grid:
- **Util:** Overall cluster utilization %
- **Per-type:** Used/total with % for each GPU type
- **Running:** Jobs currently executing
- **Queued:** Jobs waiting
- **Completed:** Total jobs finished
- **Avg JCT:** Average job completion time (hours)
- **Rate:** Windowed completion rate (jobs/hr)

## Queue Panel

Side panel showing jobs waiting to be scheduled:
- Job ID and type
- Scale factor (GPU count)
- Wait time (hours)
- Sorted by wait time (longest first)

## Binary Data Format

### Design Principles
- **Little-endian** byte order throughout
- **8-byte alignment** for all section starts
- **Fixed-size round records** for direct offset calculation
- **Separate variable-length data** (queues) in dedicated section

### File Structure
```
simulation.viz.bin
├── Header (fixed 256 bytes, padded)
│   ├── magic: "GPUVIZ01" (8 bytes)
│   ├── version: uint32 (currently 1)
│   ├── num_rounds: uint32
│   ├── num_jobs: uint32
│   ├── num_gpu_types: uint8
│   ├── total_gpus: uint16
│   ├── padding: 1 byte
│   ├── job_metadata_offset: uint64
│   ├── rounds_offset: uint64
│   ├── queue_offset: uint64
│   ├── index_offset: uint64
│   └── config_json_offset: uint64 (points to JSON metadata)
│
├── Config JSON (variable size, 8-byte aligned)
│   └── {gpu_types, measurement_window, job_types, ...}
│
├── Job Metadata (fixed-size array, loaded once)
│   └── Per job (16 bytes each):
│       ├── job_id: uint32
│       ├── type_id: uint16
│       ├── scale_factor: uint8
│       ├── padding: 1 byte
│       ├── arrival_round: uint32
│       └── padding: 4 bytes
│
├── Round Data (FIXED-SIZE records, streamed on demand)
│   └── Per round (fixed size = 24 + 2*num_gpu_types + 4*total_gpus):
│       ├── round: uint32
│       ├── sim_time: float32
│       ├── utilization: float32
│       ├── jobs_running: uint16
│       ├── jobs_queued: uint16
│       ├── jobs_completed: uint32
│       ├── avg_jct: float32
│       ├── completion_rate: float32
│       ├── gpu_used[]: uint16 per type
│       └── allocations: uint32[total_gpus] (job_id, 0=empty)
│
├── Queue Data (variable-length, separate section)
│   └── Per round:
│       ├── queue_len: uint16
│       └── queue: uint32[queue_len] (job IDs)
│
└── Index Table (at end, for queue random access)
    └── queue_byte_offset[round]: uint64 per round
```

### Key Changes from Initial Design (per Codex review)
1. **Fixed-size rounds** - Queue moved to separate section
2. **uint32 job IDs** - Supports >65K jobs
3. **uint16 gpu_used[]** - Supports >255 GPUs per type
4. **index_offset in header** - No tail-fetch needed
5. **Explicit endianness** - Little-endian throughout
6. **8-byte alignment** - All sections aligned

### Size Estimates
- Header: 256 bytes (fixed)
- Per job: 16 bytes
- Per round (108 GPUs): 24 + 6 + 432 = 462 bytes
- Per round queue (avg 5 jobs): ~22 bytes
- 10K rounds, 1K jobs: ~5 MB total

### Why Binary
- ~460 bytes per round vs ~2KB+ for JSON
- Fixed-size records enable direct offset calculation: `offset = rounds_offset + (round * round_size)`
- Range requests for efficient streaming
- 10K rounds: ~5MB binary vs ~20MB JSON

### Loading Strategy
1. **Initial:** Fetch header (256 bytes) + config JSON + job metadata (~20KB)
2. **On scrub:** Fetch rounds in batches of 50-100 using calculated offsets
3. **Prefetch:** While playing, load next batch in background
4. **Queue on-demand:** Fetch queue data only when queue panel visible
5. **Cache:** LRU cache for recent batches, configurable size
6. **AbortController:** Cancel stale fetches when scrubbing quickly

## Technology Stack

### Rendering
- **HTML5 Canvas** for GPU grid (better performance than DOM for 100+ cells)
- Dirty-region repaints (only redraw changed cells)
- Pre-rendered label atlas for job type abbreviations at scale

### Framework
- **Start with Vanilla JS** for simplicity
- **Consider Preact/Svelte** if UI complexity grows (state management for timelines, filters, tooltips)
- Hybrid approach: framework for UI controls, Canvas for grid rendering

### Styling
- Plain CSS with CSS Grid for layout

### Server
- Static file server with range request support
- Files must be served uncompressed (or use chunk-compression with offsets)

## Architecture

### Modular Design
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ DataSource  │────▶│   Decoder   │────▶│    Model    │
│ (Range IO)  │     │ (Binary→JS) │     │  (State)    │
└─────────────┘     └─────────────┘     └─────────────┘
                          │                    │
                    [Web Worker]               │
                                               ▼
                                        ┌─────────────┐
                                        │  Renderer   │
                                        │  (Canvas)   │
                                        └─────────────┘
                                               │
                                               ▼
                                        ┌─────────────┐
                                        │ Controller  │
                                        │ (Playback)  │
                                        └─────────────┘
```

### Components
- **DataSource:** Range request fetching, caching, prefetching
- **Decoder:** Binary parsing in Web Worker to avoid UI jank
- **Model:** Timeline state, current round, loaded simulations
- **Renderer:** Canvas drawing, hover detection, dirty tracking
- **Controller:** Playback controls, keyboard shortcuts, sync

### Integrity Checks
- Magic number validation
- Version compatibility check
- Length validation on all arrays
- Optional: CRC per block for corruption detection

## Files to Create

```
cluster/viz/
├── index.html           # Main app HTML
├── viz.js               # Main entry, Controller
├── data-source.js       # Range requests, caching
├── decoder.js           # Binary parsing (also as worker)
├── decoder.worker.js    # Web Worker wrapper
├── model.js             # State management
├── renderer.js          # Canvas rendering
├── viz.css              # Styling
├── binary_format.py     # Binary file reader/writer utilities
└── preprocess_viz.py    # Log parser, generates .viz.bin files
```

## Preprocessing Script

```bash
python viz/preprocess_viz.py \
  --log results_full/fig11_.../simulation.log \
  --telemetry telemetry_data/fig11_..._telemetry.json \
  --output telemetry_data/fig11_..._viz.bin
```

### Input Parsing
From `simulation.log`:
- `EVENT {"event": "job_arrival", ...}` - Job metadata
- `[Micro-task scheduled] Job ID: X Worker type: Y Worker ID(s): Z` - Allocations
- `EVENT {"event": "job_completion", ...}` - When jobs finish

From `*_telemetry.json`:
- Per-round metrics (utilization, counts, etc.)

### Worker ID Mapping
Worker IDs encode GPU type (derived from cluster config):
- 0 to (k80_count-1): K80
- k80_count to (k80_count+p100_count-1): P100
- etc.

## Implementation Order

1. **Binary format utilities** - Python read/write for .viz.bin
2. **Preprocessing script** - Parse logs, generate binary files
3. **HTML layout** - File pickers, Canvas elements, controls
4. **DataSource** - Range requests with caching
5. **Decoder** - Binary parsing (main thread first, then Worker)
6. **GPU grid rendering** - Canvas drawing, colors, labels
7. **Playback controls** - Play/pause, speed, scrubber
8. **Metrics display** - Stats below each grid
9. **Queue panel** - Side panel with waiting jobs
10. **Two-simulation mode** - Synced playback, comparison
11. **Phase markers** - Warm-up/measurement/cooldown on timeline

## Scalability Notes

Current design optimized for:
- ~100-1000 GPUs
- ~10K-100K rounds
- ~1K-10K jobs

For larger scale (10K+ GPUs, 1M+ rounds):
- Consider delta encoding for allocations (store only changes)
- Multi-resolution index (coarse summaries for fast scrubbing)
- Zoom/pan interface with level-of-detail rendering
- Aggregated bucket views when zoomed out

## Future Enhancements (Out of Scope)

- Export animation as video/GIF
- Aggregate statistics comparison panel
- Fragmentation metric visualization
- Job filtering by type/size
- Delta encoding for large datasets
