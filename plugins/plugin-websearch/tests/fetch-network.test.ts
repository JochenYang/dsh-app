/**
 * The URL/address policy: the same contract the host's `web-fetch-http`
 * provider documents, asserted here so a drift in this plugin breaks its own
 * suite instead of the model's fetches. The public-address table is the
 * security boundary, so it is asserted by range rather than by sample.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_BODY_CHARS,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  MAX_URL_LENGTH,
  classifyContentType,
  decoderForCharset,
  isNonPublicIpLiteral,
  isPublicAddress,
  isRedirectStatus,
  isSameOrigin,
  literalHostAddresses,
  parseCharset,
  stripIpv6Brackets,
  validateFetchUrl,
} from '../src/fetch/network.ts'

describe('isPublicAddress', () => {
  it('accepts globally routable addresses', () => {
    assert.equal(isPublicAddress('93.184.216.34'), true)
    assert.equal(isPublicAddress('1.1.1.1'), true)
    assert.equal(isPublicAddress('223.5.5.5'), true)
    assert.equal(isPublicAddress('8.8.8.8'), true)
    assert.equal(isPublicAddress('2001:4860:4860::8888'), true)
  })

  it('refuses the TUN benchmark range the whole feature exists for', () => {
    assert.equal(isPublicAddress('198.18.0.1'), false)
    assert.equal(isPublicAddress('198.19.255.255'), false)
  })

  it('refuses private, loopback, link-local and CGNAT space', () => {
    for (const address of ['10.0.0.1', '127.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255']) {
      assert.equal(isPublicAddress(address), false, address)
    }
  })

  it('refuses the well-known non-public IPv6 ranges', () => {
    for (const address of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1']) {
      assert.equal(isPublicAddress(address), false, address)
    }
  })

  it('classifies IPv4-mapped IPv6 by the embedded address', () => {
    assert.equal(isPublicAddress('::ffff:93.184.216.34'), true)
    assert.equal(isPublicAddress('::ffff:127.0.0.1'), false)
    assert.equal(isPublicAddress('::ffff:198.18.0.9'), false)
  })

  it('refuses the mapped and transition forms a prefix table misses', () => {
    // The regression this table exists for: the WHATWG URL parser rewrites a
    // bracketed `::ffff:127.0.0.1` to `::ffff:7f00:1`, so a checker that only
    // knew the dotted spelling let loopback through. Every entry here is an
    // address that names this machine or a non-routable destination.
    for (const address of [
      '::ffff:7f00:1',            // 127.0.0.1, mapped and hex
      '::ffff:a00:1',             // 10.0.0.1, mapped and hex
      '0:0:0:0:0:ffff:7f00:1',    // the same, fully expanded
      '::ffff:7f00:0001',
      '2002:7f00:1::1',           // 6to4 wrapping loopback
      '2001:0:0:0:0:0:0:1',       // Teredo
      '64:ff9b::7f00:1',          // NAT64 wrapping loopback
      '192.0.2.5',                // TEST-NET-1
      '198.51.100.7',             // TEST-NET-2
      '203.0.113.9',              // TEST-NET-3
      '192.88.99.1',              // 6to4 relay anycast
      '100::1',                   // discard-only
      '2001:2::1',                // benchmarking
      '5f00::1',                  // segment routing
    ]) {
      assert.equal(isPublicAddress(address), false, address)
    }
  })

  it('agrees with the host provider on the shared boundary cases', () => {
    // These are the host predicate's answers, read off `ipaddr.js` itself.
    for (const address of ['93.184.216.34', '1.1.1.1', '2001:4860:4860::8888', '2606:2800:220:1::1']) {
      assert.equal(isPublicAddress(address), true, address)
    }
    for (const address of ['198.18.0.1', '10.0.0.1', '127.0.0.1', '::1', '::', 'fe80::1', 'fc00::1']) {
      assert.equal(isPublicAddress(address), false, address)
    }
  })

  it('refuses malformed input', () => {
    for (const address of ['', 'not-an-ip', '1.2.3.4.5', '999.1.1.1', 'abc.def.gih.jkl']) {
      assert.equal(isPublicAddress(address), false, address)
    }
    // `ipaddr.js` reads a short dotted form as the address it names
    // (`1.2.3` → 1.2.0.3), exactly as the host provider's library does — so
    // this is a public address, not a refusal. Asserted so the divergence
    // from a hand-rolled octet check stays visible.
    assert.equal(isPublicAddress('1.2.3'), true)
  })
})

describe('validateFetchUrl', () => {
  it('accepts http and https URLs', () => {
    assert.equal(validateFetchUrl('https://example.com/a?b=c').href, 'https://example.com/a?b=c')
    assert.equal(validateFetchUrl('http://example.com/').protocol, 'http:')
  })

  it('refuses an over-long URL', () => {
    assert.throws(() => validateFetchUrl(`https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`), /maximum length/)
  })

  it('refuses a non-HTTP scheme', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'data:text/plain,hi', 'about:blank']) {
      assert.throws(() => validateFetchUrl(url), /WEB_INVALID_URL|scheme/i)
    }
  })

  it('refuses embedded credentials', () => {
    assert.throws(() => validateFetchUrl('https://user:pass@example.com/'), /credentials/i)
  })
})

describe('helpers', () => {
  it('detects redirect statuses and nothing else', () => {
    for (const status of [301, 302, 303, 307, 308]) assert.equal(isRedirectStatus(status), true, String(status))
    for (const status of [200, 204, 304, 400, 404, 500]) assert.equal(isRedirectStatus(status), false, String(status))
  })

  it('treats scheme, hostname and port as the origin', () => {
    const a = new URL('https://example.com:443/a')
    assert.equal(isSameOrigin(a, new URL('https://example.com/b')), true)
    assert.equal(isSameOrigin(a, new URL('http://example.com/b')), false)
    assert.equal(isSameOrigin(a, new URL('https://other.com/b')), false)
    assert.equal(isSameOrigin(a, new URL('https://example.com:8443/b')), false)
  })

  it('classifies content types with the host\'s vocabulary', () => {
    assert.equal(classifyContentType('text/html; charset=utf-8'), 'html')
    assert.equal(classifyContentType('application/xhtml+xml'), 'html')
    assert.equal(classifyContentType('text/plain'), 'text')
    assert.equal(classifyContentType('application/json'), 'text')
    assert.equal(classifyContentType('application/ld+json'), 'text')
    assert.equal(classifyContentType('image/png'), undefined)
    assert.equal(classifyContentType('application/octet-stream'), undefined)
    assert.equal(classifyContentType(null), undefined)
  })

  it('extracts and applies the charset', () => {
    assert.equal(parseCharset('text/html; charset=GBK'), 'gbk')
    assert.equal(parseCharset('text/html;charset="utf-8"'), 'utf-8')
    assert.equal(parseCharset('text/html'), undefined)
    const decoder = decoderForCharset('gbk')
    // 0xC4E3 = 你 in GBK; the decoder turns the bytes back into the character.
    const bytes = new Uint8Array([0xC4, 0xE3])
    assert.equal(decoder.decode(bytes), '你')
    assert.throws(() => decoderForCharset('nonsense-charset'), /charset/i)
  })

  it('strips IPv6 brackets and detects literals', () => {
    assert.equal(stripIpv6Brackets('[::1]'), '::1')
    assert.equal(isNonPublicIpLiteral('127.0.0.1'), true)
    assert.equal(isNonPublicIpLiteral('93.184.216.34'), false)
    assert.equal(isNonPublicIpLiteral('example.com'), false)
    assert.deepEqual(literalHostAddresses(new URL('http://93.184.216.34/x')), ['93.184.216.34'])
    assert.equal(literalHostAddresses(new URL('https://example.com/')), null)
  })

  it('keeps the caps in step with the host provider', () => {
    assert.equal(MAX_RESPONSE_BYTES, 5_000_000)
    assert.equal(MAX_BODY_CHARS, 100_000)
    assert.equal(MAX_REDIRECTS, 5)
  })
})
