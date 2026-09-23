/**
 * npm-side primitive tests: package-name validation, exact-version
 * validation, registry URL building, output tailing, profile-name hygiene,
 * and the kernel CLI locator's entry-script walk-up.
 *
 * @module plugin-market/tests/npm
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { MarketValidationError } from '../src/errors.ts'
import {
  compareVersions,
  EXACT_VERSION_PATTERN,
  LATEST_PROBE_CONCURRENCY,
  latestVersionsOf,
  PACKAGE_NAME_PATTERN,
  registryUrl,
  resolveDshBin,
  resolveRegistryVersion,
  tailLines,
  validateExactVersion,
  validatePackageName,
  validateProfileName,
} from '../src/npm.ts'

describe('validatePackageName', () => {
  it('accepts plain and scoped npm names', () => {
    for (const name of ['react', 'dsh-git-conventions', '@dsh-app/plugin-market', '@scope/a.b_c-d~e0', 'a1']) {
      assert.equal(validatePackageName(name), name)
    }
  })

  it('rejects non-strings and empties', () => {
    assert.throws(() => validatePackageName(undefined), MarketValidationError)
    assert.throws(() => validatePackageName(42), MarketValidationError)
    assert.throws(() => validatePackageName(''), MarketValidationError)
    assert.throws(() => validatePackageName('   '), MarketValidationError)
  })

  it('rejects names outside the npm grammar', () => {
    for (const name of ['React', 'has space', '../etc/passwd', '@scope', '/leading', 'pkg@1.2.3', 'a/b', 'x\ny', 'javascript:alert(1)']) {
      assert.throws(() => validatePackageName(name), MarketValidationError, `expected rejection: ${name}`)
    }
  })

  it('rejects names longer than the npm cap', () => {
    assert.throws(() => validatePackageName('a'.repeat(215)), MarketValidationError)
    assert.equal(PACKAGE_NAME_PATTERN.test('a'.repeat(214)), true)
  })
})

describe('validateExactVersion', () => {
  it('accepts exact semver forms and returns them trimmed', () => {
    assert.equal(validateExactVersion('1.2.3'), '1.2.3')
    assert.equal(validateExactVersion(' 0.1.5-rc.1 '), '0.1.5-rc.1')
    assert.equal(validateExactVersion('1.2.3+build.7'), '1.2.3+build.7')
    assert.equal(validateExactVersion(undefined), undefined)
    assert.equal(validateExactVersion(''), undefined)
  })

  it('rejects ranges, tags, and malformed versions', () => {
    for (const version of ['^1.2.3', '~1.2.3', '>=1.0.0', 'latest', '*', '1.2', '1.2.x', 42]) {
      assert.throws(() => validateExactVersion(version), MarketValidationError, `expected rejection: ${String(version)}`)
    }
    assert.equal(EXACT_VERSION_PATTERN.test('1.2.3-rc.1+build'), true)
  })
})

describe('registryUrl', () => {
  it('percent-encodes scoped names into the path', () => {
    assert.equal(registryUrl('react'), 'https://registry.npmjs.org/react/latest')
    assert.equal(registryUrl('@dsh-app/plugin-market'), 'https://registry.npmjs.org/%40dsh-app%2Fplugin-market/latest')
    assert.equal(registryUrl('react', '1.2.3'), 'https://registry.npmjs.org/react/1.2.3')
  })
})

describe('tailLines', () => {
  it('keeps the last N non-empty lines', () => {
    const text = ['a', '', 'b', 'c', 'd'].join('\n')
    assert.equal(tailLines(text, 2), 'b\nc\nd'.split('\n').slice(-2).join('\n'))
    assert.equal(tailLines('x\n\ny', 10), 'x\ny')
    assert.equal(tailLines('', 5), '')
    assert.equal(tailLines('l1\r\nl2\r\nl3', 2), 'l2\nl3')
  })
})

describe('compareVersions', () => {
  /** LocaleCompare-style shorthand: the comparator must reproduce sign(a - b). */
  const expectOrder = (a: string, b: string, expected: number): void => {
    assert.equal(compareVersions(a, b), expected, `${a} vs ${b}`)
    assert.equal(compareVersions(b, a), -expected, `${b} vs ${a}`)
  }

  it('answers 0 for equal and zero-padded versions', () => {
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
    assert.equal(compareVersions('01.02.03', '1.2.3'), 0)
    assert.equal(compareVersions('1.2.3+build.7', '1.2.3+other'), 0)
  })

  it('compares segment by segment with numeric order', () => {
    expectOrder('1.2.3', '1.2.4', -1)
    expectOrder('1.2.3', '1.10.0', -1)
    expectOrder('2.0.0', '1.99.99', 1)
    expectOrder('1.0.0', '1.0.0-rc.1', 1)
  })

  it('ranks a release above any prerelease of the same core version', () => {
    expectOrder('1.0.0-rc.1', '1.0.0', -1)
    expectOrder('1.0.0-alpha', '1.0.0', -1)
  })

  it('orders prerelease identifiers by semver precedence', () => {
    expectOrder('1.0.0-alpha', '1.0.0-beta', -1)
    expectOrder('1.0.0-alpha', '1.0.0-alpha.1', -1)
    expectOrder('1.0.0-rc.1', '1.0.0-rc.2', -1)
    expectOrder('1.0.0-alpha.1', '1.0.0-beta.1', -1)
  })

  it('sorts numeric identifiers below alphanumeric ones', () => {
    expectOrder('1.0.0-1', '1.0.0-alpha', -1)
    expectOrder('1.0.0-2', '1.0.0-10', -1)
  })

  it('answers 0 for malformed input instead of throwing', () => {
    assert.equal(compareVersions('not-a-version', '1.2.3'), 0)
    assert.equal(compareVersions('1.2.3', ''), 0)
    assert.equal(compareVersions('^1.2.3', '1.2.3'), 0)
  })
})

describe('validateProfileName', () => {
  it('accepts simple profile names and rejects path-shaped ones', () => {
    assert.equal(validateProfileName('web'), 'web')
    assert.equal(validateProfileName('my-profile_2'), 'my-profile_2')
    assert.throws(() => validateProfileName('../web'), MarketValidationError)
    assert.throws(() => validateProfileName('a b'), MarketValidationError)
    assert.throws(() => validateProfileName(''), MarketValidationError)
  })
})

describe('resolveDshBin', () => {
  const root = join(tmpdir(), `dsh-market-bin-test-${process.pid}`)

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('walks up from the running entry script to the kernel package root', () => {
    const kernel = join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(join(kernel, 'lib'), { recursive: true })
    writeFileSync(join(kernel, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }), 'utf8')
    const bin = join(kernel, 'lib', 'bin.js')
    writeFileSync(bin, '// entry', 'utf8')
    assert.equal(resolveDshBin(bin), bin)
  })

  it('stops walking at the filesystem root and throws a coded error', () => {
    assert.throws(() => resolveDshBin(join(tmpdir(), 'no-such-bin-here.js')), MarketValidationError)
    assert.throws(() => resolveDshBin(undefined), MarketValidationError)
    // The failure carries a code (the panel owns the sentence) and must not
    // carry absolute paths.
    let message = ''
    try {
      resolveDshBin(undefined)
    } catch (error) {
      assert.ok(error instanceof MarketValidationError)
      assert.equal(error.host.code, 'cli.notFound')
      message = (error as Error).message
    }
    assert.equal(message.includes(tmpdir()), false)
  })
})

describe('latestVersionsOf (bounded batch probe)', () => {
  /** A probe that tracks how many run at once and yields a per-name version. */
  const trackingProbe = (): { probe: (name: string) => Promise<string | undefined>, peak: () => number } => {
    let active = 0
    let peak = 0
    return {
      probe: async (name: string): Promise<string | undefined> => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
        active -= 1
        return `${name}@latest`
      },
      peak: () => peak,
    }
  }

  it('keeps the batch within the concurrency cap and maps every name', async () => {
    const names = Array.from({ length: 12 }, (_, index) => `pkg-${String(index)}`)
    const { probe, peak } = trackingProbe()
    const result = await latestVersionsOf(names, probe)
    assert.equal(peak() <= LATEST_PROBE_CONCURRENCY, true, `peak ${String(peak())} exceeds ${String(LATEST_PROBE_CONCURRENCY)}`)
    assert.equal(Object.keys(result).length, names.length)
    for (const name of names) assert.equal(result[name], `${name}@latest`)
  })

  it('degrades one failed probe to undefined without losing the rest', async () => {
    const result = await latestVersionsOf(['pkg-a', 'pkg-b'], async (name) =>
      name === 'pkg-b' ? undefined : '2.0.0')
    assert.deepEqual(result, { 'pkg-a': '2.0.0', 'pkg-b': undefined })
  })

  it('answers an empty record for an empty batch', async () => {
    assert.deepEqual(await latestVersionsOf([], async () => '1.0.0'), {})
  })
})

// --- registry fallback -------------------------------------------------------
//
// From Mainland China — this product's first market — npm's own host is
// regularly unreachable or slow, while the kernel's own plugin manager already
// declares `registry.npmmirror.com` as a fallback. Without one, the panel
// reports "no such package" for a package the CLI installs fine.
//
// The distinction these cases pin is the one a naive retry loop gets wrong: a
// host that could not be REACHED is not a verdict, but "no such package" from
// the canonical host IS one — asking a lagging mirror next would let its 404
// masquerade as the package not existing.

describe('resolveRegistryVersion (registry fallback)', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  /** Answer every request with `respond`, recording the URLs asked. */
  function stubFetch(respond: (url: string) => Response): string[] {
    const asked: string[] = []
    globalThis.fetch = ((url: unknown) => {
      asked.push(String(url))
      return Promise.resolve(respond(String(url)))
    }) as typeof fetch
    return asked
  }

  it('answers from the canonical host without asking anyone else', async () => {
    const asked = stubFetch(() => new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 }))
    assert.equal(await resolveRegistryVersion('react'), '1.2.3')
    assert.deepEqual(asked, ['https://registry.npmjs.org/react/latest'])
  })

  it('falls back to the mirror when the canonical host cannot be reached', async () => {
    const asked = stubFetch((url) => (url.includes('registry.npmjs.org')
      ? (() => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org') })()
      : new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 })))
    assert.equal(await resolveRegistryVersion('react'), '1.2.3')
    assert.deepEqual(asked, [
      'https://registry.npmjs.org/react/latest',
      'https://registry.npmmirror.com/react/latest',
    ])
  })

  it('treats a 5xx as "this host did not answer" and moves on', async () => {
    const asked = stubFetch((url) => (url.includes('registry.npmjs.org')
      ? new Response('bad gateway', { status: 502 })
      : new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 })))
    assert.equal(await resolveRegistryVersion('react'), '1.2.3')
    assert.equal(asked.length, 2)
  })

  it('takes "no such package" as the answer and stops asking', async () => {
    const asked = stubFetch(() => new Response('{"error":"Not found"}', { status: 404 }))
    await assert.rejects(() => resolveRegistryVersion('no-such-package'))
    assert.deepEqual(asked, ['https://registry.npmjs.org/no-such-package/latest'])
  })

  it('a requested version is asked for by name on whichever host answers', async () => {
    const asked = stubFetch(() => new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 }))
    assert.equal(await resolveRegistryVersion('react', '1.2.3'), '1.2.3')
    assert.deepEqual(asked, ['https://registry.npmjs.org/react/1.2.3'])
  })

  it('asks both registry paths for an UNCOMPRESSED body', async () => {
    // The header is the whole defence against a dispatcher that hands back the
    // origin's gzip bytes with the `content-encoding` gone: measured through the
    // kernel's own dispatcher, one mirror `…/latest` answered with NO headers and
    // 8,738 bytes of gzip (unparseable) where the same request with this header
    // answered 22,000 bytes of valid JSON. Without it the panel reports
    // `update.latestUnknown` while the mirror is serving the manifest perfectly —
    // so the resolve path AND the latest probe are both asserted here.
    const seen: Array<RequestInit | undefined> = []
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      seen.push(init)
      return Promise.resolve(new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 }))
    }) as typeof fetch
    // Distinct names: the latest probe caches per package for five minutes, and a
    // name an earlier test already probed would answer from that cache with no
    // request at all.
    await resolveRegistryVersion('plain-body-resolve')
    await latestVersionsOf(['plain-body-latest'])
    assert.equal(seen.length, 2, `expected one request per path, saw ${String(seen.length)}`)
    for (const init of seen) {
      assert.equal((init?.headers as Record<string, string> | undefined)?.['accept-encoding'], 'identity')
    }
  })
})

describe('registryUrl', () => {
  it('targets the canonical host unless told otherwise', () => {
    assert.equal(registryUrl('react'), 'https://registry.npmjs.org/react/latest')
    assert.equal(registryUrl('react', '1.2.3', 'registry.npmmirror.com'), 'https://registry.npmmirror.com/react/1.2.3')
  })
})
