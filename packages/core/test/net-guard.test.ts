import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress } from '../src/net-guard.ts';

test('public addresses pass', () => {
  for (const ip of ['1.1.1.1', '185.19.28.1', '2a00:1450:4001:82a::200e', '2606:4700::1111']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test('private, loopback, link-local and metadata addresses are blocked', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '2001:db8::1',
    'not-an-ip',
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});
