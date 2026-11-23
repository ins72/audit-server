// Keeps the fork's own server session in step with the Stremio login held by the core.
//
// The core logs in directly against api.strem.io, so the server only learns who the user
// is when we hand it the authKey. The server verifies it with Stremio, starts a signed
// session cookie and discards the key (see server/auth.js). The server also reports the
// user's entitlement (paid / shared member / free) which drives the paywall.
//
// Re-verification after the first success is silent: a network blip or a renewed cookie never
// replaces the app (and a playing video) with a spinner.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, apiPost } from './serverApi';

type ServerSessionStatus = 'logged-out' | 'checking' | 'verified' | 'error' | 'rejected' | 'blocked' | 'replaced';

type Entitlement = {
    active: boolean,
    plan?: { id: string, name: string },
    role: 'free' | 'owner' | 'member' | 'granted' | 'none',
    paywall: boolean,
    status?: string | null,
    currentPeriodEnd?: number | null,
    graceEndsAt?: number | null,
    sharedBy?: string | null,
    memberRole?: 'member' | 'manager',
    canManageInvites?: boolean,
    invites?: { used: number, max: number },
};

const HEARTBEAT_INTERVAL = 2 * 60 * 1000;
const MIN_REFRESH_GAP = 30 * 1000;
const MAX_AUTO_RETRIES = 5;

const useServerSession = (profile: Profile) => {
    const authKey = profile.auth?.key ?? null;
    const [status, setStatus] = useState<ServerSessionStatus>(authKey === null ? 'logged-out' : 'checking');
    const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [support, setSupport] = useState<string | null>(null);
    const verifiedKeyRef = useRef<string | null>(null);
    const lastRefreshRef = useRef(0);

    const retry = useCallback(() => setAttempt((value) => value + 1), []);

    // Re-reads the entitlement (e.g. after returning from Stripe Checkout). Resolves to the fresh value,
    // or null when it could not be read (the previous state is kept).
    const refresh = useCallback(async (): Promise<Entitlement | null> => {
        lastRefreshRef.current = Date.now();
        try {
            const response = await apiFetch('/auth/me');
            if (response.status === 401) {
                const body = await response.json().catch(() => ({}));
                if (body.error === 'session_replaced') {
                    // Signed out by a newer login on another device (device limit). Do not log straight back in:
                    // two devices would keep signing each other out. The user decides.
                    verifiedKeyRef.current = null;
                    setStatus('replaced');
                    return null;
                }
                retry(); // cookie expired: silently present the Stremio key again
                return null;
            }
            if (!response.ok) return null;
            const data = await response.json();
            setEntitlement(data.entitlement ?? null);
            return data.entitlement ?? null;
        } catch (_e) {
            return null;
        }
    }, [retry]);

    useEffect(() => {
        if (authKey === null) {
            verifiedKeyRef.current = null;
            setStatus('logged-out');
            setEntitlement(null);
            // Clears the cookie and marks the user offline; harmless when there was no session.
            apiPost('/auth/logout').catch(() => undefined);
            return;
        }

        const silent = verifiedKeyRef.current === authKey;
        let cancelled = false;
        if (!silent) setStatus('checking');

        apiPost('/auth/session', { authKey })
            .then(async (response) => {
                if (cancelled) return;
                if (response.ok) {
                    const data = await response.json();
                    if (cancelled) return;
                    verifiedKeyRef.current = authKey;
                    setEntitlement(data.entitlement ?? null);
                    setStatus('verified');
                } else if (response.status === 403) {
                    // The operator blocked this account: retrying cannot help
                    verifiedKeyRef.current = null;
                    const body = await response.json().catch(() => ({}));
                    setSupport(typeof body.support === 'string' ? body.support : null);
                    if (cancelled) return;
                    setStatus('blocked');
                } else if (response.status === 401) {
                    // Stremio itself rejected this key. Do not log out automatically: the user decides.
                    verifiedKeyRef.current = null;
                    setStatus('rejected');
                } else if (!silent) {
                    setStatus('error');
                }
            })
            .catch(() => {
                if (!cancelled && !silent) setStatus('error');
            });

        return () => {
            cancelled = true;
        };
    }, [authKey, attempt]);

    // A busy or restarting server answers 502/timeout: retry quietly with jittered backoff before
    // asking the user to press the button, so a server restart does not need every user to react.
    const autoRetriesRef = useRef(0);
    useEffect(() => {
        if (status === 'verified') {
            autoRetriesRef.current = 0;
            return;
        }
        if (status !== 'error' || autoRetriesRef.current >= MAX_AUTO_RETRIES) return;
        const delay = Math.min(30000, 2000 * 2 ** autoRetriesRef.current) * (0.75 + Math.random() * 0.5);
        const timer = setTimeout(() => {
            autoRetriesRef.current += 1;
            retry();
        }, delay);
        return () => clearTimeout(timer);
    }, [status, attempt, retry]);

    // Heartbeat: lets the server show the user as online, renews the cookie and picks up
    // entitlement changes (subscription lapsed, invite removed, ...).
    useEffect(() => {
        if (status !== 'verified') return;
        // Jittered so thousands of clients reconnecting after a server restart do not beat in lockstep,
        // and skipped while the tab is hidden (the visibility handler below refreshes on return).
        let timer: ReturnType<typeof setTimeout>;
        const schedule = () => {
            timer = setTimeout(() => {
                if (document.visibilityState === 'visible') refresh();
                schedule();
            }, HEARTBEAT_INTERVAL * (0.8 + Math.random() * 0.4));
        };
        schedule();
        const onVisible = () => {
            if (document.visibilityState === 'visible' && Date.now() - lastRefreshRef.current > MIN_REFRESH_GAP) {
                refresh();
            }
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [status, refresh]);

    // Tidy one-shot return flags (Stripe checkout, invite confirmation link) from the address bar.
    // The checkout flag stays while the paywall is still polling for the payment to land.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const tidy = (params.has('checkout') && entitlement?.active === true) || (params.has('invite') && status === 'verified');
        if (tidy) {
            window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
        }
    }, [entitlement, status]);

    return { status, entitlement, retry, refresh, support };
};

export type { ServerSessionStatus, Entitlement };
export default useServerSession;
