// Where the app's legal and help links point. The operator sets them in the panel (Settings > Branding), they arrive in
// window.__BRAND__; until then the stock addresses stay so nothing is a dead link.
type Brand = { serverDownloadUrl?: string, sourceUrl?: string, termsUrl?: string, privacyUrl?: string, supportEmail?: string, ownAccounts?: boolean, trakt?: boolean };
const brand = (): Brand => (window as any).__BRAND__ || {};

// Legal and support addresses: the operator's own. An empty answer means "none set" and the screens leave the link out
// (with own accounts we never show another company's terms, privacy policy or help desk as if they were ours).
const termsUrl = (): string => brand().termsUrl || (brand().ownAccounts ? '' : 'https://www.stremio.com/tos');
const privacyUrl = (): string => brand().privacyUrl || (brand().ownAccounts ? '' : 'https://www.stremio.com/privacy');
const supportUrl = (): string => (brand().supportEmail ? `mailto:${brand().supportEmail}` : brand().ownAccounts ? '' : 'https://stremio.zendesk.com/hc/en-us');
// Where the source code of this build is published (the licence requires offering it): the operator's fork, else upstream
const sourceUrl = (commit: string): string => brand().sourceUrl || `https://github.com/stremio/stremio-web/tree/${commit}`;
// Facebook and Apple sign-in need the stock account service
const socialLoginAvailable = (): boolean => !brand().ownAccounts;

// Own accounts reset passwords on this site's page; otherwise the stock page
const resetPasswordUrl = (email: string): string => (brand().ownAccounts
    ? `${window.location.origin}/account/reset?email=${encodeURIComponent(email)}`
    : `https://www.strem.io/reset-password/${email}`);

// Account settings (data download, deleting the account): our own page with own accounts, the stock page otherwise
const accountSettingsUrl = (): string => (brand().ownAccounts ? `${window.location.origin}/account/manage` : 'https://www.stremio.com/acc-settings');
// With own accounts Trakt is offered only when the operator set up a Trakt API app (our server then runs the link)
const stockServicesAvailable = (): boolean => !brand().ownAccounts || brand().trakt === true;

const ownAccounts = (): boolean => !!brand().ownAccounts;

// "You are leaving" page for links the app does not trust
const warningUrl = (): string => (brand().ownAccounts ? `${window.location.origin}/warning` : 'https://www.stremio.com/warning');
// Where the streaming server app is downloaded: the operator's link, the stock page, or nothing (own accounts, none set)
const serverDownloadUrl = (): string | null => brand().serverDownloadUrl || (brand().ownAccounts ? null : 'https://www.stremio.com/download-service');
const isOwnAddonUrl = (url: string): boolean => url.startsWith(`${window.location.origin}/trakt/addon`) || url.startsWith('https://www.strem.io/trakt/addon');

export { sourceUrl, warningUrl, serverDownloadUrl, isOwnAddonUrl, ownAccounts, accountSettingsUrl, stockServicesAvailable, resetPasswordUrl, termsUrl, privacyUrl, supportUrl, socialLoginAvailable };
