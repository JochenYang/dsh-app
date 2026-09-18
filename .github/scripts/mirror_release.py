#!/usr/bin/env python3
"""Mirror a GitHub release to ModelScope, rebuild the index, prune old versions.

Called by .github/workflows/publish-mirror.yml. Every knob arrives through the
environment so the workflow stays the single place that knows about inputs and
secrets:

    MODELSCOPE_TOKEN     required; the ModelScope access token
    MODELSCOPE_REPO      target repo id (owner/name); falls back to the
                         lowercased GITHUB_REPOSITORY
    MODELSCOPE_ENDPOINT  optional; defaults to https://www.modelscope.cn
    RELEASE_TAG          release tag: a v-prefixed shell tag, or a
                         runtime-<dshVersion> kernel runtime tag
    ONLY_PATTERN         partial drill: mirror only matching local assets
    RUNTIME_PLATFORMS    optional; the platform cells a runtime release must be
                         complete for (space/comma separated). Without it only
                         the asset shapes are checked, not the matrix.
    KEEP_VERSIONS        prune: shell versions retained per channel (default 10)
    KEEP_RUNTIME_VERSIONS
                         prune: runtime versions retained (default 3)
    PRUNE_MODE           prune: off | dry-run | apply (default apply); dry-run
                         also turns the latest cleanup into report-only

Subcommands:

    mirror       upload the release assets, rebuild releases/versions.json,
                 prune expired versions and converge releases/latest/ to the
                 assets of this release, according to PRUNE_MODE. A
                 runtime-<dshVersion> tag takes the runtime path instead:
                 assets land in releases/runtime/<tag>/, releases/versions.json
                 and releases/latest/ are not touched, and an independent
                 runtime retention window applies.
    diagnose     commit a few-byte probe file to test the commit endpoint
    prune-probe  upload -> list -> delete -> confirm 404 on a throwaway path

Layout in the target repo (see AGENTS.md section 10):

    releases/latest/<asset>             rolling copy of the newest stable
    releases/archive/<version>/<asset>  every stable version
    releases/prerelease/<tag>/<asset>   every prerelease
    releases/versions.json              index {updated, versions: {...}}
    releases/runtime/<tag>/<asset>      every kernel runtime asset, <tag> being
                                        runtime-<dshVersion>; the app resolves
                                        exactly this path

The app updater reads versions.json to choose a version to install or roll back
to, so pruning MUST keep the index in sync: an entry whose assets were deleted
is a 404 in the user's updater. Version retention therefore only ever targets
the two version directory prefixes, and the index is rewritten from the same
in-memory state in the same run. Logical-LFS storage is deduplicated by content
sha256, so the bytes reported for the delete list overestimate the space
actually freed.

releases/latest/ is NOT a retention concern and is deliberately outside the
version-retention allowlist: it is the rolling copy the updater reads first.
After a full stable publish, once every asset upload and the index commit have
succeeded, the mirror converges releases/latest/ to exactly the asset-name set
this run uploaded, deleting whatever a previous release left behind. That is
the only deletion this script performs under releases/latest/, it runs through
its own narrower guard (latest_cleanup_allowed), and it never runs for a
prerelease tag or a partial drill. archive/prerelease and versions.json are
untouched by it, so rollback always has the full history.

releases/runtime/ is a third, fully separate tree: kernel runtime assets are not
shell installers, so they have no index entry and no rolling copy, and they are
retained by their own window (KEEP_RUNTIME_VERSIONS, default 3). Its delete path
is guarded by its own allowlist (runtime_deletion_allowed), disjoint from
DELETABLE_PREFIXES, so a runtime retention bug cannot delete a shell asset and
the shell retention cannot delete a runtime. The remote directory listing is the
runtime policy's only source of truth, because the directory name IS the release
tag - see the "Runtime artifacts" section below.
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
# Positively whitelisted for version retention: a retention delete path is only
# acceptable under one of these. releases/latest/ is deliberately absent - it is
# the rolling copy the updater always reads first, and it must never lose files
# to a retention rule. Its own convergence step uses latest_cleanup_allowed().
DELETABLE_PREFIXES = (ARCHIVE_PREFIX, PRERELEASE_PREFIX)

# The kernel runtime tree. Writes and deletes only ever name paths below this
# prefix, and its allowlist is deliberately disjoint from DELETABLE_PREFIXES:
# the shell policy can never build a delete path under releases/runtime/ and the
# runtime policy can never build one under releases/archive|prerelease/. Neither
# of them can reach releases/latest/ or releases/versions.json.
RUNTIME_PREFIX = 'releases/runtime/'
RUNTIME_DELETABLE_PREFIXES = (RUNTIME_PREFIX,)
RUNTIME_TAG_PREFIX = 'runtime-'

DEFAULT_KEEP_VERSIONS = 10
DEFAULT_KEEP_RUNTIME_VERSIONS = 3
DEFAULT_PRUNE_MODE = 'apply'
PRUNE_MODES = ('off', 'dry-run', 'apply')

# Version directory names we are willing to build a delete path from. Anything
# else (empty, dotted traversal, absolute, backslash) is refused.
SAFE_NAME_RE = re.compile(r'^[0-9A-Za-z][0-9A-Za-z._-]*$')
# Runtime directory and asset names. Unlike the shell version names these allow
# '+': a dsh version may carry build metadata (dsh-app's own URL builder encodes
# it), and refusing the tag of a release we are about to mirror would be worse
# than allowing a character that is useless for traversal.
RUNTIME_TAG_RE = re.compile(r'^runtime-[0-9A-Za-z][0-9A-Za-z._+-]*$')
RUNTIME_NAME_RE = re.compile(r'^[0-9A-Za-z][0-9A-Za-z._+-]*$')
# Split-runtime assets, published in the same release as the single tarball.
# A layer file is named by its producer (kind + cache key + target, e.g.
# node-9ab12cd34ef5-win32-x64.tgz) rather than by the dsh version, and each
# matrix cell publishes its own index — so neither can be matched by the
# version-suffix rule the tarball follows, and both are validated by
# runtime_layer_problems instead. The `dsh-` kind needs its own branch: the
# single tarball (`dsh-runtime-<cell>-<version>.tgz`) starts with it too.
LAYER_ASSET_RE = re.compile(
    r'^(?:(?:node|vendor|meta|suite)-|dsh-(?!runtime-))[0-9A-Za-z][0-9A-Za-z._+-]*\.tgz$'
)
LAYER_INDEX_RE = re.compile(r'^layers-[0-9A-Za-z][0-9A-Za-z._+-]*\.json$')
# Office-payload assets, published in the same release as the runtime tarball:
# the engine tarball (version-addressed like the runtime's), its sidecar, and
# the cell's metadata JSON. Validated by runtime_payload_problems, exempt from
# the single-tarball shape rules for the same reason the layer files are — the
# `.json` carries neither a dsh version nor a `.tgz.sha512` of its own.
OFFICE_PAYLOAD_ASSET_RE = re.compile(
    r'^office-payload-[0-9A-Za-z][0-9A-Za-z._+-]*\.(?:tgz|tgz\.sha512|json)$'
)

# One file name directly below releases/latest/. No leading dot: a hidden file
# is not a release asset, and the narrowest rule is the safest one here.
LATEST_NAME_RE = re.compile(r'^[0-9A-Za-z][0-9A-Za-z._+-]*$')
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
    """Append to $GITHUB_STEP_SUMMARY and echo to the log.

    The echo is deliberate: `gh run view --log` is how a backfill or a review
    reads a run, and the rendered summary panel is not reachable that way.
    """
    for line in lines:
        log(f'summary| {line}')
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
        keep_runtime_versions=DEFAULT_KEEP_RUNTIME_VERSIONS,
        runtime_platforms=(),
    ):
        self.endpoint = endpoint
        self.repo = repo
        self.token = token
        self.gh_repo = gh_repo
        self.tag = tag
        self.only_pattern = only_pattern
        self.keep_versions = keep_versions
        self.prune_mode = prune_mode
        self.keep_runtime_versions = keep_runtime_versions
        # The matrix a runtime release must be complete for; empty means the
        # shape checks alone apply (see runtime_asset_problems).
        self.runtime_platforms = tuple(runtime_platforms or ())

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
        raw_runtime_keep = (os.environ.get('KEEP_RUNTIME_VERSIONS') or '').strip()
        try:
            keep_runtime_versions = (
                int(raw_runtime_keep) if raw_runtime_keep else DEFAULT_KEEP_RUNTIME_VERSIONS
            )
        except ValueError:
            raise MirrorError(
                f'KEEP_RUNTIME_VERSIONS must be an integer, got {raw_runtime_keep!r}'
            )
        if keep_runtime_versions < 1:
            raise MirrorError(
                f'KEEP_RUNTIME_VERSIONS must be >= 1 (got {keep_runtime_versions});'
                ' use PRUNE_MODE=off to disable runtime pruning entirely'
            )
        prune_mode = (os.environ.get('PRUNE_MODE') or '').strip() or DEFAULT_PRUNE_MODE
        if prune_mode not in PRUNE_MODES:
            raise MirrorError(
                f'PRUNE_MODE must be one of {", ".join(PRUNE_MODES)}, got {prune_mode!r}'
            )
        # Space- or comma-separated, because the workflow passes it as the shell
        # word list it also iterates over.
        runtime_platforms = tuple(
            part
            for part in re.split(r'[,\s]+', (os.environ.get('RUNTIME_PLATFORMS') or '').strip())
            if part
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
            keep_runtime_versions=keep_runtime_versions,
            runtime_platforms=runtime_platforms,
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


def latest_cleanup_allowed(path):
    """Guard for one file directly below releases/latest/. Returns (allowed, reason).

    Narrower than deletion_allowed by construction: instead of a prefix match it
    accepts exactly one file-name component below releases/latest/, so a nested
    directory, a traversal segment, an absolute path, a backslash, an empty name
    or a hidden file are all refused. Version retention refuses the whole
    directory; this guard is the only thing allowed to remove a file from it.
    """
    if not isinstance(path, str) or not path:
        return False, 'empty path'
    if path.startswith('/') or '\\' in path:
        return False, 'not a repo-relative posix path'
    if not path.startswith(LATEST_PREFIX):
        return False, f'not below {LATEST_PREFIX}'
    name = path[len(LATEST_PREFIX):]
    if not name:
        return False, f'no file name below {LATEST_PREFIX}'
    if '/' in name:
        return False, f'{LATEST_PREFIX} holds files, not subdirectories'
    if name.startswith('.'):
        return False, f'unexpected name below {LATEST_PREFIX}'
    if not LATEST_NAME_RE.match(name):
        return False, f'unsafe file name {name!r}'
    return True, ''


def build_latest_cleanup_plan(remote_files, keep_names, upload_ok=True):
    """Names under releases/latest/ that are not part of this release.

    ``keep_names`` is exactly the asset-name set this run downloaded from the
    GitHub Release and uploaded (latest*.yml included), so it needs no separate
    whitelist. Any other file below releases/latest/ was left behind by an
    earlier release and is a candidate for removal; a path the narrow guard
    rejects is a refusal, never a deletion.

    ``upload_ok`` is the ordering guard: without a successful upload and index
    commit the plan is empty, because deleting the stale-but-working copy before
    the new one is in place would leave the updater without assets.
    """
    if not upload_ok:
        return {
            'keep': [],
            'delete': [],
            'bytes': 0,
            'refusals': [],
            'skipped': 'upload or index commit did not succeed',
        }
    keep_names = set(keep_names or ())
    keep = []
    delete = []
    refusals = []
    for item in remote_files or []:
        path = (item or {}).get('path') or ''
        if not path.startswith(LATEST_PREFIX):
            continue
        allowed, reason = latest_cleanup_allowed(path)
        if not allowed:
            refusals.append((path, reason))
            continue
        entry = {'path': path, 'size': item.get('size') or 0}
        (keep if path[len(LATEST_PREFIX):] in keep_names else delete).append(entry)
    keep.sort(key=lambda entry: entry['path'])
    delete.sort(key=lambda entry: entry['path'])
    return {
        'keep': keep,
        'delete': delete,
        'bytes': sum(entry['size'] for entry in delete),
        'refusals': refusals,
        'skipped': None,
    }


def apply_latest_cleanup(cfg, api, plan):
    """Delete every stale releases/latest/ file in one commit.

    One commit keeps the operation atomic for the updater (it never observes a
    half-slimmed directory) and the SDK reports per-path failures, which are
    recorded and left for the next run instead of aborting the release.
    """
    outcome = {'deleted': [], 'failed': [], 'bytes': 0}
    paths = [entry['path'] for entry in plan['delete']]
    if not paths:
        return outcome
    log(
        f'latest cleanup: deleting {len(paths)} stale file(s) from {LATEST_PREFIX},'
        f' {human_bytes(plan["bytes"])} of LFS objects'
    )
    try:
        result = api.delete_files(
            repo_id=cfg.repo,
            repo_type='model',
            file_paths=paths,
            commit_message=f'Slim {LATEST_PREFIX} to {cfg.tag}',
            revision='master',
        )
    except BaseException as exc:  # noqa: BLE001 - reported, release stays green
        reason = cfg.redact(f'{type(exc).__name__}: {exc}')[:300]
        gha_warning(f'latest cleanup delete failed: {reason}')
        outcome['failed'].append((LATEST_PREFIX.rstrip('/'), reason))
        return outcome
    failed = list((result or {}).get('failed_files') or [])
    outcome['deleted'] = list((result or {}).get('deleted_files') or paths)
    outcome['bytes'] = plan['bytes']
    outcome['failed'] = [(path, 'reported in failed_files') for path in failed]
    for path in failed:
        gha_warning(f'latest cleanup: the SDK could not delete {path}')
    return outcome


def run_latest_cleanup(cfg, api, plan, dry_run):
    """Report-only under dry-run; otherwise delete. Returns the outcome or None."""
    if dry_run:
        log(f'latest cleanup dry-run: {len(plan["delete"])} stale file(s) would be deleted')
        return None
    return apply_latest_cleanup(cfg, api, plan)


def summary_latest_lines(plan, outcome=None, dry_run=False):
    """Render the releases/latest/ convergence section of the step summary."""
    lines = [f'#### Latest cleanup ({"dry-run" if dry_run else "apply"})', '']
    if plan['skipped']:
        lines.append(f'- Skipped: {plan["skipped"]} (the working copy stays as it was)')
        return lines
    if plan['refusals']:
        lines.append(f'- REFUSED by the latest whitelist ({len(plan["refusals"])}):')
        lines += [f'  - `{path}`: {reason}' for path, reason in plan['refusals']]
        lines.append('- No deletion was attempted; the guard rejected at least one path.')
        return lines

    lines.append(
        f'- Kept ({len(plan["keep"])}): the asset names of this release, latest*.yml included'
    )
    if not plan['delete']:
        lines.append(f'- Delete list: none (`{LATEST_PREFIX}` already holds only this release)')
        return lines

    lines.append(f'- Stale files to remove ({len(plan["delete"])}):')
    lines += [
        f'  - `{entry["path"]}` - {human_bytes(entry["size"])}' for entry in plan['delete']
    ]
    lines.append(
        f'- Stale LFS objects: {human_bytes(plan["bytes"])}'
        ' (sha256 dedup means less is freed)'
    )
    lines.append(
        '- The same files stay in `releases/archive/<version>/`, so rollback is unaffected.'
    )
    if dry_run:
        lines.append('- Dry run: no file was deleted')
        return lines
    if outcome is not None:
        lines.append(f'- Deleted {len(outcome["deleted"])} of {len(plan["delete"])} file(s)')
        if outcome['failed']:
            lines.append(f'- WARNING: delete failed for {len(outcome["failed"])} file(s):')
            lines += [f'  - `{path}`: {reason}' for path, reason in outcome['failed']]
            lines.append(
                '- The mirror commit already succeeded; retry with'
                ' `-f tag=... -f prune_mode=apply`.'
            )
    return lines


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
# Runtime artifacts (releases/runtime/<tag>/)
# ----------------------------------------------------------------------
# A kernel runtime release (tag `runtime-<dshVersion>`) is mirrored on its own
# path, index and retention policy. The three separations are properties of the
# code, not conventions a future edit has to remember:
#
#   * path   - this flow writes and deletes only below releases/runtime/<tag>/,
#              and its guard (runtime_deletion_allowed) accepts nothing else.
#              The shell guard refuses releases/runtime/ and the runtime guard
#              refuses releases/archive|prerelease/, so neither policy can delete
#              the other tree, and neither can reach releases/latest/ or
#              releases/versions.json.
#   * index  - releases/versions.json is neither read nor written here. The
#              runtime layout is self-describing (the directory name IS the
#              release tag), which keeps a stale or unreadable shell index from
#              blocking a kernel mirror and a kernel mirror from dropping a shell
#              version the updater still offers.
#   * latest - releases/latest/ is the shell's rolling copy of shell installers:
#              not a target here, and not part of the runtime cleanup either.
#
# Retention therefore ranks the remote directory listing instead of an index,
# under its own window (KEEP_RUNTIME_VERSIONS), and the tag being published is
# always kept.
#
# A runtime release carries three shapes of asset: the single tarball with its
# sidecar and manifest (the fallback every client can always use), since the
# split-runtime work the layer set - five layer files plus `layers-<cell>.json`
# per matrix cell - and, since the office engine left the runtime, the per-cell
# office payload (its version-addressed tarball, that tarball's sidecar and the
# cell's metadata JSON). All are flat files in the same directory, so the
# upload, the retention window and the delete guard treat them identically; only
# the completeness check distinguishes them (runtime_asset_problems for the
# tarball, runtime_layer_problems for the optional layer set,
# runtime_payload_problems for the payload - which is all-or-nothing across the
# cells, and the release's own per-cell manifests are what says a payload was
# built at all: one cell arriving without it is a half upload whose office
# conversion would 404 forever).
def is_runtime_tag(tag):
    """True for a `runtime-<dshVersion>` kernel release tag."""
    return str(tag).lower().startswith(RUNTIME_TAG_PREFIX)


def runtime_version_of(tag):
    """`runtime-0.1.5-rc.2` -> `0.1.5-rc.2` (the dsh version, not the tag)."""
    text = str(tag)
    if text.lower().startswith(RUNTIME_TAG_PREFIX):
        return text[len(RUNTIME_TAG_PREFIX):]
    return text


def runtime_deletion_allowed(path):
    """Whitelist guard for one runtime delete path. Returns (allowed, reason).

    Positive allowlist, and deliberately narrower than the shell guard: exactly
    `releases/runtime/<tag>/<file>`, with a validated tag directory and no
    subdirectory below it. The runtime layout is flat by construction (the app
    resolves one URL per asset), so a nested path under a version directory is
    an unknown layout and is refused rather than guessed at. Everything else -
    releases/latest/, releases/archive/, releases/prerelease/,
    releases/versions.json, the repo root, .gitattributes, absolute paths, any
    traversal form - is refused, which is what makes a runtime retention bug
    incapable of touching a shell asset.
    """
    if not isinstance(path, str) or not path:
        return False, 'empty path'
    if path.startswith('/') or '\\' in path:
        return False, 'not a repo-relative posix path'
    if any(segment in ('', '.', '..') for segment in path.split('/')):
        return False, 'unexpected path segment'
    if path == VERSIONS_PATH:
        return False, f'{VERSIONS_PATH} is rewritten, never deleted'
    if path.startswith(LATEST_PREFIX):
        return False, f'{LATEST_PREFIX} is never pruned'
    prefix = None
    for candidate in RUNTIME_DELETABLE_PREFIXES:
        if path.startswith(candidate):
            prefix = candidate
            break
    if prefix is None:
        return False, f'outside {", ".join(RUNTIME_DELETABLE_PREFIXES)}'
    parts = path[len(prefix):].split('/')
    if len(parts) != 2:
        return False, f'expected exactly {prefix}<tag>/<file>'
    directory, name = parts
    if not RUNTIME_TAG_RE.match(directory):
        return False, f'unexpected runtime directory {directory!r}'
    if not RUNTIME_NAME_RE.match(name):
        return False, f'unsafe file name {name!r}'
    return True, ''


def runtime_directories(remote_files):
    """Split a remote inventory into runtime version directories and strays.

    Returns (directories, strays): `directories` is the sorted set of names
    directly below releases/runtime/ that hold files, `strays` is every path
    sitting directly below the prefix itself. A stray is not a layout this
    script writes, so it is reported and never deleted.
    """
    directories = set()
    strays = []
    for item in remote_files or ():
        path = (item or {}).get('path') or ''
        if not path.startswith(RUNTIME_PREFIX):
            continue
        rest = path[len(RUNTIME_PREFIX):]
        if '/' not in rest:
            strays.append(path)
            continue
        directories.add(rest.split('/', 1)[0])
    return sorted(directories), sorted(strays)


def plan_runtime_retention(remote_files, keep_runtime_versions, current_tag):
    """Split the runtime tree into the kept set and the delete candidates.

    The remote directory listing is the only source of truth: unlike shell
    versions there is no index to rank, and the directory name carries the
    version. Versions are ranked by semver, newest first, and the newest
    `keep_runtime_versions` are kept; the tag being published is always kept,
    even when it ranks below the cut-off (a backfill of an older kernel line
    must not delete what it just uploaded). A directory whose name is not
    `runtime-<semver>` is never a candidate: the policy does not delete what it
    cannot rank, and the kept-set report makes such a directory visible.

    One window covers the whole tree (no per-channel split like the shell's):
    a runtime version is an artifact for a dsh version, and stable and
    prerelease kernel lines are the same kind of object to the app.
    """
    directories, strays = runtime_directories(remote_files)
    ranked = []
    unranked = []
    for name in directories:
        # Only our own directory shape is rankable. A stray directory (no
        # `runtime-` prefix, or a non-semver version) is reported and left alone
        # rather than guessed at.
        if not RUNTIME_TAG_RE.match(name):
            unranked.append(name)
            continue
        key = semver_sort_key(runtime_version_of(name))
        if key is None:
            unranked.append(name)
            continue
        ranked.append((key, name))
    ordered = sorted(ranked, reverse=True)
    kept = [name for _, name in ordered[:keep_runtime_versions]]
    candidates = []
    for _, name in ordered[keep_runtime_versions:]:
        if name == current_tag:
            kept.append(name)
            continue
        candidates.append(name)
    return {
        'kept': kept,
        'candidates': candidates,
        'unranked': unranked,
        'strays': strays,
        'current_tag': current_tag,
        'keep_runtime_versions': keep_runtime_versions,
    }


def build_runtime_delete_plan(candidates, remote_files, current_tag):
    """Turn runtime retention candidates into delete entries plus refusals.

    Same shape as the shell planner: a candidate whose directory holds a path
    the guard refuses is not deleted at all - it becomes a refusal, and the
    caller aborts the run instead of deleting the subset it could classify.
    """
    entries = []
    refusals = []
    for tag in candidates:
        if tag == current_tag:
            # Belt and braces: the tag being published is never a candidate.
            continue
        if '\\' in str(tag) or not RUNTIME_TAG_RE.match(str(tag)):
            refusals.append((tag, f'unsafe runtime directory name {tag!r}'))
            continue
        prefix = f'{RUNTIME_PREFIX}{tag}/'
        files = [item for item in remote_files if item['path'].startswith(prefix)]
        rejected = []
        for item in files:
            allowed, reason = runtime_deletion_allowed(item['path'])
            if not allowed:
                rejected.append((item['path'], reason))
        if rejected:
            for path, reason in rejected:
                refusals.append((tag, f'{path}: {reason}'))
                gha_error(f'refusing to delete {path}: {reason}')
            continue
        entries.append({
            'version': runtime_version_of(tag),
            'tag': tag,
            'prefix': prefix,
            'paths': [item['path'] for item in files],
            'bytes': sum(item['size'] for item in files),
        })
    return entries, refusals


def guard_runtime_entries(entries):
    """Abort the run if any path of any entry is outside the runtime allowlist.

    Run over the whole plan before the first delete, not per entry: a poisoned
    entry must not be preceded by deletions that already happened. Raises
    MirrorError, which main() reports as FAILED - a layout the policy cannot
    place is never silently skipped.
    """
    refused = []
    for entry in entries or ():
        for path in (entry or {}).get('paths') or ():
            allowed, reason = runtime_deletion_allowed(path)
            if not allowed:
                refused.append(f'{path}: {reason}')
    if refused:
        raise MirrorError(
            f'refusing to delete {len(refused)} path(s) outside the runtime'
            ' whitelist: ' + '; '.join(refused[:5])
        )


def apply_runtime_prune(cfg, api, entries):
    """Delete one runtime version per commit so one failure cannot block others.

    There is no index to keep in sync, so a failed delete simply leaves the
    directory in place for the next run to retry.
    """
    guard_runtime_entries(entries)
    outcome = {'deleted': [], 'failed': []}
    for entry in entries:
        paths = entry['paths']
        if not paths:
            log(f'{entry["prefix"]}: no remote file left, nothing to delete')
            continue
        log(f'{entry["prefix"]}: deleting {len(paths)} file(s), {human_bytes(entry["bytes"])}')
        try:
            result = api.delete_files(
                repo_id=cfg.repo,
                repo_type='model',
                file_paths=paths,
                commit_message=(
                    f'Prune runtime {entry["tag"]}'
                    f' (keep {cfg.keep_runtime_versions} runtime version(s))'
                ),
                revision='master',
            )
        except BaseException as exc:  # noqa: BLE001 - reported, then next version
            reason = cfg.redact(f'{type(exc).__name__}: {exc}')[:300]
            gha_warning(f'delete failed for {entry["prefix"]}: {reason}')
            outcome['failed'].append((entry['tag'], reason))
            continue
        failed_paths = list((result or {}).get('failed_files') or [])
        if failed_paths:
            gha_warning(f'{entry["prefix"]}: SDK reported failed_files {failed_paths[:5]}')
            outcome['failed'].append((entry['tag'], f'failed_files: {failed_paths[:5]}'))
            continue
        deleted = len((result or {}).get('deleted_files') or paths)
        log(f'{entry["prefix"]}: deleted {deleted} file(s)')
        outcome['deleted'].append({
            'version': entry['version'],
            'files': deleted,
            'bytes': entry['bytes'],
        })
    return outcome


def runtime_asset_problems(names, version, platforms=None):
    """Problems with a downloaded runtime asset set; an empty list means OK.

    Two layers, and the second is the one that matters:

    * shape - a tgz with its sidecar plus a manifest, and every archive/sidecar
      carrying THIS version. The mirror path is derived from the tag, so an
      asset built for another dsh version would otherwise be published under
      this one's path.
    * matrix - when `platforms` is known (RUNTIME_PLATFORMS, the same list
      release.yml builds and the app resolves one URL per entry), every one of
      them must be present with all three assets. Without it a run that catches
      the six-cell matrix mid-upload - which is the normal state of a runtime
      release for tens of minutes - would publish a mirror whose missing cells
      answer 404 while looking healthy, and nothing would ever repair it.

    Split-layer and office-payload assets ride along in the same release and are
    EXEMPT from both rules: their names are not the single tarball's (the layer
    files are content/suite-addressed and carry no sidecar; the payload's
    metadata JSON carries no dsh version), and a release published before either
    existed has none. They are validated by runtime_layer_problems and
    runtime_payload_problems, and on their own neither ever satisfies the
    "an archive is present" requirement.
    """
    names = list(names or ())
    present = set(names)
    single = [name for name in names if not is_layer_asset(name) and not is_payload_asset(name)]
    archives = [name for name in single if name.endswith('.tgz')]
    sidecars = [name for name in single if name.endswith('.tgz.sha512')]
    manifests = [
        name for name in names if name.startswith('manifest-') and name.endswith('.json')
    ]
    problems = []
    if not archives:
        problems.append('no *.tgz asset')
    if not manifests:
        problems.append('no manifest-<platform>-<arch>.json asset')
    for name in archives + sidecars:
        if not name.endswith((f'-{version}.tgz', f'-{version}.tgz.sha512')):
            problems.append(f'{name} does not carry the version {version}')
    for name in archives:
        if f'{name}.sha512' not in sidecars:
            problems.append(f'{name} has no .sha512 sidecar')
    for platform in platforms or ():
        for name in (
            f'dsh-runtime-{platform}-{version}.tgz',
            f'dsh-runtime-{platform}-{version}.tgz.sha512',
            f'manifest-{platform}.json',
        ):
            if name not in present:
                problems.append(f'missing {name}')
    return problems


def is_layer_asset(name):
    """True for a split-runtime layer file or a per-cell layer index."""
    return bool(LAYER_ASSET_RE.match(name) or LAYER_INDEX_RE.match(name))


def is_payload_asset(name):
    """True for one of a cell's three office-payload assets."""
    return bool(OFFICE_PAYLOAD_ASSET_RE.match(name))


def read_payload_declarations(assets_dir, names):
    """The cells whose per-cell manifest declares an `officePayload` block.

    The runtime manifest IS the release's own statement about what it carries:
    `build-runtime.mjs` writes the block whenever it built a payload, and
    uploads the block and the artifacts in the same cell step. Reading the
    declarations therefore makes "this release owes an engine per cell" a fact
    of the release instead of an inference from which files happened to arrive —
    which is what lets a release whose payload upload failed for EVERY cell be
    refused rather than mirrored quietly. An unreadable body contributes
    nothing; the caller's shape checks catch what that implies.
    """
    cells = set()
    for name in names or ():
        if not name.startswith('manifest-') or not name.endswith('.json'):
            continue
        try:
            body = json.loads((Path(assets_dir) / name).read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if isinstance(body, dict) and isinstance(body.get('officePayload'), dict):
            cells.add(name[len('manifest-'):-len('.json')])
    return cells


def runtime_payload_problems(names, version, platforms=None, declared=None):
    """Problems with the office-payload assets of a runtime release set.

    The payload is the LibreOffice engine the runtime no longer carries: the
    shell downloads it once per content version, when a user converts a
    document, and resolves exactly one URL per cell - so a mirror that carries
    the runtime tarball but not the payload leaves that cell's office
    conversion permanently unavailable. That is invisible from the runtime
    install (the tree boots fine without an engine) and invisible to every
    other check here, which is why it gets its own predicate.

    The rules, in two layers:

    * shape (always) - every payload tarball and sidecar carries THIS version
      (the mirror path is derived from the tag, so an artifact built for another
      kernel version would be published under this one's path), every tarball
      has its `.sha512` sidecar, and no sidecar is orphaned. The metadata JSON
      carries no version by design (the tag names the kernel), so only its
      presence per cell is checked.
    * matrix (when `platforms` is known, or `declared` names any cell) - the
      payload is ALL-OR-NOTHING across the cells. `declared` is what the
      release's own manifests say (read_payload_declarations): a cell that
      declares an engine owes all three assets, and because one release is one
      build, a declaration ANYWHERE means every cell in the matrix owes them.
      Without this a release whose payload upload failed would mirror with a
      hole the app turns into a permanent 404 for that platform, and nothing
      would ever repair it. A release that declares NO payload and carries none
      is not a problem: a line without the office provider needs none, and every
      runtime published before the payload existed carries none - requiring one
      would strand exactly those old releases on the backfill path.
    """
    names = [name for name in (names or ()) if is_payload_asset(name)]
    present = set(names)
    archives = [name for name in names if name.endswith('.tgz')]
    sidecars = [name for name in names if name.endswith('.tgz.sha512')]
    problems = []
    for name in archives + sidecars:
        if not name.endswith((f'-{version}.tgz', f'-{version}.tgz.sha512')):
            problems.append(f'{name} does not carry the version {version}')
    for name in archives:
        if f'{name}.sha512' not in sidecars:
            problems.append(f'{name} has no .sha512 sidecar')
    # A sidecar with no archive is half an upload, not a payload: it is refused
    # rather than mirrored as a file nothing can ever verify against.
    for name in sidecars:
        if name[: -len('.sha512')] not in present:
            problems.append(f'{name} has no matching archive')
    # Which cells owe a payload: whatever the release's own manifests declare,
    # or — when none is readable — every cell once any payload asset is present.
    # A declaration ANYWHERE means every matrix cell owes one: one release is
    # one build, so a cell without the block would be the odd one out.
    required = set(declared or ())
    if not required and present:
        required = set(platforms or ())
    if required and platforms:
        required |= set(platforms)
    for platform in sorted(required):
        for name in (
            f'office-payload-{platform}-{version}.tgz',
            f'office-payload-{platform}-{version}.tgz.sha512',
            f'office-payload-{platform}.json',
        ):
            if name not in present:
                problems.append(f'missing {name}')
    return problems


def read_layer_indexes(assets_dir, names):
    """{index asset name: parsed body or None} for the layer indexes present.

    ``None`` records "this file exists but is not readable JSON", itself a
    problem: the client resolves an index BEFORE downloading any layer, so a
    mirror serving a broken one is worse than a mirror serving none - the
    official host would have answered instead.
    """
    indexes = {}
    for name in names:
        if not LAYER_INDEX_RE.match(name):
            continue
        try:
            indexes[name] = json.loads((Path(assets_dir) / name).read_text(encoding='utf-8'))
        except (OSError, ValueError):
            indexes[name] = None
    return indexes


def runtime_layer_problems(names, indexes, platforms=None):
    """Problems with the split-layer assets of a runtime release set.

    Layer assets are OPTIONAL: the app falls back to the single tarball when a
    release has none, and every runtime published before the split existed has
    none, so an absent layer set is not a problem. A set that IS present must be
    usable, which is what the checks below enforce:

    * an index must be readable, must name its layers, and must be labelled with
      its own cell (six cells publish six indexes, and the app resolves exactly
      one of them);
    * every file an index names must be present, or the client resolves an index
      and then 404s on the layers it points at - the partial-mirror failure this
      whole module refuses to publish;
    * every layer file must be named by some index. An orphan means a cell
      uploaded half its set (or uploaded it before its index), which is the same
      partial state seen from the other side.

    ``platforms`` is NOT used to require layers per cell - only to reject an
    index for a cell outside the matrix when the matrix is known.
    """
    names = list(names or ())
    present = set(names)
    problems = []
    claimed = set()
    for index_name, body in sorted((indexes or {}).items()):
        cell = index_name[len('layers-'):-len('.json')]
        if platforms and cell not in platforms:
            problems.append(f'{index_name} is not one of the runtime cells ({cell})')
            continue
        if body is None:
            problems.append(f'{index_name} is not readable JSON')
            continue
        if not isinstance(body, dict):
            problems.append(f'{index_name} is not a JSON object')
            continue
        if f'{body.get("platform")}-{body.get("arch")}' != cell:
            problems.append(
                f'{index_name} describes {body.get("platform")}-{body.get("arch")}'
                f' but is published as {cell}'
            )
            continue
        layers = body.get('layers')
        if not isinstance(layers, list) or not layers:
            problems.append(f'{index_name} names no layers')
            continue
        for entry in layers:
            name = entry.get('name') if isinstance(entry, dict) else None
            if not isinstance(name, str) or not LAYER_ASSET_RE.match(name):
                problems.append(f'{index_name} names an invalid layer {name!r}')
                continue
            claimed.add(name)
            if name not in present:
                problems.append(f'{index_name} names {name}, which the release does not carry')
    for name in sorted(present):
        if LAYER_ASSET_RE.match(name) and name not in claimed:
            problems.append(f'{name} is not named by any layer index')
    return problems


def summary_runtime_lines(plan, entries, refusals, outcome=None, dry_run=False, skipped=None,
                          mode='apply'):
    """Render the runtime prune section: kept set, delete list, actual action.

    ``mode`` is the PRUNE_MODE in force, so a section that did nothing says which
    setting decided that (``off``) instead of claiming the mode it did not use.
    """
    heading = 'dry-run' if dry_run else mode
    lines = [f'#### Runtime prune ({heading})', '']
    if skipped:
        lines.append(f'- Skipped: {skipped}')
        return lines

    lines.append(
        f'- Source: the directory listing of `{RUNTIME_PREFIX}` (runtime assets have'
        ' no index, so the listing is the policy\'s only input)'
    )
    lines.append(
        f'- Keep policy: newest `{plan["keep_runtime_versions"]}` runtime version(s);'
        f' current tag `{plan["current_tag"]}` always kept'
    )
    lines.append(f'- Retained ({len(plan["kept"])}): {", ".join(plan["kept"]) or "none"}')
    if plan['unranked']:
        lines.append(
            f'- Not semver-ranked, never pruned ({len(plan["unranked"])}):'
            f' {", ".join(plan["unranked"])}'
        )
    if plan['strays']:
        lines.append(
            f'- Files directly below `{RUNTIME_PREFIX}` ({len(plan["strays"])}),'
            ' not a layout this script writes, kept as found:'
        )
        lines += [f'  - `{path}`' for path in plan['strays']]
    lines.append(f'- `{VERSIONS_PATH}` and `{LATEST_PREFIX}` are out of scope for runtime')
    if refusals:
        lines.append(f'- REFUSED by the runtime whitelist ({len(refusals)}):')
        lines += [f'  - `{tag}`: {reason}' for tag, reason in refusals]
        lines.append('- No deletion was attempted; the guard rejected at least one path.')
        return lines

    if not entries:
        lines.append(
            f'- Delete list: none (every `{RUNTIME_PREFIX}` version is inside the'
            ' retention window)'
        )
        return lines

    lines.append(f'- Delete list ({len(entries)}):')
    for entry in entries:
        lines.append(
            f'  - `{entry["prefix"]}` - {len(entry["paths"])} file(s),'
            f' {human_bytes(entry["bytes"])} of LFS objects (sha256 dedup means less is freed)'
        )
    if dry_run:
        lines.append('- Dry run: no file was deleted')
        return lines
    if outcome is not None:
        if outcome['deleted']:
            lines.append(
                f'- Deleted ({len(outcome["deleted"])}):'
                f' {", ".join(item["version"] for item in outcome["deleted"])}'
            )
        if outcome['failed']:
            lines.append(f'- WARNING: delete failed for {len(outcome["failed"])} version(s):')
            lines += [f'  - `{tag}`: {reason}' for tag, reason in outcome['failed']]
            lines.append(
                '- The directory stays as it was; re-run'
                f' `gh workflow run publish-mirror.yml -f tag={plan["current_tag"]}'
                ' -f prune_mode=apply` to retry.'
            )
    return lines


def subcommand_mirror_runtime(cfg):
    """Mirror a `runtime-<dshVersion>` release into releases/runtime/<tag>/."""
    tag = cfg.tag
    if not RUNTIME_TAG_RE.match(tag):
        raise MirrorError(
            f'invalid runtime release tag {tag!r}: expected runtime-<dshVersion>'
        )
    version = runtime_version_of(tag)
    target = f'{RUNTIME_PREFIX}{tag}'
    partial = bool(cfg.only_pattern)

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

    names = [item.name for item in files]
    problems = runtime_asset_problems(names, version, cfg.runtime_platforms)
    problems += runtime_payload_problems(
        names,
        version,
        cfg.runtime_platforms,
        read_payload_declarations(assets_dir, names),
    )
    problems += runtime_layer_problems(
        names,
        read_layer_indexes(assets_dir, names),
        cfg.runtime_platforms,
    )
    if problems and not partial:
        # An incomplete set would publish a mirror that answers 404 for the
        # cells that never arrived, and the app resolves one URL per cell: a
        # mirror with a hole in it looks healthy and fails a download. Refuse
        # before uploading anything; a drill is incomplete by design and is
        # reported instead, and it never prunes.
        raise MirrorError(
            f'the downloaded assets are not a complete runtime set for {version}:'
            ' ' + '; '.join(problems)
            + ' (a runtime release is completed by a six-cell matrix, so wait for'
              ' it to finish and dispatch the mirror again)'
        )

    warnings = []
    if partial:
        warnings.append(
            f'PARTIAL DRILL ON RUNTIME TAG `{tag}`: only the assets matching'
            f' `{cfg.only_pattern}` are considered, so `{target}` is incomplete by'
            ' design and retention was skipped.'
        )
        log(f'WARNING: {warnings[-1]}')

    info = [
        f'Release: `{tag}` (kernel runtime assets, dsh {version})',
        f'Target: `{cfg.repo}`',
        f'Path: `{target}`',
        f'Files: {len(files)} asset(s)'
        + (f' (only_pattern `{cfg.only_pattern}`)' if partial else ''),
        f'Index: `{VERSIONS_PATH}` untouched (runtime assets have no shell index entry)',
        f'Rolling copy: `{LATEST_PREFIX}` untouched',
        f'SDK: {sdk_runtime_info()}',
    ]
    log(f'mirror plan: {tag} (runtime) -> {cfg.repo} [{target}]')

    api = load_modelscope_api(cfg)
    log(f'uploading {len(files)} file(s) to {target}')
    result = api.upload_folder(
        repo_id=cfg.repo,
        repo_type='model',
        folder_path=str(assets_dir),
        path_in_repo=target,
        commit_message=f'Mirror {tag} from {cfg.gh_repo} to {target}',
        disable_tqdm=True,
    )
    if result is None:
        log(f'{target}: already up to date, nothing new to commit')
    else:
        batches = len(result) if isinstance(result, list) else 1
        log(f'{target}: committed in {batches} batch(es)')

    refused = []
    prune_failed = False
    if partial:
        prune_lines = summary_runtime_lines(
            None, [], [],
            skipped='only_pattern drill uploads a subset of a version',
            mode=cfg.prune_mode,
        )
    elif cfg.prune_mode == 'off':
        prune_lines = summary_runtime_lines(
            None, [], [],
            skipped='PRUNE_MODE=off (the runtime tree was not even listed)',
            mode='off',
        )
    else:
        # The inventory is read after the upload so the just-published directory
        # is visible in it; the current tag is excluded from the candidates by
        # name as well, so a stale listing cannot cost a version the run needed.
        remote_files = fetch_remote_files(api, cfg)
        log(f'remote inventory: {len(remote_files)} file(s)')
        plan = plan_runtime_retention(remote_files, cfg.keep_runtime_versions, tag)
        entries, refused = build_runtime_delete_plan(plan['candidates'], remote_files, tag)
        if refused:
            gha_error(
                f'runtime prune refused {len(refused)} path(s) outside the delete whitelist'
            )
            prune_lines = summary_runtime_lines(plan, entries, refused)
        elif cfg.prune_mode == 'dry-run':
            log(
                f'runtime prune dry-run: {len(entries)} version(s) outside'
                f' keep_runtime_versions={cfg.keep_runtime_versions} would be deleted'
            )
            prune_lines = summary_runtime_lines(plan, entries, refused, dry_run=True)
        else:
            outcome = apply_runtime_prune(cfg, api, entries)
            prune_failed = bool(outcome['failed'])
            prune_lines = summary_runtime_lines(plan, entries, refused, outcome=outcome)

    # Nothing above touched releases/versions.json or releases/latest/, so the
    # summary says so explicitly: a reviewer reading a runtime mirror must be
    # able to see that the shell side was out of scope, not merely untouched.
    title = 'runtime' + (', partial drill' if partial else '')
    write_summary(
        [f'### ModelScope mirror: OK ({title})', '']
        + [f'- {item}' for item in info]
        + [f'- WARNING: {item}' for item in warnings]
        + [
            '',
            *prune_lines,
            '',
            f'- No shell asset was read, written or deleted'
            f' (`{ARCHIVE_PREFIX}`, `{PRERELEASE_PREFIX}`, `{LATEST_PREFIX}`,'
            f' `{VERSIONS_PATH}` are out of scope for a runtime tag)',
            '',
            f'- Backfill if this run needs repeating: `{cfg.backfill}`',
        ]
    )
    if refused:
        # A refused delete path means the retention model disagrees with the
        # repository layout: the assets are uploaded, but this must be looked at,
        # so the run does not finish green.
        fail(
            f'runtime prune refused {len(refused)} path(s) outside the delete whitelist;'
            ' no file was deleted',
            backfill=cfg.backfill,
        )
    log(f'OK: {tag} mirrored to {cfg.repo}')
    if prune_failed:
        # The mirror is committed; only the cleanup needs attention, so keep the
        # run green and say so.
        gha_warning('runtime prune did not complete; see the step summary')


# ----------------------------------------------------------------------
# Subcommands
# ----------------------------------------------------------------------
def subcommand_mirror(cfg):
    """Upload the release, rebuild the index, then prune by policy."""
    if is_runtime_tag(cfg.tag):
        # Kernel runtime assets have no shell index, no rolling copy and their
        # own retention window, so they take a separate flow. It is entered from
        # this subcommand - not from a new mode value - because the tag shape is
        # already unambiguous: the operator cannot dispatch `mode=mirror` with
        # the wrong half, and a runtime tag, which used to fail outright, now
        # works with the same backfill command as a shell release.
        return subcommand_mirror_runtime(cfg)
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
        f'Files: {len(files)} asset(s)'
        + (f' (only_pattern `{cfg.only_pattern}`)' if partial else ''),
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
    # releases/latest/ is converged after a full stable publish; a prerelease
    # never writes it, and a partial drill must not, because its whitelist would
    # only cover the subset it uploaded.
    latest_cleanup = not partial and not prerelease
    remote_files = None
    if not partial and (cfg.prune_mode != 'off' or latest_cleanup):
        # One inventory serves both the retention prune and the latest cleanup.
        remote_files = fetch_remote_files(api, cfg)
        log(f'remote inventory: {len(remote_files)} file(s)')
    if not partial and cfg.prune_mode != 'off':
        plan = plan_retention(versions, cfg.keep_versions, cfg.tag)
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

    # Latest cleanup runs only now, after every asset upload AND the index
    # commit succeeded: the working copy the updater reads first must never be
    # stripped before the new release is fully in place. It is not a retention
    # rule, so keep_versions does not gate it; PRUNE_MODE=dry-run only makes it
    # report; releases/archive/, releases/prerelease/ and versions.json are
    # never touched.
    latest_lines = ['#### Latest cleanup: skipped (partial drill)', '']
    latest_refused = []
    latest_failed = False
    if latest_cleanup:
        keep_names = [item.name for item in files]
        latest_plan = build_latest_cleanup_plan(remote_files, keep_names)
        if latest_plan['refusals']:
            for path, reason in latest_plan['refusals']:
                gha_error(f'refusing to delete {path}: {reason}')
            latest_lines = summary_latest_lines(latest_plan)
            latest_refused = latest_plan['refusals']
        elif cfg.prune_mode == 'dry-run':
            latest_lines = summary_latest_lines(latest_plan, dry_run=True)
            run_latest_cleanup(cfg, api, latest_plan, dry_run=True)
        else:
            latest_outcome = run_latest_cleanup(cfg, api, latest_plan, dry_run=False)
            latest_failed = bool(latest_outcome['failed'])
            latest_lines = summary_latest_lines(latest_plan, outcome=latest_outcome)
    elif not partial:
        latest_lines = [
            '#### Latest cleanup: skipped (a prerelease never writes releases/latest/)',
            '',
        ]

    write_summary(
        [f'### ModelScope mirror: OK{" (partial drill)" if partial else ""}', '']
        + [f'- {item}' for item in info]
        + [f'- WARNING: {item}' for item in warnings]
        + [
            '', *prune_lines,
            '', *latest_lines,
            '', f'- Backfill if this run needs repeating: `{cfg.backfill}`',
        ]
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
    if latest_refused:
        # The mirror is committed, but the guard refused at least one path below
        # releases/latest/: the layout is not what the cleanup expects, so fail
        # loudly instead of deleting something the rule cannot classify.
        fail(
            f'latest cleanup refused {len(latest_refused)} path(s) below {LATEST_PREFIX};'
            ' no stale file was deleted',
            backfill=cfg.backfill,
        )
    log(f'OK: {cfg.tag} mirrored to {cfg.repo}')
    if prune_failed or latest_failed:
        # The release is already published and the mirror is committed; only the
        # cleanup needs attention, so keep the run green and say so.
        gha_warning('prune or latest cleanup did not complete; see the step summary')


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
