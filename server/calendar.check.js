'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildCalendar, createCalendar, fold } = require('./calendar');

const NOW = Date.parse('2026-11-21T12:00:00Z');

test('buildCalendar lists episodes in the window only, escaped and all-day', () => {
    const text = buildCalendar({
        now: NOW, host: 'tv.example', productName: 'Acme, TV',
        series: [{ id: 'tt1', name: 'Show; One', videos: [
            { id: 'tt1:1:2', title: 'Next, week', season: 1, episode: 2, released: '2026-11-28T00:00:00Z' },
            { id: 'tt1:1:1', title: 'Long ago', season: 1, episode: 1, released: '2026-01-01T00:00:00Z' },
            { id: 'tt1:9:9', title: 'Far away', season: 9, episode: 9, released: '2027-12-01T00:00:00Z' },
            { id: 'tt1:x', title: 'No date', released: 'soon' }
        ] }]
    });
    assert.match(text, /^BEGIN:VCALENDAR\r\n/);
    assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 1);
    assert.match(text, /DTSTART;VALUE=DATE:20261128/);
    assert.match(text, /SUMMARY:Show\; One \u00b7 S01E02 \u00b7 Next\\, week/);
    assert.match(text, /X-WR-CALNAME:Acme\\, TV/);
    assert.match(text, /UID:tt1:tt1:1:2@tv.example/);
    assert.ok(text.endsWith('END:VCALENDAR\r\n'));
});

test('long lines are folded under 75 bytes', () => {
    const folded = fold(`SUMMARY:${'\u00e9'.repeat(100)}`);
    for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
    assert.equal(folded.split('\r\n').map((line, i) => (i ? line.slice(1) : line)).join(''), `SUMMARY:${'\u00e9'.repeat(100)}`);
});

test('feed reads series from the library, caches Cinemeta, survives it being down', async () => {
    let calls = 0;
    let down = false;
    const videos = [{ id: 'tt1:1:2', name: 'Pilot', season: 1, number: 2, released: '2026-11-25T00:00:00Z' }];
    const cal = createCalendar({
        now: () => NOW,
        seriesFor: (token) => (token === 'good' ? [{ _id: 'tt1', type: 'series', name: 'Show' }, { _id: 'tt2', type: 'movie', name: 'Film' }, { _id: 'tt3', type: 'series', name: 'Gone', removed: true }] : null),
        fetchImpl: async (url) => {
            calls += 1;
            if (down) throw new Error('down');
            assert.match(url, /\/meta\/series\/tt1\.json$/);
            return { ok: true, json: async () => ({ meta: { videos } }) };
        }
    });
    assert.equal(await cal.feed('bad'), null);
    const first = await cal.feed('good');
    assert.match(first, /SUMMARY:Show \u00b7 S01E02 \u00b7 Pilot/);
    assert.ok(!/Film|Gone/.test(first));
    await cal.feed('good');
    assert.equal(calls, 1);
    down = true;
    assert.equal(await createCalendar({ now: () => NOW, seriesFor: () => [{ _id: 'tt9', type: 'series', name: 'X' }], fetchImpl: async () => { throw new Error('down'); } }).feed('t') .then((t) => t.includes('VEVENT')), false);
});
