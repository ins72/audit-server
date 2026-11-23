'use strict';

// Our own account service: the part of api.strem.io that holds people (email, password), their sign-in keys and their
// profile (library, add-on collection, settings). The unmodified Stremio core talks to it through POST /api/<name> with the
// same request and reply shapes (learned from stremio-core, see docs/ACCOUNTS_API.md). Public content services
// (Cinemeta and other add-ons) are not touched: they are ordinary add-ons the user's collection points at.
//
// Replies are always HTTP 200 with { result } or { error: { message, code } }, as the core expects.
// Storage is one JSON file (atomic writes, daily backups) like the rest of this server; a database is task P1-03.

const crypto = require('crypto');
const express = require('express');
const { createAccountsStore } = require('./accountsStore');
const { toSvg } = require('./qr');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAX_KEYS_PER_USER = 20;
const MAX_LIBRARY_ITEMS = 20000;
const MAX_ADDONS = 200;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 8;

// code: stable number the client can show or log; message: plain text people read
const ERR = {
    invalid_email: { message: 'Please enter a valid email address', code: 101 },
    weak_password: { message: `Password must be at least ${MIN_PASSWORD} characters`, code: 102 },
    consent_required: { message: 'You must accept the terms and the privacy policy', code: 103 },
    email_taken: { message: 'This email address is already registered', code: 104 },
    registration_closed: { message: 'New registrations are closed', code: 105 },
    user_not_found: { message: 'User not found', code: 1 },
    wrong_password: { message: 'Wrong passphrase', code: 2 },
    invalid_key: { message: 'Session expired', code: 1 },
    too_many_attempts: { message: 'Too many attempts, try again in a few minutes', code: 106 },
    link_waiting: { message: 'Waiting for the sign-in to be confirmed', code: 101 },
    link_invalid: { message: 'This code is invalid or has expired', code: 101 },
    unsupported: { message: 'This sign-in method is not available here', code: 107 },
    invalid_request: { message: 'Invalid request', code: 108 },
    too_large: { message: 'Too much data', code: 109 },
    storage: { message: 'The server could not save your data, try again', code: 110 },
    banned: { message: 'This account has been blocked', code: 111 }
};
const fail = (name) => ({ error: ERR[name] });

const hashKey = (authKey) => crypto.createHash('sha256').update(authKey).digest('hex');
const scrypt = (password, salt) => new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (error, key) => (error ? reject(error) : resolve(key)));
});
const hashPassword = async (password) => {
    const salt = crypto.randomBytes(16);
    return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${(await scrypt(password, salt)).toString('base64')}`;
};
const checkPassword = async (password, stored) => {
    const [kind, , salt, hash] = String(stored).split('$');
    if (kind !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = await scrypt(password, Buffer.from(salt, 'base64'));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};

const isoOrNull = (value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const createAccounts = ({ dataFile = ':memory:', store = null, audit = { record() {} }, fetchImpl = fetch, defaultAddonUrls = () => [], registrationOpen = () => true,
    sendResetEmail = null, productName = () => '', publicUrl = '', now = Date.now, resolveHost: resolveHostOption = null, addonRefresh = true } = {}) => {
    const db = store || createAccountsStore(dataFile);
    if (!store) db.startBackups(now);
    let traktService = null;
    const failures = new Map(); // "ip|email" -> [timestamps]

    const tooManyFailures = (id) => {
        const recent = (failures.get(id) || []).filter((time) => now() - time < FAIL_WINDOW_MS);
        failures.set(id, recent);
        if (failures.size > 5000) failures.clear(); // bounded memory under a spray of random emails
        return recent.length >= FAIL_LIMIT;
    };
    const noteFailure = (id) => failures.set(id, [...(failures.get(id) || []), now()]);

    const publicUser = (user) => ({
        _id: user.id,
        email: user.email,
        fbId: null,
        appleId: null,
        avatar: user.avatar || null,
        lastModified: new Date(user.lastModified).toISOString(),
        dateRegistered: new Date(user.dateRegistered).toISOString(),
        // Only what the app needs to know the link is alive; the refresh token stays on the server
        trakt: user.trakt ? { created_at: user.trakt.created_at, expires_in: user.trakt.expires_in, access_token: user.trakt.access_token } : null,
        premium_expire: null,
        gdpr_consent: user.gdprConsent
    });

    const issueKey = (user, meta = {}) => {
        const authKey = crypto.randomBytes(32).toString('base64url');
        db.addKey(user.id, hashKey(authKey), meta, MAX_KEYS_PER_USER, now());
        return authKey;
    };

    // Operator block list, supplied by the server from the auth store: a blocked account's key stops working everywhere.
    let blockCheck = () => false;
    // Resolves the account whose profile list a caller shares (the household owner's id), or null for a per-account list.
    let householdResolver = () => null;

    // The account that stores a caller's profile list: the household owner's record when billing says this caller shares
    // one, so every member's device reads/writes the same list; otherwise the caller's own record.
    const profileStoreUser = (user) => {
        const ownerId = householdResolver(user);
        if (ownerId && ownerId !== user.id) {
            const owner = db.userById(ownerId);
            if (owner) return owner;
        }
        return user;
    };

    const userForKey = (authKey) => {
        if (typeof authKey !== 'string' || authKey.length < 20 || authKey.length > 200) return null;
        const hash = hashKey(authKey);
        const owner = db.keyOwner(hash);
        const user = owner && db.userById(owner.userId);
        if (!user) return null;
        if (blockCheck(user.email)) return null; // operator blocked this account: the key is dead
        // lastUsed only matters for trimming old keys: refreshing it at most hourly keeps requests from writing
        if (now() - owner.lastUsed > 60 * 60 * 1000) db.touchKey(hash, now());
        return user;
    };

    // Used by the login gate in place of asking api.strem.io: { id, email } or null.
    const lookup = (authKey) => {
        const user = userForKey(authKey);
        return user ? { id: user.id, email: user.email } : null;
    };

    const register = async ({ email, password, gdpr_consent: consent }, meta) => {
        if (!registrationOpen()) return fail('registration_closed');
        const clean = typeof email === 'string' ? email.trim() : '';
        if (!EMAIL.test(clean) || clean.length > 200) return fail('invalid_email');
        if (blockCheck(clean)) return fail('banned');
        if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return fail('weak_password');
        if (!consent || consent.tos !== true || consent.privacy !== true) return fail('consent_required');
        if (db.userByEmail(clean)) return fail('email_taken');
        const passwordHash = await hashPassword(password);
        const time = now();
        const user = {
            id: crypto.randomBytes(12).toString('hex'),
            email: clean,
            passwordHash,
            dateRegistered: time,
            lastModified: time,
            gdprConsent: { tos: true, privacy: true, marketing: consent.marketing === true, from: typeof consent.from === 'string' ? consent.from.slice(0, 20) : 'web' }
        };
        try {
            db.insertUser(user); // the unique email index settles a race between two sign-ups
        } catch (e) {
            if (/UNIQUE/i.test(e.message)) return fail('email_taken');
            throw e;
        }
        const authKey = issueKey(user, meta);
        audit.record('account-registered', { email: clean.toLowerCase() });
        return { result: { authKey, user: publicUser(user) } };
    };

    const login = async ({ email, password }, meta = {}) => {
        const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
        const limiter = `${meta.ip || ''}|${clean}`;
        if (tooManyFailures(limiter)) return fail('too_many_attempts');
        if (clean && blockCheck(clean)) return fail('banned');
        const user = clean ? db.userByEmail(clean) : null;
        // Same work whether or not the email exists, so response time does not reveal who is registered
        const ok = typeof password === 'string' && password.length <= MAX_PASSWORD && await checkPassword(password, user ? user.passwordHash : 'scrypt$0$AAAA$AAAA').catch(() => false);
        if (!user || !ok) {
            noteFailure(limiter);
            return fail(user ? 'wrong_password' : 'user_not_found');
        }
        const authKey = issueKey(user, { ua: meta.ua });
        return { result: { authKey, user: publicUser(user) } };
    };

    const logout = ({ authKey }) => {
        if (typeof authKey === 'string') db.removeKey(hashKey(authKey));
        return { result: { success: true } };
    };

    const eraseUser = (user) => {
        db.removeUser(user.id);
        audit.record('account-deleted', { email: user.email.toLowerCase() });
    };

    const deleteUser = async ({ authKey, password }) => {
        const user = userForKey(authKey);
        if (!user) return fail('invalid_key');
        if (typeof password !== 'string' || !(await checkPassword(password, user.passwordHash).catch(() => false))) return fail('wrong_password');
        eraseUser(user);
        return { result: { success: true } };
    };

    // Operator erase: returns whether an account existed.
    const eraseByEmail = (email) => {
        const user = db.userByEmail(String(email || '').trim());
        if (!user) return false;
        eraseUser(user);
        return true;
    };

    const saveUser = ({ authKey, avatar, trakt, gdpr_consent: consent }) => {
        const user = userForKey(authKey);
        if (!user) return fail('invalid_key');
        // The email, password and ids are not changeable from the client; everything else the core may push is.
        if (avatar === null || (typeof avatar === 'string' && avatar.length <= 500)) user.avatar = avatar || null;
        // Trakt can only be disconnected from the app; connecting goes through Trakt's own sign-in (see trakt.js)
        if (trakt === null && user.trakt) {
            const old = user.trakt;
            user.trakt = null;
            if (traktService) traktService.disconnect(old);
        }
        if (consent && typeof consent === 'object') user.gdprConsent = { ...user.gdprConsent, marketing: consent.marketing === true };
        user.lastModified = now();
        db.saveUser(user);
        return { result: { success: true } };
    };

    // Default add-ons for people who never saved a collection: manifests are read once per hour from the operator's list.
    let defaultsCache = { at: 0, key: '', value: [] };
    // When a default add-on cannot be read (its host is down or blocked) the last good copy is used, and for the standard catalog
    // a built-in description, so a new account never starts with an empty list.
    const lastGood = new Map();
    const BUILTIN = {
        'https://v3-cinemeta.strem.io/manifest.json': { id: 'com.linvo.cinemeta', version: '3.0.0', name: 'Cinemeta', description: 'The official add-on for movie and series catalogs', resources: ['catalog', 'meta', 'addon_catalog'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: [{ type: 'movie', id: 'top', name: 'Popular', extra: [{ name: 'genre' }, { name: 'skip' }, { name: 'search' }] }, { type: 'series', id: 'top', name: 'Popular', extra: [{ name: 'genre' }, { name: 'skip' }, { name: 'search' }] }] }
    };
    const defaultAddons = async () => {
        const urls = defaultAddonUrls().filter((url) => /^https?:\/\//i.test(url));
        const key = urls.join('\n');
        if (defaultsCache.key === key && now() - defaultsCache.at < 60 * 60 * 1000 && defaultsCache.value.length > 0) return defaultsCache.value;
        const found = await Promise.all(urls.map(async (transportUrl) => {
            try {
                const response = await fetchImpl(transportUrl, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
                if (!response.ok) throw new Error('status');
                const manifest = await response.json();
                if (!manifest || typeof manifest.id !== 'string' || typeof manifest.name !== 'string') throw new Error('manifest');
                const official = /(^|\.)strem\.io$/i.test(new URL(transportUrl).hostname);
                return { manifest, transportUrl, flags: { official, protected: official } };
            } catch (_e) {
                return lastGood.get(transportUrl) || (BUILTIN[transportUrl] ? { manifest: BUILTIN[transportUrl], transportUrl, flags: { official: true, protected: true } } : null);
            }
        }));
        found.forEach((entry) => { if (entry) lastGood.set(entry.transportUrl, entry); });
        const value = found.filter(Boolean);
        defaultsCache = { at: now(), key, value };
        return value;
    };

    // The stock service refreshes installed add-ons' manifests when the app asks with update:true (new catalogs, new versions).
    // Addresses come from users, so this server only reads public hosts (no loopback, private, link-local), follows no redirects,
    // and keeps one shared copy per address for an hour.
    const isPublicAddress = (ip) => {
        const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
        if (v4) {
            const [a, b] = [Number(v4[1]), Number(v4[2])];
            return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
        }
        const v6 = ip.toLowerCase();
        if (v6.startsWith('::ffff:')) return isPublicAddress(v6.slice(7));
        return !(v6 === '::' || v6 === '::1' || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('fc') || v6.startsWith('fd'));
    };
    const resolveHost = resolveHostOption || (async (host) => (await require('dns').promises.lookup(host, { all: true })).map((entry) => entry.address));
    const manifestCache = new Map(); // address -> { at, manifest }
    const readManifest = async (transportUrl, expectedId) => {
        const cached = manifestCache.get(transportUrl);
        if (cached && now() - cached.at < 60 * 60 * 1000) return cached.manifest;
        let manifest = null;
        try {
            const url = new URL(transportUrl);
            if (!/^https?:$/.test(url.protocol) || !/\/manifest\.json$/.test(url.pathname)) throw new Error('not a manifest address');
            const addresses = /^[\d.]+$|:/.test(url.hostname) ? [url.hostname.replace(/^\[|\]$/g, '')] : await resolveHost(url.hostname);
            if (!addresses.length || !addresses.every(isPublicAddress)) throw new Error('not a public host');
            const response = await fetchImpl(transportUrl, { signal: AbortSignal.timeout(5000), redirect: 'manual', headers: { accept: 'application/json' } });
            if (response.ok) {
                const found = await response.json();
                if (found && found.id === expectedId && typeof found.name === 'string' && typeof found.version === 'string') manifest = found;
            }
        } catch (_e) { /* keep what is stored */ }
        if (manifestCache.size > 2000) manifestCache.clear();
        manifestCache.set(transportUrl, { at: now(), manifest });
        return manifest;
    };
    const refreshAddons = async (user) => {
        const list = user.addons.list;
        const next = await Promise.all(list.slice(0, MAX_ADDONS).map(async (addon) => {
            if (!addon.manifest || (addon.flags && addon.flags.protected)) return addon;
            const manifest = await readManifest(addon.transportUrl, addon.manifest.id);
            return manifest && JSON.stringify(manifest) !== JSON.stringify(addon.manifest) ? { ...addon, manifest } : addon;
        }));
        if (next.some((addon, i) => addon !== list[i])) {
            user.addons = { list: next, lastModified: now() };
            db.saveUser(user);
        }
    };

    const addonCollectionGet = async ({ authKey, update }) => {
        const user = userForKey(authKey);
        if (!user) return fail('invalid_key');
        if (user.addons === null) return { result: { addons: await defaultAddons(), lastModified: new Date(user.dateRegistered).toISOString() } };
        if (update === true && addonRefresh) await refreshAddons(user).catch(() => {});
        return { result: { addons: user.addons.list, lastModified: new Date(user.addons.lastModified).toISOString() } };
    };

    const addonCollectionSet = ({ authKey, addons }) => {
        const user = userForKey(authKey);
        if (!user) return fail('invalid_key');
        if (!Array.isArray(addons)) return fail('invalid_request');
        if (addons.length > MAX_ADDONS) return fail('too_large');
        if (!addons.every((addon) => addon && typeof addon === 'object' && addon.manifest && typeof addon.transportUrl === 'string')) return fail('invalid_request');
        user.addons = { list: addons, lastModified: now() };
        db.saveUser(user);
        return { result: { success: true } };
    };

    // Library sync: the core asks for [id, modified] pairs, pulls what is newer here and pushes what is newer there.
    const datastoreMeta = ({ authKey, collection }) => {
        const user = userForKey(authKey);
        if (!user) return fail('invalid_key');
        return { result: collection === 'libraryItem' ? db.libraryMeta(user.id) : [] };
    };

    const datastoreGet = ({ authKey, collection, ids, all }) => {
        const user = userForKey(authKey);
        if (!user) return fail('invalid_key');
        if (collection !== 'libraryItem') return { result: [] };
        if (all === true) return { result: db.libraryAll(user.id) };
        return { result: db.libraryGet(user.id, (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string').slice(0, MAX_LIBRARY_ITEMS)) };
    };

    const datastorePut = ({ authKey, collection, changes }) => {
        const user = userForKey(authKey);
        if (!user) return fail('invalid_key');
        if (collection !== 'libraryItem' || !Array.isArray(changes)) return fail('invalid_request');
        const items = [];
        for (const item of changes) {
            const mtime = item && Date.parse(item._mtime);
            if (!item || typeof item._id !== 'string' || item._id.length > 200 || !Number.isFinite(mtime)) return fail('invalid_request');
            items.push({ item, mtime });
        }
        try {
            db.libraryPut(user.id, items, MAX_LIBRARY_ITEMS);
            if (traktService && user.trakt) traktService.onLibraryChange(user.id, changes).catch(() => {});
        } catch (e) {
            if (e.code === 'TOO_LARGE') return fail('too_large');
            throw e;
        }
        return { result: { success: true } };
    };

    // App settings sync: the native player saves its quality, dub, audio/subtitle language and picture choices here so a
    // person's profile carries them across devices. A flat JSON object of small scalar values, kept small and bounded.
    const MAX_SETTINGS_BYTES = 16 * 1024;
    const MAX_SETTINGS_KEYS = 200;
    const appSettingsGet = ({ authKey }) => {
        const user = userForKey(authKey);
        if (!user) return fail('invalid_key');
        const settings = user.appSettings && typeof user.appSettings.values === 'object' && user.appSettings.values !== null ? user.appSettings.values : {};
        return { result: { settings, lastModified: user.appSettings ? user.appSettings.lastModified : now() } };
    };
    const appSettingsSet = ({ authKey, settings }) => {
        const user = userForKey(authKey);
        if (!user) return fail('invalid_key');
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return fail('invalid_request');
        const keys = Object.keys(settings);
        if (keys.length > MAX_SETTINGS_KEYS) return fail('too_large');
        // Each value is a short string, number or boolean; keys are plain setting names.
        const clean = {};
        let bytes = 0;
        for (const key of keys) {
            if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(key)) return fail('invalid_request');
            const value = settings[key];
            if (typeof value === 'boolean') { clean[key] = value; bytes += key.length + 6; }
            else if (typeof value === 'number' && Number.isFinite(value)) { clean[key] = value; bytes += key.length + 24; }
            else if (typeof value === 'string' && value.length <= 512) { clean[key] = value; bytes += key.length + value.length; }
            else return fail('invalid_request');
            if (bytes > MAX_SETTINGS_BYTES) return fail('too_large');
        }
        user.appSettings = { values: clean, lastModified: now() };
        user.lastModified = now();
        db.saveUser(user);
        return { result: { success: true, lastModified: user.appSettings.lastModified } };
    };
    // signs the person out everywhere. Requests answer the same whether or not the email is registered.
    const RESET_TTL_MS = 60 * 60 * 1000;
    const RESET_LIMIT = 3;
    const resetAsks = new Map(); // email|ip -> timestamps
    const requestReset = async (email, meta = {}) => {
        if (!sendResetEmail) return { sent: false, reason: 'mail_off' };
        const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
        if (!EMAIL.test(clean) || clean.length > 200) return { sent: false, reason: 'invalid_email' };
        for (const id of [`e|${clean}`, `i|${meta.ip || ''}`]) {
            const recent = (resetAsks.get(id) || []).filter((time) => now() - time < RESET_TTL_MS);
            if (recent.length >= RESET_LIMIT * (id[0] === 'i' ? 4 : 1)) return { sent: false, reason: 'too_many' };
            resetAsks.set(id, [...recent, now()]);
        }
        if (resetAsks.size > 5000) resetAsks.clear();
        const user = db.userByEmail(clean);
        if (user) {
            const token = crypto.randomBytes(32).toString('base64url');
            user.reset = { hash: hashKey(token), expires: now() + RESET_TTL_MS };
            db.saveUser(user);
            try {
                await sendResetEmail({ to: user.email, resetUrl: `${publicUrl}/account/reset?token=${token}` });
            } catch (e) {
                console.error('Password reset email failed:', e.message);
            }
        }
        return { sent: true };
    };
    const resetPassword = async ({ token, password }) => {
        if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return { ok: false, error: 'weak_password' };
        if (typeof token !== 'string' || token.length < 20 || token.length > 200) return { ok: false, error: 'invalid_token' };
        const hash = hashKey(token);
        const found = db.userByResetHash(hash);
        if (!found || found.reset.expires < now()) return { ok: false, error: 'invalid_token' };
        const passwordHash = await hashPassword(password);
        const user = db.userByResetHash(hash); // read again: it may have been used while we were hashing
        if (!user) return { ok: false, error: 'invalid_token' };
        user.passwordHash = passwordHash;
        user.reset = null;
        user.lastModified = now();
        db.transaction(() => {
            db.saveUser(user);
            db.removeKeysOf(user.id);
        });
        audit.record('account-password-reset', { email: user.email.toLowerCase() });
        return { ok: true };
    };

    const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0c0b11;color:#f2f2f5;font:16px system-ui,sans-serif}
main{width:min(380px,90vw)}h1{font-size:22px;margin:0 0 6px}p{color:#a9a8b3;line-height:1.5}input,button{width:100%;box-sizing:border-box;padding:14px;margin:6px 0;border-radius:12px;border:1px solid #3a3948;background:#17161d;color:inherit;font:inherit}
button{background:#f2f2f5;color:#0c0b11;font-weight:600;cursor:pointer;border:0}.msg{min-height:1.5em}a{color:#9b8cff}</style></head><body><main>${body}</main></body></html>`;
    const pageRouter = express.Router();
    pageRouter.get('/reset', (req, res) => {
        res.set({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'" });
        const name = esc(productName() || 'your account');
        const token = typeof req.query.token === 'string' ? req.query.token : '';
        if (!token) {
            res.type('html').send(page('Reset password', `<h1>Reset password</h1><p>Enter your email address and we will send you a link to choose a new password for ${name}.</p>
<form id="f"><input id="e" type="email" placeholder="Email" autocomplete="email" required value="${esc(typeof req.query.email === 'string' ? req.query.email.slice(0, 200) : '')}"><button>Send link</button></form><p class="msg" id="m"></p>
<script>f.onsubmit=async(ev)=>{ev.preventDefault();m.textContent='';const r=await fetch('/account/reset-request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e.value})}).then(r=>r.json()).catch(()=>null);
m.textContent=!r?'Something went wrong, try again.':r.sent?'If this email has an account, a link is on its way. It works for one hour.':r.reason==='mail_off'?'Password reset by email is not set up here. Please contact support.':r.reason==='too_many'?'Too many requests, try again later.':'Please enter a valid email address.'}</script>`));
            return;
        }
        res.type('html').send(page('Choose a new password', `<h1>Choose a new password</h1><p>For ${name}. You will be signed out on all devices.</p>
<form id="f"><input id="p" type="password" placeholder="New password (8+ characters)" autocomplete="new-password" minlength="8" required><button>Save password</button></form><p class="msg" id="m"></p>
<script>f.onsubmit=async(ev)=>{ev.preventDefault();m.textContent='';const r=await fetch('/account/reset',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token).replace(/</g, '\\u003c')},password:p.value})}).then(r=>r.json()).catch(()=>null);
if(r&&r.ok){f.remove();m.innerHTML='Done. <a href="/">Log in with your new password</a>.'}else m.textContent=!r?'Something went wrong, try again.':r.error==='weak_password'?'Use at least 8 characters.':'This link has expired or was already used. Ask for a new one.'}</script>`));
    });
    pageRouter.get('/link', (_req, res) => {
        res.set({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'" });
        res.type('html').send(page('Sign in a device', `<h1>Sign in a device</h1><p id="ask">Confirm with your email and password to sign in the device that shows this code${productName() ? ` to ${esc(productName())}` : ''}.</p>
<div id="one" hidden><p>You are signed in here as <b id="who"></b>.</p><button id="go">Sign in the device as this account</button><button id="other" type="button" style="background:none;color:#9b8cff;font-weight:400">Use another account</button></div>
<form id="f"><input id="c" placeholder="Code" autocomplete="off" autocapitalize="characters" maxlength="12" required><input id="e" type="email" placeholder="Email" autocomplete="email" required><input id="p" type="password" placeholder="Password" autocomplete="current-password" required>
<div id="reg" hidden><input id="p2" type="password" placeholder="Confirm password" autocomplete="new-password"><label id="agree" style="display:flex;gap:8px;align-items:flex-start;margin:8px 0;color:#a9a8b3;font-size:14px"><input id="tos" type="checkbox" style="width:auto;margin:3px 0 0;padding:0"><span>I agree to the Terms of Service and Privacy Policy</span></label></div>
<button id="submit">Sign in the device</button></form><p style="margin:10px 0 0"><a href="#" id="toggle">New here? Create an account</a></p><p class="msg" id="m"></p>
<script>c.value=new URLSearchParams(location.search).get('code')||'';
let key='';try{const a=JSON.parse(localStorage.getItem('profile')||'null').auth;if(a&&typeof a.key==='string'&&a.user&&a.user.email){key=a.key;who.textContent=a.user.email;one.hidden=false;f.hidden=true;ask.hidden=true}}catch(_e){}
other.onclick=()=>{f.hidden=false;ask.hidden=false;other.hidden=true};
go.onclick=async()=>{m.textContent='';const r=await fetch('/account/link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:c.value,authKey:key})}).catch(()=>null);
if(r&&r.ok){f.remove();one.remove();m.textContent='Done. The device is signed in. You can close this page.'}else m.textContent=!r?'Something went wrong, try again.':r.status===401?'This sign-in is no longer valid here. Use your email and password below.':'This code is invalid or has expired. Show a new code on the device.'};
let registering=false;
toggle.onclick=(ev)=>{ev.preventDefault();registering=!registering;reg.hidden=!registering;p2.required=registering;tos.required=registering;p.autocomplete=registering?'new-password':'current-password';submit.textContent=registering?'Create account and sign in':'Sign in the device';toggle.textContent=registering?'Already have an account? Sign in':'New here? Create an account';m.textContent='';};
f.onsubmit=async(ev)=>{ev.preventDefault();m.textContent='';
if(registering&&p.value!==p2.value){m.textContent='Passwords do not match.';return;}
const body={code:c.value,email:e.value,password:p.value};if(registering){body.register=true;body.consent=tos.checked;}
const resp=await fetch('/account/link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).catch(()=>null);
if(resp&&resp.ok){f.remove();one.remove();m.textContent='Done. The device is signed in. You can close this page.';return;}
let msg='';try{const j=resp?await resp.json():null;msg=j&&j.error?j.error:'';}catch(_e){}
m.textContent=!resp?'Something went wrong, try again.':msg||(resp.status===401?'Wrong email or password.':resp.status===429?'Too many attempts, try again in a few minutes.':resp.status===403?'That account is blocked, or new sign-ups are closed.':resp.status===409?'That email is already registered, sign in instead.':'This code is invalid or has expired. Show a new code on the device.');}</script>`));
    });

    // Account settings for the person: download their data or delete the account, each confirmed with the password.
    pageRouter.get('/manage', (_req, res) => {
        res.set({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'" });
        res.type('html').send(page('Your account', `<h1>Your account</h1><p>Confirm with your email and password, then download your data or delete your account${productName() ? ` at ${esc(productName())}` : ''}.</p>
<form id="f"><input id="e" type="email" placeholder="Email" autocomplete="email" required><input id="p" type="password" placeholder="Password" autocomplete="current-password" required>
<button type="submit" id="dl">Download my data</button><button type="button" id="rm" style="background:#7a1f2b;color:#fff">Delete my account</button></form><p class="msg" id="m"></p>
<script>const call=async(path)=>fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e.value,password:p.value})});
const say=(r)=>{m.textContent=r.status===401?'Wrong email or password.':r.status===429?'Too many attempts, try again in a few minutes.':'Something went wrong, try again.'};
f.onsubmit=async(ev)=>{ev.preventDefault();m.textContent='';const r=await call('/account/export').catch(()=>null);if(!r||!r.ok)return say(r||{status:0});
const a=document.createElement('a');a.href=URL.createObjectURL(await r.blob());a.download='my-data.json';a.click();m.textContent='Downloaded.'};
rm.onclick=async()=>{if(!f.reportValidity()||!confirm('Delete your account and everything saved in it? This cannot be undone.'))return;m.textContent='';const r=await call('/account/delete').catch(()=>null);
if(r&&r.ok){f.remove();m.textContent='Your account was deleted.'}else say(r||{status:0})}</script>`));
    });
    pageRouter.use(express.json({ limit: '4kb' }));
    // Password check shared by export and delete; failures count against the same limit as sign-in.
    const confirmed = async (req) => {
        const limiter = `${req.ip || ''}|${String(req.body && req.body.email).trim().toLowerCase()}`;
        if (tooManyFailures(limiter)) return { status: 429 };
        const user = req.body && typeof req.body.email === 'string' ? db.userByEmail(req.body.email.trim()) : null;
        const password = req.body && req.body.password;
        const ok = typeof password === 'string' && password.length <= MAX_PASSWORD && await checkPassword(password, user ? user.passwordHash : 'scrypt$0$AAAA$AAAA').catch(() => false);
        if (!user || !ok) { noteFailure(limiter); return { status: 401 }; }
        return { user };
    };
    pageRouter.post('/link', async (req, res) => {
        res.set('cache-control', 'no-store');
        sweepLinks();
        const body = req.body || {};
        const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
        // New here: register an account, then link the device to it. Check the code is live first so a dead or
        // already-used code never creates an account.
        if (body.register === true) {
            const entry = links.get(code);
            if (!entry || entry.authKey) { res.status(404).json({ ok: false, error: 'This code is invalid or has expired. Show a new code on the device.' }); return; }
            const reg = await register(
                { email: body.email, password: body.password,
                    gdpr_consent: { tos: body.consent === true, privacy: body.consent === true, from: 'link' } },
                { ua: 'linked device', ip: req.ip });
            if (!reg.result) {
                const codeNum = reg.error && reg.error.code;
                const status = codeNum === 105 || codeNum === 111 ? 403 : codeNum === 104 ? 409 : codeNum === 106 ? 429 : 400;
                res.status(status).json({ ok: false, error: reg.error ? reg.error.message : 'Could not create your account.' });
                return;
            }
            entry.authKey = reg.result.authKey;
            audit.record('account-link-signin', { email: String(body.email || '').trim().toLowerCase(), by: 'register' });
            res.json({ ok: true });
            return;
        }
        // A phone that is already signed in to this site approves with its own session (one tap); otherwise email and password
        const sessionUser = typeof body.authKey === 'string' ? userForKey(body.authKey) : null;
        const check = sessionUser ? { user: sessionUser } : await confirmed(req);
        if (!check.user) { res.status(check.status || 401).json({ ok: false }); return; }
        const entry = links.get(code);
        if (!entry || entry.authKey) { res.status(404).json({ ok: false }); return; }
        entry.authKey = issueKey(check.user, { ua: 'linked device' });
        audit.record('account-link-signin', { email: check.user.email.toLowerCase(), by: sessionUser ? 'signed-in phone' : 'password' });
        res.json({ ok: true });
    });
    pageRouter.post('/export', async (req, res) => {
        res.set('cache-control', 'no-store');
        const check = await confirmed(req);
        if (!check.user) { res.status(check.status).json({ ok: false }); return; }
        audit.record('account-exported', { email: check.user.email.toLowerCase(), by: 'owner' });
        res.set('content-disposition', 'attachment; filename="my-data.json"');
        res.json({ exportedAt: new Date(now()).toISOString(), user: publicUser(check.user), addons: check.user.addons ? check.user.addons.list : null, library: db.libraryAll(check.user.id), ratings: db.ratingsAll(check.user.id).map((row) => ({ type: row.media_type, id: row.media_id, status: row.status })) });
    });
    pageRouter.post('/delete', async (req, res) => {
        res.set('cache-control', 'no-store');
        const check = await confirmed(req);
        if (!check.user) { res.status(check.status).json({ ok: false }); return; }
        eraseUser(check.user);
        res.json({ ok: true });
    });
    pageRouter.post('/reset-request', async (req, res) => {
        res.set('cache-control', 'no-store');
        res.json(await requestReset(req.body && req.body.email, { ip: req.ip }));
    });
    pageRouter.post('/reset', async (req, res) => {
        res.set('cache-control', 'no-store');
        res.json(await resetPassword(req.body || {}));
    });

    // Operator tools (behind the admin token). Never returns password hashes or key hashes.
    const adminRouter = (guard) => {
        const admin = express.Router();
        admin.use(guard);
        admin.use(express.json({ limit: '4kb' }));
        const find = (email) => db.userByEmail(String(email || '').trim());
        admin.get('/info', (req, res) => {
            const user = find(req.query.email);
            if (!user) { res.status(404).json({ error: 'not_found' }); return; }
            res.json({
                email: user.email, registered: new Date(user.dateRegistered).toISOString(), modified: new Date(user.lastModified).toISOString(),
                devices: db.keyCount(user.id), libraryItems: db.libraryCount(user.id),
                addons: user.addons ? user.addons.list.length : null, marketing: user.gdprConsent.marketing === true,
                resetPending: !!(user.reset && user.reset.expires > now()), mailConfigured: !!sendResetEmail
            });
        });
        admin.get('/stats', (_req, res) => res.json({ accounts: db.count() }));
        admin.post('/signout', (req, res) => {
            const user = find(req.body && req.body.email);
            if (!user) { res.status(404).json({ error: 'not_found' }); return; }
            db.removeKeysOf(user.id);
            res.json({ ok: true });
        });
        admin.post('/reset', async (req, res) => {
            if (!find(req.body && req.body.email)) { res.status(404).json({ error: 'not_found' }); return; }
            const result = await requestReset(req.body.email, { ip: 'operator' });
            audit.record('account-reset-sent', { email: String(req.body.email).trim().toLowerCase() });
            res.json(result);
        });
        // The person's own data as a download: profile, add-ons and library (what they would get by asking).
        admin.get('/export', (req, res) => {
            const user = find(req.query.email);
            if (!user) { res.status(404).json({ error: 'not_found' }); return; }
            audit.record('account-exported', { email: user.email.toLowerCase() });
            res.set('content-disposition', 'attachment; filename="account-data.json"');
            res.json({ exportedAt: new Date(now()).toISOString(), user: publicUser(user), addons: user.addons ? user.addons.list : null, library: db.libraryAll(user.id), ratings: db.ratingsAll(user.id).map((row) => ({ type: row.media_type, id: row.media_id, status: row.status })) });
        });
        return admin;
    };

    // The secret address of the person's calendar feed of upcoming episodes (created on first ask)
    const calendarToken = ({ authKey }) => {
        const user = userForKey(authKey);
        if (!user) return fail('invalid_key');
        let token = db.calendarToken(user.id);
        if (!token) {
            token = crypto.randomBytes(24).toString('base64url');
            db.setCalendarToken(user.id, token);
        }
        return { result: { path: `/calendar/${token}.ics` } };
    };
    // Library items for a feed token, or null when no such token
    const calendarSeries = (token) => {
        const id = typeof token === 'string' && token.length >= 20 && token.length <= 100 ? db.userIdByCalendarToken(token) : null;
        return id ? db.libraryAll(id) : null;
    };

    const traktAuthUrl = ({ authKey }) => {
        const user = userForKey(authKey);
        if (!user) return fail('invalid_key');
        const url = traktService ? traktService.startUrl(user.id) : null;
        return url ? { result: { url } } : fail('unsupported');
    };

    // Ratings ("watched / liked / loved" on a title): the app's replacement for the stock likes service
    const RATINGS = new Set(['watched', 'liked', 'loved']);
    const MEDIA = /^[\w:.-]{1,60}$/;
    const ratingsRouter = express.Router();
    ratingsRouter.use((req, res, next) => {
        res.set({ 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
        if (req.method === 'OPTIONS') { res.status(204).end(); return; }
        next();
    });
    ratingsRouter.use(express.json({ limit: '4kb', type: () => true }));
    ratingsRouter.get('/api/get_status', (req, res) => {
        res.set('cache-control', 'no-store');
        const user = userForKey(req.query.authToken);
        const { mediaType, mediaId } = req.query;
        if (!user || !MEDIA.test(String(mediaId)) || !MEDIA.test(String(mediaType))) { res.status(401).json({ message: 'Invalid request' }); return; }
        res.json({ status: db.ratingGet(user.id, mediaType, mediaId) });
    });
    ratingsRouter.post('/api/send', (req, res) => {
        res.set('cache-control', 'no-store');
        const { authToken, mediaId, mediaType, status } = req.body || {};
        const user = userForKey(authToken);
        if (!user || !MEDIA.test(String(mediaId)) || !MEDIA.test(String(mediaType)) || (status !== null && status !== undefined && !RATINGS.has(status))) {
            res.status(user ? 400 : 401).json({ message: 'Invalid request' });
            return;
        }
        db.ratingSet(user.id, mediaType, mediaId, status || null, now());
        res.json({ message: 'ok', rating: status ? { status } : null, action: status ? 'set' : 'removed' });
    });

    // Link sign-in for TV and phone apps (the stock "link" service): the device asks for a code, shows it as a QR code, the person
    // confirms it on any browser with their email and password, and the device collects a sign-in key. GET /v2/create, GET /v2/read.
    const LINK_TTL_MS = 10 * 60 * 1000;
    const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const links = new Map(); // code -> { at, authKey }
    const linkCreates = new Map(); // ip -> timestamps
    const sweepLinks = () => {
        for (const [code, value] of links) if (now() - value.at > LINK_TTL_MS) links.delete(code);
        if (links.size > 2000) links.clear();
    };
    // The address people open on their phone: PUBLIC_URL when set, else the address the request came in on (the forwarded host behind a trusted proxy)
    const baseOf = (req) => {
        if (publicUrl) return publicUrl;
        const forwarded = req.app && req.app.get('trust proxy') ? String(req.get('x-forwarded-host') || '').split(',')[0].trim() : '';
        return `${req.protocol}://${forwarded || req.get('host')}`;
    };
    const linkRouter = express.Router();
    linkRouter.use((req, res, next) => { res.set({ 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); next(); });
    linkRouter.get('/create', (req, res) => {
        const recent = (linkCreates.get(req.ip) || []).filter((time) => now() - time < LINK_TTL_MS);
        if (recent.length >= 30) { res.json(fail('too_many_attempts')); return; }
        linkCreates.set(req.ip, [...recent, now()]);
        if (linkCreates.size > 5000) linkCreates.clear();
        sweepLinks();
        const code = Array.from(crypto.randomBytes(6), (byte) => LINK_ALPHABET[byte % LINK_ALPHABET.length]).join('');
        links.set(code, { at: now(), authKey: null });
        const link = `${baseOf(req)}/account/link?code=${code}`;
        res.json({ result: { code, link, qrcode: `data:image/svg+xml;base64,${Buffer.from(toSvg(link)).toString('base64')}` } });
    });
    linkRouter.get('/read', (req, res) => {
        sweepLinks();
        const entry = typeof req.query.code === 'string' ? links.get(req.query.code.toUpperCase()) : null;
        if (!entry) { res.json(fail('link_invalid')); return; }
        if (!entry.authKey) { res.json(fail('link_waiting')); return; }
        links.delete(req.query.code.toUpperCase());
        res.json({ result: { authKey: entry.authKey } });
    });

    // "Export my data" from inside the app: a short-lived download address (the app opens it)
    const exportIds = new Map();
    const dataExport = ({ authKey }) => {
        const user = userForKey(authKey);
        if (!user) return fail('invalid_key');
        const cutoff = now() - 15 * 60 * 1000;
        for (const [key, value] of exportIds) if (value.at < cutoff) exportIds.delete(key);
        if (exportIds.size > 500) exportIds.clear();
        const exportId = crypto.randomBytes(24).toString('base64url');
        exportIds.set(exportId, { userId: user.id, at: now() });
        return { result: { exportId } };
    };
    const exportRouter = express.Router();
    exportRouter.get('/:id/export.json', (req, res) => {
        const entry = exportIds.get(req.params.id);
        const user = entry && now() - entry.at < 15 * 60 * 1000 ? db.userById(entry.userId) : null;
        res.set({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        if (!user) { res.status(404).json({ error: 'expired' }); return; }
        audit.record('account-exported', { email: user.email.toLowerCase(), by: 'owner' });
        res.set('content-disposition', 'attachment; filename="my-data.json"').json({
            exportedAt: new Date(now()).toISOString(), user: publicUser(user), addons: user.addons ? user.addons.list : null, library: db.libraryAll(user.id),
            ratings: db.ratingsAll(user.id).map((row) => ({ type: row.media_type, id: row.media_id, status: row.status }))
        });
    });

    const handlers = {
        calendarToken,
        traktAuthUrl,
        login, register, logout, deleteUser, saveUser, addonCollectionGet, addonCollectionSet, datastoreMeta, datastoreGet, datastorePut,
        appSettingsGet, appSettingsSet,
        // The device's profile list (each profile is its own account) and which one is active, saved to the signed-in
        // account so they survive a reinstall or a new device and follow the person. Bounded like app settings.
        profilesGet: ({ authKey }) => {
            const user = userForKey(authKey);
            if (!user) return fail('invalid_key');
            const store = profileStoreUser(user);
            const profiles = store.profiles || { list: [], active: null };
            return { result: { list: profiles.list || [], active: profiles.active || null, rev: store.profiles ? store.profiles.rev : 0 } };
        },
        profilesSet: ({ authKey, list, active }) => {
            const user = userForKey(authKey);
            if (!user) return fail('invalid_key');
            const store = profileStoreUser(user);
            if (!Array.isArray(list) || list.length > 16) return fail('too_large');
            const ids = new Set();
            let bytes = 0;
            let live = 0;
            const clean = list.map((p) => {
                if (!p || typeof p !== 'object') return null;
                const id = String(p.id || '').slice(0, 24);
                if (!id || ids.has(id)) return null;
                // A tombstone (deleted) carries only id + the time it was removed, so a delete on one device reaches the
                // others; it needs no key. A live profile must have one.
                const deleted = p.deleted === true;
                const key = String(p.authKey || p.credential || '').slice(0, 512);
                if (!deleted && !key) return null;
                ids.add(id);
                const mod = Number.isFinite(p.mod) ? p.mod : 0;
                bytes += id.length + key.length + 16;
                if (deleted) return { id, deleted: true, mod };
                const name = String(p.name || '').slice(0, 60);
                const color = Number.isFinite(p.color) ? p.color | 0 : 0;
                const pin = p.pin ? String(p.pin).slice(0, 8) : null;
                bytes += name.length + (pin ? pin.length : 0);
                live++;
                return { id, name, color, authKey: key, pin, mod };
            }).filter(Boolean);
            if (live > 8) return fail('too_large');
            if (bytes > MAX_SETTINGS_BYTES) return fail('too_large');
            const liveIds = new Set(clean.filter((p) => !p.deleted).map((p) => p.id));
            const chosen = typeof active === 'string' && liveIds.has(active)
                ? active
                : (clean.find((p) => !p.deleted) ? clean.find((p) => !p.deleted).id : null);
            store.profiles = { list: clean, active: chosen, rev: now() };
            store.lastModified = now();
            db.saveUser(store);
            return { result: { success: true, rev: store.profiles.rev } };
        },
        getUser: ({ authKey }) => {
            const user = userForKey(authKey);
            return user ? { result: publicUser(user) } : fail('invalid_key');
        },
        loginWithToken: ({ token }) => {
            const user = userForKey(token);
            return user ? { result: { authKey: token, user: publicUser(user) } } : fail('invalid_key');
        },
        authWithFacebook: () => fail('unsupported'),
        authWithApple: () => fail('unsupported'),
        // Accepted and dropped: usage reporting is our own statistics (/auth/activity), not Stremio's.
        events: ({ authKey }) => (userForKey(authKey) ? { result: { success: true } } : fail('invalid_key')),
        seekLog: () => ({ result: { success: true } }),
        configEvents: () => ({ result: { success: true } }),
        getSkipGaps: () => ({ result: { gaps: [] } }),
        getModal: () => ({ result: null }),
        getGeo: () => ({ result: { country: null } }),
        dataExport
    };

    // POST /api/<name>
    const router = express.Router();
    // The core posts JSON without always labelling it as such, so parse whatever content type arrives
    // Other apps (and web clients on other addresses) may call this API: the sign-in key travels in the body, never in a cookie
    router.use((req, res, next) => {
        res.set({ 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' });
        if (req.method === 'OPTIONS') { res.status(204).end(); return; }
        next();
    });
    // Whatever the label says (Java's HttpURLConnection labels JSON as a form by default): JSON first, then form fields
    router.use(express.text({ limit: '12mb', type: () => true }));
    router.use((req, res, next) => {
        const text = typeof req.body === 'string' ? req.body : '';
        try {
            req.body = text === '' ? {} : JSON.parse(text);
        } catch (_e) {
            if (!text.includes('=')) { res.json(fail('invalid_request')); return; } // neither JSON nor form fields
            req.body = Object.fromEntries(new URLSearchParams(text.length < 1024 * 1024 ? text : ''));
        }
        next();
    });
    // The stock ratings service lives on its own host with the same /api/ paths; a client that only swaps the host reaches it here
    const toRatings = (name) => (req, res, next) => { const q = req.url.indexOf('?'); req.url = `/api/${name}${q < 0 ? '' : req.url.slice(q)}`; ratingsRouter(req, res, next); };
    router.get('/get_status', toRatings('get_status'));
    router.post('/send', toRatings('send'));
    router.post('/:name', async (req, res) => {
        res.set('cache-control', 'no-store');
        const handler = Object.hasOwn(handlers, req.params.name) ? handlers[req.params.name] : null;
        if (!handler) {
            res.json(fail('invalid_request'));
            return;
        }
        try {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            res.json(await handler(body, { ip: req.ip, ua: String(req.get('user-agent') || '').slice(0, 200) }));
        } catch (e) {
            console.error(`Account API ${req.params.name} failed:`, e.message);
            res.json(fail('storage'));
        }
    });
    // Every answer of this API is JSON in the stock shape, also for a wrong method or an unreadable body (clients read error.code)
    router.use((_req, res) => { res.json(fail('invalid_request')); });
    router.use((_err, _req, res, _next) => { res.json(fail('invalid_request')); });

    return {
        router,
        pageRouter,
        adminRouter,
        ratingsRouter,
        linkRouter,
        exportRouter,
        requestReset,
        resetPassword,
        lookup,
        calendarSeries,
        attachTrakt: (service) => { traktService = service; },
        traktRecord: (userId) => { const user = db.userById(userId); return user ? user.trakt : null; },
        setTraktRecord: (userId, record) => {
            const user = db.userById(userId);
            if (!user) return;
            user.trakt = record;
            user.lastModified = now();
            db.saveUser(user);
        },
        eraseByEmail,
        count: () => db.count(),
        listAll: () => db.list().map((u) => ({ id: u.id, email: u.email, lastSeen: u.dateRegistered })),
        setBlockChecker: (fn) => { blockCheck = typeof fn === 'function' ? fn : () => false; },
        // Billing tells us which account holds a household's shared profile list (the owner's id), so every member's
        // device reads and writes the same list. Cleared when billing is absent (no plans), keeping per-account lists.
        setHouseholdResolver: (fn) => { householdResolver = typeof fn === 'function' ? fn : (() => null); },
        revokeKeys: (email) => { const u = db.userByEmail(String(email || '').trim()); if (u) db.removeKeysOf(u.id); },
        hasAccount: (email) => !!db.userByEmail(String(email || '').trim()),
        flush: () => true,
        isHealthy: () => true,
        close: () => db.close(),
        handlers
    };
};

module.exports = { createAccounts, hashPassword, checkPassword, ERR };
