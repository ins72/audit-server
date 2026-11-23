'use strict';

// Inventory of everything that still says Stremio or talks to a Stremio host, grouped so it can be worked through.
// Usage: node tools/branding/audit.js [--json]   (run from the repository root)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SKIP = new Set(['node_modules', 'build', '.git', 'data', 'docs', 'tests']);
const TEXT = /\.(js|jsx|ts|tsx|json|html|less|css|md|svg|webmanifest)$/;
const HOST = /(?:https?:)?\/\/[a-z0-9.-]*(?:strem\.io|stremio\.com|stremio\.zendesk\.com|stremio\.github\.io)[^\s'"`)]*/gi;
const WORD = /stremio/gi;
const IMPORT = /(?:from|require\()\s*['"](?:stremio|@stremio)[^'"]*['"]/;

const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out); else out.push(full);
    }
    return out;
};

const result = { hosts: {}, strings: [], files: {}, assets: [] };
for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file);
    if (/stremio/i.test(path.basename(file)) && !TEXT.test(file)) result.assets.push(rel);
    if (!TEXT.test(file) || rel.startsWith('server/') || rel.startsWith('tools/') || rel === 'package.json' || rel === 'pnpm-lock.yaml') continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
        if (IMPORT.test(line) || /^\s*(import|export) .* from 'stremio\//.test(line)) return;
        const hosts = line.match(HOST) || [];
        hosts.forEach((host) => {
            const clean = host.replace(/[.,;]+$/, '');
            const key = clean.replace(/^(https?:)?\/\//, '').split(/[/?#]/)[0];
            result.hosts[key] = result.hosts[key] || [];
            result.hosts[key].push(`${rel}:${index + 1}`);
        });
        const withoutHosts = line.replace(HOST, '').replace(/stremio[-_/][\w.-]+|@stremio\/[\w.-]+|'stremio\/[^']*'/gi, '');
        if (WORD.test(withoutHosts)) {
            result.strings.push({ at: `${rel}:${index + 1}`, text: line.trim().slice(0, 140) });
            result.files[rel] = (result.files[rel] || 0) + 1;
        }
        WORD.lastIndex = 0;
    });
}

if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
} else {
    console.log(`Hosts (${Object.keys(result.hosts).length}):`);
    Object.entries(result.hosts).sort((a, b) => b[1].length - a[1].length).forEach(([host, at]) => console.log(`  ${String(at.length).padStart(3)}  ${host}   e.g. ${at[0]}`));
    console.log(`\nVisible-text lines mentioning Stremio: ${result.strings.length} in ${Object.keys(result.files).length} files`);
    Object.entries(result.files).sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([file, count]) => console.log(`  ${String(count).padStart(3)}  ${file}`));
    console.log(`\nAssets with Stremio in the file name: ${result.assets.length}`);
    result.assets.forEach((asset) => console.log(`  ${asset}`));
}
