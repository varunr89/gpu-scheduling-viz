#!/usr/bin/env python3
"""Seed the workbench database with Gavel and FGD replication experiments.

Creates experiment groups matching the paper figures, split by policy so
each group works correctly with the Design form's sweep reconstruction.

  Gavel Fig 9:  Single-GPU LAS -- one group per policy (baseline, Gavel)
  Gavel Fig 10: Multi-GPU LAS -- one group per policy
  Gavel Fig 11: Multi-GPU FTF -- one group per policy
  FGD Cluster H: one group per placement strategy

Usage:
    python3 workbench/scripts/seed_experiments.py [--api http://localhost:8765]
"""

import argparse
import json
import urllib.request

API_BASE = "http://localhost:8765/api"

SEEDS = [0, 1, 2]


def post(url, data):
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def delete(url):
    req = urllib.request.Request(url, method="DELETE")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def build_experiments(policy, lam_values, seeds, base_config):
    """Build experiment spec list from the cross product of lam x seeds."""
    experiments = []
    for lam in lam_values:
        jph = round(3600 / lam, 1)
        for seed in seeds:
            config = {
                **base_config,
                "policy": policy,
                "lam": lam,
                "seed": seed,
            }
            name = f"{policy}_lam{lam}_s{seed}"
            experiments.append({
                "name": name,
                "policy": policy,
                "config": config,
            })
    return experiments


# ── Common Gavel params ─────────────────────────────────────────────
GAVEL_COMMON = {
    "cluster_preset": "Philly 108",
    "mode": "steady_state",
    "window_start": 4000,
    "window_end": 5000,
    "time_per_iteration": 360,
    "max_simulated_time": 360000000,
    "enable_fgd": False,
    "enable_migration_penalty": False,
    "enable_gpu_sharing": False,
    "solver": "ECOS",
    "completion_rate_threshold": 0,
    "log_level": "WARNING",
}


# ── Evenly-spaced lam values ────────────────────────────────────────
# Fig 9: 20 rates from 0.4-8.0 jph => lam from 9000 down to 450.
# Use arithmetic lam: 450 to 9000, step 450 (20 values).
FIG9_LAMS = list(range(450, 9001, 450))  # [450, 900, 1350, ..., 9000]

# Fig 10: 15 rates from 0.2-3.0 jph => lam from 18000 down to 1200.
# Use arithmetic lam: 1200 to 18000, step 1200 (15 values).
FIG10_LAMS = list(range(1200, 18001, 1200))

# Fig 11: 17 rates from 0.2-3.4 jph => lam roughly 1059-18000.
# Use arithmetic lam: 1000 to 17000, step 1000 (17 values).
FIG11_LAMS = list(range(1000, 17001, 1000))

# FGD: 15 rates from 5-360 jph => lam from 720 down to 10.
# Use arithmetic lam: 10 to 720, step 50 (~15 values).
FGD_LAMS = list(range(10, 721, 50))  # [10, 60, 110, ..., 710] = 15 values


# ── FGD Cluster H common params ─────────────────────────────────────
FGD_CLUSTER_H_COMMON = {
    "cluster_spec": {"generic": 5592},
    "gpus_per_node": 8,
    "mode": "steady_state",
    "window_start": 4000,
    "window_end": 5000,
    "time_per_iteration": 600,
    "max_simulated_time": 360000000,
    "workload_mode": "alibaba",
    "throughputs_file": "simulation_throughputs_cluster_h.json",
    "reference_worker_type": "generic",
    "enable_migration_penalty": False,
    "enable_gpu_sharing": False,
    "solver": "ECOS",
    "completion_rate_threshold": 0.1,
    "log_level": "WARNING",
}


# ── Group definitions ────────────────────────────────────────────────
# Each tuple: (group_name, policy, lam_values, base_config)
GROUPS = [
    # Gavel Fig 9 -- Single-GPU LAS
    (
        "Gavel Fig 9 -- Baseline (LAS)",
        "max_min_fairness",
        FIG9_LAMS,
        {**GAVEL_COMMON, "generate_multi_gpu_jobs": False},
    ),
    (
        "Gavel Fig 9 -- Gavel (LAS)",
        "max_min_fairness_perf",
        FIG9_LAMS,
        {**GAVEL_COMMON, "generate_multi_gpu_jobs": False},
    ),
    # Gavel Fig 10 -- Multi-GPU LAS
    (
        "Gavel Fig 10 -- Baseline (Multi-GPU LAS)",
        "max_min_fairness",
        FIG10_LAMS,
        {**GAVEL_COMMON, "generate_multi_gpu_jobs": True},
    ),
    (
        "Gavel Fig 10 -- Gavel (Multi-GPU LAS)",
        "max_min_fairness_perf",
        FIG10_LAMS,
        {**GAVEL_COMMON, "generate_multi_gpu_jobs": True},
    ),
    # Gavel Fig 11 -- Multi-GPU FTF
    (
        "Gavel Fig 11 -- Baseline (FTF)",
        "finish_time_fairness",
        FIG11_LAMS,
        {**GAVEL_COMMON, "generate_multi_gpu_jobs": True},
    ),
    (
        "Gavel Fig 11 -- Gavel (FTF)",
        "finish_time_fairness_perf",
        FIG11_LAMS,
        {**GAVEL_COMMON, "generate_multi_gpu_jobs": True},
    ),
    # FGD Cluster H -- one group per placement strategy
    (
        "FGD Cluster H -- Strided (baseline)",
        "max_min_fairness",
        FGD_LAMS,
        {**FGD_CLUSTER_H_COMMON, "enable_fgd": False, "fgd_placement_mode": "fgd"},
    ),
    (
        "FGD Cluster H -- Random",
        "max_min_fairness",
        FGD_LAMS,
        {**FGD_CLUSTER_H_COMMON, "enable_fgd": True, "fgd_placement_mode": "random"},
    ),
    (
        "FGD Cluster H -- BestFit",
        "max_min_fairness",
        FGD_LAMS,
        {**FGD_CLUSTER_H_COMMON, "enable_fgd": True, "fgd_placement_mode": "bestfit"},
    ),
    (
        "FGD Cluster H -- FGD",
        "max_min_fairness",
        FGD_LAMS,
        {**FGD_CLUSTER_H_COMMON, "enable_fgd": True, "fgd_placement_mode": "fgd"},
    ),
]


def main():
    parser = argparse.ArgumentParser(description="Seed workbench with replication experiments")
    parser.add_argument("--api", default=API_BASE, help="API base URL")
    parser.add_argument("--clean", action="store_true", help="Delete all existing groups first")
    args = parser.parse_args()
    api = args.api

    if args.clean:
        resp = urllib.request.urlopen(f"{api}/experiments")
        existing = json.loads(resp.read())
        for g in existing:
            delete(f"{api}/experiments/{g['id']}")
            print(f"  Deleted '{g['name']}'")
        if existing:
            print()

    total = 0
    for group_name, policy, lam_values, base_config in GROUPS:
        experiments = build_experiments(policy, lam_values, SEEDS, base_config)
        payload = {
            "name": group_name,
            "simulator": "Gavel",
            "experiments": experiments,
        }
        result = post(f"{api}/experiments", payload)
        n = len(result.get("experiments", []))
        total += n
        jph_range = f"{round(3600/max(lam_values), 1)}-{round(3600/min(lam_values), 1)} jph"
        print(f"  Created '{group_name}' -- {n} experiments ({jph_range})")

    print(f"\nDone. {len(GROUPS)} groups, {total} experiments total.")


if __name__ == "__main__":
    main()
