'use strict';

// Writes believable usage history (growth, returning viewers, a few playback errors) into a statistics file, so a demo
// instance or a screenshot run shows a lively dashboard instead of empty charts. Deterministic: same input, same output.
// Usage from code: seedStats(file, ids, { days: 30, endAt: Date.now() }). Never run against real data.

const { createStats } = require('../../server/stats');

const DAY = 24 * 60 * 60 * 1000;
const TITLES = [
    ['movie', 'tt0111161', 'The Shawshank Redemption'], ['movie', 'tt0068646', 'The Godfather'], ['series', 'tt0944947', 'Game of Thrones'],
    ['series', 'tt0903747', 'Breaking Bad'], ['movie', 'tt1375666', 'Inception'], ['series', 'tt0386676', 'The Office'],
    ['movie', 'tt0133093', 'The Matrix'], ['series', 'tt2861424', 'Rick and Morty']
];
const AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'
];

const rng = (seed) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
};

const seedStats = (file, ids, { days = 30, endAt = Date.now(), seed = 7 } = {}) => {
    const random = rng(seed);
    let clock = endAt - days * DAY;
    const stats = createStats({ dataFile: file, enabled: true, listUsers: () => [], now: () => clock });
    const joined = new Map();
    for (let d = 0; d < days; d += 1) {
        // People join gradually (more towards the end), then return with a probability that fades a little over time.
        ids.forEach((id, index) => {
            if (!joined.has(id) && random() < (index / ids.length) * 0.12 + 0.04 + d / days * 0.1) joined.set(id, d);
        });
        joined.forEach((first, id) => {
            const age = d - first;
            const comes = age === 0 || random() < Math.max(0.25, 0.8 - age * 0.02);
            if (!comes) return;
            clock = endAt - (days - d) * DAY + Math.floor((8 + random() * 14) * 3600 * 1000);
            if (clock > endAt) clock = endAt - 1000;
            const agent = AGENTS[Math.abs(id.length * 7 + id.charCodeAt(id.length - 1)) % AGENTS.length];
            stats.recordActive(id, { login: true, userAgent: agent, language: random() < 0.7 ? 'en-US' : 'de-DE' });
            if (random() < 0.65) {
                const [type, contentId, title] = TITLES[Math.floor(random() * TITLES.length)];
                stats.recordWatch(id, { seconds: 600 + Math.floor(random() * 6000), type, contentId, title, start: true, source: 'torrent', addon: 'streams.demo.example', completed: random() < 0.4 });
                if (random() < 0.06) stats.recordError(id, { code: 'stream_failed', critical: true, type, contentId, source: 'torrent', addon: 'streams.demo.example' });
            }
        });
    }
    clock = endAt;
    stats.flush();
    return joined.size;
};

module.exports = { seedStats };
