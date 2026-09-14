#!/usr/bin/env python3
"""Mirror a GitHub release to ModelScope, rebuild the index, prune old versions.

Called by .github/workflows/publish-mirror.yml. Every knob arrives through the
environment so the workflow stays the single place that knows about inputs and
secrets:

    MODELSCOPE_TOKEN     required; the ModelScope access token
    MODELSCOPE_REPO      target repo id (owner/name); falls back to the
                         lowercased GITHUB_REPOSITORY
    MODELSCOPE_ENDPOINT  optional; defaults to https://www.modelscope.cn
    RELEASE_TAG          v-prefixed release tag (mirror/diagnose context)
    ONLY_PATTERN         partial drill: mirror only matching local assets
    KEEP_VERSIONS        prune: versions retained per channel (default 10)
    PRUNE_MODE           prune: off | dry-run | apply (default apply)

Subcommands:

    mirror       upload the release assets, rebuild releases/versions.json and
                 prune expired versions according to PRUNE_MODE
    diagnose     commit a few-byte probe file to test the commit endpoint
    prune-probe  upload -> list -> delete -> confirm 404 on a throwaway path

Layout in the target repo (see AGENTS.md section 10):

    releases/latest/<asset>             rolling copy of the newest stable
    releases/archive/<version>/<asset>  every stable version
    releases/prerelease/<tag>/<asset>   every prerelease
    releases/versions.json              index {updated, versions: {...}}

The app updater reads versions.json to choose a version to install or roll back
to, so pruning MUST keep the index in sync: an entry whose assets were deleted
is a 404 in the user's updater. Deletion therefore only ever targets the two
version directory prefixes, and the index is rewritten from the same in-memory
state in the same run. Logical-LFS storage is deduplicated by content sha256,
so the bytes reported for the delete list overestimate the space actually
freed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

VERSIONS_PATH = 'releases/versions.json'
LATEST_PREFIX = 'releases/latest/'
ARCHIVE_PREFIX = 'releases/archive/'
PRERELEASE_PREFIX = 'releases/prerelease/'
PROBE_PREFIX = 'releases/prune-probe/'
# Positively whitelisted: a delete path is only acceptable under one of these.
# releases/latest/ is deliberately absent - it is the rolling copy the updater
# always reads first, and it must never lose files to a retention rule.
DELETABLE_PREFIXES = (ARCHIVE_PREFIX, PRERELEASE_PREFIX)

DEFAULT_KEEP_VERSIONS = 10
DEFAULT_PRUNE_MODE = 'apply'
PRUNE_MODES = ('off', 'dry-run', 'apply')

# Version directory names we are willing to build a delete path from. Anything
# else (empty, dotted traversal, absolute, backslash) is refused.
SAFE_NAME_RE = re.compile(r'^[0-9A-Za-z][0-9A-Za-z._-]*$')
SEMVER_RE = re.compile(r'^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?$')

USER_AGENT = 'dsh-app-publish-mirror'


class MirrorError(Exception):
    """Fatal mirror failure: reported as FAILED in the step summary."""


# ----------------------------------------------------------------------
# Logging and step summary
# ----------------------------------------------------------------------
def log(message):
    print(f'[modelscope] {message}', flush=True)


def gha_warning(message):
    print(f'::warning::{message}', flush=True)


def gha_error(message):
    print(f'::error::{message}', flush=True)


def write_summary(lines):
    target = os.environ.get('GITHUB_STEP_SUMMARY')
    if not target:
        return
    try:
        with open(target, 'a', encoding='utf-8') as handle:
            handle.write('\n'.join(lines) + '\n')
    except OSError:
        pass


# ----------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------
class Config:
    """Environment-derived configuration for one invocation."""

    def __init__(
        self,
        endpoint,
        repo,
        token,
        gh_repo,
        tag,
        only_pattern,
        keep_versions,
        prune_mode,
    ):
        self.endpoint = endpoint
        self.repo = repo
        self.token = token
        self.gh_repo = gh_repo
        self.tag = tag
        self.only_pattern = only_pattern
        self.keep_versions = keep_versions
        self.prune_mode = prune_mode

    @property
    def backfill(self):
        return f'gh workflow run publish-mirror.yml -f tag={self.tag or "<tag>"}'

    def redact(self, text):
        # Never let the token reach the log, even through an exception.
        text = str(text)
        return text.replace(self.token, '<redacted>') if self.token and self.token in text else text

    @classmethod
    def from_env(cls):
        raw_keep = (os.environ.get('KEEP_VERSIONS') or '').strip()
        try:
            keep_versions = int(raw_keep) if raw_keep else DEFAULT_KEEP_VERSIONS
        except ValueError:
            raise MirrorError(f'KEEP_VERSIONS must be an integer, got {raw_keep!r}')
        if keep_versions < 1:
            raise MirrorError(
                f'KEEP_VERSIONS must be >= 1 (got {keep_versions}); use PRUNE_MODE=off'
                ' to disable pruning entirely'
            )
        prune_mode = (os.environ.get('PRUNE_MODE') or '').strip() or DEFAULT_PRUNE_MODE
        if prune_mode not in PRUNE_MODES:
            raise MirrorError(
                f'PRUNE_MODE must be one of {", ".join(PRUNE_MODES)}, got {prune_mode!r}'
            )
        return cls(
            endpoint=(os.environ.get('MODELSCOPE_ENDPOINT') or 'https://www.modelscope.cn').rstrip('/'),
            repo=os.environ.get('MODELSCOPE_REPO') or os.environ['GITHUB_REPOSITORY'].lower(),
            token=os.environ['MODELSCOPE_TOKEN'],
            gh_repo=os.environ['GITHUB_REPOSITORY'],
            tag=(os.environ.get('RELEASE_TAG') or '').strip(),
            only_pattern=(os.environ.get('ONLY_PATTERN') or '').strip(),
            keep_versions=keep_versions,
            prune_mode=prune_mode,
        )


def fail(reason, extra=None, backfill=None):
    """Report a fatal mirror failure and exit non-zero."""
    reason = str(reason)
    log(f'FAILED: {reason}')
    lines = ['### ModelScope mirror: FAILED', '', f'- Reason: {reason}']
    lines += [f'- {item}' for item in (extra or [])]
    lowered = reason.lower()
    if '503' in reason or 'unavailable' in lowered:
        lines.append(
            '- Reading: looks like the 503 "commit publisher unavailable" rate limit'
            ' - run `gh workflow run publish-mirror.yml -f mode=diagnose` before backfilling.'
        )
    if backfill:
        lines += ['', f'- Backfill once the endpoint recovers: `{backfill}`']
    write_summary(lines)
    sys.exit(1)


# ----------------------------------------------------------------------
# Remote helpers
# ----------------------------------------------------------------------
def read_published_index(cfg):
    """Read the PUBLIC releases/versions.json; never rebuild from scratch.

    The index is a read-modify-write. Only a 404 means "first publish"; any
    other read failure is fatal, because rebuilding from empty would silently
    drop the whole history while missing assets can always be re-uploaded.
    """
    url = (
        f'{cfg.endpoint}/api/v1/models/{cfg.repo}/repo'
        f'?Revision=master&FilePath={urllib.parse.quote(VERSIONS_PATH, safe="/")}'
    )
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read().decode('utf-8')
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            log(f'{VERSIONS_PATH} not published yet -> starting from an empty index')
            return {}
        raise MirrorError(
            f'cannot read the published {VERSIONS_PATH}: HTTP {exc.code}'
            ' (refusing to rebuild the index from scratch)'
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        raise MirrorError(
            f'cannot read the published {VERSIONS_PATH}: {cfg.redact(exc)}'
            ' (refusing to rebuild the index from scratch)'
        )
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        raise MirrorError(f'the published {VERSIONS_PATH} is not valid JSON (refusing to rebuild it)')

    # The repo API may wrap payloads in a {Data: ...} envelope, and an HTTP 200
    # can still carry a non-200 business Code.
    if isinstance(parsed, dict) and 'versions' not in parsed and 'Data' in parsed:
        data = parsed['Data']
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except json.JSONDecodeError:
                raise MirrorError('the published index envelope does not contain JSON')
        parsed = data
    if not isinstance(parsed, dict):
        raise MirrorError(f'the published {VERSIONS_PATH} is not an index object')
    code = parsed.get('Code', parsed.get('code'))
    if code is not None and str(code) != '200':
        raise MirrorError(f'the published {VERSIONS_PATH} is unavailable: Code {code}')
    return parsed


def list_remote_files(api, cfg):
    """Call the remote file lister across the facades the pin can resolve to.

    The pinned modelscope shim exposes the legacy positional
    ``get_model_files(model_id, revision, root, recursive)``; the newer facade
    exposes ``list_repo_files(repo_id, repo_type, *, revision, recursive)``.
    Only a signature TypeError is retried with the next attempt - a transport
    error must propagate.
    """
    attempts = (
        ('get_model_files', lambda: api.get_model_files(cfg.repo, 'master', None, True)),
        (
            'get_model_files',
            lambda: api.get_model_files(repo_id=cfg.repo, revision='master', recursive=True),
        ),
        (
            'list_repo_files',
            lambda: api.list_repo_files(cfg.repo, 'model', revision='master', recursive=True),
        ),
    )
    errors = []
    for name, attempt in attempts:
        if not hasattr(api, name):
            continue
        try:
            return attempt()
        except TypeError as exc:
            errors.append(f'{name}: {exc}')
    raise MirrorError('cannot list the remote files: ' + '; '.join(errors or ['no lister on the SDK']))


def fetch_remote_files(api, cfg):
    """List every remote file path and size in the target repo.

    Both the legacy dict shape (``Path``/``Size``) and the newer FileInfo shape
    are accepted so the caller does not depend on which facade the pinned SDK
    resolves to. Directory entries are dropped: a retention delete only ever
    names files.
    """
    raw = list_remote_files(api, cfg)
    files = []
    for item in raw or []:
        if isinstance(item, dict):
            path = item.get('Path') or item.get('path') or ''
            size = item.get('Size') or item.get('size') or 0
            kind = item.get('Type') or item.get('type') or 'blob'
        else:
            path = getattr(item, 'path', '') or ''
            size = getattr(item, 'size', 0) or 0
            kind = getattr(item, 'type', 'blob') or 'blob'
        if not path or kind == 'tree':
            continue
        try:
            size = int(size)
        except (TypeError, ValueError):
            size = 0
        files.append({'path': path, 'size': size})
    return files


def commit_index(cfg, api, versions, commit_message):
    """Write and commit releases/versions.json from ``versions``."""
    index_file = Path(os.environ.get('RUNNER_TEMP', '.')) / 'versions.json'
    index_file.write_text(
        json.dumps({'updated': index_stamp(), 'versions': versions}, indent=2) + '\n',
        encoding='utf-8',
    )
    result = api.upload_file(
        repo_id=cfg.repo,
        repo_type='model',
        path_or_fileobj=str(index_file),
        path_in_repo=VERSIONS_PATH,
        commit_message=commit_message,
        disable_tqdm=True,
    )
    return result


def index_stamp():
    return time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())


def sdk_runtime_info():
    """Describe the SDK actually installed, so a green run stays auditable."""
    from importlib import metadata

    parts = []
    for name in ('modelscope', 'modelscope-hub'):
        try:
            parts.append(f'{name} {metadata.version(name)}')
        except metadata.PackageNotFoundError:
            parts.append(f'{name} (not installed)')
    return ', '.join(parts)


# ----------------------------------------------------------------------
# Retention policy
# ----------------------------------------------------------------------
def parse_semver(version):
    """Return (major, minor, patch, prerelease) or None for unrankable names."""
    match = SEMVER_RE.match(str(version).strip())
    if not match:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)), match.group(4))


def _prerelease_key(part):
    # Numeric identifiers sort below alphanumeric ones, per semver precedence.
    return (0, int(part), '') if part.isdigit() else (1, 0, part)


def semver_sort_key(version):
    """Sort key, newest first when reversed; returns None if unrankable."""
    parsed = parse_semver(version)
    if parsed is None:
        return None
    major, minor, patch, prerelease = parsed
    if prerelease is None:
        return (major, minor, patch, 1, ())
    return (major, minor, patch, 0, tuple(_prerelease_key(p) for p in prerelease.split('.')))


def version_channel(version, entry):
    """Channel of an index entry; '-' in the version means prerelease."""
    channel = str((entry or {}).get('channel') or '').strip().lower()
    if channel in ('stable', 'prerelease'):
        return channel
    return 'prerelease' if '-' in str(version) else 'stable'


def plan_retention(versions, keep_versions, current_tag):
    """Split the index into versions to keep and versions to prune.

    Stable and prerelease versions are ranked separately (a prerelease flood
    must not evict stable history). ``keep_versions`` is applied per channel;
    the tag being published right now is always kept, even when it ranks below
    the cut-off (which is exactly what a backfill of an old tag would do).
    Versions whose name is not semver-ranked are never candidates: we do not
    delete what the policy cannot rank.
    """
    current_version = current_tag[1:] if str(current_tag).lower().startswith('v') else str(current_tag)
    ranked = {'stable': [], 'prerelease': []}
    unranked = []
    for version, entry in versions.items():
        key = semver_sort_key(version)
        if key is None:
            unranked.append(version)
            continue
        ranked[version_channel(version, entry)].append((key, version))

    kept = {'stable': [], 'prerelease': []}
    candidates = []
    for channel in ('stable', 'prerelease'):
        ordered = sorted(ranked[channel], reverse=True)
        kept[channel] = [version for _, version in ordered[:keep_versions]]
        for _, version in ordered[keep_versions:]:
            if version == current_version:
                kept[channel].append(version)
                continue
            candidates.append((version, channel, versions.get(version) or {}))
    return {
        'kept': kept,
        'candidates': candidates,
        'unranked': unranked,
        'current_version': current_version,
        'current_tag': current_tag,
        'keep_versions': keep_versions,
    }


def candidate_prefix(version, channel):
    """The only two path shapes a retention rule may delete from."""
    if channel == 'prerelease':
        # Prerelease directories are named after the tag, not the version.
        return f'{PRERELEASE_PREFIX}{version}/'
    return f'{ARCHIVE_PREFIX}{version}/'


def deletion_allowed(path, prefixes=DELETABLE_PREFIXES):
    """Whitelist guard. Returns (allowed, reason) for one repo-relative path.

    Positive allowlist only: anything that is not a file strictly below one of
    ``prefixes`` is refused, which covers releases/latest/,
    releases/versions.json, the repo root, .gitattributes and any traversal
    attempt by construction.
    """
    if not isinstance(path, str) or not path:
        return False, 'empty path'
    if path.startswith('/') or '\\' in path:
        return False, 'not a repo-relative posix path'
    segments = path.split('/')
    if any(segment in ('', '.', '..') for segment in segments):
        return False, 'unexpected path segment'
    if path == VERSIONS_PATH:
        return False, f'{VERSIONS_PATH} is rewritten, never deleted'
    if path.startswith(LATEST_PREFIX):
        return False, 'releases/latest/ is never pruned'
    for prefix in prefixes:
        if path.startswith(prefix) and len(path) > len(prefix):
            return True, ''
    return False, 'outside releases/archive/ and releases/prerelease/'


def build_delete_plan(candidates, remote_files, current_tag):
    """Turn retention candidates into delete entries plus a refusal list.

    Remote sizes are attached for the report; a candidate with no remote file
    is kept in the plan (its index entry is stale and must still be dropped,
    otherwise a half-deleted version keeps 404-ing from the index).
    """
    entries = []
    refusals = []
    for version, channel, entry in candidates:
        tag = str((entry or {}).get('tag') or (f'v{version}' if channel == 'stable' else version))
        if tag == current_tag:
            # Belt and braces: the tag being published is never a candidate.
            continue
        if any(char in version for char in '/\\') or not SAFE_NAME_RE.match(version):
            refusals.append((version, f'unsafe version name {version!r}'))
            continue
        dir_name = tag if channel == 'prerelease' else version
        if any(char in dir_name for char in '/\\') or not SAFE_NAME_RE.match(dir_name):
            refusals.append((version, f'unsafe directory name {dir_name!r}'))
            continue
        prefix = candidate_prefix(dir_name, channel)
        files = [item for item in remote_files if item['path'].startswith(prefix)]
        rejected = [item['path'] for item in files if not deletion_allowed(item['path'])[0]]
        if rejected:
            for path in rejected:
                reason = deletion_allowed(path)[1]
                refusals.append((version, f'{path}: {reason}'))
                gha_error(f'refusing to delete {path}: {reason}')
            continue
        entries.append({
            'version': version,
            'channel': channel,
            'tag': tag,
            'prefix': prefix,
            'paths': [item['path'] for item in files],
            'bytes': sum(item['size'] for item in files),
        })
    return entries, refusals


def human_bytes(size):
    value = float(size)
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if value < 1024 or unit == 'TB':
            return f'{value:.1f} {unit}' if unit != 'B' else f'{int(value)} B'
        value /= 1024
    return f'{value:.1f} TB'


def summary_prune_lines(plan, entries, refusals, outcome=None, dry_run=False):
    """Render the prune section of the step summary and the k8s-style log."""
    kept = plan['kept']
    lines = [f'#### Prune ({"dry-run" if dry_run else "apply"})', '']
    lines.append(
        f'- Keep policy: newest `{plan["keep_versions"]}` per channel'
        f' ({len(kept["stable"]) + len(kept["prerelease"])} retained; stable and prerelease'
        f' ranked separately), current tag `{plan["current_tag"]}` always kept'
    )
    lines.append(f'- Retained stable ({len(kept["stable"])}): {", ".join(kept["stable"]) or "none"}')
    lines.append(
        f'- Retained prerelease ({len(kept["prerelease"])}): {", ".join(kept["prerelease"]) or "none"}'
    )
    if plan['unranked']:
        lines.append(
            f'- Not ranked, never pruned ({len(plan["unranked"])}): {", ".join(plan["unranked"])}'
        )
    if refusals:
        lines.append(f'- REFUSED by the path whitelist ({len(refusals)}):')
        lines += [f'  - `{version}`: {reason}' for version, reason in refusals]
        lines.append('- No deletion was attempted; the guard rejected at least one path.')
        return lines

    if not entries:
        lines.append('- Delete list: none (every indexed version is inside the retention window)')
        lines.append('- Index changes: none')
        return lines

    lines.append(f'- Delete list ({len(entries)}):')
    for entry in entries:
        lines.append(
            f'  - `{entry["prefix"]}` - {len(entry["paths"])} file(s),'
            f' {human_bytes(entry["bytes"])} of LFS objects (sha256 dedup means less is freed)'
        )
    if dry_run:
        lines.append('- Dry run: no file was deleted and the index was not changed')
        return lines

    if outcome is not None:
        if outcome['deleted']:
            lines.append(
                f'- Deleted ({len(outcome["deleted"])}): {", ".join(item["version"] for item in outcome["deleted"])}'
            )
        if outcome['failed']:
            lines.append(f'- WARNING: delete failed for {len(outcome["failed"])} version(s):')
            lines += [f'  - `{version}`: {reason}' for version, reason in outcome['failed']]
            lines.append(
                '- Those entries stay in the index on purpose; re-run'
                f' `gh workflow run publish-mirror.yml -f tag={plan["current_tag"]}'
                ' -f prune_mode=apply` to retry.'
            )
    return lines


def load_modelscope_api(cfg, capability=None):
    """Import and construct the SDK client, checking a required capability."""
    from modelscope.hub.api import HubApi

    api = HubApi(endpoint=cfg.endpoint, token=cfg.token)
    if capability and not hasattr(api, capability):
        raise MirrorError(
            f'the installed SDK exposes no {capability}();'
            f' cannot prune ({sdk_runtime_info()})'
        )
    return api


def apply_prune(cfg, api, entries):
    """Delete one version per commit so one failure cannot block the others."""
    outcome = {'deleted': [], 'failed': []}
    for entry in entries:
        paths = entry['paths']
        if not paths:
            # Nothing left on the remote: drop the stale index entry.
            log(f'{entry["prefix"]}: no remote file left, removing the stale index entry only')
            outcome['deleted'].append({'version': entry['version'], 'files': 0, 'bytes': 0})
            continue
        log(f'{entry["prefix"]}: deleting {len(paths)} file(s), {human_bytes(entry["bytes"])}')
        try:
            result = api.delete_files(
                repo_id=cfg.repo,
                repo_type='model',
                file_paths=paths,
                commit_message=f'Prune {entry["tag"]} (keep {cfg.keep_versions} per channel)',
                revision='master',
            )
        except BaseException as exc:  # noqa: BLE001 - reported, then next version
            reason = cfg.redact(f'{type(exc).__name__}: {exc}')[:300]
            gha_warning(f'delete failed for {entry["prefix"]}: {reason}')
            outcome['failed'].append((entry['version'], reason))
            continue
        failed_paths = list((result or {}).get('failed_files') or [])
        if failed_paths:
            gha_warning(f'{entry["prefix"]}: SDK reported failed_files {failed_paths[:5]}')
            outcome['failed'].append((entry['version'], f'failed_files: {failed_paths[:5]}'))
            continue
        deleted = len((result or {}).get('deleted_files') or paths)
        log(f'{entry["prefix"]}: deleted {deleted} file(s)')
        outcome['deleted'].append({
            'version': entry['version'],
            'files': deleted,
            'bytes': entry['bytes'],
        })
    return outcome


# ----------------------------------------------------------------------
# Subcommands
# ----------------------------------------------------------------------
def subcommand_mirror(cfg):
    """Upload the release, rebuild the index, then prune by policy."""
    if not cfg.tag.lower().startswith('v'):
        raise MirrorError(f'invalid release tag {cfg.tag!r}: expected a v-prefixed tag')

    version = cfg.tag[1:]
    prerelease = '-' in version
    channel = 'prerelease' if prerelease else 'stable'
    partial = bool(cfg.only_pattern)
    if prerelease:
        targets = [f'{PRERELEASE_PREFIX}{cfg.tag}']
    else:
        targets = ['releases/latest', f'{ARCHIVE_PREFIX}{version}']

    assets_dir = Path('release-assets')
    if not assets_dir.is_dir():
        raise MirrorError(f'{assets_dir} is missing: the download step produced no assets')

    files = sorted(
        (item for item in assets_dir.iterdir() if item.is_file()),
        key=lambda item: item.name,
    )
    if partial:
        needle = cfg.only_pattern.lower()
        files = [item for item in files if needle in item.name.lower()]
    if not files:
        detail = f' matching only_pattern {cfg.only_pattern!r}' if partial else ''
        raise MirrorError(f'no local assets{detail} to upload from {assets_dir}')

    warnings = []
    if partial and not prerelease:
        warnings.append(
            f'PARTIAL DRILL ON STABLE TAG `{cfg.tag}`: the matching files in'
            ' `releases/latest` were overwritten by this run.'
        )
        log(f'WARNING: {warnings[-1]}')

    info = [
        f'Release: `{cfg.tag}` ({channel})',
        f'Target: `{cfg.repo}`',
        'Paths: ' + ', '.join(f'`{target}`' for target in targets),
        f'Files: {len(files)} asset(s)' + (f' (only_pattern `{cfg.only_pattern}`)' if partial else ''),
        f'SDK: {sdk_runtime_info()}',
    ]
    log(f'mirror plan: {cfg.tag} ({channel}) -> {cfg.repo} [{", ".join(targets)}]')

    # Read the index BEFORE the uploads: a read failure must cost nothing, and
    # `concurrency: publish-mirror` guarantees no other mirror run can
    # interleave between this read and the commit below.
    index = read_published_index(cfg)
    published = index.get('versions') or {}
    if not isinstance(published, dict):
        raise MirrorError(f'{VERSIONS_PATH} has no usable "versions" object')
    previous_count = len(published)

    api = load_modelscope_api(cfg)

    for target in targets:
        log(f'uploading {len(files)} file(s) to {target}')
        result = api.upload_folder(
            repo_id=cfg.repo,
            repo_type='model',
            folder_path=str(assets_dir),
            path_in_repo=target,
            commit_message=f'Mirror {cfg.tag} from {cfg.gh_repo} to {target}',
            disable_tqdm=True,
        )
        if result is None:
            log(f'{target}: already up to date, nothing new to commit')
        else:
            batches = len(result) if isinstance(result, list) else 1
            log(f'{target}: committed in {batches} batch(es)')

    versions = dict(published)
    if partial:
        log(f'partial drill: {VERSIONS_PATH} left untouched')
        info.append(f'Index: `{VERSIONS_PATH}` not modified (partial drill)')
    else:
        versions[version] = {
            'tag': cfg.tag,
            'channel': channel,
            'assets': [item.name for item in files],
            'uploadedAt': index_stamp(),
        }

    prune_lines = [f'#### Prune: skipped (partial drill leaves the index untouched)', '']
    removed = set()
    prune_failed = False
    refused = []
    if not partial and cfg.prune_mode != 'off':
        plan = plan_retention(versions, cfg.keep_versions, cfg.tag)
        remote_files = fetch_remote_files(api, cfg)
        log(f'remote inventory: {len(remote_files)} file(s)')
        entries, refused = build_delete_plan(plan['candidates'], remote_files, cfg.tag)
        if refused:
            gha_error(f'prune refused {len(refused)} path(s) outside the delete whitelist')
            prune_lines = summary_prune_lines(plan, entries, refused)
        elif cfg.prune_mode == 'dry-run':
            log(
                f'prune dry-run: {len(entries)} version(s) outside keep_versions='
                f'{cfg.keep_versions} would be deleted'
            )
            prune_lines = summary_prune_lines(plan, entries, refused, dry_run=True)
        else:
            outcome = apply_prune(cfg, api, entries)
            removed = {item['version'] for item in outcome['deleted']}
            prune_failed = bool(outcome['failed'])
            prune_lines = summary_prune_lines(plan, entries, refused, outcome=outcome)
            versions = {ver: ent for ver, ent in versions.items() if ver not in removed}
    elif not partial:
        prune_lines = ['#### Prune: off (nothing deleted)', '']

    if not partial:
        suffix = f', removed {", ".join(sorted(removed))}' if removed else ''
        info.append(f'Index: `{VERSIONS_PATH}` now holds {len(versions)} version(s){suffix}')

    # Self-checks: the index may only lose versions the prune actually removed,
    # and it must always still advertise the tag being published.
    lost = [ver for ver in published if ver not in versions and ver not in removed]
    if lost:
        raise MirrorError(
            f'{VERSIONS_PATH} merge dropped {lost}: read {previous_count},'
            f' wrote {len(versions)} (concurrent publish?)'
        )
    if not partial and version not in versions:
        raise MirrorError(f'{VERSIONS_PATH} would not advertise the published version {version}')

    if partial:
        log('partial drill: no index commit')
    else:
        log(f'committing {VERSIONS_PATH}: {previous_count} -> {len(versions)} version(s)')
        commit_index(cfg, api, versions, f'Update {VERSIONS_PATH} for {cfg.tag}')

    write_summary(
        [f'### ModelScope mirror: OK{" (partial drill)" if partial else ""}', '']
        + [f'- {item}' for item in info]
        + [f'- WARNING: {item}' for item in warnings]
        + ['', *prune_lines, '', f'- Backfill if this run needs repeating: `{cfg.backfill}`']
    )
    if refused:
        # A refused delete path means the retention model disagrees with the
        # repository layout: the mirror itself is committed, but this must be
        # looked at, so the run does not finish green.
        fail(
            f'prune refused {len(refused)} path(s) outside the delete whitelist;'
            ' no file was deleted',
            backfill=cfg.backfill,
        )
    log(f'OK: {cfg.tag} mirrored to {cfg.repo}')
    if prune_failed:
        # The release is already published and the mirror is committed; only
        # the cleanup needs attention, so keep the run green and say so.
        gha_warning('prune did not complete; see the step summary')


def subcommand_diagnose(cfg):
    """Commit one tiny probe file and report whether the endpoint accepted it."""
    api = load_modelscope_api(cfg)
    run_id = os.environ.get('GITHUB_RUN_ID', '')
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    probe_path = f'releases/.probe-{stamp}.json'
    payload = json.dumps({
        'probe': True,
        'workflow': 'publish-mirror',
        'run_id': run_id,
        'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }).encode('utf-8')

    log(f'committing probe {probe_path} ({len(payload)} bytes) to {cfg.repo}')
    try:
        api.upload_file(
            repo_id=cfg.repo,
            repo_type='model',
            path_or_fileobj=payload,
            path_in_repo=probe_path,
            commit_message=f'Probe commit endpoint (workflow run {run_id})',
            disable_tqdm=True,
        )
    except BaseException as exc:
        reason = cfg.redact(f'{type(exc).__name__}: {exc}')[:400]
        lowered = reason.lower()
        rate_limited = '503' in reason or 'servererror' in lowered or 'unavailable' in lowered
        hint = (
            'the platform still refuses commits (looks like the 503 "commit publisher'
            ' unavailable" rate limit); wait, then dispatch again before backfilling'
            if rate_limited else
            'not the known rate limit; check the token scope and the target repo id'
        )
        log(f'PROBE FAILED: {reason}')
        write_summary([
            '### ModelScope commit probe: FAILED',
            '',
            f'- Target: `{cfg.repo}`',
            f'- Probe: `{probe_path}`',
            f'- Error: `{reason}`',
            f'- Reading: {hint}',
            f'- Backfill once probes pass: `{cfg.backfill}`',
        ])
        sys.exit(1)

    log('PROBE OK: the commit endpoint accepted a write')
    write_summary([
        '### ModelScope commit probe: OK',
        '',
        f'- Target: `{cfg.repo}`',
        f'- SDK: {sdk_runtime_info()}',
        f'- Probe: `{probe_path}` committed',
        '- Reading: the commit endpoint is accepting writes again; a backfill should succeed.',
        f'- Backfill: `{cfg.backfill}`',
    ])


def probe_file_status(cfg, path):
    """HTTP status of one repo file; 404 means the path is really gone."""
    url = (
        f'{cfg.endpoint}/api/v1/models/{cfg.repo}/repo'
        f'?Revision=master&FilePath={urllib.parse.quote(path, safe="/")}'
    )
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, len(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, 0


def fetch_public_entries(cfg):
    """Raw repo/files entries; they carry IsLFS, which the SDK listing drops."""
    url = f'{cfg.endpoint}/api/v1/models/{cfg.repo}/repo/files?Revision=master&Recursive=true'
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        parsed = json.loads(response.read().decode('utf-8'))
    data = parsed.get('Data', parsed) if isinstance(parsed, dict) else {}
    entries = data.get('Files') if isinstance(data, dict) else None
    return entries or []


def subcommand_prune_probe(cfg):
    """Prove upload -> list -> delete -> 404 on a throwaway path.

    Touches nothing outside releases/prune-probe/<uuid>/: the retention policy
    is exercised for real (the SDK commit path, the LFS path and the delete
    action) without exposing any released version to a bug. One probe file is
    LFS-tracked by suffix so the delete action is verified against the storage
    mode every real asset uses.
    """
    api = load_modelscope_api(cfg, capability='delete_files')
    run_id = os.environ.get('GITHUB_RUN_ID', '')
    probe_dir = f'{PROBE_PREFIX}{uuid.uuid4().hex[:12]}'
    probes = {
        f'{probe_dir}/probe.txt': b'prune probe: plain file\n',
        f'{probe_dir}/probe.zip': b'prune probe: (logical) LFS file by suffix\n',
    }
    steps = []

    log(f'prune-probe: {sdk_runtime_info()}')
    steps.append(f'- SDK: {sdk_runtime_info()}')

    # 1) upload
    for path, payload in probes.items():
        log(f'prune-probe: uploading {path} ({len(payload)} bytes)')
        api.upload_file(
            repo_id=cfg.repo,
            repo_type='model',
            path_or_fileobj=payload,
            path_in_repo=path,
            commit_message=f'Prune probe upload (workflow run {run_id})',
            disable_tqdm=True,
        )
    steps.append(f'- Uploaded {len(probes)} probe file(s) under `{probe_dir}/`')

    # 2) list
    remote = {item['path'] for item in fetch_remote_files(api, cfg)}
    listed = {path: (path in remote) for path in probes}
    for path, present in listed.items():
        log(f'prune-probe: {path} listed={present}')
    steps.append(
        '- List after upload: ' + ', '.join(f'`{Path(p).name}`={"present" if ok else "MISSING"}' for p, ok in listed.items())
    )
    if not all(listed.values()):
        raise MirrorError(f'probe files are not listed after upload: {listed}')

    # The real assets live in logical LFS, so the probe must show that the
    # delete commit covers an LFS-flagged path too, not just a plain blob.
    entries = {entry.get('Path'): entry for entry in fetch_public_entries(cfg)}
    lfs = {path: bool((entries.get(path) or {}).get('IsLFS')) for path in probes}
    for path, is_lfs in lfs.items():
        log(f'prune-probe: {path} IsLFS={is_lfs}')
    steps.append(
        '- Storage mode: ' + ', '.join(f'`{Path(p).name}`={"LFS" if v else "plain"}' for p, v in lfs.items())
    )
    if not lfs.get(f'{probe_dir}/probe.zip'):
        gha_warning('the .zip probe file is not flagged LFS; the LFS delete path was not exercised')
        steps.append('- WARNING: the .zip probe file is not flagged LFS on the server')

    # 3) delete - the probe path is whitelisted only for this throwaway prefix,
    #    so the production guard stays exactly as strict as the prune step uses.
    for path in probes:
        allowed, reason = deletion_allowed(path, prefixes=(PROBE_PREFIX,))
        if not allowed:
            raise MirrorError(f'probe path {path} rejected by the guard: {reason}')
    log(f'prune-probe: deleting {len(probes)} file(s) in one commit')
    result = api.delete_files(
        repo_id=cfg.repo,
        repo_type='model',
        file_paths=sorted(probes),
        commit_message=f'Prune probe delete (workflow run {run_id})',
        revision='master',
    )
    deleted = list((result or {}).get('deleted_files') or [])
    failed = list((result or {}).get('failed_files') or [])
    log(f'prune-probe: delete_files returned deleted={deleted} failed={failed}')
    steps.append(f'- delete_files reported {len(deleted)} deleted, {len(failed)} failed')

    # 4) confirm 404 + absence from the listing
    statuses = {}
    for path in probes:
        status, _ = probe_file_status(cfg, path)
        statuses[path] = status
        log(f'prune-probe: {path} -> HTTP {status}')
    remote_after = {item['path'] for item in fetch_remote_files(api, cfg)}
    still_listed = [path for path in probes if path in remote_after]
    steps.append(
        '- HTTP after delete: ' + ', '.join(f'`{Path(p).name}`={s}' for p, s in statuses.items())
    )
    steps.append(f'- Still listed: {still_listed or "none"}')

    ok = all(status == 404 for status in statuses.values()) and not still_listed
    title = '### ModelScope prune probe: OK' if ok else '### ModelScope prune probe: FAILED'
    write_summary([title, '', f'- Target: `{cfg.repo}`', f'- Throwaway path: `{probe_dir}/`', *steps])
    if not ok:
        raise MirrorError(
            f'delete did not stick: statuses={statuses} still listed={still_listed}'
        )
    log('prune-probe OK: upload -> list -> delete -> 404 verified; no real version was touched')


SUBCOMMANDS = {
    'mirror': subcommand_mirror,
    'diagnose': subcommand_diagnose,
    'prune-probe': subcommand_prune_probe,
}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('command', choices=sorted(SUBCOMMANDS))
    args = parser.parse_args(argv)

    try:
        cfg = Config.from_env()
    except MirrorError as exc:
        fail(exc)
        return
    try:
        SUBCOMMANDS[args.command](cfg)
    except MirrorError as exc:
        fail(exc, backfill=cfg.backfill)
    except SystemExit:
        raise
    except BaseException as exc:
        # Report instead of a traceback: a traceback could echo the token.
        fail(
            f'unexpected {type(exc).__name__}: {cfg.redact(exc)[:400]}',
            backfill=cfg.backfill,
        )


if __name__ == '__main__':
    main()
