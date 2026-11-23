// Usage statistics: who logs in and when, who actually watches, for how long, and what.
//
// What this can and cannot know (see docs/HANDOVER.md, "Statistics"):
// - Logins and activity come from the server's own session handling.
// - Watch time and titles are REPORTED BY THE PAGE (POST /auth/activity) while the player is playing. They are
//   as trustworthy as the client code: good for product analytics, not for billing or enforcement.
// - Passwords are never visible here (the Stremio core logs in directly against Stremio), so password changes
//   cannot be tracked.
//
// Stored in its own file (STATS_FILE, default data/stats.json) so it can be deleted or disabled on its own.
// Disabled with WATCH_STATS=false: the endpoint then accepts and discards reports, nothing is stored.

const crypto = require('crypto');
const express = require('express');
const { createJsonFile } = require('./jsonFile');
const { createRateLimiter } = require('./security');

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_KEPT = 120;
// Id lists are only needed for the 30-day active count; older days keep just their counts, so the file stays small.
const ID_LISTS_KEPT_DAYS = 35;
// The whole file is rewritten on each save, so batch busy-time writes more than the other files do.
const SAVE_DELAY_MS = 30 * 1000;
const CONTENT_KEPT = 2000;
const MAX_REPORT_SECONDS = 120;
const LOGINS_KEPT = 20;
const MAX_ACTIVE_PER_DAY = 200000;

// Coarse device profile from the User-Agent (no IP, no fingerprinting): enough to answer "what do people watch on"
const parseUserAgent = (ua) => {
    const text = typeof ua === 'string' ? ua : '';
    const os = /Windows/i.test(text) ? 'Windows'
        : /Android/i.test(text) ? 'Android'
            : /iPhone|iPad|iPod/i.test(text) ? 'iOS'
                : /Mac OS X|Macintosh/i.test(text) ? 'macOS'
                    : /CrOS/i.test(text) ? 'ChromeOS'
                        : /Linux|X11/i.test(text) ? 'Linux' : 'Other';
    const browser = /Edg\//i.test(text) ? 'Edge'
        : /OPR\/|Opera/i.test(text) ? 'Opera'
            : /Firefox|FxiOS/i.test(text) ? 'Firefox'
                : /Chrome|CriOS|Chromium/i.test(text) ? 'Chrome'
                    : /Safari/i.test(text) ? 'Safari' : 'Other';
    const form = /SmartTV|SMART-TV|Tizen|Web0S|WebOS|AppleTV|Android TV|GoogleTV|Roku|BRAVIA|HbbTV/i.test(text) ? 'tv'
        : /iPad|Tablet/i.test(text) || (/Android/i.test(text) && !/Mobile/i.test(text)) ? 'tablet'
            : /Mobi|iPhone|Android/i.test(text) ? 'phone' : 'desktop';
    return { os, browser, form };
};
const languageOf = (header) => {
    const first = typeof header === 'string' ? header.split(',')[0].trim().split(';')[0] : '';
    return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(first) ? first.split('-')[0].toLowerCase() : 'unknown';
};
const SOURCES = new Set(['torrent', 'http', 'youtube', 'external', 'other']);
const MAX_ADDONS = 200;
const MAX_ERROR_CODES = 100;

// Per-day lists hold a short fingerprint of each id instead of the full id: with tens of thousands of users
// over 35 days they are the biggest part of the file, and the whole file is rewritten on every save.
// 32 bits is plenty to count distinct people per day (about 0.3 expected collisions among 50,000 people).
const shortId = (id) => crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 8);

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const clean = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');

const createStats = ({ dataFile = null, enabled = true, listUsers = () => [], now = Date.now } = {}) => {
    const file = enabled ? createJsonFile(dataFile, () => ({ days: {}, users: {}, content: {}, hours: new Array(24).fill(0), types: {}, profiles: {}, sources: {}, addons: {}, errorCodes: {}, upgrade: { seen: {}, converted: {} } }), { saveDelayMs: SAVE_DELAY_MS }) : null;
    const data = file ? file.data : { days: {}, users: {}, content: {}, hours: new Array(24).fill(0), types: {}, profiles: {}, sources: {}, addons: {}, errorCodes: {}, upgrade: { seen: {}, converted: {} } };
    if (!Array.isArray(data.hours) || data.hours.length !== 24) data.hours = new Array(24).fill(0);
    if (!data.types || typeof data.types !== 'object') data.types = {};
    ['logins', 'profiles', 'sources', 'addons', 'errorCodes'].forEach((name) => {
        if (!data[name] || typeof data[name] !== 'object') data[name] = {};
    });
    if (!data.upgrade || typeof data.upgrade !== 'object') data.upgrade = { seen: {}, converted: {} };
    if (!data.upgrade.seen || typeof data.upgrade.seen !== 'object') data.upgrade.seen = {};
    if (!data.upgrade.converted || typeof data.upgrade.converted !== 'object') data.upgrade.converted = {};
    // How many times each user was shown the upgrade dialog (repeat views), alongside the first time (seen).
    if (!data.upgrade.views || typeof data.upgrade.views !== 'object') data.upgrade.views = {};

    const day = () => {
        const key = dayKey(now());
        if (!data.days[key]) {
            data.days[key] = { logins: 0, active: [], watchers: [], seconds: 0 };
            // By calendar age, not by count: a quiet server can have gaps between days
            const keepFrom = dayKey(now() - DAYS_KEPT * DAY_MS);
            const listsFrom = dayKey(now() - ID_LISTS_KEPT_DAYS * DAY_MS);
            Object.keys(data.days).forEach((name) => {
                if (name < keepFrom) {
                    delete data.days[name];
                    return;
                }
                const entry = data.days[name];
                if (name < listsFrom && Array.isArray(entry.active)) {
                    entry.activeCount = entry.active.length;
                    entry.watchersCount = entry.watchers.length;
                    delete entry.active;
                    delete entry.watchers;
                }
            });
        }
        return data.days[key];
    };
    // Membership checks run on every heartbeat, so keep a Set next to each stored array (rebuilt lazily after a
    // restart or an erase) instead of scanning a list that can hold tens of thousands of ids.
    const sets = new WeakMap();
    const addOnce = (list, fullId) => {
        const id = shortId(fullId);
        let set = sets.get(list);
        if (!set) {
            set = new Set(list);
            sets.set(list, set);
        }
        if (list.length < MAX_ACTIVE_PER_DAY && !set.has(id)) {
            set.add(id);
            list.push(id);
        }
    };

    // Called from the session endpoints. login = a fresh sign-in (not a heartbeat).
    const recordActive = (id, { login = false, userAgent, language } = {}) => {
        if (!file) return;
        if (login || !data.profiles[id]) {
            // Last known device and language of each person, refreshed at every sign-in
            data.profiles[id] = { ...parseUserAgent(userAgent), lang: languageOf(language), at: now() };
        }
        const today = day();
        if (login) {
            today.logins += 1;
            // Recent sign-in times per person, newest last
            const list = data.logins[id] || (data.logins[id] = []);
            list.push(now());
            if (list.length > LOGINS_KEPT) list.splice(0, list.length - LOGINS_KEPT);
        }
        addOnce(today.active, id);
        file.save();
    };

    const recordWatch = (id, { seconds, type, contentId, title, start, source = null, addon = null, completed = false }) => {
        if (!file) return false;
        const t = now();
        const today = day();
        addOnce(today.active, id);
        addOnce(today.watchers, id);
        today.seconds += seconds;
        data.hours[new Date(t).getUTCHours()] += seconds;
        data.types[type] = (data.types[type] || 0) + seconds;
        const user = data.users[id] || (data.users[id] = { seconds: 0, plays: 0, firstWatchAt: t, lastWatchAt: t });
        user.seconds += seconds;
        user.lastWatchAt = t;
        if (start) user.plays += 1;
        const bump = (map, key, cap) => {
            if (!key) return null;
            if (!map[key]) {
                if (Object.keys(map).length >= cap) return null;
                map[key] = { seconds: 0, plays: 0, errors: 0 };
            }
            return map[key];
        };
        [bump(data.sources, source, 10), bump(data.addons, addon, MAX_ADDONS)].forEach((entry) => {
            if (!entry) return;
            entry.seconds += seconds;
            if (start) entry.plays += 1;
        });
        if (start) today.plays = (today.plays || 0) + 1;
        if (completed) today.completions = (today.completions || 0) + 1;
        if (contentId) {
            // Series episodes arrive as "tt123:1:2" (imdb:season:episode): count the whole series as one title
            const baseId = contentId.split(':')[0];
            const key = `${type}:${baseId}`;
            const item = data.content[key] || (data.content[key] = { type, id: baseId, title, seconds: 0, plays: 0 });
            item.seconds += seconds;
            if (title) item.title = title;
            if (start) item.plays += 1;
            if (completed) item.completions = (item.completions || 0) + 1;
            const keys = Object.keys(data.content);
            if (keys.length > CONTENT_KEPT) {
                keys.sort((a, b) => data.content[a].seconds - data.content[b].seconds)
                    .slice(0, keys.length - CONTENT_KEPT)
                    .forEach((name) => { delete data.content[name]; });
            }
        }
        file.save();
        return true;
    };

    // A playback failure reported by the player (the stream could not be played, or the player gave up)
    const recordError = (id, { code, critical, type, contentId, source, addon }) => {
        if (!file) return false;
        const today = day();
        addOnce(today.active, id);
        today.errors = (today.errors || 0) + 1;
        if (critical) today.criticalErrors = (today.criticalErrors || 0) + 1;
        const label = code || 'unknown';
        if (data.errorCodes[label] || Object.keys(data.errorCodes).length < MAX_ERROR_CODES) {
            data.errorCodes[label] = (data.errorCodes[label] || 0) + 1;
        }
        if (source && data.sources[source]) data.sources[source].errors += 1;
        if (addon && data.addons[addon]) data.addons[addon].errors += 1;
        if (contentId) {
            const item = data.content[`${type}:${contentId.split(':')[0]}`];
            if (item) item.errors = (item.errors || 0) + 1;
        }
        file.save();
        return true;
    };

    const erase = (id) => {
        if (!file) return true;
        delete data.users[id];
        delete data.logins[id];
        delete data.profiles[id];
        Object.values(data.days).forEach((entry) => {
            if (!Array.isArray(entry.active)) return; // compacted day: counts only, nothing attributable
            const token = shortId(id);
            entry.active = entry.active.filter((value) => value !== token); // new arrays: their Sets are rebuilt lazily
            entry.watchers = entry.watchers.filter((value) => value !== token);
        });
        return file.flush();
    };

    // One person's activity for the operator: recent sign-ins and watch totals
    const userDetail = (id) => ({
        recentLogins: (data.logins[id] || []).slice().reverse(),
        watch: data.users[id] ? { ...data.users[id] } : null
    });

    const exportFor = (id) => (data.users[id] ? { ...data.users[id] } : null);

    const summary = (days = 30, roleOf = null) => {
        const t = now();
        const users = listUsers();
        const watchSeconds = (user) => (data.users[user.id] ? data.users[user.id].seconds : 0);
        const real = users.filter((user) => !user.erased && user.email);
        const series = [];
        for (let i = days - 1; i >= 0; i -= 1) {
            const key = dayKey(t - i * DAY_MS);
            const entry = data.days[key];
            series.push({
                day: key,
                newUsers: real.filter((user) => dayKey(user.firstSeen) === key).length,
                logins: entry ? entry.logins : 0,
                activeUsers: entry ? (entry.active ? entry.active.length : entry.activeCount || 0) : 0,
                watchers: entry ? (entry.watchers ? entry.watchers.length : entry.watchersCount || 0) : 0,
                hoursWatched: entry ? Math.round(entry.seconds / 36) / 100 : 0,
                plays: entry ? entry.plays || 0 : 0,
                errors: entry ? entry.errors || 0 : 0
            });
        }
        const watchers = real.filter((user) => watchSeconds(user) > 0);
        // Bounce: signed in at least a day ago and never played anything
        const neverWatched = real
            .filter((user) => watchSeconds(user) === 0 && t - user.firstSeen > DAY_MS)
            .sort((a, b) => b.firstSeen - a.firstSeen);
        const old = real.filter((user) => t - user.firstSeen > 7 * DAY_MS);
        const retained = old.filter((user) => t - user.lastSeen < 7 * DAY_MS);
        // Time from first sign-in to first playback, for users who watched (median, minutes)
        const gaps = watchers
            .map((user) => data.users[user.id].firstWatchAt - user.firstSeen)
            .filter((gap) => gap >= 0)
            .sort((a, b) => a - b);
        const totalPlays = Object.values(data.users).reduce((sum, user) => sum + user.plays, 0);
        const totalSeconds = Object.values(data.users).reduce((sum, user) => sum + user.seconds, 0);
        const activeSince = (count) => {
            const set = new Set();
            for (let i = 0; i < count; i += 1) {
                const entry = data.days[dayKey(t - i * DAY_MS)];
                if (entry && entry.active) entry.active.forEach((id) => set.add(id));
            }
            return set;
        };
        const activeWeek = activeSince(7);
        const activeMonth = activeSince(30);
        const activeToday = activeSince(1);
        // Where users stand commercially: owner / member / granted / free (paywall off) / none (stuck at the paywall)
        const roles = {};
        if (roleOf) real.forEach((user) => {
            const role = roleOf(user) || 'unknown';
            roles[role] = (roles[role] || 0) + 1;
        });
        const toRowOf = (user) => ({ email: user.email, firstSeen: user.firstSeen, lastSeen: user.lastSeen, logins: user.logins });
        // Classic day-N retention: of the users who first signed in N days ago (or earlier, within the 35 days of
        // id lists we keep), the share that were active on exactly the Nth day after their first sign-in.
        const retention = {};
        [1, 7, 30].forEach((n) => {
            const eligible = real.filter((user) => t - user.firstSeen >= (n + 1) * DAY_MS && t - user.firstSeen <= 34 * DAY_MS);
            const returned = eligible.filter((user) => {
                const entry = data.days[dayKey(user.firstSeen + n * DAY_MS)];
                if (!entry || !Array.isArray(entry.active)) return false;
                let set = sets.get(entry.active);
                if (!set) {
                    set = new Set(entry.active); // cached per day: building it per user would be quadratic
                    sets.set(entry.active, set);
                }
                return set.has(shortId(user.id));
            });
            retention[`day${n}`] = { eligible: eligible.length, returned: returned.length, percent: eligible.length === 0 ? null : Math.round((returned.length / eligible.length) * 100) };
        });
        // Paying (or plan-sharing) people who stopped showing up: the ones worth an email before they cancel
        const atRisk = roleOf ? real
            .filter((user) => ['owner', 'member'].includes(roleOf(user)) && t - user.lastSeen > 14 * DAY_MS)
            .sort((a, b) => a.lastSeen - b.lastSeen)
            .slice(0, 100)
            .map((user) => ({ ...toRowOf(user), role: roleOf(user) })) : [];
        const toRow = (user) => ({ email: user.email, firstSeen: user.firstSeen, lastSeen: user.lastSeen, logins: user.logins });
        return {
            enabled: file !== null,
            totals: {
                users: real.length,
                everWatched: watchers.length,
                neverWatched: neverWatched.length,
                hoursWatched: Math.round(Object.values(data.users).reduce((sum, user) => sum + user.seconds, 0) / 36) / 100,
                retention7d: old.length === 0 ? null : Math.round((retained.length / old.length) * 100),
                // Share of all known users that ever played something
                activationPercent: real.length === 0 ? null : Math.round((watchers.length / real.length) * 100),
                activeToday: activeToday.size,
                activeLast7d: activeWeek.size,
                activeLast30d: activeMonth.size,
                // daily / monthly actives: how many of the month's users show up on a typical day
                stickinessPercent: activeMonth.size === 0 ? null : Math.round((activeToday.size / activeMonth.size) * 100),
                medianMinutesToFirstWatch: gaps.length === 0 ? null : Math.round(gaps[Math.floor(gaps.length / 2)] / 60000),
                avgMinutesPerPlay: totalPlays === 0 ? null : Math.round(totalSeconds / totalPlays / 60)
            },
            // Seconds watched per hour of day, UTC (shift to your own time zone when reading)
            hoursOfDayUtc: data.hours.map((seconds) => Math.round(seconds / 36) / 100),
            byType: Object.entries(data.types).map(([type, seconds]) => ({ type, hours: Math.round(seconds / 36) / 100 })).sort((a, b) => b.hours - a.hours),
            // How engaged the people who watch are: users by total hours watched
            watchDepth: (() => {
                const buckets = { under1h: 0, from1to5h: 0, from5to20h: 0, over20h: 0 };
                watchers.forEach((user) => {
                    const hours = watchSeconds(user) / 3600;
                    if (hours < 1) buckets.under1h += 1;
                    else if (hours < 5) buckets.from1to5h += 1;
                    else if (hours < 20) buckets.from5to20h += 1;
                    else buckets.over20h += 1;
                });
                return buckets;
            })(),
            // This week against the week before: [last 7 days, previous 7 days, change in %]
            trends: (() => {
                const sum = (from, to, pick) => {
                    let total = 0;
                    for (let i = from; i < to; i += 1) {
                        const entry = data.days[dayKey(t - i * DAY_MS)];
                        if (entry) total += pick(entry);
                    }
                    return total;
                };
                const metric = (pick) => {
                    const current = sum(0, 7, pick);
                    const previous = sum(7, 14, pick);
                    return [current, previous, previous === 0 ? null : Math.round(((current - previous) / previous) * 100)];
                };
                const count = (entry, list, counter) => (entry[list] ? entry[list].length : entry[counter] || 0);
                return {
                    logins: metric((entry) => entry.logins),
                    hoursWatched: metric((entry) => Math.round(entry.seconds / 36) / 100),
                    activeUserDays: metric((entry) => count(entry, 'active', 'activeCount')),
                    watcherDays: metric((entry) => count(entry, 'watchers', 'watchersCount')),
                    newUsers: (() => {
                        const inWindow = (from, to) => real.filter((user) => t - user.firstSeen >= from * DAY_MS && t - user.firstSeen < to * DAY_MS).length;
                        const current = inWindow(0, 7);
                        const previous = inWindow(7, 14);
                        return [current, previous, previous === 0 ? null : Math.round(((current - previous) / previous) * 100)];
                    })()
                };
            })(),
            playback: (() => {
                const total = Object.values(data.days).reduce((acc, entry) => {
                    acc.plays += entry.plays || 0;
                    acc.completions += entry.completions || 0;
                    acc.errors += entry.errors || 0;
                    acc.criticalErrors += entry.criticalErrors || 0;
                    return acc;
                }, { plays: 0, completions: 0, errors: 0, criticalErrors: 0 });
                return {
                    ...total,
                    completionPercent: total.plays === 0 ? null : Math.round((total.completions / total.plays) * 100),
                    errorsPer100Plays: total.plays === 0 ? null : Math.round((total.errors / total.plays) * 1000) / 10
                };
            })(),
            bySource: Object.entries(data.sources).map(([name, entry]) => ({ name, hours: Math.round(entry.seconds / 36) / 100, plays: entry.plays, errors: entry.errors })).sort((a, b) => b.hours - a.hours),
            byAddon: Object.entries(data.addons).map(([name, entry]) => ({ name, hours: Math.round(entry.seconds / 36) / 100, plays: entry.plays, errors: entry.errors, errorsPer100Plays: entry.plays === 0 ? null : Math.round((entry.errors / entry.plays) * 1000) / 10 })).sort((a, b) => b.plays - a.plays).slice(0, 15),
            errorCodes: Object.entries(data.errorCodes).map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count).slice(0, 10),
            // Distinct people by device, browser, form factor and browser language (their latest sign-in)
            devices: (() => {
                const tally = (pick) => {
                    const counts = {};
                    real.forEach((user) => {
                        const profile = data.profiles[user.id];
                        if (profile) counts[pick(profile)] = (counts[pick(profile)] || 0) + 1;
                    });
                    return Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
                };
                return { os: tally((p) => p.os), browser: tally((p) => p.browser), form: tally((p) => p.form), language: tally((p) => p.lang) };
            })(),
            roles,
            retention,
            atRisk,
            // Share of users who pay or are covered by someone's plan
            conversionPercent: roleOf && real.length > 0 ? Math.round((((roles.owner || 0) + (roles.member || 0)) / real.length) * 100) : null,
            // Upgrade-modal funnel: how many saw the paywall dialog, and what share of them eventually upgraded.
            upgrade: (() => {
                const seen = Object.keys(data.upgrade.seen).length;
                const converted = Object.keys(data.upgrade.converted).length;
                const views = Object.values(data.upgrade.views).reduce((sum, n) => sum + (Number(n) || 0), 0);
                return { seen, converted, views, conversionPercent: seen > 0 ? Math.round((converted / seen) * 1000) / 10 : null };
            })(),
            daily: series,
            neverWatched: neverWatched.slice(0, 200).map(toRow),
            topUsers: watchers
                .sort((a, b) => watchSeconds(b) - watchSeconds(a))
                .slice(0, 20)
                .map((user) => ({ email: user.email, hours: Math.round(watchSeconds(user) / 36) / 100, plays: data.users[user.id].plays, lastWatchAt: data.users[user.id].lastWatchAt })),
            topContent: Object.values(data.content)
                .sort((a, b) => b.seconds - a.seconds)
                .slice(0, 20)
                .map((item) => ({ type: item.type, id: item.id, title: item.title, hours: Math.round(item.seconds / 36) / 100, plays: item.plays, completionPercent: item.plays > 0 && item.completions !== undefined ? Math.min(100, Math.round((item.completions / item.plays) * 100)) : null, errors: item.errors || 0 }))
        };
    };

    // Upgrade-modal funnel: a user who was shown the paywall upgrade dialog, and whether they later converted
    // (became entitled). Conversion is marked when a seen user is next seen active, so "% eventually upgraded" is exact.
    const recordUpgradeSeen = (id) => {
        if (!file || !id) return false;
        // seen[id] holds the first-seen time (one entry per user); views[id] counts every time they saw it again,
        // so the funnel can say "N views from M people" without counting one repeat-viewer as a new user.
        if (!data.upgrade.seen[id]) data.upgrade.seen[id] = now();
        data.upgrade.views[id] = (data.upgrade.views[id] || 0) + 1;
        file.save();
        return true;
    };
    const hasSeenUpgrade = (id) => !!(id && data.upgrade.seen[id]);
    const markUpgradeConverted = (id) => {
        if (!file || !id || !data.upgrade.seen[id] || data.upgrade.converted[id]) return false;
        data.upgrade.converted[id] = now();
        file.save();
        return true;
    };

    // Reports from the player: { seconds, type, id, title, start }. Always answers 204 (also when disabled)
    // so the page never needs to know.
    const reportLimiter = createRateLimiter({ max: 20, keyFn: (req) => (req.session ? req.session.id : req.ip) });
    const router = (requireSession) => {
        const r = express.Router();
        r.post('/activity', requireSession, reportLimiter, express.json({ limit: '2kb' }), (req, res) => {
            const body = req.body || {};
            const type = clean(body.type, 30) || 'unknown';
            const contentId = clean(body.id, 120);
            const source = SOURCES.has(body.source) ? body.source : null;
            // Add-on host only (never a path or query: add-on URLs can carry personal tokens)
            const addon = /^[a-z0-9.-]{1,100}$/i.test(body.addon || '') ? String(body.addon).toLowerCase() : null;
            if (body.event === 'error') {
                recordError(req.session.id, { code: clean(body.code, 40), critical: body.critical === true, type, contentId, source, addon });
            } else {
                const seconds = Number(body.seconds);
                if (Number.isFinite(seconds) && seconds > 0) {
                    recordWatch(req.session.id, {
                        seconds: Math.min(Math.round(seconds), MAX_REPORT_SECONDS),
                        type,
                        contentId,
                        title: clean(body.title, 200),
                        start: body.start === true,
                        source,
                        addon,
                        completed: body.completed === true
                    });
                }
            }
            res.status(204).end();
        });
        return r;
    };

    return {
        recordActive,
        recordWatch,
        recordError,
        recordUpgradeSeen,
        hasSeenUpgrade,
        markUpgradeConverted,
        erase,
        exportFor,
        userDetail,
        shortId,
        summary,
        router,
        flush: () => (file ? file.flush() : true),
        isHealthy: () => (file ? file.isHealthy() : true),
        data
    };
};

module.exports = { createStats };
