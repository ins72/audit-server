'use strict';

// Trakt integration run by our own server (the stock one ran on strem.io). It is optional: it needs a Trakt API app
// (TRAKT_CLIENT_ID / TRAKT_CLIENT_SECRET) and is offered only when those are set.
//  1. Connect: the person opens Trakt's sign-in page from the app, Trakt sends them back to /trakt/callback, we keep the
//     tokens (refresh token never leaves the server).
//  2. Trakt add-on: the core installs an add-on from /trakt/addon/<id>/manifest.json; it lists the person's Trakt
//     watchlist, recommendations and what is trending as catalogs.
//  3. History: titles the person finishes watching are added to their Trakt history.
// Trakt itself stays a public service; we only talk to it with the person's permission.

const crypto = require('crypto');
const express = require('express');

const STATE_TTL_MS = 10 * 60 * 1000;
const WATCHED_RATIO = 0.8;
const RECENT_MS = 2 * 24 * 60 * 60 * 1000; // only titles watched in the last two days are sent, so a first sync does not flood history
const IMDB = /^tt\d{1,12}$/;

const CATALOGS = [
    { type: 'movie', id: 'trakt.watchlist', name: 'Trakt watchlist' },
    { type: 'series', id: 'trakt.watchlist', name: 'Trakt watchlist' },
    { type: 'movie', id: 'trakt.recommended', name: 'Trakt recommended' },
    { type: 'series', id: 'trakt.recommended', name: 'Trakt recommended' },
    { type: 'movie', id: 'trakt.trending', name: 'Trakt trending' },
    { type: 'series', id: 'trakt.trending', name: 'Trakt trending' }
];
const KIND = { movie: 'movies', series: 'shows' };

const createTrakt = ({ api: API = 'https://api.trakt.tv', site: SITE = 'https://trakt.tv', clientId = '', clientSecret = '', publicUrl = '', accounts, fetchImpl = fetch, now = Date.now, productName = () => '' } = {}) => {
    const enabled = !!(clientId && clientSecret && publicUrl);
    const redirectUri = `${publicUrl}/trakt/callback`;
    const states = new Map(); // state -> { userId, at }
    const sent = new Set(); // history entries already sent (the watched_at timestamp also makes Trakt ignore repeats)

    const call = async (path, { method = 'GET', token = null, body = null } = {}) => {
        const response = await fetchImpl(`${API}${path}`, {
            method,
            signal: AbortSignal.timeout(8000),
            headers: {
                'content-type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': clientId, ...(token ? { authorization: `Bearer ${token}` } : {})
            },
            body: body ? JSON.stringify(body) : undefined
        });
        if (!response.ok) throw Object.assign(new Error(`Trakt answered ${response.status}`), { status: response.status });
        return response.status === 204 ? null : response.json().catch(() => null);
    };
    const tokenCall = (fields) => call('/oauth/token', { method: 'POST', body: { client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, ...fields } });
    const toRecord = (data) => ({ access_token: data.access_token, refresh_token: data.refresh_token, created_at: data.created_at, expires_in: data.expires_in });

    // The person's current access token, refreshed when it is about to expire; null when not connected or the link is dead.
    const accessToken = async (userId) => {
        const record = accounts.traktRecord(userId);
        if (!record) return null;
        if (now() / 1000 < record.created_at + record.expires_in - 24 * 3600) return record.access_token;
        try {
            const fresh = toRecord(await tokenCall({ refresh_token: record.refresh_token, grant_type: 'refresh_token' }));
            accounts.setTraktRecord(userId, fresh);
            return fresh.access_token;
        } catch (_e) {
            return null;
        }
    };

    const startUrl = (userId) => {
        if (!enabled) return null;
        const cutoff = now() - STATE_TTL_MS;
        for (const [key, value] of states) if (value.at < cutoff) states.delete(key);
        if (states.size > 1000) states.clear();
        const state = crypto.randomBytes(24).toString('base64url');
        states.set(state, { userId, at: now() });
        return `${SITE}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state })}`;
    };

    const finish = async (code, state) => {
        const entry = states.get(state);
        states.delete(state);
        if (!entry || now() - entry.at > STATE_TTL_MS || typeof code !== 'string' || code.length > 200) return false;
        try {
            accounts.setTraktRecord(entry.userId, toRecord(await tokenCall({ code, grant_type: 'authorization_code' })));
            return true;
        } catch (_e) {
            return false;
        }
    };

    const disconnect = async (record) => {
        if (!enabled || !record) return;
        await call('/oauth/revoke', { method: 'POST', body: { token: record.access_token, client_id: clientId, client_secret: clientSecret } }).catch(() => {});
    };

    const metaOf = (type, entry) => {
        const item = entry[type === 'movie' ? 'movie' : 'show'] || entry;
        const imdb = item && item.ids && item.ids.imdb;
        if (!imdb || !IMDB.test(imdb)) return null;
        return { id: imdb, type, name: String(item.title || imdb), releaseInfo: item.year ? String(item.year) : undefined, poster: `https://images.metahub.space/poster/medium/${imdb}/img`, posterShape: 'poster' };
    };

    const catalog = async (userId, type, id) => {
        if (!KIND[type] || !CATALOGS.some((entry) => entry.id === id)) return null;
        const kind = KIND[type];
        let list;
        if (id === 'trakt.trending') {
            list = await call(`/${kind}/trending?limit=40`);
        } else {
            const token = await accessToken(userId);
            if (!token) return [];
            list = await call(id === 'trakt.watchlist' ? `/sync/watchlist/${kind}` : `/recommendations/${kind}?limit=40`, { token });
        }
        return (list || []).map((entry) => metaOf(type, entry)).filter(Boolean).slice(0, 100);
    };

    // Called with the library items a device just pushed: finished titles go to the person's Trakt history.
    const onLibraryChange = async (userId, items) => {
        if (!enabled || !accounts.traktRecord(userId)) return;
        const movies = [];
        const shows = new Map(); // imdb -> Map(season -> [{ number, watched_at }])
        for (const item of items.slice(0, 200)) {
            const state = item && item.state;
            const watchedAt = state && Date.parse(state.lastWatched);
            if (!state || !IMDB.test(String(item._id)) || !Number.isFinite(watchedAt) || now() - watchedAt > RECENT_MS || item.removed) continue;
            if (!(state.duration > 0 && state.timeOffset / state.duration >= WATCHED_RATIO) && !(state.flaggedWatched > 0)) continue;
            const key = `${item._id}|${state.video_id}|${state.lastWatched}`;
            if (sent.has(key)) continue;
            sent.add(key);
            if (sent.size > 5000) sent.clear();
            const stamp = new Date(watchedAt).toISOString();
            if (item.type === 'movie') {
                movies.push({ ids: { imdb: item._id }, watched_at: stamp });
            } else if (item.type === 'series') {
                const [, season, episode] = String(state.video_id).split(':').map(Number);
                if (!Number.isInteger(season) || !Number.isInteger(episode)) continue;
                const seasons = shows.get(item._id) || new Map();
                seasons.set(season, [...(seasons.get(season) || []), { number: episode, watched_at: stamp }]);
                shows.set(item._id, seasons);
            }
        }
        if (!movies.length && !shows.size) return;
        const token = await accessToken(userId);
        if (!token) return;
        await call('/sync/history', {
            method: 'POST',
            token,
            body: {
                movies,
                shows: [...shows].map(([imdb, seasons]) => ({ ids: { imdb }, seasons: [...seasons].map(([number, episodes]) => ({ number, episodes })) }))
            }
        }).catch((e) => console.error('Trakt history sync failed:', e.message));
    };

    const router = express.Router();
    router.get('/callback', async (req, res) => {
        res.set({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        const ok = enabled && await finish(req.query.code, req.query.state);
        const name = String(productName() || 'the app').replace(/[&<>"']/g, '');
        res.status(ok ? 200 : 400).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trakt</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0c0b11;color:#f2f2f5;font:16px system-ui,sans-serif;text-align:center"><main style="max-width:360px;padding:16px">
<h1 style="font-size:22px">${ok ? 'Trakt connected' : 'Could not connect Trakt'}</h1><p style="color:#a9a8b3">${ok ? `You can close this window and return to ${name}.` : 'The link expired or was already used. Go back to the app and try again.'}</p></main></body>`);
    });
    // The Trakt add-on (the id in the address is the person's account id, as in the app's own add-on address)
    router.get('/addon/:uid/manifest.json', (req, res) => {
        if (!enabled || !accounts.traktRecord(req.params.uid)) { res.status(404).json({ error: 'not connected' }); return; }
        res.set({ 'access-control-allow-origin': '*', 'cache-control': 'no-store' }).json({
            id: 'org.trakt.integration', version: '1.0.0', name: 'Trakt', description: 'Your Trakt watchlist, recommendations and trending titles.',
            resources: ['catalog'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: CATALOGS, behaviorHints: { configurable: false }
        });
    });
    router.get(['/addon/:uid/catalog/:type/:id.json', '/addon/:uid/catalog/:type/:id/:extra.json'], async (req, res) => {
        res.set({ 'access-control-allow-origin': '*', 'cache-control': 'private, max-age=300' });
        if (!enabled || !accounts.traktRecord(req.params.uid)) { res.status(404).json({ error: 'not connected' }); return; }
        const metas = await catalog(req.params.uid, req.params.type, req.params.id).catch(() => null);
        if (metas === null) { res.status(404).json({ error: 'unknown catalog' }); return; }
        res.json({ metas });
    });

    return { enabled, startUrl, router, onLibraryChange, disconnect, catalog, accessToken };
};

module.exports = { createTrakt, CATALOGS };
