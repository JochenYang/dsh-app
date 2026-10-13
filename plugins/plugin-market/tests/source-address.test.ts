/**
 * The catalog source address policy: which literals a source URL may name and
 * which answers a hostname may resolve to (`src/source-address.ts`).
 *
 * The exception is asserted from both sides: the RFC 2544 block passes, and the
 * addresses around it do not (a rule that allowed `reserved` by NAME would pass
 * the first assertion and fail the second).
 *
 * @module plugin-market/tests/source-address
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  blockedAddressOf,
  literalAddressOf,
  literalAddressReason,
  verdictOfAddress,
} from '../src/source-address.ts'

describe('verdictOfAddress (IPv4)', () => {
  it('allows globally routable addresses', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '223.5.5.5']) {
      assert.equal(verdictOfAddress(address).blocked, false, address)
    }
  })

  it('refuses loopback, the private blocks, link-local and the metadata endpoint', () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ['127.0.0.1', 'loopback'],
      ['127.9.9.9', 'loopback'],
      ['10.0.0.1', 'private'],
      ['172.16.0.1', 'private'],
      ['172.31.255.254', 'private'],
      ['192.168.1.1', 'private'],
      ['169.254.1.1', 'linkLocal'],
      // The cloud metadata endpoint: inside 169.254/16, kept as its own case
      // because that is the address an SSRF attempt actually names.
      ['169.254.169.254', 'linkLocal'],
      ['0.0.0.0', 'unspecified'],
      ['100.64.0.1', 'carrierGradeNat'],
      ['192.0.2.5', 'reserved'],
      ['198.51.100.7', 'reserved'],
      ['224.0.0.1', 'multicast'],
      ['255.255.255.255', 'broadcast'],
    ]
    for (const [address, range] of expected) {
      const verdict = verdictOfAddress(address)
      assert.equal(verdict.blocked, true, address)
      assert.equal(verdict.range, range, address)
    }
  })

  it('allows the RFC 2544 block, and only that block', () => {
    // A TUN/fake-IP network answers every hostname inside this /15 (the module
    // header states why it is allowed).
    for (const address of ['198.18.0.1', '198.18.0.57', '198.19.255.255']) {
      const verdict = verdictOfAddress(address)
      assert.equal(verdict.blocked, false, address)
      assert.equal(verdict.range, 'benchmarking', address)
    }
    // The neighbours stay ordinary addresses: the exception is the /15, not
    // the `reserved` range name ipaddr.js files it under (that name also
    // carries TEST-NET and 240/4, which stay refused).
    assert.equal(verdictOfAddress('198.17.255.255').blocked, false)
    assert.equal(verdictOfAddress('198.20.0.1').blocked, false)
    assert.equal(verdictOfAddress('198.51.100.7').blocked, true)
  })
})

describe('verdictOfAddress (IPv6)', () => {
  it('allows globally routable addresses', () => {
    for (const address of ['2606:4700:4700::1111', '2400:3200::1']) {
      assert.equal(verdictOfAddress(address).blocked, false, address)
    }
  })

  it('refuses loopback, unspecified, link-local, unique-local and multicast', () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ['::1', 'loopback'],
      ['::', 'unspecified'],
      ['fe80::1', 'linkLocal'],
      ['fc00::1', 'uniqueLocal'],
      ['fd12:3456::1', 'uniqueLocal'],
      ['ff02::1', 'multicast'],
    ]
    for (const [address, range] of expected) {
      const verdict = verdictOfAddress(address)
      assert.equal(verdict.blocked, true, address)
      assert.equal(verdict.range, range, address)
    }
  })

  it('judges an IPv4-mapped address by the address it embeds', () => {
    const loopback = verdictOfAddress('::ffff:127.0.0.1')
    assert.equal(loopback.blocked, true)
    assert.equal(loopback.range, 'loopback')
    assert.equal(verdictOfAddress('::ffff:10.0.0.1').blocked, true)
    assert.equal(verdictOfAddress('::ffff:169.254.169.254').blocked, true)
    assert.equal(verdictOfAddress('::ffff:93.184.216.34').blocked, false)
    // The exception is IPv4-only, and a mapped address IS IPv4.
    assert.equal(verdictOfAddress('::ffff:198.18.0.9').blocked, false)
  })

  it('refuses the transition forms that carry an IPv4 address', () => {
    // 2002::/16 is 6to4 (its payload here is 10.0.0.1), 64:ff9b::/96 is NAT64
    // (its payload 10.0.0.1): both reach an IPv4 destination the policy
    // refuses, so neither may be let through.
    assert.equal(verdictOfAddress('2002:0a00:0001::').range, '6to4')
    assert.equal(verdictOfAddress('2002:0a00:0001::').blocked, true)
    assert.equal(verdictOfAddress('64:ff9b::a00:1').range, 'rfc6052')
    assert.equal(verdictOfAddress('64:ff9b::a00:1').blocked, true)
  })

  it('refuses IPv6\'s own benchmarking block, which the IPv4 exception does not cover', () => {
    // The module header claims the exception is a subnet test on IPv4 and that
    // `2001:2::/48` stays refused. Without this assertion that distinction
    // rests on the header alone: `ipaddr.js` files the IPv6 block under the
    // SAME `benchmarking` range name, so a rule written against the name would
    // let it through.
    const verdict = verdictOfAddress('2001:2::7f00:1')
    assert.equal(verdict.blocked, true)
    assert.equal(verdict.range, 'benchmarking')
    assert.equal(verdictOfAddress('2001:2::1').blocked, true)
  })

  it('fails closed on anything that is not an address', () => {
    const verdict = verdictOfAddress('not-an-address')
    assert.equal(verdict.blocked, true)
    assert.equal(verdict.range, 'unparsable')
  })
})

describe('blockedAddressOf', () => {
  it('refuses the whole answer set when any address is refused', () => {
    // A connection may take any answer, so one private answer is enough.
    assert.deepEqual(
      blockedAddressOf(['93.184.216.34', '10.0.0.1']),
      { address: '10.0.0.1', range: 'private' },
    )
    assert.deepEqual(
      blockedAddressOf(['10.0.0.1', '93.184.216.34']),
      { address: '10.0.0.1', range: 'private' },
    )
  })

  it('answers undefined when every address passes, and for an empty set', () => {
    assert.equal(blockedAddressOf(['93.184.216.34', '::ffff:1.1.1.1']), undefined)
    assert.equal(blockedAddressOf(['198.18.0.35']), undefined)
    assert.equal(blockedAddressOf([]), undefined)
  })
})

describe('literalAddressOf', () => {
  it('recognizes literals of both families, with IPv6 brackets off', () => {
    assert.equal(literalAddressOf('127.0.0.1'), '127.0.0.1')
    assert.equal(literalAddressOf('93.184.216.34'), '93.184.216.34')
    assert.equal(literalAddressOf('[::1]'), '::1')
    assert.equal(literalAddressOf('[fe80::1]'), 'fe80::1')
  })

  it('answers undefined for a name', () => {
    assert.equal(literalAddressOf('example.com'), undefined)
    assert.equal(literalAddressOf('127.0.0.1.example.com'), undefined)
    // A bracketed NAME is not a literal either (`isIP` decides, not the shape).
    assert.equal(literalAddressOf('[example.com]'), undefined)
  })
})

describe('literalAddressReason', () => {
  it('carries a coded reason for a refused literal, with no sentence of its own', () => {
    for (const hostname of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '[::1]', '[fe80::1]']) {
      const reason = literalAddressReason(hostname)
      assert.equal(reason?.code, 'source.privateAddress', hostname)
      assert.equal(reason?.params?.host, hostname)
      // The English diagnostic is developer-facing and never user copy.
      assert.match(reason?.text ?? '', /private, loopback or link-local/)
    }
  })

  it('answers nothing for a name or a public literal', () => {
    for (const hostname of ['example.com', '93.184.216.34', '[2606:4700:4700::1111]']) {
      assert.equal(literalAddressReason(hostname), undefined, hostname)
    }
  })
})
