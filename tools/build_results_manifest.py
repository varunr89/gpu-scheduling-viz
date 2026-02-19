#!/usr/bin/env python3
"""Build structured results manifest for the GPU scheduling visualizer.

Reads experiment results from Gavel CSV, FGD JSON, and paper reference curves,
then writes a structured manifest.json with both the existing experiment entries
and the processed results.

Run from: gpu-scheduling-viz/
"""

import csv
import json
import math
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Optional

import numpy as np


# ---------------------------------------------------------------------------
# Paths (relative to gpu-scheduling-viz/)
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
MANIFEST_PATH = DATA_DIR / "manifest.json"
GAVEL_DIR = BASE_DIR / ".." / "gavel"
GAVEL_CSV = GAVEL_DIR / "experiments" / "combined" / "results" / "gavel_replication_combined.csv"
FGD_JSON = GAVEL_DIR / "experiments" / "fgd-standalone" / "results" / "full_run" / "all_results.json"
GAVEL_PAPER_REF = GAVEL_DIR / "experiments" / "gavel-replication" / "scripts" / "paper_reference_curves.json"
FGD_PAPER_REF = GAVEL_DIR / "experiments" / "fgd-standalone" / "paper_reference_curves.json"
GAVEL_VIZ_DIR = DATA_DIR / "gavel_replication"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
TOTAL_GPUS_FGD = 6212

GAVEL_FIGURE_CONFIG = {
    "fig9": {
        "title": "Figure 9: Single-GPU Jobs (Max-Min Fairness / LAS)",
        "x_label": "Input Job Rate (jobs/hr)",
        "y_label": "Average JCT (hours)",
        "x_range": [0, 7],
        "y_range": [0, 100],
        "policies": {
            "max_min_fairness": {"label": "Baseline", "color": "#e74c3c", "marker": "square"},
            "max_min_fairness_perf": {"label": "Gavel", "color": "#2ecc71", "marker": "circle"},
        },
        "type": "single",
    },
    "fig10": {
        "title": "Figure 10: Multi-GPU Jobs (Max-Min Fairness / LAS)",
        "x_label": "Input Job Rate (jobs/hr)",
        "y_label": "Average JCT (hours)",
        "x_range": [0, 3],
        "y_range": [0, 100],
        "policies": {
            "max_min_fairness": {"label": "Baseline", "color": "#e74c3c", "marker": "square"},
            "max_min_fairness_perf": {"label": "Gavel", "color": "#2ecc71", "marker": "circle"},
        },
        "type": "multi",
    },
    "fig11": {
        "title": "Figure 11: Multi-GPU Jobs (Finish-Time Fairness)",
        "x_label": "Input Job Rate (jobs/hr)",
        "y_label": "Average JCT (hours)",
        "x_range": [0, 3.5],
        "y_range": [0, 100],
        "policies": {
            "finish_time_fairness": {"label": "Baseline", "color": "#e74c3c", "marker": "square"},
            "finish_time_fairness_perf": {"label": "Gavel", "color": "#2ecc71", "marker": "circle"},
        },
        "type": "multi",
    },
}

FGD_POLICY_CONFIG = {
    "random":        {"label": "Random",      "color": "#e74c3c"},
    "gpuclustering": {"label": "Clustering",   "color": "#f39c12"},
    "dotprod":       {"label": "DotProduct",   "color": "#9b59b6"},
    "gpupacking":    {"label": "GPU-Packing",  "color": "#3498db"},
    "bestfit":       {"label": "BestFit",      "color": "#1abc9c"},
    "fgd":           {"label": "FGD",          "color": "#2ecc71"},
}

FGD_FIGURE_CONFIG = {
    "fig7a": {
        "title": "Figure 7a: Fragmentation Rate vs Demand",
        "x_label": "Demand (% cluster capacity)",
        "y_label": "Fragmentation Rate (%)",
        "x_range": [0, 120],
        "y_range": [0, 100],
        "ref_key": "fig7a_frag_rate_pct",
        "y_fn": lambda pt: pt["frag_ratio"] * 100,
    },
    "fig7b": {
        "title": "Figure 7b: Fragmentation / Total GPUs vs Demand",
        "x_label": "Demand (% cluster capacity)",
        "y_label": "Fragmentation / Total GPUs (%)",
        "x_range": [0, 120],
        "y_range": [0, 16],
        "ref_key": "fig7b_frag_over_total_pct",
        "y_fn": lambda pt: (pt["fragmentation"] / TOTAL_GPUS_FGD) * 100,
    },
    "fig9a": {
        "title": "Figure 9a: Unallocated GPUs vs Demand",
        "x_label": "Demand (% cluster capacity)",
        "y_label": "Unallocated GPUs (%)",
        "x_range": [75, 120],
        "y_range": [0, 25],
        "ref_key": "fig9a_unalloc_gpu_pct",
        "y_fn": lambda pt: (1 - pt["alloc_ratio"]) * 100,
    },
    "fig9b": {
        "title": "Figure 9b: Occupied Nodes vs Demand",
        "x_label": "Demand (% cluster capacity)",
        "y_label": "Occupied Nodes",
        "x_range": [0, 100],
        "y_range": [0, 1250],
        "ref_key": "fig9b_occupied_nodes",
        "y_fn": lambda pt: pt["occupied_nodes"],
    },
}

# Paper reference policy key mapping (paper key -> our policy key)
FGD_REF_POLICY_MAP = {
    "random": "random",
    "clustering": "gpuclustering",
    "dotprod": "dotprod",
    "packing": "gpupacking",
    "bestfit": "bestfit",
    "fgd": "fgd",
    "ideal": "ideal",
}

FGD_REF_LABEL_MAP = {
    "random": "Random (paper)",
    "gpuclustering": "Clustering (paper)",
    "dotprod": "DotProduct (paper)",
    "gpupacking": "GPU-Packing (paper)",
    "bestfit": "BestFit (paper)",
    "fgd": "FGD (paper)",
    "ideal": "Ideal (paper)",
}

FGD_REF_COLOR_MAP = {
    "random": "#e74c3c",
    "gpuclustering": "#f39c12",
    "dotprod": "#9b59b6",
    "gpupacking": "#3498db",
    "bestfit": "#1abc9c",
    "fgd": "#2ecc71",
    "ideal": "#95a5a6",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def format_rate(rate: float) -> str:
    """Format a float rate for use in filenames (e.g. 0.4 -> '0.4', 1.0 -> '1.0')."""
    # Use the same format as the CSV name column
    if rate == int(rate):
        return f"{rate:.1f}"
    else:
        return f"{rate:g}"


def build_gavel_results() -> dict:
    """Process Gavel CSV into structured figure results."""
    print("Reading Gavel CSV:", GAVEL_CSV)

    # Read CSV
    rows = []
    with open(GAVEL_CSV) as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    print(f"  {len(rows)} rows read")

    # Group by (figure, policy, jobs_per_hr)
    groups = defaultdict(list)
    skipped_saturated = 0
    skipped_invalid = 0
    for row in rows:
        figure = row["figure"]
        policy = row["policy"]
        rate = float(row["jobs_per_hr"])
        seed = int(row["seed"])
        jct_sec = float(row["jct_sec"])
        saturated = row["saturated"].strip().lower() == "true"

        if saturated:
            skipped_saturated += 1
            continue
        if not math.isfinite(jct_sec):
            skipped_invalid += 1
            continue

        groups[(figure, policy, rate)].append({
            "seed": seed,
            "jct_hr": jct_sec / 3600.0,
            "name": row["name"],
        })

    print(f"  Skipped: {skipped_saturated} saturated, {skipped_invalid} non-finite JCT")

    # Build per-figure results
    gavel_results = {}
    for fig_key, fig_cfg in GAVEL_FIGURE_CONFIG.items():
        curves = {}
        for policy_key, policy_cfg in fig_cfg["policies"].items():
            data_points = []
            # Collect all rates for this (figure, policy)
            rates_for_policy = sorted(set(
                rate for (f, p, rate) in groups if f == fig_key and p == policy_key
            ))
            for rate in rates_for_policy:
                entries = groups[(fig_key, policy_key, rate)]
                jcts = [e["jct_hr"] for e in entries]
                mean_jct = float(np.mean(jcts))
                std_jct = float(np.std(jcts, ddof=0)) if len(jcts) > 1 else 0.0

                # Find matching .viz.bin files
                files = []
                for e in entries:
                    fname = f"gavel_repl_{e['name']}.viz.bin"
                    fpath = GAVEL_VIZ_DIR / fname
                    if fpath.exists():
                        files.append(f"gavel_replication/{fname}")

                point = {
                    "x": rate,
                    "y": round(mean_jct, 4),
                    "std": round(std_jct, 4),
                    "n": len(jcts),
                }
                if files:
                    point["files"] = files
                data_points.append(point)

            curves[policy_key] = {
                "label": policy_cfg["label"],
                "color": policy_cfg["color"],
                "marker": policy_cfg["marker"],
                "data": data_points,
            }

        # Build reference
        reference = build_gavel_reference(fig_key)

        fig_entry = {
            "title": fig_cfg["title"],
            "x_label": fig_cfg["x_label"],
            "y_label": fig_cfg["y_label"],
            "curves": curves,
        }
        if "x_range" in fig_cfg:
            fig_entry["x_range"] = fig_cfg["x_range"]
        if "y_range" in fig_cfg:
            fig_entry["y_range"] = fig_cfg["y_range"]
        if reference:
            fig_entry["reference"] = reference

        gavel_results[fig_key] = fig_entry

    return gavel_results


def build_gavel_reference(fig_key: str) -> Optional[dict]:
    """Build paper reference curves for a Gavel figure."""
    if not GAVEL_PAPER_REF.exists():
        return None

    with open(GAVEL_PAPER_REF) as f:
        paper = json.load(f)

    if fig_key not in paper:
        return None

    fig_ref = paper[fig_key]
    x_values = fig_ref["jobs_per_hr"]

    ref_curves = {}
    if "baseline" in fig_ref:
        ref_curves["baseline"] = {
            "label": "Baseline (paper)",
            "color": "#e74c3c",
            "values": fig_ref["baseline"],
        }
    if "gavel" in fig_ref:
        ref_curves["gavel"] = {
            "label": "Gavel (paper)",
            "color": "#2ecc71",
            "values": fig_ref["gavel"],
        }

    return {
        "x": x_values,
        "curves": ref_curves,
    }


def build_fgd_results() -> dict:
    """Process FGD results into structured figure results."""
    print("Reading FGD results:", FGD_JSON)

    with open(FGD_JSON) as f:
        fgd_data = json.load(f)
    print(f"  {len(fgd_data)} result objects read")

    # Group by policy
    by_policy = defaultdict(list)
    for entry in fgd_data:
        by_policy[entry["policy"]].append(entry)

    policies_found = sorted(by_policy.keys())
    print(f"  Policies: {policies_found}")
    print(f"  Seeds per policy: {[len(v) for v in by_policy.values()]}")

    # Subsample x-points: every 2% from 0 to 130 => 66 points
    x_target = np.arange(0, 132, 2, dtype=float)  # 0, 2, 4, ..., 130

    fgd_results = {}
    for fig_key, fig_cfg in FGD_FIGURE_CONFIG.items():
        curves = {}
        y_fn = fig_cfg["y_fn"]

        for policy_key in policies_found:
            if policy_key not in FGD_POLICY_CONFIG:
                continue
            policy_cfg = FGD_POLICY_CONFIG[policy_key]
            entries = by_policy[policy_key]

            # For each seed, compute (x, y) from the 911-point curve
            seed_y_interps = []
            for entry in entries:
                curve = entry["curve"]
                xs = np.array([pt["demand_fraction"] * 100 for pt in curve])
                ys = np.array([y_fn(pt) for pt in curve])
                # Interpolate to target x-points
                y_interp = np.interp(x_target, xs, ys)
                seed_y_interps.append(y_interp)

            seed_y_interps = np.array(seed_y_interps)  # (n_seeds, n_points)
            mean_y = np.mean(seed_y_interps, axis=0)
            std_y = np.std(seed_y_interps, axis=0, ddof=0) if seed_y_interps.shape[0] > 1 else np.zeros_like(mean_y)

            data_points = []
            for i, x_val in enumerate(x_target):
                data_points.append({
                    "x": round(float(x_val), 2),
                    "y": round(float(mean_y[i]), 4),
                    "std": round(float(std_y[i]), 4),
                    "n": len(entries),
                })

            curves[policy_key] = {
                "label": policy_cfg["label"],
                "color": policy_cfg["color"],
                "data": data_points,
            }

        # Build reference
        reference = build_fgd_reference(fig_cfg["ref_key"])

        fig_entry = {
            "title": fig_cfg["title"],
            "x_label": fig_cfg["x_label"],
            "y_label": fig_cfg["y_label"],
            "curves": curves,
        }
        if "x_range" in fig_cfg:
            fig_entry["x_range"] = fig_cfg["x_range"]
        if "y_range" in fig_cfg:
            fig_entry["y_range"] = fig_cfg["y_range"]
        if reference:
            fig_entry["reference"] = reference

        fgd_results[fig_key] = fig_entry

    return fgd_results


def build_fgd_reference(ref_key: str) -> Optional[dict]:
    """Build paper reference curves for an FGD figure."""
    if not FGD_PAPER_REF.exists():
        return None

    with open(FGD_PAPER_REF) as f:
        paper = json.load(f)

    if ref_key not in paper:
        return None

    fig_ref = paper[ref_key]
    x_values = fig_ref.get("demand_pct", [])

    ref_curves = {}
    for paper_key, our_key in FGD_REF_POLICY_MAP.items():
        if paper_key in fig_ref:
            ref_curves[our_key] = {
                "label": FGD_REF_LABEL_MAP.get(our_key, f"{our_key} (paper)"),
                "color": FGD_REF_COLOR_MAP.get(our_key, "#999999"),
                "values": fig_ref[paper_key],
            }

    if not ref_curves:
        return None

    return {
        "x": x_values,
        "curves": ref_curves,
    }


def print_summary(results: dict) -> None:
    """Print a summary of generated curves."""
    print("\n" + "=" * 60)
    print("Results Manifest Summary")
    print("=" * 60)

    for section_key in ["gavel", "fgd"]:
        section = results.get(section_key, {})
        if not section:
            continue
        print(f"\n--- {section_key.upper()} ---")
        for fig_key in sorted(section.keys()):
            fig = section[fig_key]
            print(f"\n  {fig_key}: {fig['title']}")
            for curve_key, curve in fig["curves"].items():
                n_points = len(curve["data"])
                n_files = sum(len(p.get("files", [])) for p in curve["data"])
                x_range = ""
                if n_points > 0:
                    x_min = curve["data"][0]["x"]
                    x_max = curve["data"][-1]["x"]
                    x_range = f" x=[{x_min}..{x_max}]"
                file_info = f", {n_files} viz files" if n_files > 0 else ""
                print(f"    {curve_key} ({curve['label']}): {n_points} points{x_range}{file_info}")

            ref = fig.get("reference")
            if ref:
                n_ref_x = len(ref.get("x", []))
                ref_curves = list(ref.get("curves", {}).keys())
                print(f"    reference: {n_ref_x} x-points, curves: {ref_curves}")


def main():
    # Verify we're in the right directory
    if not MANIFEST_PATH.exists():
        print(f"ERROR: Cannot find {MANIFEST_PATH}", file=sys.stderr)
        print("Run this script from gpu-scheduling-viz/", file=sys.stderr)
        sys.exit(1)

    # Read existing manifest
    print("Reading existing manifest:", MANIFEST_PATH)
    with open(MANIFEST_PATH) as f:
        existing = json.load(f)

    if isinstance(existing, list):
        experiments = existing
    elif isinstance(existing, dict) and "experiments" in existing:
        experiments = existing["experiments"]
    else:
        print("ERROR: Unexpected manifest format", file=sys.stderr)
        sys.exit(1)

    print(f"  {len(experiments)} existing experiment entries")

    # Build results
    gavel_results = build_gavel_results()
    fgd_results = build_fgd_results()

    results = {
        "gavel": gavel_results,
        "fgd": fgd_results,
    }

    # Write output
    output = {
        "experiments": experiments,
        "results": results,
    }

    print(f"\nWriting manifest to: {MANIFEST_PATH}")
    with open(MANIFEST_PATH, "w") as f:
        json.dump(output, f, indent=2)

    # File size
    size_kb = MANIFEST_PATH.stat().st_size / 1024
    print(f"  Written: {size_kb:.1f} KB")

    print_summary(results)


if __name__ == "__main__":
    main()
