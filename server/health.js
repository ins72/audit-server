'use strict';

// Operator health and setup checklist. Every item answers one question: is this part of the install ready?
// status: ok (fine), warn (works but fix soon), fail (broken or unsafe for production), off (feature not enabled on purpose).
// Nothing secret is ever returned, only whether it is set.

const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

const newestBackup = (file) => {
    try {
        const prefix = `${path.basename(file)}.bak-`;
        const names = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(prefix)).sort();
        if (names.length === 0) return null;
        return fs.statSync(path.join(path.dirname(file), names[names.length - 1])).mtimeMs;
    } catch (_e) {
        return null;
    }
};

const sizeOf = (file) => {
    try { return fs.statSync(file).size; } catch (_e) { return 0; }
};

// options: env (object), files ({name: path}), storageHealthy (fn), lastWebhookAt (fn), plans (fn -> active plans),
// settings (fn -> effective settings), mailConfigured (bool), paywallEnabled (bool), version (string), now (fn)
const createHealth = ({ env = process.env, files = {}, storageHealthy = () => true, lastWebhookAt = () => null, plans = () => [], settings = () => ({}),
    mailConfigured = false, accounts = null, trakt = null, paywallEnabled = false, version = 'unknown', now = Date.now, startedAt = Date.now() } = {}) => {
    const report = () => {
        const items = [];
        const add = (id, group, label, status, detail, fix) => items.push({ id, group, label, status, detail, fix: fix || null });
        const t = now();

        // Security basics
        const secret = typeof env.SESSION_SECRET === 'string' && env.SESSION_SECRET.length >= 32;
        add('session-secret', 'Security', 'Session secret', secret ? 'ok' : 'fail', secret ? 'Set; sessions survive restarts.' : 'Not set: a random one is used and everybody is signed out on every restart.', 'Set SESSION_SECRET to 32+ random characters.');
        const token = typeof env.ADMIN_TOKEN === 'string' ? env.ADMIN_TOKEN.length : 0;
        add('admin-token', 'Security', 'Operator token', token >= 24 ? 'ok' : token > 0 ? 'warn' : 'fail', token >= 24 ? 'Set and long enough.' : token > 0 ? 'Set but short (under 24 characters).' : 'Not set: the operator panel cannot be used.', 'Set ADMIN_TOKEN to 24+ random characters.');
        const url = env.PUBLIC_URL || '';
        const https = /^https:\/\//i.test(url);
        add('public-url', 'Security', 'Public address', https ? 'ok' : url ? 'warn' : 'fail', https ? url : url ? 'Set but not https.' : 'Not set: origin checks, emails and Stripe return links need it.', 'Set PUBLIC_URL to your https address.');
        add('cookie-secure', 'Security', 'Secure cookies', env.COOKIE_SECURE === 'true' ? 'ok' : https ? 'fail' : 'warn', env.COOKIE_SECURE === 'true' ? 'Cookies are HTTPS-only.' : 'Session cookies may travel over plain HTTP.', 'Set COOKIE_SECURE=true once served over HTTPS.');
        add('proxy', 'Security', 'Reverse proxy', env.TRUST_PROXY ? 'ok' : 'warn', env.TRUST_PROXY ? `TRUST_PROXY=${env.TRUST_PROXY}` : 'TRUST_PROXY is not set. Behind a proxy every visitor looks like one address, which breaks rate limits.', 'Set TRUST_PROXY=1 behind one proxy; ignore if you serve directly.');

        // Payments
        if (!paywallEnabled) {
            add('paywall', 'Payments', 'Paywall', 'off', 'Switched off: every logged-in user has access.', 'Set PAYWALL_ENABLED=true when ready to charge.');
        } else {
            const active = plans();
            add('plans', 'Payments', 'Plans', active.length > 0 && active.every((plan) => plan.priceId) ? 'ok' : 'fail', `${active.length} active plan${active.length === 1 ? '' : 's'}.`, 'Add a plan with a Stripe price in the Plans section.');
            const last = lastWebhookAt();
            add('webhook', 'Payments', 'Stripe webhook', last ? (t - last < 35 * DAY ? 'ok' : 'warn') : 'warn',
                last ? `Last event received ${new Date(last).toISOString()}.` : 'No event received yet. Normal before the first purchase; send a test event from Stripe to confirm.',
                'Stripe Dashboard, Developers, Webhooks: endpoint PUBLIC_URL/billing/webhook.');
        }

        // Email
        add('mail', 'Email', 'Invite emails', mailConfigured ? 'ok' : 'off', mailConfigured ? 'Resend is configured.' : 'Not configured: owners have to tell invitees themselves.', 'Set RESEND_API_KEY, MAIL_FROM and PUBLIC_URL.');

        // Own account service (only when OWN_ACCOUNTS=true)
        if (accounts) {
            const info = accounts();
            add('accounts', 'Data', 'Account service', info.healthy ? 'ok' : 'fail', info.healthy ? `Own accounts on: ${info.count} account${info.count === 1 ? '' : 's'} in the database.` : 'The account database cannot be read.', 'Check data/accounts.db: permissions and free space.');
            add('reset-mail', 'Email', 'Password reset emails', mailConfigured ? 'ok' : 'warn', mailConfigured ? 'Resend is configured.' : 'Not configured: people who forget their password cannot reset it.', 'Set RESEND_API_KEY, MAIL_FROM and PUBLIC_URL.');
        }

        if (accounts && trakt) {
            const on = trakt();
            add('trakt', 'Email', 'Trakt', on ? 'ok' : 'off', on ? 'Connected people get their watchlist and history synced.' : 'Not set up: the Trakt option is hidden in the app.', 'Create a Trakt API app (redirect PUBLIC_URL/trakt/callback) and set TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET.');
        }

        // Branding and legal
        const s = settings();
        add('support-email', 'Branding', 'Support email', s.supportEmail ? 'ok' : 'warn', s.supportEmail || 'Blocked users are told to contact "support" without an address.', 'Set the support email in Settings.');
        add('legal-links', 'Branding', 'Terms and privacy links', s.termsUrl && s.privacyUrl ? 'ok' : 'warn', s.termsUrl && s.privacyUrl ? 'Both set.' : 'Missing: needed before taking payments in most places.', 'Set both links in Settings.');

        // Data
        const storage = storageHealthy();
        add('storage', 'Data', 'Disk writes', storage ? 'ok' : 'fail', storage ? 'Last write succeeded.' : 'The last write failed: changes may not be saved.', 'Check the volume: free space, permissions.');
        const names = Object.keys(files);
        const total = names.reduce((sum, name) => sum + sizeOf(files[name]), 0);
        add('data-size', 'Data', 'Data size', total > 200 * MB ? 'warn' : 'ok', `${(total / MB).toFixed(1)} MB across ${names.length} files.`, 'Above about 200 MB plan the database move (task P1-03).');
        const times = names.map((name) => newestBackup(files[name])).filter(Boolean);
        const backup = times.length ? Math.max(...times) : null;
        add('backup', 'Data', 'Daily backup', backup ? (t - backup < 3 * DAY ? 'ok' : 'warn') : 'warn', backup ? `Newest local copy ${new Date(backup).toISOString().slice(0, 10)}. Local copies share the disk: also back up the folder elsewhere.` : 'No local backup copy yet (made at startup once data exists).', 'Copy the data folder off the machine on a schedule.');
        try {
            const dir = names.length ? path.dirname(files[names[0]]) : '.';
            const stat = fs.statfsSync(dir);
            const free = stat.bavail * stat.bsize;
            add('disk', 'Data', 'Free disk space', free < 500 * MB ? 'fail' : free < 2048 * MB ? 'warn' : 'ok', `${(free / 1024 / MB).toFixed(1)} GB free.`, 'Free space or enlarge the volume.');
        } catch (_e) { /* statfs not available: skip */ }

        const counts = { ok: 0, warn: 0, fail: 0, off: 0 };
        items.forEach((item) => { counts[item.status] += 1; });
        return {
            overall: counts.fail ? 'fail' : counts.warn ? 'warn' : 'ok',
            counts,
            system: { version, node: process.version, uptimeSeconds: Math.round((t - startedAt) / 1000), now: new Date(t).toISOString() },
            items
        };
    };
    return { report };
};

module.exports = { createHealth };
