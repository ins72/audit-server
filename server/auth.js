// Server-side session layer for the fork.
//
// The Stremio web client logs in directly against api.strem.io (inside the core
// WASM worker), so this server never sees the login itself. Instead the client
// hands us its authKey once; we verify it with Stremio (getUser), record who the
// user is, issue our own signed session cookie, and DROP the authKey. The
// authKey is never stored or logged here.

const crypto = require('crypto');
const express = require('express');
const { createJsonFile } = require('./jsonFile');
const { createRateLimiter } = require('./security');

const COOKIE_NAME = 'stremio_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// A session can be renewed by the heartbeat, but never beyond this age: after that the client
// must present its Stremio authKey again so a revoked Stremio session cannot live on here.
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 8000;
const MAX_AUTH_KEY_LENGTH = 512;
const MAX_CONCURRENT_VERIFICATIONS = 50; // protects api.strem.io (and us) when many clients reconnect at once
const MAX_QUEUED_VERIFICATIONS = 5000;
const MAX_QUEUE_WAIT_MS = 8000; // the client gives up after 10s: do not spend upstream calls on abandoned requests

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

const safeEqual = (a, b) => {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const parseCookies = (header) => {
    const cookies = {};
    if (typeof header !== 'string') return cookies;
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index === -1) continue;
        cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return cookies;
};

const createUserStore = (filePath) => {
    const file = createJsonFile(filePath, () => ({ users: {}, banned: {} }));
    const users = file.data.users;
    const banned = file.data.banned;

    return {
        touch(id, email, { login = false } = {}) {
            const now = Date.now();
            const existing = users[id];
            users[id] = {
                ...existing,
                id,
                email,
                firstSeen: existing ? existing.firstSeen : now,
                lastSeen: now,
                lastLogin: login ? now : (existing ? existing.lastLogin : now),
                logins: (existing ? existing.logins : 0) + (login ? 1 : 0),
                loggedOut: false
            };
            file.save();
        },
        markLoggedOut(id) {
            if (users[id]) {
                users[id].loggedOut = true;
                users[id].loggedOutAt = Date.now();
                users[id].lastSeen = users[id].loggedOutAt;
                file.save();
            }
        },
        // Operator-only note about a person (empty text removes it). Lives on the user record, so erase and export cover it.
        setNote(id, text) {
            const user = users[id];
            if (!user || user.erased) return false;
            if (text) user.note = text; else delete user.note;
            return file.flush();
        },
        // Right to erasure: drop everything we know about the user (email, counters), keep only a tombstone
        // that revokes any session cookie still in circulation.
        erase(id) {
            if (!users[id]) return false;
            const at = Date.now();
            users[id] = { id, erased: true, loggedOut: true, loggedOutAt: at, lastSeen: at };
            return file.flush();
        },
        // Device sessions (only used when MAX_DEVICES > 0). A session id (sid) lives in the cookie; the user record
        // lists the sids currently allowed and the ones evicted by newer logins (so the old device can be told why).
        registerSession(id, sid, limit) {
            const user = users[id];
            if (!user) return;
            const at = Date.now();
            const sessions = user.sessions || {};
            for (const [key, seen] of Object.entries(sessions)) {
                if (at - seen > MAX_SESSION_AGE_MS) delete sessions[key];
            }
            sessions[sid] = at;
            const evicted = user.evicted || [];
            while (Object.keys(sessions).length > limit) {
                const oldest = Object.entries(sessions).filter(([key]) => key !== sid).sort((a, b) => a[1] - b[1])[0];
                if (!oldest) break;
                delete sessions[oldest[0]];
                evicted.push(oldest[0]);
            }
            user.sessions = sessions;
            user.evicted = evicted.slice(-20);
            file.save();
        },
        sessionState(id, sid) {
            const user = users[id];
            if (user && user.sessions && sid && Object.prototype.hasOwnProperty.call(user.sessions, sid)) return 'ok';
            if (user && user.evicted && sid && user.evicted.includes(sid)) return 'evicted';
            return 'unknown';
        },
        touchSession(id, sid) {
            const user = users[id];
            if (user && user.sessions && sid && user.sessions[sid] !== undefined) {
                user.sessions[sid] = Date.now();
                file.save();
            }
        },
        dropSession(id, sid) {
            const user = users[id];
            if (user && user.sessions && sid) {
                delete user.sessions[sid];
                file.save();
            }
            return user && user.sessions ? Object.keys(user.sessions).length : 0;
        },
        deviceCount(id) {
            const user = users[id];
            return user && user.sessions ? Object.keys(user.sessions).length : 0;
        },
        isBanned(email) {
            return typeof email === 'string' && Object.prototype.hasOwnProperty.call(banned, email.trim().toLowerCase());
        },
        ban(email, note) {
            const key = String(email).trim().toLowerCase();
            const previous = banned[key];
            banned[key] = { note, at: Date.now() };
            if (file.flush()) return true;
            if (previous === undefined) delete banned[key]; else banned[key] = previous;
            return false;
        },
        unban(email) {
            const key = String(email).trim().toLowerCase();
            const previous = banned[key];
            if (previous === undefined) return null;
            delete banned[key];
            if (file.flush()) return true;
            banned[key] = previous;
            return false;
        },
        bannedList() {
            return Object.entries(banned).map(([email, entry]) => ({ email, ...entry }));
        },
        findByEmail(email) {
            const wanted = String(email).trim().toLowerCase();
            return Object.values(users).filter((user) => typeof user.email === 'string' && user.email.toLowerCase() === wanted);
        },
        // Session tokens issued at or before this moment are no longer accepted (explicit logout).
        revokedBefore(id) {
            return users[id]?.loggedOutAt || 0;
        },
        list() {
            return Object.values(users);
        },
        flush: file.flush,
        isHealthy: file.isHealthy
    };
};

const createAuth = (options = {}) => {
    const {
        secret,
        stremioApiUrl = 'https://api.strem.io',
        verifyKey = null, // own accounts: (authKey) => { id, email } | null, replaces asking api.strem.io
        onErase = null, // (email) called when the operator erases a person
        onSignout = null, // (email) called on ban/signout so the app's own keys are revoked too
        accountsList = null, // own accounts: () => [{ id, email, lastSeen }] so People lists every sign-up
        adminToken = null,
        dataFile = null,
        cookieSecure = false,
        // (user) => entitlement object; supplied by server/billing.js
        entitlementFor = () => null,
        // Concurrent devices (cookie sessions) per account; the oldest is signed out by a newer login. 0 = unlimited.
        maxDevices = 0,
        audit = { record() {} },
        // Optional usage statistics (server/stats.js)
        stats = null,
        // Shown on the blocked screen so a blocked user knows whom to ask
        supportEmail = null
    } = options;

    if (typeof secret !== 'string' || secret.length < 32) {
        throw new Error('SESSION_SECRET must be set to at least 32 characters');
    }

    const store = createUserStore(dataFile);
    // Either a fixed address or a function, so the operator can change it live from the dashboard
    const support = () => (typeof supportEmail === 'function' ? supportEmail() || null : supportEmail);

    // Only failed attempts count, so many users behind one IP are not locked out together.
    // Upstream trouble (502) is not the client's fault and must not lock users out during a Stremio outage.
    const sessionLimiter = createRateLimiter({ max: 20, countOnlyFailures: true, isFailure: (_req, res) => res.statusCode === 400 || res.statusCode === 401 });
    // Only requests that fail the token check ever reach this limiter (see adminGuard).
    const adminLimiter = createRateLimiter({ max: 10, countOnlyFailures: true });

    const sign = (payload) => {
        const body = b64url(JSON.stringify(payload));
        const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
        return `${body}.${signature}`;
    };

    const verify = (token) => {
        if (typeof token !== 'string') return null;
        const [body, signature, extra] = token.split('.');
        if (!body || !signature || extra !== undefined) return null;
        const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
        if (!safeEqual(signature, expected)) return null;
        try {
            const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            if (typeof payload.u !== 'string' || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
            return { id: payload.u, email: payload.e, iat: payload.iat, exp: payload.exp, sid: typeof payload.s === 'string' ? payload.s : null };
        } catch (_e) {
            return null;
        }
    };

    const issue = (user, iat = Date.now(), sid = crypto.randomBytes(9).toString('base64url')) => {
        const exp = Math.min(Date.now() + SESSION_TTL_MS, iat + MAX_SESSION_AGE_MS);
        return { token: sign({ u: user.id, e: user.email, iat, exp, s: sid }), exp, sid };
    };

    const cookieHeader = (value, maxAgeMs) => {
        const parts = [
            `${COOKIE_NAME}=${value}`,
            'Path=/',
            'HttpOnly',
            'SameSite=Lax',
            `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`
        ];
        if (cookieSecure) parts.push('Secure');
        return parts.join('; ');
    };

    // A valid signature is not enough: tokens issued before the user logged out are dead, so a copied
    // cookie cannot outlive an explicit logout.
    const sessionFromRequest = (req) => {
        const session = verify(parseCookies(req.headers.cookie)[COOKIE_NAME]);
        if (session === null || typeof session.iat !== 'number' || session.iat <= store.revokedBefore(session.id)) return null;
        if (maxDevices > 0 && store.sessionState(session.id, session.sid) !== 'ok') return null;
        return session;
    };

    // True when a still well-formed cookie was signed out because the account hit its device limit.
    const wasReplaced = (req) => {
        if (maxDevices === 0) return false;
        const session = verify(parseCookies(req.headers.cookie)[COOKIE_NAME]);
        return session !== null && typeof session.iat === 'number' && session.iat > store.revokedBefore(session.id) &&
            store.sessionState(session.id, session.sid) === 'evicted';
    };
    const devicesFor = (id) => (maxDevices > 0 ? { used: store.deviceCount(id), max: maxDevices } : null);

    // Use on any route that must only serve logged-in users (paid endpoints, etc).
    const requireSession = (req, res, next) => {
        const session = sessionFromRequest(req);
        if (session === null) {
            res.status(401).json({ error: wasReplaced(req) ? 'session_replaced' : 'not_logged_in' });
            return;
        }
        if (store.isBanned(session.email)) {
            res.status(403).json({ error: 'banned', support: support() });
            return;
        }
        req.session = { id: session.id, email: session.email };
        req.sessionMeta = { iat: session.iat, exp: session.exp, sid: session.sid };
        next();
    };

    // Resolves to the user, null when Stremio explicitly rejected the key,
    // and throws when we cannot tell (Stremio down, unexpected reply): never log users out over an outage.
    const fetchStremioUser = async (authKey) => {
        if (verifyKey) return verifyKey(authKey);
        const response = await fetch(`${stremioApiUrl.replace(/\/+$/, '')}/api/getUser`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'GetUser', authKey }),
            signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
        });
        if (!response.ok) throw new Error(`Stremio API answered HTTP ${response.status}`);
        const data = await response.json();
        if (data && data.result && typeof data.result._id === 'string' && typeof data.result.email === 'string') {
            return { id: data.result._id, email: data.result.email };
        }
        if (data && data.error) return null;
        throw new Error('Unexpected reply from the Stremio API');
    };

    // Identical keys in flight (page reload, several tabs) share one upstream call. Distinct keys are limited to
    // MAX_CONCURRENT_VERIFICATIONS at once; the rest wait in a bounded queue (a restart makes every client
    // reconnect together), and only a queue overflow is shed with a retryable 502.
    const inFlight = new Map();
    const waiting = [];
    let upstreamCalls = 0;
    const release = () => {
        upstreamCalls -= 1;
        while (waiting.length > 0) {
            const next = waiting.shift();
            if (Date.now() - next.at <= MAX_QUEUE_WAIT_MS) {
                next.run();
                return;
            }
            next.reject(new Error('verification waited too long in the queue'));
        }
    };
    const acquire = () => {
        if (upstreamCalls < MAX_CONCURRENT_VERIFICATIONS) {
            upstreamCalls += 1;
            return Promise.resolve();
        }
        if (waiting.length >= MAX_QUEUED_VERIFICATIONS) return Promise.reject(new Error('verification queue is full'));
        return new Promise((resolve, reject) => {
            waiting.push({
                at: Date.now(),
                reject,
                run: () => {
                    upstreamCalls += 1;
                    resolve();
                }
            });
        });
    };
    const verifyShared = (authKey) => {
        if (inFlight.has(authKey)) return inFlight.get(authKey);
        const promise = acquire()
            .then(() => fetchStremioUser(authKey).finally(release))
            .finally(() => inFlight.delete(authKey));
        inFlight.set(authKey, promise);
        return promise;
    };

    const router = express.Router();
    router.use(express.json({ limit: '4kb' }));
    router.use((_req, res, next) => {
        res.set('cache-control', 'no-store');
        next();
    });

    // Client posts its Stremio authKey; we verify it and start a session.
    router.post('/session', sessionLimiter, async (req, res) => {
        const authKey = req.body && req.body.authKey;
        if (typeof authKey !== 'string' || authKey.length === 0 || authKey.length > MAX_AUTH_KEY_LENGTH) {
            res.status(400).json({ error: 'invalid_auth_key' });
            return;
        }
        let user;
        try {
            user = await verifyShared(authKey);
        } catch (e) {
            console.error('Stremio verification failed:', e.message);
            res.set('retry-after', '5');
            res.status(502).json({ error: 'verification_unavailable' });
            return;
        }
        if (user === null) {
            res.status(401).json({ error: 'invalid_session' });
            return;
        }
        if (store.isBanned(user.email)) {
            res.status(403).json({ error: 'banned', support: support() });
            return;
        }
        const existing = sessionFromRequest(req);
        const freshLogin = existing === null || existing.id !== user.id;
        store.touch(user.id, user.email, { login: freshLogin });
        if (stats) stats.recordActive(user.id, { login: freshLogin, userAgent: req.get('user-agent'), language: req.get('accept-language') });
        // The same browser presenting its key again keeps its device slot; a new browser takes one.
        const reuse = existing !== null && existing.id === user.id ? existing.sid : undefined;
        const issued = issue(user, undefined, reuse || undefined);
        if (maxDevices > 0) store.registerSession(user.id, issued.sid, maxDevices);
        res.set('set-cookie', cookieHeader(issued.token, SESSION_TTL_MS));
        res.json({ user, entitlement: entitlementFor(user), devices: devicesFor(user.id) });
    });

    // Who am I / heartbeat. 401 when there is no valid session. Renews the cookie while it is
    // past half its life (up to MAX_SESSION_AGE_MS since the Stremio key was last verified).
    router.get('/me', requireSession, (req, res) => {
        store.touch(req.session.id, req.session.email);
        if (stats) stats.recordActive(req.session.id, { userAgent: req.get('user-agent'), language: req.get('accept-language') });
        const { iat, exp, sid } = req.sessionMeta;
        if (maxDevices > 0) store.touchSession(req.session.id, sid);
        if (exp - Date.now() < SESSION_TTL_MS / 2 && iat + MAX_SESSION_AGE_MS > exp) {
            const renewed = issue(req.session, iat, sid || undefined);
            res.set('set-cookie', cookieHeader(renewed.token, renewed.exp - Date.now()));
        }
        res.json({ user: req.session, entitlement: entitlementFor(req.session), devices: devicesFor(req.session.id) });
    });

    router.post('/logout', (req, res) => {
        const session = sessionFromRequest(req);
        if (session !== null) {
            // With a device limit only this device signs out; otherwise every cookie of the user is revoked.
            if (maxDevices > 0) {
                if (store.dropSession(session.id, session.sid) === 0) store.markLoggedOut(session.id);
            } else {
                store.markLoggedOut(session.id);
            }
        }
        res.set('set-cookie', cookieHeader('', 0));
        res.json({ ok: true });
    });

    // Hidden (404) unless the request carries the admin bearer token. A correct token is never rate limited
    // (so nobody can lock the operator out by guessing); wrong guesses are limited per IP.
    const adminGuard = (req, res, next) => {
        const header = req.headers.authorization;
        const provided = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
        if (adminToken !== null && safeEqual(provided, adminToken)) {
            next();
            return;
        }
        adminLimiter(req, res, () => {
            res.status(404).end();
        });
    };

    const admin = express.Router();
    admin.use(adminGuard);
    admin.use(express.json({ limit: '4kb' }));
    // Erase a user's record by email (GDPR-style request). Billing data is erased separately: /admin/billing/erase.
    admin.post('/users/erase', (req, res) => {
        const matches = store.findByEmail(req.body?.email);
        if (matches.length === 0) {
            res.status(404).json({ error: 'not_found' });
            return;
        }
        if (onErase) onErase(String(req.body.email));
        const ok = matches.map((user) => store.erase(user.id) && (!stats || stats.erase(user.id))).every(Boolean);
        audit.record('erase-user', { email: String(req.body.email).trim().toLowerCase() });
        res.status(ok ? 200 : 500).json({ erased: matches.length, ok });
    });
    // Operator note on a person (max 500 characters; empty removes it). The text is not copied into the audit log.
    admin.post('/note', (req, res) => {
        const matches = store.findByEmail(req.body?.email);
        if (matches.length === 0) {
            res.status(404).json({ error: 'not_found' });
            return;
        }
        if (req.body.note !== undefined && typeof req.body.note !== 'string') {
            res.status(400).json({ error: 'invalid_value' });
            return;
        }
        const note = (req.body.note || '').trim();
        if (note.length > 500) {
            res.status(400).json({ error: 'note_too_long' });
            return;
        }
        if (!matches.map((user) => store.setNote(user.id, note)).every(Boolean)) {
            res.status(500).json({ error: 'storage_unavailable' });
            return;
        }
        audit.record('note', { email: String(req.body.email).trim().toLowerCase(), change: note ? 'set' : 'cleared' });
        res.json({ ok: true, note });
    });
    admin.post('/ban', (req, res) => {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            res.status(400).json({ error: 'invalid_email' });
            return;
        }
        const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 200) : '';
        if (!store.ban(email, note)) {
            res.status(500).json({ error: 'storage_unavailable' });
            return;
        }
        // Kill any live session right away
        store.findByEmail(email).forEach((user) => store.markLoggedOut(user.id));
        if (onSignout) onSignout(email); // revoke the app's own authKeys too, so a ban takes effect on Alder immediately
        audit.record('ban', { email, note });
        res.status(201).json({ email, note });
    });
    // Sign a person out of every device without blocking them (compromised or mistakenly shared account).
    // Their next heartbeat gets 401 and the client re-presents the Stremio key, so this ends sessions the
    // operator no longer trusts; combine with /ban to keep them out.
    admin.post('/signout', (req, res) => {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const matches = email ? store.findByEmail(email) : [];
        if (matches.length === 0) {
            res.status(404).json({ error: 'not_found' });
            return;
        }
        matches.forEach((user) => store.markLoggedOut(user.id));
        if (onSignout) onSignout(email); // also revoke the app's authKeys so Alder stops until the user signs in again
        if (!store.flush()) {
            res.status(500).json({ error: 'storage_unavailable' });
            return;
        }
        audit.record('signout-everywhere', { email });
        res.json({ ok: true, users: matches.length });
    });
    admin.post('/unban', (req, res) => {
        const result = store.unban(req.body?.email);
        if (result === null) res.status(404).json({ error: 'not_banned' });
        else if (result === false) res.status(500).json({ error: 'storage_unavailable' });
        else {
            audit.record('unban', { email: String(req.body.email).trim().toLowerCase() });
            res.json({ ok: true });
        }
    });
    // Everything stored about one email (data-access requests). Never includes session ids or secrets.
    // Everything the login/stats side stores about one email (used by the operator export and by "download my data")
    const exportEmail = (rawEmail) => {
        const email = String(rawEmail || '').trim().toLowerCase();
        const matches = store.findByEmail(email);
        const records = matches.map(({ sessions, evicted, ...rest }) => ({ ...rest, devicesSignedIn: sessions ? Object.keys(sessions).length : 0 }));
        const watching = stats ? matches.map((user) => ({ id: user.id, recentLogins: stats.userDetail(user.id).recentLogins, ...stats.exportFor(user.id) })).filter((entry) => entry.seconds !== undefined || entry.recentLogins.length > 0) : [];
        return { email, users: records, blocked: store.isBanned(email), watchStats: watching };
    };
    admin.get('/users/export', (req, res) => {
        res.set('cache-control', 'no-store');
        res.json(exportEmail(req.query.email));
    });
    admin.get('/audit', (_req, res) => {
        res.set('cache-control', 'no-store');
        res.json({ entries: audit.recent() });
    });
    // People list for the operator. ?q= filters by part of the email, ?limit= (1-500, default 100) and ?offset= page
    // through the result, newest activity first. `total`/`online` always count everybody; `matched` counts the filter.
    admin.get('/sessions', (req, res) => {
        const now = Date.now();
        const query = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().slice(0, 200) : '';
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        // People who have signed in, keyed by email.
        const byEmail = new Map();
        for (const user of store.list()) byEmail.set(String(user.email || '').toLowerCase(), user);
        // Registered accounts that never opened a session belong on the list too, with no activity yet.
        if (typeof accountsList === 'function') {
            let accounts = [];
            try { accounts = accountsList() || []; } catch (_e) { accounts = []; }
            for (const acc of accounts) {
                const key = String(acc.email || '').toLowerCase();
                if (!key || byEmail.has(key)) continue;
                byEmail.set(key, { id: acc.id, email: acc.email, firstSeen: acc.lastSeen || 0, lastSeen: acc.lastSeen || 0, lastLogin: 0, logins: 0, loggedOut: false, registeredOnly: true });
            }
        }
        const everyone = [...byEmail.values()];
        const isOnline = (user) => !user.loggedOut && now - user.lastSeen < ONLINE_WINDOW_MS;
        const users = everyone
            .filter((user) => query === '' || String(user.email || '').toLowerCase().includes(query))
            .map((user) => ({ ...user, online: isOnline(user) }))
            .sort((a, b) => b.lastSeen - a.lastSeen);
        res.set('cache-control', 'no-store');
        res.json({
            online: everyone.filter(isOnline).length,
            total: everyone.length,
            matched: users.length,
            limit,
            offset,
            users: users.slice(offset, offset + limit),
            banned: store.bannedList()
        });
    });

    return { router, admin, adminGuard, requireSession, store, verify, sign, exportEmail, isBanned: (email) => store.isBanned(email) };
};

module.exports = { createAuth, COOKIE_NAME };
