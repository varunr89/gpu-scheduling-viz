"""Experiment metadata schema -- single source of truth for filter validation.

All scripts that write to manifest.json must import from here.
"""
import datetime
import re

# Canonical allowed values
TRACES = {'philly', 'alibaba'}
FIGURES = {'gavel-fig9', 'gavel-fig10', 'gavel-fig11', 'fgd-fig7', 'fgd-fig9'}
SCHEDULERS = {'mmf', 'fifo', 'gavel', 'packed'}
PLACEMENTS = {'strided', 'random', 'bestfit', 'fgd'}

REQUIRED_FIELDS = {'date', 'trace', 'figure', 'scheduler', 'placement', 'load', 'seed'}

_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
_LOAD_RE = re.compile(r'^\d+(\.\d+)?jph$')
_SEED_RE = re.compile(r'^s\d+$')

# Maps for migrating old algorithm field to (scheduler, placement)
ALGORITHM_MIGRATION = {
    'gavel': ('gavel', 'strided'),
    'baseline': ('mmf', 'strided'),
    'gavel-random': ('gavel', 'random'),
    'gavel-bestfit': ('gavel', 'bestfit'),
    'gavel+fgd': ('gavel', 'fgd'),
    'fgd': ('mmf', 'fgd'),
    'bestfit': ('mmf', 'bestfit'),
    'random': ('mmf', 'random'),
    'strided': ('mmf', 'strided'),
    'fifo': ('fifo', 'strided'),
    'packed': ('packed', 'strided'),
}

FIGURE_MIGRATION = {
    'fig9': 'gavel-fig9',
    'fig10': 'gavel-fig10',
    'fig11': 'gavel-fig11',
    'fgd-placement': 'fgd-fig7',
    'fgd-replication': 'fgd-fig7',
    'fgd-replication-fifo': 'fgd-fig7',
    'fgd-scale': 'fgd-fig9',
}

LOAD_MIGRATION = {
    'low-load': '1.0jph',
    'mid-load': '4.0jph',
    'high-load': '7.0jph',
}


def validate_filters(filters):
    """Validate experiment filters dict. Returns the dict unchanged, or raises ValueError."""
    if 'algorithm' in filters:
        raise ValueError(
            f"Old 'algorithm' field found (value: {filters['algorithm']!r}). "
            f"Use 'scheduler' + 'placement' instead. "
            f"See ALGORITHM_MIGRATION for mappings."
        )

    for field in REQUIRED_FIELDS:
        if field not in filters:
            raise ValueError(f"Missing required field '{field}'. Required: {sorted(REQUIRED_FIELDS)}")

    f = filters
    if f['trace'] not in TRACES:
        raise ValueError(f"Invalid trace {f['trace']!r}. Allowed: {sorted(TRACES)}")
    if f['figure'] not in FIGURES:
        raise ValueError(f"Invalid figure {f['figure']!r}. Allowed: {sorted(FIGURES)}")
    if f['scheduler'] not in SCHEDULERS:
        raise ValueError(f"Invalid scheduler {f['scheduler']!r}. Allowed: {sorted(SCHEDULERS)}")
    if f['placement'] not in PLACEMENTS:
        raise ValueError(f"Invalid placement {f['placement']!r}. Allowed: {sorted(PLACEMENTS)}")
    try:
        datetime.date.fromisoformat(f['date'])
    except (ValueError, TypeError):
        raise ValueError(f"Invalid date {f['date']!r}. Expected valid YYYY-MM-DD date.")
    if not _LOAD_RE.match(f['load']):
        raise ValueError(f"Invalid load {f['load']!r}. Expected '<number>jph' (e.g. '60jph', '0.8jph').")
    if not _SEED_RE.match(f['seed']):
        raise ValueError(f"Invalid seed {f['seed']!r}. Expected 's<N>' (e.g. 's0', 's1').")

    return filters


def build_manifest_entry(file, filters, rounds, complete):
    """Build a validated manifest entry with auto-generated label."""
    validate_filters(filters)

    f = filters
    label = (
        f"{f['date']} | {f['figure']} | {f['trace'].capitalize()} | "
        f"{f['scheduler'].capitalize()}/{f['placement'].capitalize()} | "
        f"{f['load']} | {f['seed']} | {rounds}r"
    )
    return {
        'file': file,
        'label': label,
        'filters': dict(filters),
        'rounds': rounds,
        'complete': complete,
    }
