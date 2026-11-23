// Run with: pnpm run test:server   (uses node:test)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createPlans } = require('./plans');

const setup = async (seed = null) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-'));
    const file = path.join(dir, 'plans.json');
    const entries = [];
    const plans = createPlans({ dataFile: file, seed, audit: { record: (action, details) => entries.push({ action, details }) } });
    const app = express();
    app.use('/admin/plans', plans.adminRouter((req, res, next) => (req.headers.authorization === 'Bearer tok' ? next() : res.status(404).end())));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, route, body, token = 'tok') => fetch(`${base}/admin/plans${route}`, {
        method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { plans, file, entries, call, close: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
};
const solo = { name: 'Solo', description: 'Just you', priceLabel: '$9 / month', seats: 0, priceId: 'price_solo1' };

test('plans: create, edit, validate and keep the price id locked', async (t) => {
    const s = await setup();
    t.after(s.close);
    assert.equal(s.plans.save('solo', solo).ok, true);
    assert.deepEqual(s.plans.save('Bad Id!', solo), { ok: false, error: 'invalid_id' });
    assert.deepEqual(s.plans.save('x', { ...solo, name: '' }), { ok: false, error: 'invalid_value', key: 'name' });
    assert.deepEqual(s.plans.save('x', { ...solo, seats: 51 }), { ok: false, error: 'invalid_value', key: 'seats' });
    assert.deepEqual(s.plans.save('x', { ...solo, seats: 1.5 }), { ok: false, error: 'invalid_value', key: 'seats' });
    assert.deepEqual(s.plans.save('x', { ...solo, priceId: 'sk_live_oops' }), { ok: false, error: 'invalid_value', key: 'priceId' });
    assert.deepEqual(s.plans.save('x', { ...solo, description: 'd'.repeat(201) }), { ok: false, error: 'invalid_value', key: 'description' });
    assert.deepEqual(s.plans.save('dup', solo), { ok: false, error: 'price_in_use' }, 'one price, one plan');

    const edited = s.plans.save('solo', { name: 'Solo Plus', seats: 1, priceLabel: '$12 / month' });
    assert.equal(edited.ok, true);
    assert.equal(edited.plan.priceId, 'price_solo1', 'price id untouched when omitted');
    assert.deepEqual(s.plans.save('solo', { name: 'Solo', seats: 0, priceId: 'price_other1' }), { ok: false, error: 'price_locked' });
    assert.equal(s.plans.list().length, 1);
    assert.deepEqual(s.entries.map((e) => e.action), ['plan-created', 'plan-updated']);
});

test('plans: archive keeps the record, the last active plan cannot be archived, restore works', async (t) => {
    const s = await setup();
    t.after(s.close);
    s.plans.save('solo', solo);
    assert.deepEqual(s.plans.setArchived('solo', true), { ok: false, error: 'last_active_plan' });
    s.plans.save('family', { name: 'Family', seats: 4, priceId: 'price_family1' });
    assert.equal(s.plans.setArchived('solo', true).ok, true);
    assert.equal(s.plans.list().find((p) => p.id === 'solo').archived, true, 'record kept for existing subscribers');
    assert.deepEqual(s.plans.setArchived('family', true), { ok: false, error: 'last_active_plan' });
    assert.equal(s.plans.setArchived('solo', false).ok, true);
    assert.deepEqual(s.plans.setArchived('ghost', true), { ok: false, error: 'not_found' });
});

test('plans: PLANS env seeds an empty store once; later edits survive a restart', async (t) => {
    const s = await setup([{ id: 'solo', name: 'Solo', priceId: 'price_solo1', seats: 0 }]);
    t.after(s.close);
    assert.deepEqual(s.plans.list().map((p) => p.id), ['solo']);
    s.plans.save('solo', { name: 'Renamed', seats: 2 });
    const again = createPlans({ dataFile: s.file, seed: [{ id: 'other', name: 'Other', priceId: 'price_oth1', seats: 0 }] });
    assert.deepEqual(again.list().map((p) => [p.id, p.name, p.seats]), [['solo', 'Renamed', 2]], 'seed ignored once the store has plans');
});

test('plans: admin API needs the token and maps errors to statuses', async (t) => {
    const s = await setup();
    t.after(s.close);
    assert.equal((await s.call('GET', '', undefined, 'wrong')).status, 404);
    assert.equal((await s.call('PUT', '/solo', solo)).status, 200);
    assert.equal((await s.call('PUT', '/solo', { ...solo, priceId: 'price_zzz999' })).status, 409);
    assert.equal((await s.call('PUT', '/bad', { ...solo, name: '' })).status, 400);
    assert.equal((await s.call('POST', '/solo/archive')).status, 409, 'last active plan');
    assert.equal((await s.call('POST', '/ghost/archive')).status, 404);
    const all = await (await s.call('GET', '')).json();
    assert.equal(all.plans[0].priceId, 'price_solo1', 'operators may see price ids');
});

test('create a Stripe price from plain inputs', async (t) => {
    const made = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const entries = [];
    const plans = createPlans({ dataFile: path.join(dir, 'p.json'), audit: { record: (a, d) => entries.push(a) }, createPrice: async (input) => { made.push(input); return 'price_new123'; } });
    assert.deepEqual(await plans.makePrice({ name: 'Solo', amount: 9.99, currency: 'USD', interval: 'month' }), { ok: true, priceId: 'price_new123', priceLabel: '$9.99 / month' });
    assert.deepEqual(made[0], { name: 'Solo', currency: 'usd', interval: 'month', unitAmount: 999 });
    const yen = await plans.makePrice({ name: 'Solo', amount: 900, currency: 'jpy', interval: 'year' });
    assert.equal(made[1].unitAmount, 900, 'zero-decimal currency is not multiplied');
    assert.match(yen.priceLabel, /900 \/ year/);
    for (const [bad, key] of [[{ name: '', amount: 5, currency: 'usd', interval: 'month' }, 'name'], [{ name: 'a', amount: 5, currency: 'dollars', interval: 'month' }, 'currency'],
        [{ name: 'a', amount: 5, currency: 'usd', interval: 'week' }, 'interval'], [{ name: 'a', amount: -1, currency: 'usd', interval: 'month' }, 'amount'], [{ name: 'a', amount: 'x', currency: 'usd', interval: 'month' }, 'amount']]) {
        assert.deepEqual(await plans.makePrice(bad), { ok: false, error: 'invalid_value', key });
    }
    assert.equal(made.length, 2, 'nothing invalid reached Stripe');
    assert.deepEqual(entries, ['plan-price-created', 'plan-price-created']);
    const noStripe = createPlans({ dataFile: path.join(dir, 'q.json') });
    assert.deepEqual(await noStripe.makePrice({ name: 'a', amount: 5, currency: 'usd', interval: 'month' }), { ok: false, error: 'stripe_unavailable' });
    const failing = createPlans({ dataFile: path.join(dir, 'r.json'), createPrice: async () => { throw new Error('boom'); } });
    assert.deepEqual(await failing.makePrice({ name: 'a', amount: 5, currency: 'usd', interval: 'month' }), { ok: false, error: 'stripe_unavailable' });
});

test('price route needs the operator token and reports availability', async (t) => {
    const s = await setup();
    t.after(s.close);
    assert.equal((await s.call('POST', '/price', { name: 'a', amount: 5, currency: 'usd', interval: 'month' }, 'wrong')).status, 404);
    assert.equal((await s.call('POST', '/price', { name: 'a', amount: 5, currency: 'usd', interval: 'month' })).status, 502);
    assert.equal((await (await s.call('GET', '/')).json()).canCreatePrice, false);
});
