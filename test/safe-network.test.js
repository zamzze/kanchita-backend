'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  parseHttpUrl,
  isPublicIp,
  resolveDestination,
  pinnedLookup,
} = require('../src/modules/streams/http/safeNetwork');

const rejectsWithCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test('parseHttpUrl accepts only credential-free HTTP and HTTPS URLs', () => {
  assert.equal(parseHttpUrl('http://public.example/path').protocol, 'http:');
  assert.equal(parseHttpUrl('https://public.example/path').protocol, 'https:');
  for (const url of [
    'ftp://public.example/file', 'file:///tmp/a', 'data:text/plain,x',
    'javascript:alert(1)', 'ws://public.example', 'wss://public.example',
    'https://user@public.example', 'https://user:secret@public.example', 'not a url',
  ]) assert.equal(parseHttpUrl(url), null, url);
});

test('IPv4 policy rejects non-global and special-use address ranges', () => {
  for (const address of [
    '0.1.2.3', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.88.99.1',
    '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
  ]) assert.equal(isPublicIp(address), false, address);
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('1.1.1.1'), true);
});

test('IPv6 policy is fail-closed and accepts global unicast only', () => {
  for (const address of [
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '2001:db8::1', '2001:2::1', '2002::1', '::ffff:192.168.1.1',
  ]) assert.equal(isPublicIp(address), false, address);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
});

test('resolveDestination rejects localhost and every unsafe DNS answer', async () => {
  await rejectsWithCode(
    resolveDestination(new URL('http://localhost/path')),
    'HTTP_UNSAFE_DESTINATION'
  );
  await rejectsWithCode(
    resolveDestination(new URL('http://media.localhost/path')),
    'HTTP_UNSAFE_DESTINATION'
  );
  await rejectsWithCode(resolveDestination(new URL('https://mixed.example/path'), {
    dnsLookup: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ],
  }), 'HTTP_UNSAFE_DESTINATION');
  await rejectsWithCode(resolveDestination(new URL('https://missing.example/path'), {
    dnsLookup: async () => { throw new Error('fixture DNS failure'); },
  }), 'HTTP_UNSAFE_DESTINATION');
});

test('resolveDestination accepts all-public DNS and explicit private test policy', async () => {
  const publicAddresses = await resolveDestination(new URL('https://public.example/path'), {
    dnsLookup: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ],
  });
  assert.deepEqual(publicAddresses, [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]);
  assert.deepEqual(await resolveDestination(new URL('http://127.0.0.1/path'), {
    allowPrivateNetworks: true,
  }), [{ address: '127.0.0.1', family: 4 }]);
});

test('pinnedLookup returns only pre-approved addresses', async () => {
  const approved = [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ];
  const lookup = pinnedLookup(approved);
  const all = await new Promise((resolve, reject) => lookup('ignored.example', { all: true },
    (error, addresses) => error ? reject(error) : resolve(addresses)));
  assert.deepEqual(all, approved);
  const ipv6 = await new Promise((resolve, reject) => lookup('ignored.example', { family: 6 },
    (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(ipv6, approved[1]);
});
