// End-to-end check of the real http_server.js: "download my data" needs a session and never leaks the Stremio key.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

test('GET /auth/my-data returns only the signed-in person\'s records', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mydata-'));
    const stremio = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => res.end(JSON.stringify({ result: { _id: 'u1', email: 'Me@Example.com' } })));
    });
    await new Promise((resolve) => stremio.listen(0, '127.0.0.1', resolve));
    const port = await new Promise((resolve) => {
        const probe = net.createServer().listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
    });
    const server = spawn('node', [path.join(__dirname, '..', 'http_server.js')], {
        env: {
            ...process.env, PORT: String(port), SESSION_SECRET: 'x'.repeat(40),
            STREMIO_API_URL: `http://127.0.0.1:${stremio.address().port}`,
            USERS_FILE: path.join(dir, 'u.json'), BILLING_FILE: path.join(dir, 'b.json'), SETTINGS_FILE: path.join(dir, 'settings.json'), PLANS_FILE: path.join(dir, 'plans.json'),
            STATS_FILE: path.join(dir, 's.json'), AUDIT_FILE: path.join(dir, 'a.log')
        },
        stdio: 'ignore'
    });
    // The server flushes its data files while shutting down, so wait for it to exit before deleting the directory.
    t.after(async () => {
        const exited = new Promise((resolve) => server.once('exit', resolve));
        server.kill();
        await exited;
        stremio.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i += 1) {
        if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal((await fetch(`${base}/auth/my-data`)).status, 401);
    const login = await fetch(`${base}/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authKey: 'secret-key' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`${base}/auth/my-data`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /my-data\.json/);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(body.account.email, 'me@example.com');
    assert.equal(body.account.users.length, 1);
    assert.equal(body.billing.email, 'me@example.com');
    assert.equal(text.includes('secret-key'), false, 'the Stremio key is never stored or exported');
});
