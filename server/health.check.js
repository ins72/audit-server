'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHealth } = require('./health');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
const file = path.join(dir, 'users.json');
fs.writeFileSync(file, '{}');

const base = { files: { users: file }, now: () => Date.parse('2026-11-20T00:00:00Z') };
const find = (report, id) => report.items.find((item) => item.id === id);

test('a bare install fails the security checks and never leaks values', () => {
    const report = createHealth({ ...base, env: { ADMIN_TOKEN: 'short-token-value' } }).report();
    assert.strictEqual(report.overall, 'fail');
    assert.strictEqual(find(report, 'session-secret').status, 'fail');
    assert.strictEqual(find(report, 'admin-token').status, 'warn');
    assert.strictEqual(find(report, 'public-url').status, 'fail');
    assert.strictEqual(find(report, 'paywall').status, 'off');
    assert.ok(!JSON.stringify(report).includes('short-token-value'));
});

test('a complete install is all ok except what is warned about', () => {
    const env = { SESSION_SECRET: 'x'.repeat(40), ADMIN_TOKEN: 'y'.repeat(30), PUBLIC_URL: 'https://tv.example.com', COOKIE_SECURE: 'true', TRUST_PROXY: '1' };
    fs.writeFileSync(`${file}.bak-2026-11-19`, '{}');
    const report = createHealth({
        ...base, env, paywallEnabled: true, mailConfigured: true,
        plans: () => [{ id: 'solo', priceId: 'price_123' }],
        settings: () => ({ supportEmail: 'help@example.com', termsUrl: 'https://e.com/t', privacyUrl: 'https://e.com/p' }),
        lastWebhookAt: () => Date.parse('2026-11-18T00:00:00Z')
    }).report();
    assert.strictEqual(report.counts.fail, 0);
    ['webhook', 'plans', 'mail', 'support-email', 'legal-links', 'storage', 'backup'].forEach((id) => assert.strictEqual(find(report, id).status, 'ok', id));
});

test('paywall without plans or webhook, failed storage and stale backup are flagged', () => {
    const report = createHealth({ ...base, env: {}, paywallEnabled: true, storageHealthy: () => false, plans: () => [], now: () => Date.parse('2026-12-30T00:00:00Z') }).report();
    assert.strictEqual(find(report, 'plans').status, 'fail');
    assert.strictEqual(find(report, 'webhook').status, 'warn');
    assert.strictEqual(find(report, 'storage').status, 'fail');
    assert.strictEqual(find(report, 'backup').status, 'warn');
});

test('account service checks appear only with own accounts', () => {
    const off = createHealth({}).report().items.map((item) => item.id);
    assert.ok(!off.includes('accounts'));
    const on = createHealth({ accounts: () => ({ healthy: true, count: 3 }), mailConfigured: false }).report().items;
    assert.equal(on.find((item) => item.id === 'accounts').status, 'ok');
    assert.equal(on.find((item) => item.id === 'reset-mail').status, 'warn');
    assert.equal(createHealth({ accounts: () => ({ healthy: false, count: 0 }) }).report().items.find((item) => item.id === 'accounts').status, 'fail');
});
