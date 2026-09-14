#!/usr/bin/env python3
"""Unit tests for mirror_release.py (retention policy and delete guard).

Pure-function tests only: no SDK, no network, no repository access. Run them
from the repository root:

    python .github/scripts/test_mirror_release.py
"""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import mirror_release as mr  # noqa: E402


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


if __name__ == '__main__':
    unittest.main(verbosity=2)
