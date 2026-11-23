// Run with: pnpm run test:server   (uses node:test; named .check.js so jest ignores it)

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const Stripe = require('stripe');
const { createAuth } = require('./auth');
const { createBilling } = require('./billing');
const { createAudit } = require('./audit');

const WEBHOOK_SECRET = 'whsec_test_secret';
const ADMIN = 'admin-token';
const STREMIO_USERS = {
    'owner-key': { _id: 'o1', email: 'owner@example.com' },
    'member-key': { _id: 'm1', email: 'Friend@Example.com' },
    'stranger-key': { _id: 'x1', email: 'stranger@example.com' },
    'guest-key': { _id: 'g1', email: 'guest@example.com' }
};

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const updates = [];
const setup = async (allOverrides = {}) => {
    const { authOptions = {}, ...overrides } = allOverrides;
    const clock = { value: Date.now() };
    const mock = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const user = STREMIO_USERS[JSON.parse(body || '{}').authKey];
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(user ? { result: user } : { error: { message: 'no session', code: 1 } }));
        });
    });
    const mockPort = await listen(mock);

    const stripe = new Stripe('sk_test_123');
    const checkoutCalls = [];
    stripe.checkout.sessions.create = async (params) => {
        checkoutCalls.push(params);
        return { url: 'https://checkout.stripe.test/session' };
    };
    stripe.billingPortal.sessions.create = async (params) => ({ url: `https://portal.stripe.test/${params.customer}` });

    stripe.subscriptions.update = async (id, params) => { updates.push({ id, params }); return {}; };

    let billing = null;
    const audit = createAudit();
    const auth = createAuth({
        ...authOptions,
        audit,
        secret: 'x'.repeat(40),
        stremioApiUrl: `http://127.0.0.1:${mockPort}`,
        adminToken: ADMIN,
        entitlementFor: (user) => billing.entitlementFor(user)
    });
    billing = createBilling({
        stripe,
        enabled: true,
        priceId: 'price_123',
        webhookSecret: WEBHOOK_SECRET,
        publicUrl: 'https://example.test',
        maxInvites: 2,
        now: () => clock.value,
        audit,
        ...overrides,
        requireSession: auth.requireSession,
        adminGuard: auth.adminGuard
    });

    const app = express();
    app.post('/billing/webhook', express.raw({ type: 'application/json' }), billing.webhook);
    app.use('/auth', auth.router);
    app.use('/billing', billing.router);
    app.use('/admin', auth.admin);
    app.use('/admin', billing.admin);
    app.get('/paid', billing.requireEntitlement, (req, res) => res.json({ ok: true, role: req.entitlement.role }));
    const server = http.createServer(app);
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;

    const login = async (authKey) => {
        const response = await fetch(`${base}/auth/session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ authKey })
        });
        const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
        return { cookie, status: response.status, body: await response.json() };
    };
    const call = async (cookie, method, path, body) => {
        const response = await fetch(`${base}${path}`, {
            method,
            headers: { 'content-type': 'application/json', cookie },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    };

    let eventCounter = 0;
    const sendEvent = async (type, object, created = Math.floor(Date.now() / 1000), id = `evt_${++eventCounter}`) => {
        const payload = JSON.stringify({ id, object: 'event', type, created, data: { object } });
        const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
        const response = await fetch(`${base}/billing/webhook`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'stripe-signature': signature },
            body: payload
        });
        return { status: response.status, body: await response.json() };
    };

    const subscription = (overrides = {}) => ({
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
        metadata: { userId: 'o1' },
        ...overrides
    });

    const close = () => { server.close(); mock.close(); };
    return { base, login, call, sendEvent, subscription, checkoutCalls, close, clock, stripe, billing, audit, updates };
};

test('billing and invites end to end', async (t) => {
    const s = await setup();
    t.after(s.close);

    const owner = await s.login('owner-key');
    const member = await s.login('member-key');
    const stranger = await s.login('stranger-key');

    await t.test('unpaid users are not entitled and get 402 on paid routes', async () => {
        assert.equal(owner.status, 200);
        assert.equal(owner.body.entitlement.active, false);
        assert.equal(owner.body.entitlement.role, 'none');
        assert.equal((await s.call(owner.cookie, 'GET', '/paid')).status, 402);
        assert.equal((await s.call('', 'GET', '/paid')).status, 401);
    });

    await t.test('checkout is created for the logged-in user', async () => {
        const result = await s.call(owner.cookie, 'POST', '/billing/checkout', {});
        assert.equal(result.status, 200);
        assert.equal(result.body.url, 'https://checkout.stripe.test/session');
        const params = s.checkoutCalls[0];
        assert.equal(params.mode, 'subscription');
        assert.equal(params.client_reference_id, 'o1');
        assert.equal(params.subscription_data.metadata.userId, 'o1');
        assert.equal(params.line_items[0].price, 'price_123');
        assert.equal(params.customer_email, 'owner@example.com');
    });

    await t.test('webhooks with a bad signature are rejected', async () => {
        const response = await fetch(`${s.base}/billing/webhook`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' },
            body: '{}'
        });
        assert.equal(response.status, 400);
    });

    await t.test('a paid subscription makes the owner entitled', async () => {
        const created = Math.floor(Date.now() / 1000);
        assert.equal((await s.sendEvent('customer.subscription.created', s.subscription(), created, 'evt_dup')).status, 200);
        const again = await s.sendEvent('customer.subscription.created', s.subscription(), created, 'evt_dup');
        assert.equal(again.body.duplicate, true);
        const me = await s.call(owner.cookie, 'GET', '/auth/me');
        assert.equal(me.body.entitlement.active, true);
        assert.equal(me.body.entitlement.role, 'owner');
        assert.equal((await s.call(owner.cookie, 'GET', '/paid')).body.role, 'owner');
        assert.equal((await s.call(owner.cookie, 'POST', '/billing/checkout', {})).status, 409);
        assert.equal((await s.call(owner.cookie, 'POST', '/billing/portal', {})).body.url, 'https://portal.stripe.test/cus_1');
    });

    await t.test('an older out-of-order event cannot overwrite newer state', async () => {
        const older = Math.floor(Date.now() / 1000) - 3600;
        await s.sendEvent('customer.subscription.updated', s.subscription({ status: 'canceled' }), older);
        assert.equal((await s.call(owner.cookie, 'GET', '/auth/me')).body.entitlement.active, true);
    });

    await t.test('only owners can invite; validation and seat limits apply', async () => {
        assert.equal((await s.call(stranger.cookie, 'POST', '/billing/invites', { email: 'a@b.co' })).status, 403);
        assert.equal((await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'not-an-email' })).status, 400);
        assert.equal((await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'OWNER@example.com' })).status, 400);
        const added = await s.call(owner.cookie, 'POST', '/billing/invites', { email: '  friend@example.COM ' });
        assert.equal(added.status, 201);
        assert.equal(added.body.invites[0].email, 'friend@example.com');
        assert.equal((await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'friend@example.com' })).status, 409);
        assert.equal((await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'second@example.com' })).status, 201);
        const full = await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'third@example.com' });
        assert.equal(full.status, 409);
        assert.equal(full.body.error, 'seat_limit_reached');
        await s.call(owner.cookie, 'POST', '/billing/invites/remove', { email: 'second@example.com' });
        assert.equal((await s.call(owner.cookie, 'GET', '/billing/invites')).body.invites.length, 1);
    });

    await t.test('the invited email gets access through the owner (case-insensitive), strangers do not', async () => {
        const me = await s.call(member.cookie, 'GET', '/auth/me');
        assert.equal(me.body.entitlement.active, true);
        assert.equal(me.body.entitlement.role, 'member');
        assert.equal(me.body.entitlement.sharedBy, 'owner@example.com');
        assert.equal((await s.call(member.cookie, 'GET', '/paid')).status, 200);
        assert.equal((await s.call(stranger.cookie, 'GET', '/paid')).status, 402);
        assert.equal((await s.call(member.cookie, 'POST', '/billing/invites', { email: 'x@y.co' })).status, 403);
    });

    await t.test('the operator can read subscriptions and invited emails in plain text', async () => {
        assert.equal((await fetch(`${s.base}/admin/billing`)).status, 404);
        const response = await fetch(`${s.base}/admin/billing`, { headers: { authorization: `Bearer ${ADMIN}` } });
        const body = await response.json();
        assert.equal(body.active, 1);
        assert.equal(body.owners[0].userId, 'o1');
        assert.equal(body.owners[0].email, 'owner@example.com');
        assert.equal(body.owners[0].invites[0].email, 'friend@example.com');
        assert.equal(body.owners[0].invites[0].acceptedBy, 'm1');
    });

    await t.test('removing an invite revokes the member', async () => {
        await s.call(owner.cookie, 'POST', '/billing/invites/remove', { email: 'friend@example.com' });
        assert.equal((await s.call(member.cookie, 'GET', '/paid')).status, 402);
        await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'friend@example.com' });
        assert.equal((await s.call(member.cookie, 'GET', '/paid')).status, 200);
    });

    await t.test('cancelling the subscription revokes owner and members, and checkout is open again', async () => {
        const later = Math.floor(Date.now() / 1000) + 60;
        await s.sendEvent('customer.subscription.deleted', s.subscription({ status: 'canceled' }), later);
        assert.equal((await s.call(owner.cookie, 'GET', '/paid')).status, 402);
        assert.equal((await s.call(member.cookie, 'GET', '/paid')).status, 402);
        const me = await s.call(owner.cookie, 'GET', '/auth/me');
        assert.equal(me.body.entitlement.role, 'owner');
        assert.equal(me.body.entitlement.status, 'canceled');
        const again = await s.call(owner.cookie, 'POST', '/billing/checkout', {});
        assert.equal(again.status, 200);
        assert.equal(s.checkoutCalls.at(-1).customer, 'cus_1'); // reuses the Stripe customer
    });
});

test('payment failures get a grace period, then access ends; recovery restores it', async (t) => {
    const s = await setup({ pastDueGraceMs: 3 * 86400000 });
    t.after(s.close);
    const owner = await s.login('owner-key');
    const base = Math.floor(s.clock.value / 1000);

    await s.sendEvent('customer.subscription.created', s.subscription(), base);
    await s.sendEvent('customer.subscription.updated', s.subscription({ status: 'past_due' }), base + 1);
    let me = await s.call(owner.cookie, 'GET', '/auth/me');
    assert.equal(me.body.entitlement.active, true, 'still active inside the grace period');
    assert.equal(me.body.entitlement.status, 'past_due');
    assert.ok(me.body.entitlement.graceEndsAt > s.clock.value);

    s.clock.value += 4 * 86400000;
    assert.equal((await s.call(owner.cookie, 'GET', '/paid')).status, 402, 'grace expired');

    await s.sendEvent('customer.subscription.updated', s.subscription({ status: 'active' }), base + 2);
    assert.equal((await s.call(owner.cookie, 'GET', '/paid')).status, 200, 'paying again restores access');
});

test('reconcile repairs a missed cancellation and tolerates a deleted subscription', async (t) => {
    const s = await setup();
    t.after(s.close);
    const owner = await s.login('owner-key');
    const base = Math.floor(s.clock.value / 1000);

    await s.sendEvent('customer.subscription.created', s.subscription({ current_period_end: base - 3600 }), base);
    assert.equal((await s.call(owner.cookie, 'GET', '/paid')).status, 200);

    s.stripe.subscriptions.retrieve = async () => s.subscription({ status: 'canceled' });
    await s.billing.reconcile();
    assert.equal((await s.call(owner.cookie, 'GET', '/paid')).status, 402, 'Stripe says canceled');

    // A subscription Stripe no longer knows about is treated as canceled
    await s.sendEvent('customer.subscription.updated', s.subscription({ current_period_end: base - 60 }), base + 10);
    assert.equal((await s.call(owner.cookie, 'GET', '/paid')).status, 200);
    s.stripe.subscriptions.retrieve = async () => { throw Object.assign(new Error('gone'), { code: 'resource_missing' }); };
    await s.billing.reconcile();
    assert.equal((await s.call(owner.cookie, 'GET', '/paid')).status, 402);

    // A Stripe outage must not lock anybody out
    await s.sendEvent('customer.subscription.updated', s.subscription({ current_period_end: base - 30 }), base + 20);
    s.stripe.subscriptions.retrieve = async () => { throw new Error('network down'); };
    await s.billing.reconcile();
    assert.equal((await s.call(owner.cookie, 'GET', '/paid')).status, 200);
});

test('a second paid subscription is flagged for the operator and does not replace the first', async (t) => {
    const s = await setup();
    t.after(s.close);
    await s.login('owner-key');
    const base = Math.floor(s.clock.value / 1000);

    await s.sendEvent('customer.subscription.created', s.subscription(), base);
    await s.sendEvent('customer.subscription.created', s.subscription({ id: 'sub_2' }), base + 1);
    const response = await fetch(`${s.base}/admin/billing`, { headers: { authorization: `Bearer ${ADMIN}` } });
    const body = await response.json();
    assert.equal(body.owners[0].stripeSubscriptionId, 'sub_1');
    assert.deepEqual(body.owners[0].duplicateSubscriptions, ['sub_2']);
});

test('invite emails: sent when configured, and a failing mailer never blocks the invite', async (t) => {
    const sent = [];
    let failNext = false;
    const s = await setup({
        sendInviteEmail: async (details) => {
            if (failNext) throw new Error('provider down');
            sent.push(details);
        }
    });
    t.after(s.close);
    const owner = await s.login('owner-key');
    await s.sendEvent('customer.subscription.created', s.subscription(), Math.floor(s.clock.value / 1000));

    const first = await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'Friend@Example.com' });
    assert.equal(first.status, 201);
    assert.equal(first.body.emailEnabled, true);
    assert.equal(first.body.notified, true);
    assert.deepEqual(sent, [{ to: 'friend@example.com', ownerEmail: 'owner@example.com' }]);

    failNext = true;
    const second = await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'second@example.com' });
    assert.equal(second.status, 201, 'invite is saved even though the email failed');
    assert.equal(second.body.notified, false);
    assert.equal(second.body.invites.length, 2);
    assert.equal((await s.call(owner.cookie, 'GET', '/billing/invites')).body.emailEnabled, true);
});

test('invites report emailEnabled=false when no mailer is configured', async (t) => {
    const s = await setup();
    t.after(s.close);
    const owner = await s.login('owner-key');
    await s.sendEvent('customer.subscription.created', s.subscription(), Math.floor(s.clock.value / 1000));
    const result = await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'a@b.co' });
    assert.equal(result.body.emailEnabled, false);
    assert.equal(result.body.notified, false);
});

test('operator comp grants give access without Stripe and can be revoked', async (t) => {
    const s = await setup();
    t.after(s.close);
    const stranger = await s.login('stranger-key');
    const admin = (method, path, body) => fetch(`${s.base}/admin${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    assert.equal((await s.call(stranger.cookie, 'GET', '/paid')).status, 402);

    assert.equal((await fetch(`${s.base}/admin/grants`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404, 'admin only');
    for (let i = 0; i < 15; i++) {
        assert.equal((await admin('POST', '/grants', { email: 'nope' })).status, 400, 'validation errors never rate-limit an authenticated operator');
    }
    const granted = await admin('POST', '/grants', { email: '  Stranger@Example.com ', note: 'tester' });
    assert.equal(granted.status, 201);

    const me = await s.call(stranger.cookie, 'GET', '/auth/me');
    assert.equal(me.body.entitlement.role, 'granted');
    assert.equal(me.body.entitlement.note, undefined, 'the operator note is not shown to the user');
    assert.equal((await s.call(stranger.cookie, 'GET', '/paid')).status, 200);
    assert.equal((await s.call(stranger.cookie, 'POST', '/billing/invites', { email: 'a@b.co' })).status, 403, 'grants cannot invite others');

    const overview = await (await admin('GET', '/billing')).json();
    assert.deepEqual(overview.grants.map((grant) => [grant.email, grant.note]), [['stranger@example.com', 'tester']]);

    assert.equal((await admin('POST', '/grants/remove', { email: 'stranger@example.com' })).status, 200);
    assert.equal((await admin('POST', '/grants/remove', { email: 'stranger@example.com' })).status, 404);
    assert.equal((await s.call(stranger.cookie, 'GET', '/paid')).status, 402);
});

test('checkout is refused while Stripe still holds a past-due subscription, and a lapsed owner cannot invite', async (t) => {
    const s = await setup({ pastDueGraceMs: 86400000 });
    t.after(s.close);
    const owner = await s.login('owner-key');
    const base = Math.floor(s.clock.value / 1000);
    await s.sendEvent('customer.subscription.created', s.subscription(), base);
    await s.sendEvent('customer.subscription.updated', s.subscription({ status: 'past_due' }), base + 1);
    s.clock.value += 2 * 86400000; // grace over
    assert.equal((await s.call(owner.cookie, 'POST', '/billing/checkout', {})).body.error, 'subscription_exists');
    assert.equal((await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'a@example.com' })).status, 403);
    assert.equal((await s.call(owner.cookie, 'POST', '/billing/portal')).status, 200, 'can still fix the card in the portal');
});

test('checkout.session.completed arriving after the subscription event does not discard it', async (t) => {
    const s = await setup();
    t.after(s.close);
    const owner = await s.login('owner-key');
    const base = Math.floor(s.clock.value / 1000);
    await s.sendEvent('checkout.session.completed', {
        mode: 'subscription', client_reference_id: 'o1', customer: 'cus_1', subscription: 'sub_1', payment_status: 'unpaid'
    }, base + 5);
    assert.equal((await s.call(owner.cookie, 'GET', '/paid')).status, 402, 'unpaid session alone grants nothing');
    await s.sendEvent('customer.subscription.created', s.subscription(), base); // older event, delivered later
    assert.equal((await s.call(owner.cookie, 'GET', '/paid')).status, 200);
});

test('reconcile does not overwrite a webhook that landed while it was waiting on Stripe', async (t) => {
    const s = await setup();
    t.after(s.close);
    const owner = await s.login('owner-key');
    const base = Math.floor(s.clock.value / 1000);
    await s.sendEvent('customer.subscription.created', s.subscription({ current_period_end: base - 60 }), base);
    s.stripe.subscriptions.retrieve = async () => {
        await s.sendEvent('customer.subscription.updated', s.subscription({ status: 'past_due' }), base + 50);
        return s.subscription({ status: 'active' }); // stale read
    };
    await s.billing.reconcile();
    const me = await s.call(owner.cookie, 'GET', '/auth/me');
    assert.equal(me.body.entitlement.status, 'past_due');
});

test('plans: checkout needs a valid plan, price decides the plan, seats follow it and downgrades cut access', async (t) => {
    const plans = [
        { id: 'solo', name: 'Solo', priceId: 'price_solo', seats: 0 },
        { id: 'family', name: 'Family', priceId: 'price_family', seats: 2 }
    ];
    const s = await setup({ plans });
    t.after(s.close);
    const owner = await s.login('owner-key');
    const member = await s.login('member-key');
    const base = Math.floor(s.clock.value / 1000);

    const list = await s.call(owner.cookie, 'GET', '/billing/plans');
    assert.deepEqual(list.body.plans.map((p) => p.id), ['solo', 'family']);
    assert.equal(JSON.stringify(list.body).includes('price_'), false, 'price ids stay on the server');

    assert.equal((await s.call(owner.cookie, 'POST', '/billing/checkout', {})).body.error, 'invalid_plan');
    assert.equal((await s.call(owner.cookie, 'POST', '/billing/checkout', { planId: 'nope' })).status, 400);
    await s.call(owner.cookie, 'POST', '/billing/checkout', { planId: 'family' });
    assert.equal(s.checkoutCalls.at(-1).line_items[0].price, 'price_family');
    assert.equal(s.checkoutCalls.at(-1).subscription_data.metadata.planId, 'family');

    const item = (price) => ({ data: [{ price: { id: price } }] });
    await s.sendEvent('customer.subscription.created', s.subscription({ items: item('price_family') }), base);
    assert.equal((await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'friend@example.com' })).status, 201);
    assert.equal((await s.call(member.cookie, 'GET', '/paid')).status, 200);

    // Switching to Solo in the Stripe portal removes the seat
    await s.sendEvent('customer.subscription.updated', s.subscription({ items: item('price_solo') }), base + 1);
    assert.equal((await s.call(member.cookie, 'GET', '/paid')).status, 402);
    assert.equal((await s.call(owner.cookie, 'GET', '/auth/me')).body.entitlement.plan.id, 'solo');
    assert.equal((await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'b@example.com' })).body.error, 'seat_limit_reached');
});

test('a failed disk write is never acknowledged to Stripe and invite changes are rolled back', async (t) => {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const s = await setup({ dataFile: path.join(dir, 'billing.json') });
    t.after(s.close);
    const owner = await s.login('owner-key');
    const base = Math.floor(s.clock.value / 1000);
    await s.sendEvent('customer.subscription.created', s.subscription(), base);

    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'a file where the directory should be'); // mkdir now fails
    const failed = await s.sendEvent('customer.subscription.updated', s.subscription({ status: 'canceled' }), base + 1, 'evt_retry');
    assert.equal(failed.status, 500);
    assert.equal((await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'a@example.com' })).status, 500);
    assert.deepEqual((await s.call(owner.cookie, 'GET', '/billing/invites')).body.invites, [], 'rolled back');

    fs.rmSync(dir, { force: true });
    const retried = await s.sendEvent('customer.subscription.updated', s.subscription({ status: 'canceled' }), base + 1, 'evt_retry');
    assert.equal(retried.status, 200);
    assert.equal(retried.body.duplicate, undefined, 'the retry was processed, not skipped as a duplicate');
});

test('erasure: removes an email everywhere, refuses while a subscription is live', async (t) => {
    const s = await setup();
    t.after(s.close);
    const owner = await s.login('owner-key');
    const member = await s.login('member-key');
    const base = Math.floor(s.clock.value / 1000);
    const admin = (path, body) => fetch(`${s.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` }, body: JSON.stringify(body) });

    await s.sendEvent('customer.subscription.created', s.subscription(), base);
    await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'friend@example.com' });
    await s.call(member.cookie, 'GET', '/auth/me'); // accepts the invite
    assert.equal((await admin('/admin/billing/erase', { email: 'owner@example.com' })).status, 409, 'live subscription');

    // the invitee asks to be forgotten
    assert.equal((await admin('/admin/billing/erase', { email: 'friend@example.com' })).status, 200);
    assert.equal((await s.call(member.cookie, 'GET', '/paid')).status, 402);
    assert.deepEqual((await s.call(owner.cookie, 'GET', '/billing/invites')).body.invites, []);

    // owner cancels, then is erased completely
    await s.sendEvent('customer.subscription.deleted', s.subscription(), base + 5);
    const erased = await (await admin('/admin/billing/erase', { email: 'owner@example.com' })).json();
    assert.equal(erased.ownersErased, 1);
    const overview = await (await fetch(`${s.base}/admin/billing`, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
    assert.equal(overview.total, 0);

    // user record erasure revokes the cookie and drops the email
    assert.equal((await admin('/admin/users/erase', { email: 'owner@example.com' })).status, 200);
    assert.equal((await s.call(owner.cookie, 'GET', '/auth/me')).status, 401);
    const sessions = await (await fetch(`${s.base}/admin/sessions`, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
    assert.equal(JSON.stringify(sessions).includes('owner@example.com'), false);
    assert.equal((await admin('/admin/users/erase', { email: 'nobody@example.com' })).status, 404);
});

test('members can leave a shared plan; owners can resend pending invitations', async (t) => {
    const sent = [];
    const s = await setup({ sendInviteEmail: async (details) => { sent.push(details); } });
    t.after(s.close);
    const owner = await s.login('owner-key');
    const member = await s.login('member-key');
    const base = Math.floor(s.clock.value / 1000);
    await s.sendEvent('customer.subscription.created', s.subscription(), base);
    await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'friend@example.com' });
    assert.equal(sent.length, 1);

    const resent = await s.call(owner.cookie, 'POST', '/billing/invites/resend', { email: 'friend@example.com' });
    assert.equal(resent.body.notified, true);
    assert.equal(sent.length, 2);
    assert.equal((await s.call(owner.cookie, 'POST', '/billing/invites/resend', { email: 'nobody@example.com' })).status, 404);

    assert.equal((await s.call(member.cookie, 'GET', '/paid')).status, 200); // joins
    assert.equal((await s.call(owner.cookie, 'POST', '/billing/invites/resend', { email: 'friend@example.com' })).body.error, 'already_joined');
    assert.equal((await s.call(owner.cookie, 'POST', '/billing/leave')).status, 404, 'owner is not a member');

    assert.equal((await s.call(member.cookie, 'POST', '/billing/leave')).status, 200);
    assert.equal((await s.call(member.cookie, 'GET', '/paid')).status, 402, 'access ends when leaving');
    assert.deepEqual((await s.call(owner.cookie, 'GET', '/billing/invites')).body.invites, [], 'seat is freed');
    assert.ok(s.audit.recent().some((entry) => entry.action === 'member-left'));
});

test('banned emails cannot log in, lose live sessions, and can be unbanned', async (t) => {
    const s = await setup();
    t.after(s.close);
    const stranger = await s.login('stranger-key');
    const admin = (path, body) => fetch(`${s.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` }, body: JSON.stringify(body) });
    assert.equal((await s.call(stranger.cookie, 'GET', '/auth/me')).status, 200);

    assert.equal((await admin('/admin/ban', { email: 'Stranger@Example.com', note: 'abuse' })).status, 201);
    assert.equal((await s.call(stranger.cookie, 'GET', '/auth/me')).status, 401, 'live cookie is revoked');
    const again = await s.login('stranger-key');
    assert.equal(again.status, 403);
    assert.equal(again.body.error, 'banned');
    assert.equal((await s.login('owner-key')).status, 200, 'others unaffected');
    assert.equal((await admin('/admin/ban', { email: 'not-an-email' })).status, 400);

    assert.equal((await admin('/admin/unban', { email: 'stranger@example.com' })).status, 200);
    assert.equal((await admin('/admin/unban', { email: 'stranger@example.com' })).status, 404);
    assert.equal((await s.login('stranger-key')).status, 200);
    const log = await (await fetch(`${s.base}/admin/audit`, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
    assert.deepEqual(log.entries.map((entry) => entry.action).slice(0, 2), ['unban', 'ban']);
});

test('automatic tax is only requested when enabled', async (t) => {
    const on = await setup({ automaticTax: true });
    t.after(on.close);
    const user = await on.login('owner-key');
    await on.call(user.cookie, 'POST', '/billing/checkout', {});
    assert.equal(on.checkoutCalls.at(-1).automatic_tax.enabled, true);
    assert.equal(on.checkoutCalls.at(-1).billing_address_collection, 'required');
    const off = await setup();
    t.after(off.close);
    const other = await off.login('owner-key');
    await off.call(other.cookie, 'POST', '/billing/checkout', {});
    assert.equal(off.checkoutCalls.at(-1).automatic_tax, undefined);
});

test('invite confirmation: no access until the emailed one-time link is opened', async (t) => {
    const mails = [];
    const s = await setup({ confirmInvites: true, sendInviteEmail: async (details) => { mails.push(details); } });
    t.after(s.close);
    const owner = await s.login('owner-key');
    const member = await s.login('member-key');
    const base = Math.floor(s.clock.value / 1000);
    await s.sendEvent('customer.subscription.created', s.subscription(), base);

    const added = await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'friend@example.com' });
    assert.equal(added.body.invites[0].confirmed, false);
    assert.equal(JSON.stringify(added.body).includes('confirmHash'), false, 'hash never leaves the server');
    assert.match(mails[0].confirmUrl, /\/billing\/confirm\?token=/);
    assert.equal((await s.call(member.cookie, 'GET', '/paid')).status, 402, 'unconfirmed invite grants nothing');

    const link = (url) => `${s.base}${new URL(url).pathname}${new URL(url).search}`;
    assert.equal((await fetch(`${s.base}/billing/confirm?token=wrong`, { redirect: 'manual' })).status, 404);

    // resending invalidates the first link
    await s.call(owner.cookie, 'POST', '/billing/invites/resend', { email: 'friend@example.com' });
    assert.notEqual(mails[1].confirmUrl, mails[0].confirmUrl);
    assert.equal((await fetch(link(mails[0].confirmUrl), { redirect: 'manual' })).status, 404, 'old link is dead');

    const ok = await fetch(link(mails[1].confirmUrl), { redirect: 'manual' });
    assert.equal(ok.status, 303);
    assert.equal((await s.call(member.cookie, 'GET', '/paid')).status, 200, 'confirmed invite grants access');
    assert.equal((await fetch(link(mails[1].confirmUrl), { redirect: 'manual' })).status, 404, 'one-time');
    assert.equal((await s.call(owner.cookie, 'GET', '/billing/invites')).body.invites[0].confirmed, true);
});

test('invite confirmation links expire after 7 days', async (t) => {
    const mails = [];
    const s = await setup({ confirmInvites: true, sendInviteEmail: async (details) => { mails.push(details); } });
    t.after(s.close);
    const owner = await s.login('owner-key');
    await s.login('member-key');
    const base = Math.floor(s.clock.value / 1000);
    await s.sendEvent('customer.subscription.created', s.subscription(), base);
    await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'friend@example.com' });
    s.clock.value += 8 * 86400000;
    const url = new URL(mails[0].confirmUrl);
    assert.equal((await fetch(`${s.base}${url.pathname}${url.search}`, { redirect: 'manual' })).status, 404);
});

const joined = async (s, extra = {}) => {
    const owner = await s.login('owner-key');
    const member = await s.login('member-key');
    const base = Math.floor(s.clock.value / 1000);
    await s.sendEvent('customer.subscription.created', s.subscription(), base);
    await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'friend@example.com', ...extra });
    await s.call(member.cookie, 'GET', '/auth/me'); // accepts the invite
    return { owner, member, base };
};

test('manager role: managers invite and remove members but not managers, billing or roles', async (t) => {
    const s = await setup({ maxInvites: 3 });
    t.after(s.close);
    const { owner, member } = await joined(s);
    assert.equal((await s.call(member.cookie, 'POST', '/billing/invites', { email: 'guest@example.com' })).status, 403, 'plain member cannot invite');

    const promoted = await s.call(owner.cookie, 'POST', '/billing/invites/role', { email: 'friend@example.com', role: 'manager' });
    assert.equal(promoted.body.invites[0].role, 'manager');
    assert.equal((await s.call(owner.cookie, 'POST', '/billing/invites/role', { email: 'friend@example.com', role: 'god' })).status, 400);
    assert.equal((await s.call(member.cookie, 'GET', '/auth/me')).body.entitlement.canManageInvites, true);

    const view = await s.call(member.cookie, 'GET', '/billing/invites');
    assert.equal(view.body.you, 'manager');
    const added = await s.call(member.cookie, 'POST', '/billing/invites', { email: 'guest@example.com', role: 'manager' });
    assert.equal(added.status, 201);
    assert.equal(added.body.invites.find((i) => i.email === 'guest@example.com').role, 'member', 'managers cannot appoint managers');
    assert.equal((await s.call(member.cookie, 'POST', '/billing/invites', { email: 'owner@example.com' })).body.error, 'cannot_invite_self');

    assert.equal((await s.call(member.cookie, 'POST', '/billing/invites/role', { email: 'guest@example.com', role: 'manager' })).status, 403);
    assert.equal((await s.call(member.cookie, 'POST', '/billing/portal')).status, 404, 'no billing access');
    assert.equal((await s.call(member.cookie, 'POST', '/billing/transfer', { email: 'guest@example.com' })).status, 403);

    // the owner makes the second invitee a manager; the first manager cannot remove them
    await s.call(owner.cookie, 'POST', '/billing/invites/role', { email: 'guest@example.com', role: 'manager' });
    assert.equal((await s.call(member.cookie, 'POST', '/billing/invites/remove', { email: 'guest@example.com' })).status, 403);
    await s.call(owner.cookie, 'POST', '/billing/invites/role', { email: 'guest@example.com', role: 'member' });
    assert.equal((await s.call(member.cookie, 'POST', '/billing/invites/remove', { email: 'guest@example.com' })).status, 200);

    // demoted: no longer a manager
    await s.call(owner.cookie, 'POST', '/billing/invites/role', { email: 'friend@example.com', role: 'member' });
    assert.equal((await s.call(member.cookie, 'POST', '/billing/invites', { email: 'guest@example.com' })).status, 403);
});

test('ownership transfer: the member becomes owner, the old owner stays on as manager', async (t) => {
    const s = await setup();
    t.after(s.close);
    const { owner, member, base } = await joined(s);
    assert.equal((await s.call(owner.cookie, 'POST', '/billing/transfer', { email: 'nobody@example.com' })).status, 404);

    // not joined yet
    await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'guest@example.com' });
    assert.equal((await s.call(owner.cookie, 'POST', '/billing/transfer', { email: 'guest@example.com' })).body.error, 'not_joined');

    assert.equal((await s.call(owner.cookie, 'POST', '/billing/transfer', { email: 'friend@example.com' })).status, 200);
    assert.deepEqual(s.updates.at(-1), { id: 'sub_1', params: { metadata: { userId: 'm1' } } });
    const newOwner = (await s.call(member.cookie, 'GET', '/auth/me')).body.entitlement;
    assert.equal(newOwner.role, 'owner');
    assert.deepEqual(newOwner.invites, { used: 2, max: 2 }, 'old owner and the other invitee');
    const oldOwner = (await s.call(owner.cookie, 'GET', '/auth/me')).body.entitlement;
    assert.equal(oldOwner.role, 'member');
    assert.equal(oldOwner.canManageInvites, true);
    assert.equal(oldOwner.sharedBy, 'friend@example.com');

    // Stripe events keep following the customer to the new owner (even though metadata still names the old one)
    await s.sendEvent('customer.subscription.updated', s.subscription({ status: 'past_due', metadata: { userId: 'o1' } }), base + 10);
    assert.equal((await s.call(member.cookie, 'GET', '/auth/me')).body.entitlement.status, 'past_due');
    assert.equal((await s.call(member.cookie, 'POST', '/billing/portal')).status, 200);
    assert.equal((await s.call(owner.cookie, 'POST', '/billing/portal')).status, 404, 'old owner has no billing access');
    const log = s.audit.recent().find((entry) => entry.action === 'ownership-transferred');
    assert.deepEqual([log.from, log.to], ['owner@example.com', 'friend@example.com']);
});

test('transfer is refused when the target already pays for their own plan', async (t) => {
    const s = await setup();
    t.after(s.close);
    const { owner, base } = await joined(s);
    await s.sendEvent('customer.subscription.created', s.subscription({ id: 'sub_2', customer: 'cus_2', metadata: { userId: 'm1' } }), base + 1);
    assert.equal((await s.call(owner.cookie, 'POST', '/billing/transfer', { email: 'friend@example.com' })).body.error, 'target_has_plan');
});

test('invitations that nobody used expire; a resend renews them; joined members never expire', async (t) => {
    const s = await setup({ inviteExpiryMs: 5 * 86400000, sendInviteEmail: async () => {} });
    t.after(s.close);
    const owner = await s.login('owner-key');
    const member = await s.login('member-key');
    const guest = await s.login('guest-key');
    const base = Math.floor(s.clock.value / 1000);
    await s.sendEvent('customer.subscription.created', s.subscription({ current_period_end: base + 90 * 86400 }), base);
    await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'friend@example.com' });
    await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'guest@example.com' });
    assert.equal((await s.call(guest.cookie, 'GET', '/paid')).status, 200, 'joins in time');

    s.clock.value += 6 * 86400000;
    assert.equal((await s.call(owner.cookie, 'GET', '/billing/invites')).body.invites.find((i) => i.email === 'friend@example.com').expired, true);
    assert.equal((await s.call(member.cookie, 'GET', '/paid')).status, 402, 'unused invite expired');
    assert.equal((await s.call(guest.cookie, 'GET', '/paid')).status, 200, 'joined member keeps access');

    await s.call(owner.cookie, 'POST', '/billing/invites/resend', { email: 'friend@example.com' });
    assert.equal((await s.call(member.cookie, 'GET', '/paid')).status, 200, 'renewed by resend');
});

test('courtesy emails: removed members and lapsed plans are told, failures never block', async (t) => {
    const notices = [];
    const s = await setup({ maxInvites: 3, sendNotice: async (details) => { notices.push(details); } });
    t.after(s.close);
    const { owner, base } = await joined(s);
    await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'guest@example.com' }); // pending, never joined

    await s.call(owner.cookie, 'POST', '/billing/invites/remove', { email: 'guest@example.com' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(notices, [], 'pending invitees get no removal notice');

    await s.sendEvent('customer.subscription.deleted', s.subscription(), base + 5);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(notices, [{ to: 'friend@example.com', kind: 'lapsed', ownerEmail: 'owner@example.com' }]);

    const failing = await setup({ sendNotice: async () => { throw new Error('mail down'); } });
    t.after(failing.close);
    const j = await joined(failing);
    assert.equal((await failing.call(j.owner.cookie, 'POST', '/billing/invites/remove', { email: 'friend@example.com' })).status, 200);
});

test('removing a joined member emails them', async (t) => {
    const notices = [];
    const s = await setup({ sendNotice: async (details) => { notices.push(details); } });
    t.after(s.close);
    const { owner } = await joined(s);
    await s.call(owner.cookie, 'POST', '/billing/invites/remove', { email: 'friend@example.com' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(notices, [{ to: 'friend@example.com', kind: 'removed', ownerEmail: 'owner@example.com' }]);
});

test('device limit: a new device signs out the oldest, which is told why; the same browser keeps its slot', async (t) => {
    const s = await setup({ authOptions: { maxDevices: 2 } });
    t.after(s.close);
    const a = await s.login('owner-key');
    const a2 = await s.login('owner-key'); // second browser
    assert.notEqual(a.cookie, a2.cookie);
    assert.deepEqual(a2.body.devices, { used: 2, max: 2 });

    // the same browser presenting its key again does not use a new slot
    const again = await fetch(`${s.base}/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: a.cookie }, body: JSON.stringify({ authKey: 'owner-key' }) });
    assert.deepEqual((await again.json()).devices, { used: 2, max: 2 });

    const a3 = await s.login('owner-key'); // third device: the least recently used one (a2; a was just used) is signed out
    assert.deepEqual(a3.body.devices, { used: 2, max: 2 });
    const evicted = await s.call(a2.cookie, 'GET', '/auth/me');
    assert.equal(evicted.status, 401);
    assert.equal(evicted.body.error, 'session_replaced');
    assert.equal((await s.call(a.cookie, 'GET', '/auth/me')).status, 200);
    assert.equal((await s.call(a3.cookie, 'GET', '/auth/me')).status, 200);

    // other users are unaffected and a garbage cookie is just "not logged in"
    assert.equal((await s.login('member-key')).status, 200);
    assert.equal((await s.call('stremio_session=junk', 'GET', '/auth/me')).body.error, 'not_logged_in');

    // logging out one device keeps the others
    await fetch(`${s.base}/auth/logout`, { method: 'POST', headers: { cookie: a3.cookie } });
    assert.equal((await s.call(a3.cookie, 'GET', '/auth/me')).status, 401);
    assert.equal((await s.call(a.cookie, 'GET', '/auth/me')).status, 200);
});

test('without a device limit everything behaves as before', async (t) => {
    const s = await setup();
    t.after(s.close);
    const a = await s.login('owner-key');
    await s.login('owner-key');
    await s.login('owner-key');
    assert.equal((await s.call(a.cookie, 'GET', '/auth/me')).status, 200);
    assert.equal((await s.call(a.cookie, 'GET', '/auth/me')).body.devices, null);
});

test('data export returns what is stored about an email, without secrets', async (t) => {
    const s = await setup({ confirmInvites: true, sendInviteEmail: async () => {} });
    t.after(s.close);
    const owner = await s.login('owner-key');
    await s.login('member-key');
    const base = Math.floor(s.clock.value / 1000);
    await s.sendEvent('customer.subscription.created', s.subscription(), base);
    await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'friend@example.com' });
    const get = async (path) => (await fetch(`${s.base}${path}`, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
    const mine = await get('/admin/billing/export?email=owner@example.com');
    assert.equal(mine.owners[0].invites[0].email, 'friend@example.com');
    const theirs = await get('/admin/billing/export?email=Friend@example.com');
    assert.equal(theirs.invitedBy[0].ownerEmail, 'owner@example.com');
    const users = await get('/admin/users/export?email=owner@example.com');
    assert.equal(users.users[0].email, 'owner@example.com');
    assert.equal(JSON.stringify([mine, theirs, users]).match(/confirmHash|sessions|evicted/), null);
    assert.equal((await fetch(`${s.base}/admin/billing/export?email=x@y.zz`)).status, 404, 'needs the admin token');
});

test('operator can remove an invitee from an owner\'s plan', async (t) => {
    const s = await setup();
    t.after(s.close);
    const owner = await s.login('owner-key');
    const member = await s.login('member-key');
    const base = Math.floor(s.clock.value / 1000);
    const admin = (body, token = ADMIN) => fetch(`${s.base}/admin/billing/invites/remove`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

    await s.sendEvent('customer.subscription.created', s.subscription(), base);
    await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'friend@example.com' });
    await s.call(member.cookie, 'GET', '/auth/me'); // accepts the invite

    assert.equal((await admin({ owner: 'owner@example.com', email: 'friend@example.com' }, 'wrong')).status, 404, 'admin only');
    assert.equal((await admin({ owner: 'nobody@example.com', email: 'friend@example.com' })).status, 404);
    assert.equal((await admin({ owner: 'owner@example.com', email: 'friend@example.com' })).status, 200);
    assert.equal((await s.call(member.cookie, 'GET', '/paid')).status, 402, 'access ended immediately');
    assert.deepEqual((await s.call(owner.cookie, 'GET', '/billing/invites')).body.invites, []);
    assert.equal((await admin({ owner: 'owner@example.com', email: 'friend@example.com' })).status, 404, 'already gone');
});

test('plans: a plan list that changes live is honoured and archived plans stay recognised for subscribers', async (t) => {
    const list = [
        { id: 'solo', name: 'Solo', priceId: 'price_solo', seats: 0, priceLabel: '$9 / month' },
        { id: 'family', name: 'Family', priceId: 'price_family', seats: 2 }
    ];
    const s = await setup({ plans: () => list });
    t.after(s.close);
    const owner = await s.login('owner-key');
    const base = Math.floor(s.clock.value / 1000);

    let offered = (await s.call(owner.cookie, 'GET', '/billing/plans')).body.plans;
    assert.deepEqual(offered.map((p) => p.id), ['solo', 'family']);
    assert.equal(offered[0].priceLabel, '$9 / month');
    assert.equal(JSON.stringify(offered).includes('price_'), false, 'price ids stay on the server');

    list.push({ id: 'team', name: 'Team', priceId: 'price_team', seats: 10 });
    offered = (await s.call(owner.cookie, 'GET', '/billing/plans')).body.plans;
    assert.deepEqual(offered.map((p) => p.id), ['solo', 'family', 'team'], 'new plan appears without a restart');

    // A subscriber on Family; the operator then archives Family
    const item = (price) => ({ data: [{ price: { id: price } }] });
    await s.sendEvent('customer.subscription.created', s.subscription({ items: item('price_family') }), base);
    list[1].archived = true;
    offered = (await s.call(owner.cookie, 'GET', '/billing/plans')).body.plans;
    assert.deepEqual(offered.map((p) => p.id), ['solo', 'team'], 'archived plan no longer offered');
    const buyer = await s.login('guest-key');
    assert.equal((await s.call(buyer.cookie, 'POST', '/billing/checkout', { planId: 'family' })).status, 400, 'and cannot be bought');
    assert.equal((await s.call(owner.cookie, 'POST', '/billing/invites', { email: 'friend@example.com' })).status, 201, 'existing subscriber keeps the plan and its shared seats');
});
