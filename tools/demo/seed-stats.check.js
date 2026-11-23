'use strict';
// Run with: node --test tools/demo/seed-stats.check.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seedStats } = require('./seed-stats');
const { createStats } = require('../../server/stats');

test('demo seeder is deterministic and produces history', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
    const ids = Array.from({ length: 15 }, (_, i) => `u-${i}`);
    const endAt = Date.parse('2026-11-20T12:00:00Z');
    seedStats(path.join(dir, 'a.json'), ids, { endAt });
    seedStats(path.join(dir, 'b.json'), ids, { endAt });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), fs.readFileSync(path.join(dir, 'b.json'), 'utf8'));
    const stats = createStats({ dataFile: path.join(dir, 'a.json'), enabled: true, listUsers: () => ids.map((id) => ({ id, email: `${id}@x.test`, firstSeen: endAt - 5 * 86400000, lastSeen: endAt, logins: 3 })), now: () => endAt });
    const summary = stats.summary(14, () => 'free');
    assert.ok(summary.daily.some((d) => d.activeUsers > 0));
    assert.ok(summary.totals.hoursWatched > 0);
    fs.rmSync(dir, { recursive: true, force: true });
});
