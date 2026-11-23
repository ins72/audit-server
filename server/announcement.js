'use strict';

// The app asks its account service for "remote config" (GET /config): announcements and experiments. We serve one
// operator-written announcement from the settings (title, text, optional button with a link, optional end date) and
// no experiments. Changing the text re-shows it to everyone who dismissed the old one (the revision follows the text).

const crypto = require('crypto');

const configFor = (settings, now = Date.now()) => {
    const title = String(settings.announcementTitle || '').trim();
    const ends = settings.announcementEnds ? Date.parse(`${settings.announcementEnds}T23:59:59Z`) : now + 30 * 24 * 3600 * 1000;
    const base = { client: { minRefreshSeconds: 300 }, experiments: { experiments: [] } };
    if (!title || !Number.isFinite(ends) || ends < now) return { ...base, notifications: { cooldownSeconds: 60, items: [] } };
    const body = String(settings.announcementBody || '').trim();
    const label = String(settings.announcementButton || '').trim() || 'Got it';
    const link = String(settings.announcementLink || '').trim();
    const rev = 1 + (crypto.createHash('sha256').update(JSON.stringify([title, body, label, link])).digest().readUInt32BE(0) % 1000000);
    const buttons = [{ id: 'ok', style: 'primary', actions: link ? [{ type: 'openUrl', url: link }] : [] }];
    return {
        ...base,
        notifications: {
            cooldownSeconds: 60,
            items: [{
                v: 1, id: 'announcement', rev, template: 'prompt', priority: 1, endsAt: new Date(ends).toISOString(), targeting: {}, buttons,
                content: { locales: { en: { title, ...(body ? { body } : {}), buttons: { ok: label } } } }
            }]
        }
    };
};

module.exports = { configFor };
