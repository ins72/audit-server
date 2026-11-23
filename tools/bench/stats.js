// Scale benchmark for the statistics module and the people list. Usage: node tools/bench/stats.js [repo-root] [users]
// Results from 2026-11-20 are in docs/PREMORTEM.md. Not part of the test suite (takes about 10 s at 100,000 users).
const path = require('path'); const fs = require('fs'); const os = require('os');
const root = process.argv[2] || path.join(__dirname, '..', '..');
const { createStats } = require(path.join(root, 'server/stats.js'));
const N = Number(process.argv[3] || 100000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
const users = []; const t0 = Date.now();
for (let i = 0; i < N; i++) users.push({ id: `u${i}`, email: `user${i}@example.com`, lastSeen: t0 - (i % 40) * 86400000, firstSeen: t0 - 90 * 86400000, logins: 1 + (i % 30) });
const stats = createStats({ dataFile: path.join(dir, 's.json'), listUsers: () => users });
let t = process.hrtime.bigint();
const lap = (label) => { const n = process.hrtime.bigint(); console.log(label.padEnd(44), (Number(n - t) / 1e6).toFixed(0).padStart(7), 'ms'); t = process.hrtime.bigint(); };
for (let i = 0; i < N; i++) stats.recordActive(`u${i}`, { login: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', language: 'en' });
lap(`recordActive x${N}`);
for (let i = 0; i < N; i += 3) stats.recordWatch(`u${i}`, { seconds: 600, type: 'movie', contentId: `tt${i % 5000}`, title: `Title ${i % 5000}`, start: true, source: 'torrent', addon: `addon${i % 20}.example`, completed: i % 5 === 0 });
lap(`recordWatch x${Math.ceil(N / 3)}`);
const roleOf = (u) => (u.logins % 7 === 0 ? 'owner' : 'none');
const s = stats.summary(30, roleOf); lap('summary(30)  [panel Statistics section]');
stats.summary(14, roleOf); lap('summary(14)');
const json = JSON.stringify(s); console.log('summary JSON size'.padEnd(44), (json.length / 1024).toFixed(0).padStart(7), 'KB');
stats.flush(); lap('flush to disk');
console.log('stats.json size'.padEnd(44), (fs.statSync(path.join(dir, 's.json')).size / 1048576).toFixed(1).padStart(7), 'MB');
const q = users.filter((u) => u.email.includes('user99')).length; lap(`filter ${N} users by email (search)`);
users.map((u) => ({ ...u, online: false })).sort((a, b) => b.lastSeen - a.lastSeen); lap(`map+sort ${N} users (sessions list)`);
console.log('full /admin/sessions JSON size (old behaviour)'.padEnd(44), (JSON.stringify(users).length / 1048576).toFixed(1).padStart(7), 'MB');
fs.rmSync(dir, { recursive: true, force: true });
