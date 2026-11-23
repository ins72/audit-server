'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { configFor } = require('./announcement');

const NOW = Date.parse('2026-11-21T12:00:00Z');

test('no title means no notification, the rest of the config is still valid', () => {
    const config = configFor({}, NOW);
    assert.deepEqual(config.notifications.items, []);
    assert.equal(config.client.minRefreshSeconds, 300);
});

test('announcement becomes one prompt with the operator text and an optional link', () => {
    const config = configFor({ announcementTitle: 'New season', announcementBody: 'Episodes land Friday', announcementButton: 'See more', announcementLink: 'https://tv.example/news' }, NOW);
    const [item] = config.notifications.items;
    assert.equal(item.template, 'prompt');
    assert.equal(item.content.locales.en.title, 'New season');
    assert.equal(item.content.locales.en.buttons.ok, 'See more');
    assert.deepEqual(item.buttons[0].actions, [{ type: 'openUrl', url: 'https://tv.example/news' }]);
    assert.match(item.id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.ok(Number.isInteger(item.rev) && item.rev >= 1);
});

test('revision follows the text; an ended announcement disappears', () => {
    const a = configFor({ announcementTitle: 'One' }, NOW).notifications.items[0].rev;
    assert.equal(configFor({ announcementTitle: 'One' }, NOW).notifications.items[0].rev, a);
    assert.notEqual(configFor({ announcementTitle: 'Two' }, NOW).notifications.items[0].rev, a);
    assert.equal(configFor({ announcementTitle: 'One', announcementEnds: '2026-11-20' }, NOW).notifications.items.length, 0);
    assert.equal(configFor({ announcementTitle: 'One', announcementEnds: '2026-11-21' }, NOW).notifications.items.length, 1);
    assert.equal(configFor({ announcementTitle: 'One' }, NOW).notifications.items[0].buttons[0].actions.length, 0);
});
