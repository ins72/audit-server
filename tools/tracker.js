#!/usr/bin/env node
// Validates docs/tracker.csv and writes docs/BACKLOG.md. Usage: node tools/tracker.js [--check]
'use strict';
const fs = require('fs');
const path = require('path');
const csvPath = path.join(__dirname, '..', 'docs', 'tracker.csv');
const outPath = path.join(__dirname, '..', 'docs', 'BACKLOG.md');
const PHASES = {
    0: 'Verify and close what exists', 1: 'Foundation to sell', 2: 'Operate and localise', 3: 'Reliability and hosting',
    4: 'Content API', 5: 'Own accounts and clients', 6: 'Multi-tenant',
};
const STATUSES = ['todo', 'doing', 'blocked', 'done'];
const SIZES = ['S', 'M', 'L'];
const [head, ...lines] = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
const cols = head.split(',');
const rows = lines.map((l) => {
    const parts = l.split(',');
    if (parts.length !== cols.length) throw new Error(`Bad column count: ${l}`);
    return Object.fromEntries(cols.map((c, i) => [c, parts[i].trim()]));
});
const ids = new Set(rows.map((r) => r.id));
const errors = [];
if (ids.size !== rows.length) errors.push('Duplicate id');
for (const r of rows) {
    if (!STATUSES.includes(r.status)) errors.push(`${r.id}: bad status ${r.status}`);
    if (!SIZES.includes(r.size)) errors.push(`${r.id}: bad size ${r.size}`);
    if (!(r.phase in PHASES)) errors.push(`${r.id}: bad phase ${r.phase}`);
    for (const d of r.depends.split(' ').filter(Boolean)) if (!ids.has(d)) errors.push(`${r.id}: unknown dependency ${d}`);
    if (!r.done_when) errors.push(`${r.id}: missing done_when`);
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
const byId = new Map(rows.map((r) => [r.id, r]));
const ready = (r) => r.status === 'todo' && r.depends.split(' ').filter(Boolean).every((d) => byId.get(d).status === 'done');
const pct = (a) => (a.length ? Math.round((a.filter((r) => r.status === 'done').length / a.length) * 100) : 0);
let md = '# Backlog and progress\n\n> Generated from [`tracker.csv`](tracker.csv) by `node tools/tracker.js`. **Edit the CSV, not this file.** `--check` validates only.\n\n';
md += `Overall: **${rows.filter((r) => r.status === 'done').length}/${rows.length} done (${pct(rows)}%)**.\n\n`;
md += '## Next up (todo with every dependency done)\n\n';
const next = rows.filter(ready);
md += next.length ? next.map((r) => `- **${r.id}** ${r.title} (${r.size}, phase ${r.phase})`).join('\n') : '- nothing ready';
md += '\n\n';
for (const [p, name] of Object.entries(PHASES)) {
    const a = rows.filter((r) => r.phase === p);
    md += `## Phase ${p}: ${name} (${pct(a)}%)\n\n| ID | Task | Size | Decision | Depends | Done when | Status |\n|---|---|---|---|---|---|---|\n`;
    for (const r of a) md += `| ${r.id} | ${r.title} | ${r.size} | ${r.decision} | ${r.depends || '-'} | ${r.done_when} | ${r.status} |\n`;
    md += '\n';
}
if (process.argv.includes('--check')) { console.log(`OK ${rows.length} rows`); process.exit(0); }
fs.writeFileSync(outPath, md);
console.log(`Wrote ${outPath} (${rows.length} rows)`);
