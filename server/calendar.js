'use strict';

// Calendar feed of upcoming episodes (replaces the stock site's /calendar/<id>.ics). A person subscribes to one secret
// address; it lists episodes of the series in their library that air from a few days ago to three months ahead.
// Episode dates come from the Cinemeta add-on (a public service that stays), cached for six hours.

const CACHE_MS = 6 * 60 * 60 * 1000;
const MAX_SERIES = 100;
const DAY = 24 * 60 * 60 * 1000;

const escapeText = (text) => String(text).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Lines longer than 75 characters continue on the next line after a space (RFC 5545)
const fold = (line) => {
    const parts = [];
    let rest = line;
    while (Buffer.byteLength(rest) > 74) {
        let cut = 74;
        while (Buffer.byteLength(rest.slice(0, cut)) > 74) cut -= 1;
        parts.push(rest.slice(0, cut));
        rest = ` ${rest.slice(cut)}`;
    }
    parts.push(rest);
    return parts.join('\r\n');
};
const day = (time) => new Date(time).toISOString().slice(0, 10).replace(/-/g, '');

// series: [{ id, name, videos: [{ id, title, season, episode, released }] }]
const buildCalendar = ({ series, now = Date.now(), productName = 'Upcoming episodes', host = 'localhost' }) => {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${escapeText(productName)}//Upcoming episodes//EN`, 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${escapeText(productName)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT12H'];
    for (const show of series) {
        for (const video of show.videos || []) {
            const time = Date.parse(video.released);
            if (!Number.isFinite(time) || time < now - 3 * DAY || time > now + 90 * DAY) continue;
            const code = Number.isInteger(video.season) && Number.isInteger(video.episode) ? `S${String(video.season).padStart(2, '0')}E${String(video.episode).padStart(2, '0')}` : '';
            lines.push(
                'BEGIN:VEVENT',
                `UID:${escapeText(`${show.id}:${video.id}`)}@${host}`,
                `DTSTAMP:${new Date(now).toISOString().replace(/[-:]|\.\d{3}/g, '')}`,
                `DTSTART;VALUE=DATE:${day(time)}`,
                `DTEND;VALUE=DATE:${day(time + DAY)}`,
                `SUMMARY:${escapeText([show.name, code, video.title].filter(Boolean).join(' \u00b7 '))}`,
                'TRANSP:TRANSPARENT',
                'END:VEVENT'
            );
        }
    }
    lines.push('END:VCALENDAR');
    return `${lines.map(fold).join('\r\n')}\r\n`;
};

const createCalendar = ({ seriesFor, metaBase = 'https://v3-cinemeta.strem.io', fetchImpl = fetch, now = Date.now, productName = () => '', host = 'localhost' }) => {
    const metas = new Map(); // series id -> { at, videos }
    const loadVideos = async (id) => {
        const cached = metas.get(id);
        if (cached && now() - cached.at < CACHE_MS) return cached.videos;
        let videos = cached ? cached.videos : [];
        try {
            const response = await fetchImpl(`${metaBase}/meta/series/${encodeURIComponent(id)}.json`, { signal: AbortSignal.timeout(5000) });
            if (response.ok) {
                const body = await response.json();
                videos = ((body.meta && body.meta.videos) || []).map((video) => ({
                    id: String(video.id || ''), title: String(video.title || video.name || ''), season: video.season, episode: video.episode ?? video.number, released: video.released
                }));
            }
        } catch (_e) { /* keep the old copy; a feed with fewer episodes beats an error */ }
        if (metas.size > 2000) metas.clear();
        metas.set(id, { at: now(), videos });
        return videos;
    };
    // Returns the feed text, or null when the token is unknown.
    const feed = async (token) => {
        const library = seriesFor(token);
        if (library === null) return null;
        const wanted = library.filter((item) => item.type === 'series' && !item.removed && typeof item._id === 'string' && /^[\w:.-]{1,60}$/.test(item._id)).slice(0, MAX_SERIES);
        const series = [];
        for (let i = 0; i < wanted.length; i += 5) {
            series.push(...await Promise.all(wanted.slice(i, i + 5).map(async (item) => ({ id: item._id, name: item.name, videos: await loadVideos(item._id) }))));
        }
        return buildCalendar({ series, now: now(), productName: productName() || 'Upcoming episodes', host });
    };
    return { feed };
};

module.exports = { buildCalendar, createCalendar, fold };
