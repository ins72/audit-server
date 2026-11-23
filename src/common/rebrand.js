// Replaces the product name inside translated text, so one operator setting renames the app in all 50+ languages.
// Only the bare word is replaced: web addresses, e-mail addresses, file names and compound words keep "Stremio".
// Plain CommonJS on purpose: the browser bundle and the server tests both load this file.

const NAME = /(?<![\w/.@-])(Stremio|STREMIO)(?![\w-]|\.(?:com|io|zendesk))/g;

const rebrandText = (text, productName) => {
    if (typeof text !== 'string' || !productName) return text;
    return text.replace(NAME, (match) => (match === 'STREMIO' ? productName.toUpperCase() : productName));
};

// resources: { language: { translation: { KEY: 'text' } } } as handed to i18next; returns a new object.
// overrides: { KEY: 'text' } wins in every language over the translation (the operator's own wording).
const rebrandResources = (resources, productName, overrides = {}) => {
    const own = Object.fromEntries(Object.entries(overrides || {}).filter(([, text]) => typeof text === 'string' && text !== ''));
    if (!productName && Object.keys(own).length === 0) return resources;
    return Object.fromEntries(Object.entries(resources).map(([language, value]) => [language, {
        ...value,
        translation: {
            ...Object.fromEntries(Object.entries(value.translation).map(([key, text]) => [key, rebrandText(text, productName)])),
            ...own
        }
    }]));
};

module.exports = { rebrandText, rebrandResources };
