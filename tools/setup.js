#!/usr/bin/env node
'use strict';
// First-run setup: writes .env with fresh secrets so `docker compose up -d` works.
//   node tools/setup.js --domain tv.example.com [--name "Acme TV"] [--force]
// Prints the operator token once; keep it, it opens the operator panel.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const domain = (flag('domain') || '').trim().toLowerCase();
if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) {
    console.error('Usage: node tools/setup.js --domain tv.example.com [--force]\nThe domain must already point at this machine (an A or AAAA record) so HTTPS can be issued.');
    process.exit(1);
}
const file = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(file) && !args.includes('--force')) {
    console.error('.env already exists. Nothing changed (use --force to replace it; the old secrets will stop working).');
    process.exit(1);
}
const secret = (bytes) => crypto.randomBytes(bytes).toString('hex');
const adminToken = secret(24);
const lines = [
    '# Written by tools/setup.js. See .env.example for every option.',
    `DOMAIN=${domain}`,
    `PUBLIC_URL=https://${domain}`,
    `SESSION_SECRET=${secret(32)}`,
    `ADMIN_TOKEN=${adminToken}`,
    'COOKIE_SECURE=true',
    'OWN_ACCOUNTS=true',
    'PAYWALL_ENABLED=false'
];
fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
console.log(`Wrote ${file}\n\nOperator token (shown once, also stored in .env): ${adminToken}\nNext: docker compose up -d   then open https://${domain}/operator/`);
