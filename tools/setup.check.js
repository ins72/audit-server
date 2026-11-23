'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

test('setup writes a private .env with fresh secrets and refuses to overwrite', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
    fs.mkdirSync(path.join(root, 'tools'));
    fs.copyFileSync(path.join(__dirname, 'setup.js'), path.join(root, 'tools', 'setup.js'));
    const run = (...a) => spawnSync(process.execPath, [path.join(root, 'tools', 'setup.js'), ...a], { encoding: 'utf8' });
    assert.notEqual(run().status, 0);
    assert.notEqual(run('--domain', 'localhost').status, 0);
    const ok = run('--domain', 'TV.Example.com');
    assert.equal(ok.status, 0, ok.stderr);
    const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
    assert.match(env, /^DOMAIN=tv\.example\.com$/m);
    assert.match(env, /^PUBLIC_URL=https:\/\/tv\.example\.com$/m);
    assert.match(env, /^SESSION_SECRET=[0-9a-f]{64}$/m);
    assert.match(env, /^ADMIN_TOKEN=[0-9a-f]{48}$/m);
    assert.match(env, /^OWN_ACCOUNTS=true$/m);
    assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o077, 0, 'only the owner can read it');
    assert.ok(ok.stdout.includes(env.match(/ADMIN_TOKEN=(\w+)/)[1]));
    assert.notEqual(run('--domain', 'tv.example.com').status, 0, 'does not overwrite');
    assert.equal(run('--domain', 'tv.example.com', '--force').status, 0);
    fs.rmSync(root, { recursive: true });
});
