'use strict';

// SQLite storage for the account service (Node's built-in node:sqlite, Node 22.13 or newer, no native packages to install).
// One row per person, per sign-in key and per library item, so a sync touches only what changed instead of rewriting
// one large file. WAL mode keeps readers and the writer from blocking each other. Everything here is synchronous.

const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    date_registered INTEGER NOT NULL,
    last_modified INTEGER NOT NULL,
    gdpr TEXT NOT NULL,
    avatar TEXT,
    trakt TEXT,
    addons TEXT,
    addons_modified INTEGER,
    app_settings TEXT,
    app_settings_modified INTEGER,
    profiles TEXT,
    profiles_modified INTEGER,
    reset_hash TEXT,
    reset_expires INTEGER
);
CREATE INDEX IF NOT EXISTS users_reset ON users(reset_hash) WHERE reset_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS keys (
    hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_used INTEGER NOT NULL,
    ua TEXT
);
CREATE INDEX IF NOT EXISTS keys_user ON keys(user_id);
CREATE TABLE IF NOT EXISTS library (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (user_id, item_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ratings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_type TEXT NOT NULL,
    media_id TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, media_type, media_id)
) WITHOUT ROWID;
`;

const BACKUPS_KEPT = 7;

const createAccountsStore = (file = ':memory:') => {
    const { DatabaseSync } = require('node:sqlite');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    db.exec(SCHEMA);
    // Added after the first release: older databases get the column on start
    if (!db.prepare('PRAGMA table_info(users)').all().some((column) => column.name === 'calendar_token')) {
        db.exec('ALTER TABLE users ADD COLUMN calendar_token TEXT; CREATE UNIQUE INDEX IF NOT EXISTS users_calendar ON users(calendar_token) WHERE calendar_token IS NOT NULL;');
    }
    if (!db.prepare('PRAGMA table_info(users)').all().some((column) => column.name === 'app_settings')) {
        db.exec('ALTER TABLE users ADD COLUMN app_settings TEXT; ALTER TABLE users ADD COLUMN app_settings_modified INTEGER;');
    }
    if (!db.prepare('PRAGMA table_info(users)').all().some((column) => column.name === 'profiles')) {
        db.exec('ALTER TABLE users ADD COLUMN profiles TEXT; ALTER TABLE users ADD COLUMN profiles_modified INTEGER;');
    }

    const q = {};
    const prepare = (name, sql) => { q[name] = db.prepare(sql); };
    prepare('userById', 'SELECT * FROM users WHERE id = ?');
    prepare('userByEmail', 'SELECT * FROM users WHERE email = ?');
    prepare('userByCalendar', 'SELECT * FROM users WHERE calendar_token = ?');
    prepare('setCalendar', 'UPDATE users SET calendar_token = ? WHERE id = ?');
    prepare('getCalendar', 'SELECT calendar_token FROM users WHERE id = ?');
    prepare('userByReset', 'SELECT * FROM users WHERE reset_hash = ?');
    prepare('insertUser', 'INSERT INTO users (id, email, password_hash, date_registered, last_modified, gdpr, avatar, trakt, addons, addons_modified, reset_hash, reset_expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    prepare('updateUser', 'UPDATE users SET password_hash = ?, last_modified = ?, gdpr = ?, avatar = ?, trakt = ?, addons = ?, addons_modified = ?, app_settings = ?, app_settings_modified = ?, profiles = ?, profiles_modified = ?, reset_hash = ?, reset_expires = ? WHERE id = ?');
    prepare('deleteUser', 'DELETE FROM users WHERE id = ?');
    prepare('countUsers', 'SELECT COUNT(*) AS n FROM users');
    prepare('listUsers', 'SELECT id, email, date_registered FROM users ORDER BY date_registered DESC');
    prepare('addKey', 'INSERT INTO keys (hash, user_id, created_at, last_used, ua) VALUES (?, ?, ?, ?, ?)');
    prepare('keyRow', 'SELECT user_id, last_used FROM keys WHERE hash = ?');
    prepare('touchKey', 'UPDATE keys SET last_used = ? WHERE hash = ?');
    prepare('deleteKey', 'DELETE FROM keys WHERE hash = ?');
    prepare('deleteKeysOf', 'DELETE FROM keys WHERE user_id = ?');
    prepare('countKeys', 'SELECT COUNT(*) AS n FROM keys WHERE user_id = ?');
    prepare('trimKeys', 'DELETE FROM keys WHERE user_id = ? AND hash IN (SELECT hash FROM keys WHERE user_id = ? ORDER BY last_used ASC LIMIT ?)');
    prepare('libMeta', 'SELECT item_id, mtime FROM library WHERE user_id = ?');
    prepare('libOne', 'SELECT body FROM library WHERE user_id = ? AND item_id = ?');
    prepare('libAll', 'SELECT body FROM library WHERE user_id = ?');
    prepare('libMtime', 'SELECT mtime FROM library WHERE user_id = ? AND item_id = ?');
    prepare('libUpsert', 'INSERT INTO library (user_id, item_id, mtime, body) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, item_id) DO UPDATE SET mtime = excluded.mtime, body = excluded.body');
    prepare('ratingGet', 'SELECT status FROM ratings WHERE user_id = ? AND media_type = ? AND media_id = ?');
    prepare('ratingSet', 'INSERT INTO ratings (user_id, media_type, media_id, status, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, media_type, media_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at');
    prepare('ratingDelete', 'DELETE FROM ratings WHERE user_id = ? AND media_type = ? AND media_id = ?');
    prepare('ratingsAll', 'SELECT media_type, media_id, status, updated_at FROM ratings WHERE user_id = ?');
    prepare('libCount', 'SELECT COUNT(*) AS n FROM library WHERE user_id = ?');

    const json = (text) => (text === null || text === undefined ? null : JSON.parse(text));
    const toUser = (row) => (row ? {
        id: row.id,
        email: row.email,
        passwordHash: row.password_hash,
        dateRegistered: row.date_registered,
        lastModified: row.last_modified,
        gdprConsent: json(row.gdpr),
        avatar: row.avatar,
        trakt: json(row.trakt),
        addons: row.addons === null ? null : { list: json(row.addons), lastModified: row.addons_modified },
        appSettings: row.app_settings === null || row.app_settings === undefined ? null : { values: json(row.app_settings), lastModified: row.app_settings_modified },
        profiles: row.profiles === null || row.profiles === undefined ? null : { ...json(row.profiles), rev: row.profiles_modified },
        reset: row.reset_hash ? { hash: row.reset_hash, expires: row.reset_expires } : null
    } : null);

    const transaction = (work) => {
        db.exec('BEGIN IMMEDIATE');
        try {
            const result = work();
            db.exec('COMMIT');
            return result;
        } catch (e) {
            try { db.exec('ROLLBACK'); } catch (_e) { /* already rolled back */ }
            throw e;
        }
    };

    const writeUser = (user) => q.updateUser.run(
        user.passwordHash, user.lastModified, JSON.stringify(user.gdprConsent), user.avatar || null, user.trakt ? JSON.stringify(user.trakt) : null,
        user.addons ? JSON.stringify(user.addons.list) : null, user.addons ? user.addons.lastModified : null,
        user.appSettings ? JSON.stringify(user.appSettings.values) : null, user.appSettings ? user.appSettings.lastModified : null,
        user.profiles ? JSON.stringify({ list: user.profiles.list, active: user.profiles.active }) : null, user.profiles ? user.profiles.rev : null,
        user.reset ? user.reset.hash : null, user.reset ? user.reset.expires : null, user.id
    );

    let backupTimer = null;
    return {
        userById: (id) => toUser(q.userById.get(id)),
        userByEmail: (email) => toUser(q.userByEmail.get(String(email))),
        userByResetHash: (hash) => toUser(q.userByReset.get(hash)),
        count: () => q.countUsers.get().n,
        list: () => q.listUsers.all().map((row) => ({ id: row.id, email: row.email, dateRegistered: row.date_registered })),
        userIdByCalendarToken: (token) => { const row = q.userByCalendar.get(token); return row ? row.id : null; },
        calendarToken: (userId) => q.getCalendar.get(userId).calendar_token,
        setCalendarToken: (userId, token) => q.setCalendar.run(token, userId),
        // Throws on a duplicate email (unique index): the caller turns that into "already registered".
        insertUser: (user) => q.insertUser.run(user.id, user.email, user.passwordHash, user.dateRegistered, user.lastModified, JSON.stringify(user.gdprConsent), null, null, null, null, null, null),
        saveUser: writeUser,
        removeUser: (id) => q.deleteUser.run(id), // keys and library go with it (ON DELETE CASCADE)

        // Adds a key and drops the least recently used ones beyond maxKeys, in one step.
        addKey: (userId, hash, meta, maxKeys, at) => transaction(() => {
            q.addKey.run(hash, userId, at, at, meta && meta.ua ? String(meta.ua) : null);
            const extra = q.countKeys.get(userId).n - maxKeys;
            if (extra > 0) q.trimKeys.run(userId, userId, extra);
        }),
        keyOwner: (hash) => {
            const row = q.keyRow.get(hash);
            return row ? { userId: row.user_id, lastUsed: row.last_used } : null;
        },
        touchKey: (hash, at) => q.touchKey.run(at, hash),
        removeKey: (hash) => q.deleteKey.run(hash),
        removeKeysOf: (userId) => q.deleteKeysOf.run(userId),
        keyCount: (userId) => q.countKeys.get(userId).n,

        ratingGet: (userId, type, id) => { const row = q.ratingGet.get(userId, type, id); return row ? row.status : null; },
        ratingSet: (userId, type, id, status, at) => (status ? q.ratingSet.run(userId, type, id, status, at) : q.ratingDelete.run(userId, type, id)),
        ratingsAll: (userId) => q.ratingsAll.all(userId),
        libraryMeta: (userId) => q.libMeta.all(userId).map((row) => [row.item_id, row.mtime]),
        libraryGet: (userId, ids) => ids.map((id) => q.libOne.get(userId, id)).filter(Boolean).map((row) => JSON.parse(row.body)),
        libraryAll: (userId) => q.libAll.all(userId).map((row) => JSON.parse(row.body)),
        libraryCount: (userId) => q.libCount.get(userId).n,
        // items: [{ item, mtime }]. Newer wins per item; all or nothing. Returns false when it would exceed maxItems.
        libraryPut: (userId, items, maxItems) => transaction(() => {
            for (const { item, mtime } of items) {
                const known = q.libMtime.get(userId, item._id);
                if (!known || known.mtime <= mtime) q.libUpsert.run(userId, item._id, mtime, JSON.stringify(item));
            }
            if (q.libCount.get(userId).n > maxItems) throw Object.assign(new Error('library too large'), { code: 'TOO_LARGE' });
        }),
        transaction,

        // A consistent copy once a day, the newest BACKUPS_KEPT kept. VACUUM INTO works while the server is running.
        startBackups: (now = Date.now) => {
            if (file === ':memory:') return;
            const run = () => {
                try {
                    const day = new Date(now()).toISOString().slice(0, 10);
                    const target = `${file}.bak-${day}`;
                    if (!fs.existsSync(target)) db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
                    const old = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.bak-`)).sort().slice(0, -BACKUPS_KEPT);
                    old.forEach((name) => fs.rmSync(path.join(path.dirname(file), name), { force: true }));
                } catch (e) {
                    console.error('Account database backup failed:', e.message);
                }
            };
            run();
            backupTimer = setInterval(run, 6 * 60 * 60 * 1000);
            backupTimer.unref();
        },
        close: () => { if (backupTimer) clearInterval(backupTimer); db.close(); }
    };
};

module.exports = { createAccountsStore };
