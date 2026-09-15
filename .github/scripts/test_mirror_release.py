#!/usr/bin/env python3
"""Unit tests for mirror_release.py (retention policy and delete guards).

No network, no repository access, no ModelScope call: the retention and guard
tests are pure functions over a fake remote inventory, and the flow tests drive
subcommand_mirror_runtime with a fake SDK plus a temporary release-assets
directory. Run them from the repository root:

    python .github/scripts/test_mirror_release.py
"""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import mirror_release as mr  # noqa: E402

RUNTIME_PLATFORMS = (
    'win32-x64',
    'win32-arm64',
    'darwin-x64',
    'darwin-arm64',
    'linux-x64',
    'linux-arm64',
)


def runtime_asset_names(version, platforms=('win32-x64', 'linux-x64')):
    names = []
    for platform in platforms:
        names.append(f'dsh-runtime-{platform}-{version}.tgz')
        names.append(f'dsh-runtime-{platform}-{version}.tgz.sha512')
        names.append(f'manifest-{platform}.json')
    return names


def runtime_inventory(*versions, platforms=('win32-x64', 'linux-x64')):
    """Fake remote listing of releases/runtime/runtime-<version>/<asset>."""
    files = []
    for version in versions:
        for name in runtime_asset_names(version, platforms):
            files.append({'path': f'releases/runtime/runtime-{version}/{name}', 'size': 10})
    return files


# The layer names a producer emits (scripts/split-runtime-layers.mjs): the name
# IS the cache key, so only the dsh/suite layers carry a version.
LAYER_KINDS = (('node', '9ab12cd34ef5'), ('vendor', 'fedcba987654'), ('meta', '001122334455'))


def runtime_layer_assets(platforms=('win32-x64', 'linux-x64'), version='0.1.5-rc.2'):
    """{asset name: body} for one cell's layer set plus its index."""
    assets = {}
    for platform in platforms:
        layers = []
        for kind, key in LAYER_KINDS:
            layers.append({
                'kind': kind,
                'name': f'{kind}-{key}-{platform}.tgz',
                'sha512': 'a' * 128,
                'bytes': 10,
                'entries': ['runtime/node'],
            })
        layers.append({
            'kind': 'dsh', 'name': f'dsh-{version}-{platform}.tgz',
            'sha512': 'b' * 128, 'bytes': 10, 'entries': ['runtime/app/node_modules/@deepseek-ai'],
        })
        layers.append({
            'kind': 'suite', 'name': f'suite-s1-{platform}.tgz',
            'sha512': 'c' * 128, 'bytes': 10, 'entries': ['runtime/app/node_modules/@dsh-app'],
        })
        for layer in layers:
            assets[layer['name']] = 'x'
        owner, arch = platform.split('-')
        assets[f'layers-{platform}.json'] = json.dumps({
            'dshVersion': version, 'suiteVersion': 's1', 'channel': 'stable',
            'platform': owner, 'arch': arch, 'integrity': '', 'source': 'artifact',
            'layers': layers,
        })
    return assets


class SemverOrderingTests(unittest.TestCase):
    def test_numeric_order_beats_string_order(self):
        versions = ['0.11.9', '0.11.10', '0.9.0', '0.11.2']
        self.assertEqual(
            sorted(versions, key=mr.semver_sort_key, reverse=True),
            ['0.11.10', '0.11.9', '0.11.2', '0.9.0'],
        )

    def test_release_ranks_above_its_prereleases(self):
        versions = ['0.12.0-rc.1', '0.12.0', '0.12.0-beta.2']
        self.assertEqual(
            sorted(versions, key=mr.semver_sort_key, reverse=True),
            ['0.12.0', '0.12.0-rc.1', '0.12.0-beta.2'],
        )

    def test_numeric_prerelease_id_sorts_below_alphanumeric(self):
        versions = ['0.12.0-rc.1', '0.12.0-rc.beta']
        self.assertEqual(
            sorted(versions, key=mr.semver_sort_key, reverse=True),
            ['0.12.0-rc.beta', '0.12.0-rc.1'],
        )

    def test_unrankable_names_have_no_key(self):
        for name in ('nightly', 'v0.11.8', '0.11', '0.11.8.1', ''):
            self.assertIsNone(mr.semver_sort_key(name), name)


def index_of(*versions):
    entries = {}
    for version in versions:
        channel = 'prerelease' if '-' in version else 'stable'
        tag = f'v{version}'
        entries[version] = {'tag': tag, 'channel': channel, 'assets': ['a.bin']}
    return entries


class RetentionTests(unittest.TestCase):
    def test_keep_is_applied_per_channel(self):
        versions = index_of(
            '0.9.0', '0.10.0', '0.11.0', '0.12.0-rc.1', '0.12.0-rc.2', '0.12.0-rc.3',
        )
        plan = mr.plan_retention(versions, 2, 'v0.11.0')
        self.assertEqual(plan['kept']['stable'], ['0.11.0', '0.10.0'])
        self.assertEqual(plan['kept']['prerelease'], ['0.12.0-rc.3', '0.12.0-rc.2'])
        self.assertEqual(
            sorted(version for version, _, _ in plan['candidates']),
            ['0.12.0-rc.1', '0.9.0'],
        )

    def test_current_tag_is_kept_even_below_the_cutoff(self):
        # A backfill of an old tag must never prune the version it publishes.
        versions = index_of('0.9.0', '0.10.0', '0.11.0')
        plan = mr.plan_retention(versions, 1, 'v0.9.0')
        self.assertIn('0.9.0', plan['kept']['stable'])
        self.assertEqual(
            sorted(version for version, _, _ in plan['candidates']),
            ['0.10.0'],
        )

    def test_unrankable_versions_are_never_candidates(self):
        versions = index_of('0.10.0', '0.11.0')
        versions['nightly'] = {'tag': 'nightly', 'channel': 'stable'}
        plan = mr.plan_retention(versions, 1, 'v0.11.0')
        self.assertEqual(plan['unranked'], ['nightly'])
        self.assertEqual([version for version, _, _ in plan['candidates']], ['0.10.0'])

    def test_missing_channel_falls_back_to_the_version_shape(self):
        plan = mr.plan_retention({'0.12.0-rc.1': {'tag': 'v0.12.0-rc.1'}}, 5, 'v1.0.0')
        self.assertEqual(plan['kept']['prerelease'], ['0.12.0-rc.1'])
        self.assertEqual(plan['kept']['stable'], [])

    def test_candidate_prefix_uses_the_tag_for_prereleases(self):
        self.assertEqual(
            mr.candidate_prefix('0.11.0', 'stable'), 'releases/archive/0.11.0/'
        )
        self.assertEqual(
            mr.candidate_prefix('v0.12.0-rc.1', 'prerelease'),
            'releases/prerelease/v0.12.0-rc.1/',
        )


class DeleteGuardTests(unittest.TestCase):
    def test_allowed_prefixes(self):
        for path in (
            'releases/archive/0.10.0/latest.yml',
            'releases/prerelease/v0.12.0-rc.1/DSH-APP.dmg',
            'releases/archive/0.10.0/nested/dir/asset.bin',
        ):
            self.assertTrue(mr.deletion_allowed(path)[0], path)

    def test_everything_else_is_refused(self):
        for path in (
            'releases/latest/latest.yml',
            'releases/versions.json',
            'releases/archive',
            'releases/archive/',
            '.gitattributes',
            'README.md',
            'configuration.json',
            '/releases/archive/0.10.0/a.bin',
            'releases/archive/../latest/latest.yml',
            'releases\\archive\\0.10.0\\a.bin',
            'releases/archive/0.10.0/',
            '',
        ):
            self.assertFalse(mr.deletion_allowed(path)[0], path)

    def test_refusal_reason_is_reported(self):
        self.assertIn('latest', mr.deletion_allowed('releases/latest/latest.yml')[1])
        self.assertIn('never deleted', mr.deletion_allowed('releases/versions.json')[1])
        self.assertIn('outside releases/archive/', mr.deletion_allowed('README.md')[1])


class DeletePlanTests(unittest.TestCase):
    def setUp(self):
        self.versions = index_of('0.9.0', '0.10.0', '0.11.0')
        self.plan = mr.plan_retention(self.versions, 2, 'v0.11.0')

    def test_plan_counts_assets_and_bytes(self):
        remote = [
            {'path': 'releases/archive/0.9.0/a.bin', 'size': 100},
            {'path': 'releases/archive/0.9.0/b.bin', 'size': 200},
            {'path': 'releases/archive/0.11.0/a.bin', 'size': 999},
        ]
        entries, refusals = mr.build_delete_plan(
            self.plan['candidates'], remote, 'v0.11.0'
        )
        self.assertEqual(refusals, [])
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]['prefix'], 'releases/archive/0.9.0/')
        self.assertEqual(len(entries[0]['paths']), 2)
        self.assertEqual(entries[0]['bytes'], 300)

    def test_missing_remote_dir_still_removes_the_index_entry(self):
        entries, refusals = mr.build_delete_plan(
            self.plan['candidates'], [], 'v0.11.0'
        )
        self.assertEqual(refusals, [])
        self.assertEqual(entries[0]['paths'], [])
        self.assertEqual(entries[0]['bytes'], 0)

    def test_unsafe_version_name_is_refused(self):
        candidates = [('../latest', 'stable', {'tag': 'v../latest'})]
        entries, refusals = mr.build_delete_plan(candidates, [], 'v0.11.0')
        self.assertEqual(entries, [])
        self.assertEqual(len(refusals), 1)

    def test_current_tag_is_never_a_candidate(self):
        candidates = [('0.11.0', 'stable', {'tag': 'v0.11.0'})]
        entries, refusals = mr.build_delete_plan(candidates, [], 'v0.11.0')
        self.assertEqual((entries, refusals), ([], []))

    def test_odd_remote_path_under_a_candidate_is_refused(self):
        remote = [
            {'path': 'releases/archive/0.9.0/a.bin', 'size': 1},
            {'path': 'releases/archive/0.9.0/../../latest/latest.yml', 'size': 1},
        ]
        entries, refusals = mr.build_delete_plan(
            self.plan['candidates'], remote, 'v0.11.0'
        )
        self.assertEqual(entries, [])
        self.assertEqual(len(refusals), 1)

    def test_human_bytes(self):
        self.assertEqual(mr.human_bytes(0), '0 B')
        self.assertEqual(mr.human_bytes(2048), '2.0 KB')
        self.assertEqual(mr.human_bytes(5 * 1024 ** 3), '5.0 GB')


class ConfigTests(unittest.TestCase):
    base_env = {
        'MODELSCOPE_TOKEN': 'token-value',
        'GITHUB_REPOSITORY': 'JochenYang/dsh-app',
        'MODELSCOPE_REPO': 'jochenYang/dsh-app',
    }

    def test_defaults(self):
        with mock.patch.dict(os.environ, self.base_env, clear=True):
            cfg = mr.Config.from_env()
        self.assertEqual(cfg.keep_versions, 10)
        self.assertEqual(cfg.prune_mode, 'apply')
        self.assertEqual(cfg.endpoint, 'https://www.modelscope.cn')

    def test_invalid_keep_versions_is_rejected(self):
        env = dict(self.base_env, KEEP_VERSIONS='two')
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(mr.MirrorError):
                mr.Config.from_env()

    def test_zero_keep_versions_is_rejected(self):
        env = dict(self.base_env, KEEP_VERSIONS='0')
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(mr.MirrorError):
                mr.Config.from_env()

    def test_unknown_prune_mode_is_rejected(self):
        env = dict(self.base_env, PRUNE_MODE='delete-everything')
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(mr.MirrorError):
                mr.Config.from_env()

    def test_token_is_redacted(self):
        with mock.patch.dict(os.environ, self.base_env, clear=True):
            cfg = mr.Config.from_env()
        self.assertNotIn('token-value', cfg.redact('boom token-value boom'))


class ApplyPruneTests(unittest.TestCase):
    """One version per atomic commit: a failure must not block the rest."""

    def setUp(self):
        self.cfg = mr.Config(
            endpoint='https://example.invalid',
            repo='owner/repo',
            token='token-value',
            gh_repo='owner/repo',
            tag='v0.11.0',
            only_pattern='',
            keep_versions=1,
            prune_mode='apply',
        )

    @staticmethod
    def entry(version, paths):
        return {
            'version': version,
            'channel': 'stable',
            'tag': f'v{version}',
            'prefix': f'releases/archive/{version}/',
            'paths': paths,
            'bytes': len(paths),
        }

    def test_one_failure_does_not_block_the_other_version(self):
        calls = []

        class FakeApi:
            def delete_files(self, **kwargs):
                calls.append(kwargs['file_paths'])
                if len(calls) == 1:
                    raise RuntimeError('boom')
                return {'deleted_files': kwargs['file_paths'], 'failed_files': []}

        outcome = mr.apply_prune(
            self.cfg,
            FakeApi(),
            [self.entry('0.9.0', ['a']), self.entry('0.8.0', ['b'])],
        )
        self.assertEqual(len(calls), 2)
        self.assertEqual([item['version'] for item in outcome['deleted']], ['0.8.0'])
        self.assertEqual([version for version, _ in outcome['failed']], ['0.9.0'])
        self.assertIn('boom', outcome['failed'][0][1])

    def test_failed_files_from_the_sdk_count_as_a_failure(self):
        class FakeApi:
            def delete_files(self, **kwargs):
                return {'deleted_files': [], 'failed_files': kwargs['file_paths']}

        outcome = mr.apply_prune(self.cfg, FakeApi(), [self.entry('0.9.0', ['a'])])
        self.assertEqual(outcome['deleted'], [])
        self.assertEqual(len(outcome['failed']), 1)

    def test_missing_remote_file_drops_the_entry_without_calling_the_sdk(self):
        class FakeApi:
            def delete_files(self, **kwargs):
                raise AssertionError('must not be called for an empty path list')

        outcome = mr.apply_prune(self.cfg, FakeApi(), [self.entry('0.9.0', [])])
        self.assertEqual([item['version'] for item in outcome['deleted']], ['0.9.0'])
        self.assertEqual(outcome['failed'], [])

    def test_token_is_redacted_in_a_failure_reason(self):
        class FakeApi:
            def delete_files(self, **kwargs):
                raise RuntimeError('rejected with token-value in the message')

        outcome = mr.apply_prune(self.cfg, FakeApi(), [self.entry('0.9.0', ['a'])])
        self.assertNotIn('token-value', outcome['failed'][0][1])


class LatestCleanupGuardTests(unittest.TestCase):
    """The releases/latest/ cleanup has its own, narrower allowlist."""

    def test_accepts_exactly_one_asset_file_below_latest(self):
        for path in (
            'releases/latest/latest.yml',
            'releases/latest/latest-linux-arm64.yml',
            'releases/latest/DSH-APP-0.11.8-win-x64.exe',
            'releases/latest/DSH-APP-0.11.8-win-x64.exe.blockmap',
            'releases/latest/dsh-app_0.11.8_amd64.deb',
            'releases/latest/DSH.APP-0.11.8-mac.zip.blockmap',
        ):
            self.assertTrue(mr.latest_cleanup_allowed(path)[0], path)

    def test_everything_else_is_refused(self):
        for path in (
            'releases/latest/0.11.6/DSH-APP-win-x64.exe',
            'releases/latest/a/b.bin',
            'releases/latest/../latest.yml',
            'releases/latest/..',
            'releases/latest/',
            'releases/latest/.hidden',
            'releases/latest',
            'releases/archive/0.10.0/a.bin',
            'releases/prerelease/v0.12.0-rc.1/a.bin',
            'releases/versions.json',
            '/releases/latest/latest.yml',
            'releases\\latest\\latest.yml',
            '',
        ):
            self.assertFalse(mr.latest_cleanup_allowed(path)[0], path)

    def test_refusal_reason_is_reported(self):
        self.assertIn(
            'not below releases/latest/',
            mr.latest_cleanup_allowed('releases/archive/0.10.0/a.bin')[1],
        )
        self.assertIn(
            'not subdirectories',
            mr.latest_cleanup_allowed('releases/latest/a/b.bin')[1],
        )


class LatestCleanupPlanTests(unittest.TestCase):
    def remote(self):
        return [
            {'path': 'releases/latest/DSH-APP-0.11.8-win-x64.exe', 'size': 10},
            {'path': 'releases/latest/latest.yml', 'size': 1},
            {'path': 'releases/latest/DSH-APP-0.11.6-win-x64.exe', 'size': 20},
            {'path': 'releases/latest/DSH-APP-0.11.7-win-x64.exe', 'size': 30},
            {'path': 'releases/archive/0.11.6/DSH-APP-0.11.6-win-x64.exe', 'size': 20},
            {'path': 'releases/versions.json', 'size': 1},
        ]

    def test_whitelisted_names_are_kept_and_history_is_deleted(self):
        plan = mr.build_latest_cleanup_plan(
            self.remote(),
            ['DSH-APP-0.11.8-win-x64.exe', 'latest.yml'],
        )
        self.assertEqual(
            [item['path'] for item in plan['keep']],
            ['releases/latest/DSH-APP-0.11.8-win-x64.exe', 'releases/latest/latest.yml'],
        )
        self.assertEqual(
            [item['path'] for item in plan['delete']],
            [
                'releases/latest/DSH-APP-0.11.6-win-x64.exe',
                'releases/latest/DSH-APP-0.11.7-win-x64.exe',
            ],
        )
        self.assertEqual(plan['bytes'], 50)
        self.assertEqual(plan['refusals'], [])
        self.assertIsNone(plan['skipped'])

    def test_latest_metadata_is_kept_when_it_belongs_to_the_release(self):
        plan = mr.build_latest_cleanup_plan(self.remote(), ['latest.yml'])
        self.assertIn('releases/latest/latest.yml', [item['path'] for item in plan['keep']])
        self.assertNotIn('releases/latest/latest.yml', [item['path'] for item in plan['delete']])

    def test_archive_and_index_paths_are_never_candidates(self):
        plan = mr.build_latest_cleanup_plan(self.remote(), ['latest.yml'])
        paths = [item['path'] for item in plan['delete']]
        self.assertNotIn('releases/archive/0.11.6/DSH-APP-0.11.6-win-x64.exe', paths)
        self.assertNotIn('releases/versions.json', paths)

    def test_a_rejected_path_is_a_refusal_not_a_deletion(self):
        remote = [{'path': 'releases/latest/../secret', 'size': 1}]
        plan = mr.build_latest_cleanup_plan(remote, [])
        self.assertEqual(plan['delete'], [])
        self.assertEqual(len(plan['refusals']), 1)

    def test_nothing_stale_yields_no_deletions(self):
        plan = mr.build_latest_cleanup_plan(
            [{'path': 'releases/latest/latest.yml', 'size': 1}], ['latest.yml']
        )
        self.assertEqual(plan['delete'], [])
        self.assertEqual(plan['refusals'], [])

    def test_upload_failure_yields_an_empty_plan(self):
        # Ordering guard: a failed upload/index commit must never strip the
        # working copy the updater reads first.
        plan = mr.build_latest_cleanup_plan(self.remote(), ['latest.yml'], upload_ok=False)
        self.assertEqual(plan['delete'], [])
        self.assertEqual(plan['keep'], [])
        self.assertEqual(plan['bytes'], 0)
        self.assertTrue(plan['skipped'])


class LatestCleanupApplyTests(unittest.TestCase):
    def setUp(self):
        self.cfg = mr.Config(
            endpoint='https://example.invalid',
            repo='owner/repo',
            token='token-value',
            gh_repo='owner/repo',
            tag='v0.11.8',
            only_pattern='',
            keep_versions=10,
            prune_mode='apply',
        )

    @staticmethod
    def plan(paths):
        return {
            'keep': [],
            'delete': [
                {'path': path, 'size': index + 1} for index, path in enumerate(paths)
            ],
            'bytes': sum(index + 1 for index, _ in enumerate(paths)),
            'refusals': [],
            'skipped': None,
        }

    def test_dry_run_never_calls_delete(self):
        class FakeApi:
            def delete_files(self, **kwargs):
                raise AssertionError('dry-run must not delete anything')

        plan = self.plan(['releases/latest/DSH-APP-0.11.6-win-x64.exe'])
        self.assertIsNone(mr.run_latest_cleanup(self.cfg, FakeApi(), plan, dry_run=True))
        self.assertIn(
            '- Dry run: no file was deleted',
            mr.summary_latest_lines(plan, dry_run=True),
        )

    def test_one_commit_deletes_every_stale_file(self):
        calls = []

        class FakeApi:
            def delete_files(self, **kwargs):
                calls.append(kwargs['file_paths'])
                return {'deleted_files': kwargs['file_paths'], 'failed_files': []}

        paths = ['releases/latest/a.exe', 'releases/latest/b.exe']
        outcome = mr.run_latest_cleanup(self.cfg, FakeApi(), self.plan(paths), dry_run=False)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0], paths)
        self.assertEqual(outcome['deleted'], paths)
        self.assertEqual(outcome['failed'], [])

    def test_failed_files_are_recorded_without_aborting(self):
        class FakeApi:
            def delete_files(self, **kwargs):
                return {
                    'deleted_files': kwargs['file_paths'][1:],
                    'failed_files': kwargs['file_paths'][:1],
                }

        paths = ['releases/latest/a.exe', 'releases/latest/b.exe']
        outcome = mr.run_latest_cleanup(self.cfg, FakeApi(), self.plan(paths), dry_run=False)
        self.assertEqual(outcome['deleted'], paths[1:])
        self.assertEqual([path for path, _ in outcome['failed']], paths[:1])

    def test_a_delete_error_is_reported_not_raised(self):
        class FakeApi:
            def delete_files(self, **kwargs):
                raise RuntimeError('boom token-value')

        outcome = mr.run_latest_cleanup(
            self.cfg, FakeApi(), self.plan(['releases/latest/a.exe']), dry_run=False
        )
        self.assertEqual(len(outcome['failed']), 1)
        self.assertNotIn('token-value', outcome['failed'][0][1])


# ----------------------------------------------------------------------
# Kernel runtime assets (releases/runtime/<tag>/)
# ----------------------------------------------------------------------
class RuntimeTagTests(unittest.TestCase):
    def test_runtime_tags_are_recognized_and_version_extracted(self):
        self.assertTrue(mr.is_runtime_tag('runtime-0.1.5-rc.2'))
        self.assertEqual(mr.runtime_version_of('runtime-0.1.5-rc.2'), '0.1.5-rc.2')
        self.assertFalse(mr.is_runtime_tag('v0.11.8'))
        self.assertFalse(mr.is_runtime_tag(''))

    def test_the_two_tag_shapes_are_mutually_exclusive(self):
        # A runtime tag must not look like a shell tag, and vice versa: the
        # dispatch in subcommand_mirror() keys on exactly this.
        self.assertFalse(mr.is_runtime_tag('v0.11.8'))
        self.assertFalse('v0.11.8'.startswith(mr.RUNTIME_TAG_PREFIX))
        runtime = 'runtime-0.1.5-rc.2'
        self.assertTrue(mr.is_runtime_tag(runtime))
        self.assertFalse(runtime.startswith('v'))


class RuntimeAssetShapeTests(unittest.TestCase):
    def test_a_complete_two_cell_set_has_no_problems(self):
        names = runtime_asset_names('0.1.5-rc.2')
        self.assertEqual(mr.runtime_asset_problems(names, '0.1.5-rc.2'), [])

    def test_a_missing_sidecar_is_a_problem(self):
        names = [name for name in runtime_asset_names('0.1.5-rc.2') if not name.endswith('.sha512')]
        problems = mr.runtime_asset_problems(names, '0.1.5-rc.2')
        self.assertTrue(any('no .sha512 sidecar' in problem for problem in problems))

    def test_an_asset_of_another_version_is_a_problem(self):
        names = runtime_asset_names('0.1.4') + runtime_asset_names('0.1.5-rc.2')
        problems = mr.runtime_asset_problems(names, '0.1.5-rc.2')
        self.assertTrue(any('does not carry the version' in problem for problem in problems))

    def test_a_set_without_an_archive_or_manifest_is_a_problem(self):
        problems = mr.runtime_asset_problems(['manifest-win32-x64.json'], '0.1.5-rc.2')
        self.assertTrue(any('no *.tgz asset' in problem for problem in problems))
        problems = mr.runtime_asset_problems(['dsh-runtime-win32-x64-0.1.5-rc.2.tgz'], '0.1.5-rc.2')
        self.assertTrue(any('no manifest-' in problem for problem in problems))

    def test_the_platform_list_catches_a_half_uploaded_matrix(self):
        # Every shape is present, so only the matrix list can tell that this
        # mirror would answer 404 for four of the six cells the app resolves.
        names = runtime_asset_names('0.1.5-rc.2', ('win32-x64', 'linux-x64'))
        self.assertEqual(mr.runtime_asset_problems(names, '0.1.5-rc.2'), [])
        problems = mr.runtime_asset_problems(names, '0.1.5-rc.2', RUNTIME_PLATFORMS)
        self.assertEqual(len(problems), 12)
        self.assertTrue(all(problem.startswith('missing ') for problem in problems))

    def test_a_complete_matrix_has_no_problems(self):
        names = runtime_asset_names('0.1.5-rc.2', RUNTIME_PLATFORMS)
        self.assertEqual(mr.runtime_asset_problems(names, '0.1.5-rc.2', RUNTIME_PLATFORMS), [])

    def test_layer_assets_are_exempt_from_the_single_tarball_rules(self):
        # Layer files are content/suite-addressed (no dsh version suffix) and
        # carry no sidecar: the per-cell index carries their digests instead.
        assets = runtime_layer_assets(('win32-x64',))
        names = runtime_asset_names('0.1.5-rc.2', ('win32-x64',)) + list(assets)
        self.assertEqual(mr.runtime_asset_problems(names, '0.1.5-rc.2'), [])
        # ... but they never satisfy "an archive is present" on their own.
        problems = mr.runtime_asset_problems(list(assets), '0.1.5-rc.2')
        self.assertTrue(any('no *.tgz asset' in problem for problem in problems))


class RuntimeLayerAssetTests(unittest.TestCase):
    """The split-layer half of the runtime completeness check."""

    def test_a_complete_layer_set_has_no_problems(self):
        assets = runtime_layer_assets()
        problems = mr.runtime_layer_problems(
            list(assets), mr.read_layer_indexes(self.dir_with(assets), list(assets))
        )
        self.assertEqual(problems, [])

    def test_no_layer_assets_at_all_is_not_a_problem(self):
        # Every runtime published before the split has none, and the app falls
        # back to the single tarball: requiring layers would refuse those.
        self.assertEqual(mr.runtime_layer_problems(runtime_asset_names('0.1.5-rc.2'), {}), [])

    def test_an_index_naming_an_absent_layer_is_a_problem(self):
        assets = runtime_layer_assets(('win32-x64',))
        del assets['node-9ab12cd34ef5-win32-x64.tgz']
        names = list(assets)
        problems = mr.runtime_layer_problems(names, mr.read_layer_indexes(self.dir_with(assets), names))
        self.assertEqual(len(problems), 1)
        self.assertIn('which the release does not carry', problems[0])

    def test_an_unreadable_index_is_a_problem(self):
        assets = runtime_layer_assets(('win32-x64',))
        assets['layers-win32-x64.json'] = '{ not json'
        names = list(assets)
        problems = mr.runtime_layer_problems(names, mr.read_layer_indexes(self.dir_with(assets), names))
        self.assertTrue(any('is not readable JSON' in problem for problem in problems))

    def test_an_index_labelled_with_the_wrong_cell_is_a_problem(self):
        assets = runtime_layer_assets(('win32-x64',))
        body = json.loads(assets['layers-win32-x64.json'])
        body['arch'] = 'arm64'
        assets['layers-win32-x64.json'] = json.dumps(body)
        names = list(assets)
        problems = mr.runtime_layer_problems(names, mr.read_layer_indexes(self.dir_with(assets), names))
        self.assertTrue(any('describes win32-arm64' in problem for problem in problems))

    def test_an_index_outside_the_matrix_is_a_problem(self):
        assets = runtime_layer_assets(('linux-s390x',))
        names = list(assets)
        problems = mr.runtime_layer_problems(
            names, mr.read_layer_indexes(self.dir_with(assets), names), RUNTIME_PLATFORMS
        )
        self.assertTrue(any('is not one of the runtime cells' in problem for problem in problems))

    def test_a_layer_file_no_index_names_is_a_problem(self):
        # Half-uploaded cell: the layers arrived, the index did not.
        assets = runtime_layer_assets(('win32-x64',))
        del assets['layers-win32-x64.json']
        names = list(assets)
        problems = mr.runtime_layer_problems(names, mr.read_layer_indexes(self.dir_with(assets), names))
        self.assertEqual(len(problems), 5)
        self.assertTrue(all('is not named by any layer index' in problem for problem in problems))

    def test_an_index_with_no_layers_is_a_problem(self):
        assets = {'layers-win32-x64.json': json.dumps({'platform': 'win32', 'arch': 'x64', 'layers': []})}
        names = list(assets)
        problems = mr.runtime_layer_problems(names, mr.read_layer_indexes(self.dir_with(assets), names))
        self.assertTrue(any('names no layers' in problem for problem in problems))

    def dir_with(self, assets):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        directory = Path(tmp.name)
        for name, body in assets.items():
            (directory / name).write_text(body, encoding='utf-8')
        return directory


class RuntimeRetentionTests(unittest.TestCase):
    def test_keep_window_prunes_the_oldest_beyond_it(self):
        inventory = runtime_inventory('0.1.1', '0.1.2', '0.1.3', '0.1.4')
        plan = mr.plan_runtime_retention(inventory, 3, 'runtime-0.1.4')
        self.assertEqual(plan['kept'], ['runtime-0.1.4', 'runtime-0.1.3', 'runtime-0.1.2'])
        self.assertEqual(plan['candidates'], ['runtime-0.1.1'])

    def test_the_published_tag_is_kept_even_below_the_cutoff(self):
        # A backfill of an older kernel line must not delete what it published.
        inventory = runtime_inventory('0.1.1', '0.1.2', '0.1.3', '0.1.4')
        plan = mr.plan_runtime_retention(inventory, 1, 'runtime-0.1.1')
        self.assertIn('runtime-0.1.1', plan['kept'])
        self.assertEqual(sorted(plan['candidates']), ['runtime-0.1.2', 'runtime-0.1.3'])

    def test_one_window_covers_stable_and_prerelease_alike(self):
        inventory = runtime_inventory('0.1.2', '0.1.3', '0.1.4', '0.1.5-rc.1')
        plan = mr.plan_runtime_retention(inventory, 2, 'runtime-0.1.5-rc.1')
        self.assertEqual(sorted(plan['kept']), ['runtime-0.1.4', 'runtime-0.1.5-rc.1'])
        self.assertEqual(sorted(plan['candidates']), ['runtime-0.1.2', 'runtime-0.1.3'])

    def test_unrankable_directories_and_stray_files_are_never_candidates(self):
        inventory = runtime_inventory('0.1.1', '0.1.2') + [
            {'path': 'releases/runtime/nightly/dsh-runtime-win32-x64-nightly.tgz', 'size': 1},
            {'path': 'releases/runtime/manifest.json', 'size': 1},
            # A semver-shaped directory without the runtime- prefix is not a
            # shape this script writes; it is reported, not ranked or deleted.
            {'path': 'releases/runtime/0.0.1/dsh-runtime-win32-x64-0.0.1.tgz', 'size': 1},
        ]
        plan = mr.plan_runtime_retention(inventory, 1, 'runtime-0.1.2')
        self.assertEqual(plan['unranked'], ['0.0.1', 'nightly'])
        self.assertEqual(plan['strays'], ['releases/runtime/manifest.json'])
        self.assertEqual(plan['candidates'], ['runtime-0.1.1'])

    def test_shell_versions_are_invisible_to_the_runtime_window(self):
        # Isolation in the ranking direction: a shell inventory ranks nothing,
        # so a shell-only listing can never produce a runtime delete list.
        shell = [
            {'path': 'releases/archive/0.10.0/DSH-APP-0.10.0-win-x64.exe', 'size': 1},
            {'path': 'releases/latest/latest.yml', 'size': 1},
            {'path': 'releases/versions.json', 'size': 1},
            {'path': 'releases/prerelease/v0.12.0-rc.1/a.bin', 'size': 1},
        ]
        plan = mr.plan_runtime_retention(shell, 1, 'runtime-0.1.5-rc.2')
        self.assertEqual(plan['kept'], [])
        self.assertEqual(plan['candidates'], [])
        self.assertEqual(plan['unranked'], [])
        entries, refusals = mr.build_runtime_delete_plan(
            plan['candidates'], shell, 'runtime-0.1.5-rc.2'
        )
        self.assertEqual((entries, refusals), ([], []))


class RuntimeDeletePlanTests(unittest.TestCase):
    def test_delete_entries_carry_the_runtime_prefix_and_counts(self):
        inventory = runtime_inventory('0.1.1', '0.1.2')
        plan = mr.plan_runtime_retention(inventory, 1, 'runtime-0.1.2')
        entries, refusals = mr.build_runtime_delete_plan(
            plan['candidates'], inventory, 'runtime-0.1.2'
        )
        self.assertEqual(refusals, [])
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]['prefix'], 'releases/runtime/runtime-0.1.1/')
        self.assertEqual(entries[0]['version'], '0.1.1')
        self.assertEqual(len(entries[0]['paths']), 6)
        self.assertEqual(entries[0]['bytes'], 60)

    def test_a_traversing_path_under_a_candidate_is_refused(self):
        inventory = runtime_inventory('0.1.1', '0.1.2') + [
            {'path': 'releases/runtime/runtime-0.1.1/../../latest/latest.yml', 'size': 1},
        ]
        entries, refusals = mr.build_runtime_delete_plan(
            ['runtime-0.1.1'], inventory, 'runtime-0.1.2'
        )
        self.assertEqual(entries, [])
        self.assertEqual(len(refusals), 1)
        self.assertIn('unexpected path segment', refusals[0][1])

    def test_a_nested_path_under_a_candidate_is_refused(self):
        inventory = [{'path': 'releases/runtime/runtime-0.1.1/nested/a.tgz', 'size': 1}]
        entries, refusals = mr.build_runtime_delete_plan(
            ['runtime-0.1.1'], inventory, 'runtime-0.1.2'
        )
        self.assertEqual(entries, [])
        self.assertIn('expected exactly', refusals[0][1])

    def test_an_unsafe_candidate_name_is_refused(self):
        entries, refusals = mr.build_runtime_delete_plan(
            ['runtime-../latest'], [], 'runtime-0.1.2'
        )
        self.assertEqual(entries, [])
        self.assertEqual(len(refusals), 1)

    def test_the_published_tag_is_never_a_candidate(self):
        entries, refusals = mr.build_runtime_delete_plan(
            ['runtime-0.1.2'], runtime_inventory('0.1.2'), 'runtime-0.1.2'
        )
        self.assertEqual((entries, refusals), ([], []))


class RuntimeAllowlistTests(unittest.TestCase):
    """The two allowlists are disjoint by construction, not by convention."""

    def test_the_shell_and_runtime_prefixes_never_overlap(self):
        for prefix in mr.RUNTIME_DELETABLE_PREFIXES:
            self.assertEqual(prefix, mr.RUNTIME_PREFIX)
            self.assertNotIn(prefix, mr.DELETABLE_PREFIXES)
            for shell in mr.DELETABLE_PREFIXES:
                self.assertFalse(prefix.startswith(shell))
                self.assertFalse(shell.startswith(prefix))

    def test_neither_allowlist_names_the_index_or_the_rolling_copy(self):
        for prefix in mr.DELETABLE_PREFIXES + mr.RUNTIME_DELETABLE_PREFIXES:
            self.assertFalse(prefix.startswith(mr.LATEST_PREFIX))
            self.assertNotEqual(prefix.rstrip('/'), mr.VERSIONS_PATH)


class RuntimeBoundsTests(unittest.TestCase):
    """Anything the runtime policy cannot place aborts the run, never deletes."""

    OUT_OF_BOUNDS = (
        'releases/latest/DSH-APP-0.11.8-win-x64.exe',
        'releases/archive/0.10.0/DSH-APP-0.10.0-win-x64.exe',
        'releases/prerelease/v0.12.0-rc.1/DSH-APP.dmg',
        'releases/versions.json',
        '.gitattributes',
        'README.md',
        'configuration.json',
        'releases/runtime/runtime-0.1.1/../../latest/x.exe',
        'releases/runtime/../latest/x.exe',
        'releases/runtime/runtime-0.1.1/nested/x.tgz',
        'releases/runtime/runtime-0.1.1/',
        'releases/runtime/',
        'releases/runtime',
        'releases/.runtime/runtime-0.1.1/a.tgz',
        '/releases/runtime/runtime-0.1.1/a.tgz',
        'releases\\runtime\\runtime-0.1.1\\a.tgz',
        '',
    )

    def test_the_flat_runtime_asset_paths_are_accepted(self):
        for name in (
            'dsh-runtime-win32-x64-0.1.5-rc.2.tgz',
            'dsh-runtime-win32-x64-0.1.5-rc.2.tgz.sha512',
            'manifest-win32-x64.json',
        ):
            path = f'releases/runtime/runtime-0.1.5-rc.2/{name}'
            self.assertTrue(mr.runtime_deletion_allowed(path)[0], path)

    def test_every_other_shape_is_refused_with_a_reason(self):
        for path in self.OUT_OF_BOUNDS:
            allowed, reason = mr.runtime_deletion_allowed(path)
            self.assertFalse(allowed, path)
            self.assertTrue(reason, path)

    def test_the_shell_guards_cannot_reach_runtime_paths(self):
        # The other direction of the isolation: no shell rule (version
        # retention or latest cleanup) may ever name a runtime asset.
        for path in (
            'releases/runtime/runtime-0.1.5-rc.2/dsh-runtime-win32-x64-0.1.5-rc.2.tgz',
            'releases/runtime/runtime-0.1.5-rc.2/manifest-win32-x64.json',
        ):
            self.assertFalse(mr.deletion_allowed(path)[0], path)
            self.assertFalse(mr.latest_cleanup_allowed(path)[0], path)

    def test_the_runtime_guard_cannot_reach_shell_paths(self):
        for path in (
            'releases/archive/0.10.0/DSH-APP-0.10.0-win-x64.exe',
            'releases/prerelease/v0.12.0-rc.1/a.bin',
            'releases/latest/latest.yml',
            'releases/versions.json',
            'releases/runtime-lookalike/x.tgz',
        ):
            self.assertFalse(mr.runtime_deletion_allowed(path)[0], path)

    def test_a_clean_delete_list_passes_the_guard(self):
        self.assertIsNone(mr.guard_runtime_entries([
            {'paths': ['releases/runtime/runtime-0.1.1/dsh-runtime-win32-x64-0.1.1.tgz']},
        ]))

    def test_a_poisoned_delete_list_aborts(self):
        for bad in (
            'releases/latest/x.exe',
            'releases/archive/0.10.0/x',
            '.gitattributes',
            'releases/runtime/runtime-0.1.1/../../latest/x.exe',
        ):
            with self.assertRaises(mr.MirrorError) as raised:
                mr.guard_runtime_entries([{'paths': [bad]}])
            self.assertIn('runtime', str(raised.exception))

    def test_apply_refuses_before_the_first_delete(self):
        # A poisoned later entry must not be preceded by deletions that already
        # happened: the whole list is validated up front.
        calls = []

        class FakeApi:
            def delete_files(self, **kwargs):
                calls.append(kwargs['file_paths'])
                return {'deleted_files': kwargs['file_paths'], 'failed_files': []}

        cfg = mr.Config(
            endpoint='https://example.invalid',
            repo='owner/repo',
            token='token-value',
            gh_repo='owner/repo',
            tag='runtime-0.1.5-rc.2',
            only_pattern='',
            keep_versions=10,
            prune_mode='apply',
            keep_runtime_versions=3,
        )
        good = {
            'version': '0.1.1',
            'tag': 'runtime-0.1.1',
            'prefix': 'releases/runtime/runtime-0.1.1/',
            'paths': ['releases/runtime/runtime-0.1.1/dsh-runtime-win32-x64-0.1.1.tgz'],
            'bytes': 1,
        }
        bad = dict(good, paths=['releases/latest/x.exe'])
        with self.assertRaises(mr.MirrorError):
            mr.apply_runtime_prune(cfg, FakeApi(), [good, bad])
        self.assertEqual(calls, [])


class RuntimePruneTests(unittest.TestCase):
    def setUp(self):
        self.cfg = mr.Config(
            endpoint='https://example.invalid',
            repo='owner/repo',
            token='token-value',
            gh_repo='owner/repo',
            tag='runtime-0.1.5-rc.2',
            only_pattern='',
            keep_versions=10,
            prune_mode='apply',
            keep_runtime_versions=3,
        )

    @staticmethod
    def entry(tag, paths):
        return {
            'version': mr.runtime_version_of(tag),
            'tag': tag,
            'prefix': f'releases/runtime/{tag}/',
            'paths': paths,
            'bytes': len(paths),
        }

    def test_one_version_per_commit_and_a_failure_does_not_block_the_rest(self):
        calls = []

        class FakeApi:
            def delete_files(self, **kwargs):
                calls.append(kwargs['file_paths'])
                if len(calls) == 1:
                    raise RuntimeError('boom token-value')
                return {'deleted_files': kwargs['file_paths'], 'failed_files': []}

        outcome = mr.apply_runtime_prune(
            self.cfg,
            FakeApi(),
            [
                self.entry('runtime-0.1.1', ['releases/runtime/runtime-0.1.1/a.tgz']),
                self.entry('runtime-0.1.0', ['releases/runtime/runtime-0.1.0/a.tgz']),
            ],
        )
        self.assertEqual(len(calls), 2)
        self.assertEqual([item['version'] for item in outcome['deleted']], ['0.1.0'])
        self.assertEqual([tag for tag, _ in outcome['failed']], ['runtime-0.1.1'])
        self.assertNotIn('token-value', outcome['failed'][0][1])

    def test_the_delete_commit_message_names_the_runtime_window(self):
        seen = {}

        class FakeApi:
            def delete_files(self, **kwargs):
                seen.update(kwargs)
                return {'deleted_files': kwargs['file_paths'], 'failed_files': []}

        mr.apply_runtime_prune(
            self.cfg,
            FakeApi(),
            [self.entry('runtime-0.1.1', ['releases/runtime/runtime-0.1.1/a.tgz'])],
        )
        self.assertIn('keep 3 runtime version(s)', seen['commit_message'])

    def test_an_empty_entry_calls_nothing(self):
        class FakeApi:
            def delete_files(self, **kwargs):
                raise AssertionError('must not be called for an empty path list')

        outcome = mr.apply_runtime_prune(self.cfg, FakeApi(), [self.entry('runtime-0.1.1', [])])
        self.assertEqual(outcome, {'deleted': [], 'failed': []})

    def test_the_summary_shows_kept_set_delete_list_and_action(self):
        plan = mr.plan_runtime_retention(
            runtime_inventory('0.1.1', '0.1.2', '0.1.3', '0.1.4'), 3, 'runtime-0.1.4'
        )
        entries, refusals = mr.build_runtime_delete_plan(
            plan['candidates'], runtime_inventory('0.1.1', '0.1.2', '0.1.3', '0.1.4'),
            'runtime-0.1.4',
        )
        lines = mr.summary_runtime_lines(
            plan, entries, refusals, outcome={'deleted': [{'version': '0.1.1'}], 'failed': []}
        )
        text = '\n'.join(lines)
        self.assertIn('Keep policy: newest `3` runtime version(s)', text)
        self.assertIn('Retained (3): runtime-0.1.4, runtime-0.1.3, runtime-0.1.2', text)
        self.assertIn('`releases/runtime/runtime-0.1.1/` - 6 file(s)', text)
        self.assertIn('Deleted (1): 0.1.1', text)

    def test_a_refusal_is_reported_and_no_deletion_is_claimed(self):
        plan = mr.plan_runtime_retention(runtime_inventory('0.1.1'), 1, 'runtime-0.1.4')
        lines = mr.summary_runtime_lines(plan, [], [('runtime-0.1.1', 'boom')])
        text = '\n'.join(lines)
        self.assertIn('REFUSED by the runtime whitelist (1)', text)
        self.assertIn('- No deletion was attempted', text)

    def test_a_dry_run_summary_claims_no_action(self):
        inventory = runtime_inventory('0.1.1', '0.1.2')
        plan = mr.plan_runtime_retention(inventory, 1, 'runtime-0.1.2')
        entries, refusals = mr.build_runtime_delete_plan(
            plan['candidates'], inventory, 'runtime-0.1.2'
        )
        self.assertEqual(len(entries), 1)
        lines = mr.summary_runtime_lines(plan, entries, refusals, dry_run=True)
        self.assertIn('#### Runtime prune (dry-run)', lines)
        self.assertIn('- Dry run: no file was deleted', lines)


class RuntimeMirrorFlowTests(unittest.TestCase):
    """subcommand_mirror_runtime against a fake SDK and a fake inventory."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.assets = self.root / 'release-assets'
        self.assets.mkdir()
        self.version = '0.1.5-rc.2'
        self.tag = f'runtime-{self.version}'
        self.write_assets(runtime_asset_names(self.version, RUNTIME_PLATFORMS))
        self.summary = self.root / 'summary.md'
        self.summary.write_text('', encoding='utf-8')
        previous = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)

    def write_assets(self, names):
        for name in names:
            (self.assets / name).write_text('x', encoding='utf-8')

    def write_asset_map(self, assets):
        """Write real bodies — an index has to be readable JSON to pass."""
        for name, body in assets.items():
            (self.assets / name).write_text(body, encoding='utf-8')

    def cfg(self, prune_mode='apply', only_pattern='', tag=None):
        return mr.Config(
            endpoint='https://example.invalid',
            repo='owner/repo',
            token='token-value',
            gh_repo='owner/repo',
            tag=tag or self.tag,
            only_pattern=only_pattern,
            keep_versions=10,
            prune_mode=prune_mode,
            keep_runtime_versions=3,
            runtime_platforms=RUNTIME_PLATFORMS,
        )

    def run_flow(self, api, inventory, prune_mode='apply', only_pattern='', tag=None):
        counts = {'inventory': 0}

        def fake_inventory(_api, _cfg):
            counts['inventory'] += 1
            return inventory

        with mock.patch.dict(
            os.environ, {'GITHUB_STEP_SUMMARY': str(self.summary)}, clear=False
        ), mock.patch.object(mr, 'load_modelscope_api', return_value=api), mock.patch.object(
            mr, 'fetch_remote_files', side_effect=fake_inventory
        ), mock.patch.object(
            mr, 'read_published_index',
            side_effect=AssertionError('a runtime mirror must not read versions.json'),
        ), mock.patch.object(
            mr, 'commit_index',
            side_effect=AssertionError('a runtime mirror must not write versions.json'),
        ), mock.patch.object(
            mr, 'apply_prune',
            side_effect=AssertionError('a runtime mirror must not use the shell prune'),
        ), mock.patch.object(
            mr, 'build_latest_cleanup_plan',
            side_effect=AssertionError('a runtime mirror must not plan a latest cleanup'),
        ), contextlib.redirect_stdout(io.StringIO()):
            mr.subcommand_mirror_runtime(
                self.cfg(prune_mode=prune_mode, only_pattern=only_pattern, tag=tag)
            )
        return counts

    def summary_text(self):
        return self.summary.read_text(encoding='utf-8')

    @staticmethod
    def api():
        class FakeApi:
            def __init__(self):
                self.uploads = []
                self.deletes = []

            def upload_folder(self, **kwargs):
                self.uploads.append(kwargs['path_in_repo'])
                return [{'ok': True}]

            def delete_files(self, **kwargs):
                self.deletes.append(list(kwargs['file_paths']))
                return {'deleted_files': kwargs['file_paths'], 'failed_files': []}

        return FakeApi()

    def test_assets_land_under_the_runtime_path_only(self):
        api = self.api()
        self.run_flow(api, runtime_inventory(self.version, platforms=RUNTIME_PLATFORMS))
        self.assertEqual(api.uploads, [f'releases/runtime/{self.tag}'])
        self.assertEqual(api.deletes, [])
        text = self.summary_text()
        self.assertIn(f'`releases/runtime/{self.tag}`', text)
        self.assertIn('`releases/versions.json` untouched', text)
        self.assertIn('`releases/latest/` untouched', text)
        self.assertNotIn('releases/latest/DSH', text)

    def test_a_release_carrying_layer_assets_mirrors_them_with_the_tarball(self):
        assets = runtime_layer_assets(RUNTIME_PLATFORMS)
        self.write_asset_map(assets)
        api = self.api()
        self.run_flow(api, runtime_inventory(self.version, platforms=RUNTIME_PLATFORMS))
        self.assertEqual(api.uploads, [f'releases/runtime/{self.tag}'])
        self.assertEqual(api.deletes, [])
        uploaded = {item.name for item in self.assets.iterdir()}
        self.assertIn('layers-win32-x64.json', uploaded, 'the per-cell index rides along')
        self.assertIn('node-9ab12cd34ef5-win32-x64.tgz', uploaded)

    def test_a_layer_index_naming_an_absent_layer_is_refused_before_uploading(self):
        assets = runtime_layer_assets(RUNTIME_PLATFORMS)
        del assets['node-9ab12cd34ef5-win32-x64.tgz']
        self.write_asset_map(assets)
        api = self.api()
        with self.assertRaises(mr.MirrorError) as raised:
            self.run_flow(api, runtime_inventory(self.version, platforms=RUNTIME_PLATFORMS))
        self.assertIn('which the release does not carry', str(raised.exception))
        self.assertEqual(api.uploads, [], 'nothing is uploaded from a set the client cannot use')

    def test_the_window_deletes_the_extra_version_and_keeps_the_published_one(self):
        api = self.api()
        inventory = runtime_inventory(
            '0.1.1', '0.1.2', '0.1.3', self.version, platforms=RUNTIME_PLATFORMS
        )
        self.run_flow(api, inventory)
        self.assertEqual(len(api.deletes), 1)
        self.assertTrue(all(
            path.startswith('releases/runtime/runtime-0.1.1/') for path in api.deletes[0]
        ))
        self.assertEqual(len(api.deletes[0]), len(runtime_asset_names('0.1.1', RUNTIME_PLATFORMS)))
        text = self.summary_text()
        self.assertIn(f'Retained (3): {self.tag}, runtime-0.1.3, runtime-0.1.2', text)
        self.assertIn('Deleted (1): 0.1.1', text)

    def test_prune_mode_off_deletes_nothing_and_does_not_even_list(self):
        api = self.api()
        counts = self.run_flow(
            api, runtime_inventory('0.1.1', '0.1.2', '0.1.3', self.version), prune_mode='off'
        )
        self.assertEqual(api.deletes, [])
        self.assertEqual(counts['inventory'], 0)
        self.assertIn('#### Runtime prune (off)', self.summary_text())
        self.assertIn('PRUNE_MODE=off', self.summary_text())

    def test_dry_run_reports_the_plan_without_writing_anything(self):
        api = self.api()
        counts = self.run_flow(
            api, runtime_inventory('0.1.1', '0.1.2', '0.1.3', self.version),
            prune_mode='dry-run',
        )
        self.assertEqual(counts['inventory'], 1)
        self.assertEqual(api.deletes, [])
        text = self.summary_text()
        self.assertIn('#### Runtime prune (dry-run)', text)
        self.assertIn('`releases/runtime/runtime-0.1.1/`', text)
        self.assertIn('- Dry run: no file was deleted', text)
        self.assertNotIn('Deleted (', text)

    def test_a_window_with_nothing_to_prune_deletes_nothing(self):
        api = self.api()
        self.run_flow(api, runtime_inventory('0.1.1', self.version))
        self.assertEqual(api.deletes, [])
        self.assertIn('Delete list: none', self.summary_text())

    def test_an_out_of_bounds_path_aborts_the_uploaded_run(self):
        api = self.api()
        # Four directories with a window of three, so runtime-0.1.1 is a real
        # candidate and its poisoned entry is actually examined.
        inventory = runtime_inventory('0.1.1', '0.1.2', '0.1.3', self.version) + [
            {'path': 'releases/runtime/runtime-0.1.1/../../../latest/x.exe', 'size': 1},
        ]
        with self.assertRaises(SystemExit) as raised:
            self.run_flow(api, inventory)
        self.assertEqual(raised.exception.code, 1)
        self.assertEqual(api.deletes, [])
        text = self.summary_text()
        self.assertIn('REFUSED by the runtime whitelist', text)
        self.assertNotIn('- Delete list', text)

    def test_an_incomplete_asset_set_is_refused_before_uploading(self):
        for name in runtime_asset_names(self.version, RUNTIME_PLATFORMS):
            if name.endswith('.sha512'):
                (self.assets / name).unlink()
        api = self.api()
        with self.assertRaises(mr.MirrorError):
            self.run_flow(api, runtime_inventory(self.version))
        self.assertEqual(api.uploads, [])

    def test_a_half_uploaded_matrix_is_refused(self):
        # A backfill dispatched while the matrix is still uploading: every asset
        # shape is present, so only the platform list can see the hole. Mirroring
        # it would leave four cells answering 404 forever (the release trigger is
        # one-shot), which is exactly what this must refuse.
        for name in list(self.assets.iterdir()):
            if not any(cell in name.name for cell in ('win32-x64', 'linux-x64')):
                name.unlink()
        api = self.api()
        with self.assertRaises(mr.MirrorError) as raised:
            self.run_flow(api, runtime_inventory(self.version))
        self.assertIn('not a complete runtime set', str(raised.exception))
        self.assertEqual(api.uploads, [])

    def test_a_partial_drill_uploads_and_skips_retention(self):
        for name in list(self.assets.iterdir()):
            if 'win32-x64' not in name.name:
                name.unlink()
        api = self.api()
        counts = self.run_flow(
            api, runtime_inventory('0.1.1', self.version),
            only_pattern='win32-x64',
        )
        self.assertEqual(counts['inventory'], 0)
        self.assertEqual(api.deletes, [])
        self.assertIn('partial drill', self.summary_text())
        self.assertIn('only_pattern', self.summary_text())

    def test_an_empty_asset_directory_is_refused(self):
        for name in list(self.assets.iterdir()):
            name.unlink()
        with self.assertRaises(mr.MirrorError):
            self.run_flow(self.api(), [])


class RuntimeDispatchTests(unittest.TestCase):
    """The tag shape, not a new mode value, decides which flow runs."""

    def setUp(self):
        # No release-assets/ here: the shell flow must fail on that, which is
        # how the second test proves it did not take the runtime path.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        previous = os.getcwd()
        os.chdir(tmp.name)
        self.addCleanup(os.chdir, previous)

    def cfg(self, tag):
        return mr.Config(
            endpoint='https://example.invalid',
            repo='owner/repo',
            token='token-value',
            gh_repo='owner/repo',
            tag=tag,
            only_pattern='',
            keep_versions=10,
            prune_mode='apply',
            keep_runtime_versions=3,
        )

    def test_a_runtime_tag_routes_to_the_runtime_flow(self):
        cfg = self.cfg('runtime-0.1.5-rc.2')
        with mock.patch.object(mr, 'subcommand_mirror_runtime') as runtime:
            mr.subcommand_mirror(cfg)
        runtime.assert_called_once_with(cfg)

    def test_a_shell_tag_never_routes_to_the_runtime_flow(self):
        cfg = self.cfg('v0.11.8')
        with mock.patch.object(mr, 'subcommand_mirror_runtime') as runtime:
            with self.assertRaises(mr.MirrorError):
                mr.subcommand_mirror(cfg)
        runtime.assert_not_called()

    def test_a_traversing_runtime_tag_is_refused(self):
        with self.assertRaises(mr.MirrorError):
            mr.subcommand_mirror(self.cfg('runtime-../latest'))


class RuntimeConfigTests(unittest.TestCase):
    base_env = {
        'MODELSCOPE_TOKEN': 'token-value',
        'GITHUB_REPOSITORY': 'JochenYang/dsh-app',
        'MODELSCOPE_REPO': 'jochenYang/dsh-app',
    }

    def test_the_runtime_window_defaults_to_three(self):
        with mock.patch.dict(os.environ, self.base_env, clear=True):
            cfg = mr.Config.from_env()
        self.assertEqual(cfg.keep_runtime_versions, 3)
        self.assertEqual(cfg.keep_versions, 10)

    def test_the_two_windows_are_read_independently(self):
        env = dict(self.base_env, KEEP_VERSIONS='5', KEEP_RUNTIME_VERSIONS='2')
        with mock.patch.dict(os.environ, env, clear=True):
            cfg = mr.Config.from_env()
        self.assertEqual(cfg.keep_versions, 5)
        self.assertEqual(cfg.keep_runtime_versions, 2)

    def test_invalid_runtime_windows_are_rejected(self):
        for raw in ('two', '0', '-1'):
            env = dict(self.base_env, KEEP_RUNTIME_VERSIONS=raw)
            with mock.patch.dict(os.environ, env, clear=True):
                with self.assertRaises(mr.MirrorError):
                    mr.Config.from_env()

    def test_the_platform_matrix_is_parsed_from_the_environment(self):
        env = dict(self.base_env, RUNTIME_PLATFORMS='win32-x64, linux-x64\n darwin-x64')
        with mock.patch.dict(os.environ, env, clear=True):
            cfg = mr.Config.from_env()
        self.assertEqual(cfg.runtime_platforms, ('win32-x64', 'linux-x64', 'darwin-x64'))

    def test_without_the_matrix_only_the_asset_shapes_are_checked(self):
        with mock.patch.dict(os.environ, self.base_env, clear=True):
            cfg = mr.Config.from_env()
        self.assertEqual(cfg.runtime_platforms, ())


if __name__ == '__main__':
    unittest.main(verbosity=2)
