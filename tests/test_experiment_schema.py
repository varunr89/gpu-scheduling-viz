import pytest
from viz.tools.experiment_schema import (
    TRACES, FIGURES, SCHEDULERS, PLACEMENTS,
    ALGORITHM_MIGRATION, FIGURE_MIGRATION, LOAD_MIGRATION,
    validate_filters, build_manifest_entry,
)


class TestAllowedValues:
    def test_traces(self):
        assert TRACES == {'philly', 'alibaba'}

    def test_figures(self):
        assert FIGURES == {'gavel-fig9', 'gavel-fig10', 'gavel-fig11', 'fgd-fig7', 'fgd-fig9'}

    def test_schedulers(self):
        assert SCHEDULERS == {'mmf', 'fifo', 'gavel', 'packed'}

    def test_placements(self):
        assert PLACEMENTS == {'strided', 'random', 'bestfit', 'fgd'}


class TestValidateFilters:
    def test_valid_filters(self):
        filters = {
            'date': '2026-02-07', 'trace': 'alibaba', 'figure': 'fgd-fig7',
            'scheduler': 'gavel', 'placement': 'random', 'load': '60jph', 'seed': 's0',
        }
        result = validate_filters(filters)
        assert result == filters

    def test_rejects_bad_trace(self):
        filters = {
            'date': '2026-02-07', 'trace': 'azure', 'figure': 'fgd-fig7',
            'scheduler': 'gavel', 'placement': 'random', 'load': '60jph', 'seed': 's0',
        }
        with pytest.raises(ValueError, match='trace'):
            validate_filters(filters)

    def test_rejects_bad_figure(self):
        filters = {
            'date': '2026-02-07', 'trace': 'alibaba', 'figure': 'fgd-placement',
            'scheduler': 'gavel', 'placement': 'random', 'load': '60jph', 'seed': 's0',
        }
        with pytest.raises(ValueError, match='figure'):
            validate_filters(filters)

    def test_rejects_bad_scheduler(self):
        filters = {
            'date': '2026-02-07', 'trace': 'alibaba', 'figure': 'fgd-fig7',
            'scheduler': 'baseline', 'placement': 'random', 'load': '60jph', 'seed': 's0',
        }
        with pytest.raises(ValueError, match='scheduler'):
            validate_filters(filters)

    def test_rejects_bad_placement(self):
        filters = {
            'date': '2026-02-07', 'trace': 'alibaba', 'figure': 'fgd-fig7',
            'scheduler': 'gavel', 'placement': 'packed', 'load': '60jph', 'seed': 's0',
        }
        with pytest.raises(ValueError, match='placement'):
            validate_filters(filters)

    def test_rejects_named_load(self):
        filters = {
            'date': '2026-02-07', 'trace': 'alibaba', 'figure': 'fgd-fig7',
            'scheduler': 'gavel', 'placement': 'random', 'load': 'high-load', 'seed': 's0',
        }
        with pytest.raises(ValueError, match='load'):
            validate_filters(filters)

    def test_rejects_bad_date(self):
        filters = {
            'date': 'Feb 7 2026', 'trace': 'alibaba', 'figure': 'fgd-fig7',
            'scheduler': 'gavel', 'placement': 'random', 'load': '60jph', 'seed': 's0',
        }
        with pytest.raises(ValueError, match='date'):
            validate_filters(filters)

    def test_rejects_bad_seed(self):
        filters = {
            'date': '2026-02-07', 'trace': 'alibaba', 'figure': 'fgd-fig7',
            'scheduler': 'gavel', 'placement': 'random', 'load': '60jph', 'seed': 'seed0',
        }
        with pytest.raises(ValueError, match='seed'):
            validate_filters(filters)

    def test_rejects_missing_field(self):
        filters = {
            'date': '2026-02-07', 'trace': 'alibaba', 'figure': 'fgd-fig7',
            'scheduler': 'gavel', 'placement': 'random', 'load': '60jph',
        }
        with pytest.raises(ValueError, match='seed'):
            validate_filters(filters)

    def test_rejects_old_algorithm_field(self):
        filters = {
            'date': '2026-02-07', 'trace': 'alibaba', 'figure': 'fgd-fig7',
            'algorithm': 'gavel-random', 'load': '60jph', 'seed': 's0',
        }
        with pytest.raises(ValueError, match='algorithm'):
            validate_filters(filters)

    def test_decimal_load(self):
        filters = {
            'date': '2026-02-07', 'trace': 'philly', 'figure': 'gavel-fig9',
            'scheduler': 'mmf', 'placement': 'strided', 'load': '0.8jph', 'seed': 's1',
        }
        assert validate_filters(filters) == filters


class TestBuildManifestEntry:
    def test_builds_entry(self):
        entry = build_manifest_entry(
            file='fgd_replication/fgd_repl_fgd_bestfit_100jph_s1.viz.bin',
            filters={
                'date': '2026-02-21', 'trace': 'alibaba', 'figure': 'fgd-fig7',
                'scheduler': 'mmf', 'placement': 'bestfit', 'load': '100jph', 'seed': 's1',
            },
            rounds=453, complete=True,
        )
        assert entry['file'] == 'fgd_replication/fgd_repl_fgd_bestfit_100jph_s1.viz.bin'
        assert entry['rounds'] == 453
        assert entry['complete'] is True
        assert entry['filters']['scheduler'] == 'mmf'
        assert entry['filters']['placement'] == 'bestfit'
        assert '| Alibaba |' in entry['label']
        assert '| Mmf/Bestfit |' in entry['label']
        assert '| 453r' in entry['label']

    def test_build_entry_validates(self):
        with pytest.raises(ValueError):
            build_manifest_entry(
                file='test.viz.bin',
                filters={
                    'date': '2026-02-21', 'trace': 'alibaba', 'figure': 'bad-figure',
                    'scheduler': 'mmf', 'placement': 'strided', 'load': '60jph', 'seed': 's0',
                },
                rounds=100, complete=True,
            )


class TestMigrationMaps:
    def test_all_old_algorithms_mapped(self):
        old_algos = {
            'gavel', 'baseline', 'gavel-random', 'gavel-bestfit', 'gavel+fgd',
            'fgd', 'bestfit', 'random', 'strided', 'fifo', 'packed',
        }
        assert old_algos == set(ALGORITHM_MIGRATION.keys())

    def test_all_old_figures_mapped(self):
        old_figs = {
            'fig9', 'fig10', 'fig11', 'fgd-placement',
            'fgd-replication', 'fgd-replication-fifo', 'fgd-scale',
        }
        assert old_figs == set(FIGURE_MIGRATION.keys())

    def test_all_named_loads_mapped(self):
        assert set(LOAD_MIGRATION.keys()) == {'low-load', 'mid-load', 'high-load'}

    def test_algorithm_targets_are_valid(self):
        for algo, (sched, place) in ALGORITHM_MIGRATION.items():
            assert sched in SCHEDULERS, f"{algo} -> scheduler {sched!r} not in SCHEDULERS"
            assert place in PLACEMENTS, f"{algo} -> placement {place!r} not in PLACEMENTS"

    def test_figure_targets_are_valid(self):
        for old, new in FIGURE_MIGRATION.items():
            assert new in FIGURES, f"{old} -> {new!r} not in FIGURES"
