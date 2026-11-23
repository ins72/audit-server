// Self-contained load test: starts a fake Stremio API and a real http_server.js on random ports with temporary
// data files, logs in N users at the same moment, then sends 3 rounds of heartbeats for all of them.
//
//   node server/tools/loadtest.js [users=3000]            (MAX_DEVICES=3 node ... to include the device limit)
//
// Prints failures by status/error, timings and the server's health afterwards. Exit code 1 on any failure.
// It measures this machine only (loopback, no TLS, a fake instant Stremio): use it to spot regressions, not to size hardware.

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const users = Number(process.argv[2]) || 3000;

const freePort = () => new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
    });
});

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtest-'));
    const stremio = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const key = JSON.parse(body).authKey;
            res.end(JSON.stringify({ result: { _id: `u${key}`, email: `u${key}@example.com` } }));
        });
    });
    await new Promise((resolve) => stremio.listen(0, '127.0.0.1', resolve));
    const port = await freePort();
    const server = spawn('node', [path.join(__dirname, '..', '..', 'http_server.js')], {
        env: {
            ...process.env,
            PORT: String(port),
            SESSION_SECRET: 'l'.repeat(40),
            STREMIO_API_URL: `http://127.0.0.1:${stremio.address().port}`,
            USERS_FILE: path.join(dir, 'users.json'),
            BILLING_FILE: path.join(dir, 'billing.json'),
            AUDIT_FILE: path.join(dir, 'audit.log')
        },
        stdio: ['ignore', 'ignore', 'inherit']
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const base = `http://127.0.0.1:${port}`;
    const failures = {};
    const fail = (reason) => { failures[reason] = (failures[reason] || 0) + 1; };

    let started = Date.now();
    const cookies = await Promise.all(Array.from({ length: users }, async (_unused, index) => {
        try {
            const response = await fetch(`${base}/auth/session`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ authKey: String(index) })
            });
            if (response.status !== 200) {
                fail(`login ${response.status}`);
                return null;
            }
            return response.headers.get('set-cookie').split(';')[0];
        } catch (e) {
            fail(`login ${e.cause?.code || e.message}`);
            return null;
        }
    }));
    const ok = cookies.filter(Boolean);
    console.log(`logins: ${ok.length}/${users} in ${Date.now() - started} ms`);

    started = Date.now();
    let heartbeats = 0;
    for (let round = 0; round < 3; round += 1) {
        await Promise.all(ok.map(async (cookie) => {
            try {
                const response = await fetch(`${base}/auth/me`, { headers: { cookie } });
                if (response.status === 200) heartbeats += 1; else fail(`heartbeat ${response.status}`);
            } catch (e) {
                fail(`heartbeat ${e.cause?.code || e.message}`);
            }
        }));
    }
    console.log(`heartbeats: ${heartbeats}/${ok.length * 3} in ${Date.now() - started} ms`);

    const health = await fetch(`${base}/healthz`).then((response) => response.status).catch(() => 'unreachable');
    console.log(`healthz after load: ${health}`);
    console.log(`failures: ${JSON.stringify(failures)}`);

    server.kill('SIGTERM');
    stremio.close();
    fs.rmSync(dir, { recursive: true, force: true });
    setTimeout(() => process.exit(Object.keys(failures).length > 0 || health !== 200 ? 1 : 0), 800);
})();
