import { useEffect, useState } from 'react';
import { apiFetch } from './serverApi';

// What the operator edits in the dashboard (Settings page) and the server publishes at GET /config/public.
// Every field is optional: when the operator has set nothing the app looks exactly like stock Stremio.
type Branding = {
    productName?: string,
    tagline?: string,
    loginHeadline?: string,
    loginSubtitle?: string,
    supportEmail?: string,
    termsUrl?: string,
    privacyUrl?: string,
};

const KEYS: (keyof Branding)[] = ['productName', 'tagline', 'loginHeadline', 'loginSubtitle', 'supportEmail', 'termsUrl', 'privacyUrl'];

// The server writes the current branding into the page (window.__BRAND__), so the first render already has it.
const fromPage = (): Branding | null => {
    const value = (window as unknown as { __BRAND__?: Branding }).__BRAND__;
    return value && typeof value === 'object' ? value : null;
};

let cached: Branding | null = fromPage();
let pending: Promise<Branding> | null = null;

const load = (): Promise<Branding> => {
    if (cached !== null) return Promise.resolve(cached);
    if (pending === null) {
        pending = apiFetch('/config/public')
            .then((response) => (response.ok ? response.json() : {}))
            .catch(() => ({}))
            .then((data: Record<string, unknown>) => {
                const clean: Branding = {};
                KEYS.forEach((key) => {
                    const value = data?.[key];
                    if (typeof value === 'string' && value !== '') clean[key] = value;
                });
                cached = clean;
                return clean;
            });
    }
    return pending;
};

const useBranding = (): Branding => {
    const [branding, setBranding] = useState<Branding>(cached ?? {});
    useEffect(() => {
        let cancelled = false;
        load().then((value) => {
            if (!cancelled) setBranding(value);
        });
        return () => {
            cancelled = true;
        };
    }, []);
    return branding;
};

export type { Branding };
export default useBranding;
