// Run with: pnpm run test:server   (uses node:test; named .check.js so jest ignores it)

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMailer } = require('./mailer');

test('mailer sends a plain-text invite through Resend with the right request shape', async () => {
    const calls = [];
    const mailer = createMailer({
        apiKey: 're_key', from: 'App <invites@example.test>', publicUrl: 'https://example.test',
        fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true }; }
    });
    await mailer.sendInvite({ to: 'friend@example.com', ownerEmail: 'owner@example.com' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.authorization, 'Bearer re_key');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.from, 'App <invites@example.test>');
    assert.deepEqual(body.to, ['friend@example.com']);
    assert.match(body.subject, /owner@example\.com invited you/);
    assert.match(body.text, /friend@example\.com/);
    assert.match(body.text, /https:\/\/example\.test/);
    assert.equal(body.html, undefined, 'no HTML is ever sent');
});

test('mailer strips line breaks from the owner name (no header/subject injection) and surfaces provider errors', async () => {
    let sentBody;
    const ok = createMailer({
        apiKey: 'k', from: 'a@b.co', publicUrl: 'https://x.test',
        fetchImpl: async (_url, init) => { sentBody = JSON.parse(init.body); return { ok: true }; }
    });
    await ok.sendInvite({ to: 'f@e.co', ownerEmail: 'evil@e.co\r\nBcc: victim@e.co' });
    assert.doesNotMatch(sentBody.subject, /[\r\n]/);

    const failing = createMailer({ apiKey: 'k', from: 'a@b.co', publicUrl: 'https://x.test', fetchImpl: async () => ({ ok: false, status: 422 }) });
    await assert.rejects(() => failing.sendInvite({ to: 'f@e.co', ownerEmail: 'o@e.co' }), /HTTP 422/);
});

test('mailer signs emails with the product name the operator set, read at send time', async () => {
    const sent = [];
    let name = '';
    const mailer = createMailer({ apiKey: 'k', from: 'f@example.com', publicUrl: 'https://tv.example.com', productName: () => name, fetchImpl: async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; } });
    await mailer.sendInvite({ to: 'a@example.com', ownerEmail: 'o@example.com' });
    assert.ok(!sent[0].text.includes('—'), 'no signature without a product name');
    name = 'Acme TV\r\nBcc: evil@example.com';
    await mailer.sendInvite({ to: 'a@example.com', ownerEmail: 'o@example.com' });
    await mailer.sendNotice({ to: 'a@example.com', kind: 'removed', ownerEmail: 'o@example.com' });
    assert.match(sent[1].text, /\n— Acme TV Bcc: evil@example.com$/, 'line breaks are flattened');
    assert.match(sent[2].text, /— Acme TV/);
});
