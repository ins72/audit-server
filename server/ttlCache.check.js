// Run with: pnpm run test:server   (uses node:test)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTtlCache } = require('./ttlCache');

test('ttl cache: reuses a value within the time, recomputes after it, and can be bypassed', () => {
    let clock = 1000;
    let calls = 0;
    const cache = createTtlCache(30000, () => clock);
    const compute = () => { calls += 1; return calls; };
    assert.equal(cache.get('a', compute), 1);
    clock += 29999;
    assert.equal(cache.get('a', compute), 1, 'still fresh');
    assert.equal(cache.get('b', compute), 2, 'different key computed separately');
    clock += 2;
    assert.equal(cache.get('a', compute), 3, 'expired');
    assert.equal(cache.get('a', compute, { fresh: true }), 4, 'fresh bypasses');
    assert.equal(cache.get('a', compute), 4, 'and the new value is remembered');
    cache.clear();
    assert.equal(cache.get('a', compute), 5);
});

test('ttl cache: stays small', () => {
    const cache = createTtlCache(1000);
    for (let i = 0; i < 200; i += 1) cache.get(`k${i}`, () => i);
    let recomputed = 0;
    cache.get('k0', () => { recomputed += 1; return 0; });
    assert.equal(recomputed, 1, 'oldest entries were dropped');
});
