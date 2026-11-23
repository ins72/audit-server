import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useCore } from 'stremio/core';
import Button from 'stremio/components/Button';
import type { Entitlement } from '../useServerSession';
import { apiFetch, apiPost } from '../serverApi';
import useBranding from '../useBranding';
import styles from '../ServerSessionGate/styles.less';

type Props = {
    entitlement: Entitlement,
    onRefresh: () => Promise<Entitlement | null>,
};

const POLL_INTERVAL = 2000;
const POLL_ATTEMPTS = 15;

const returnedFromCheckout = () => new URLSearchParams(window.location.search).get('checkout') === 'success';

type Plan = { id: string, name: string, description: string, priceLabel: string, seats: number };

// Resolves to the redirect url; 'portal' when Stripe already holds a subscription for this user
// (a failed payment past the grace period): they must fix the card there instead of paying twice.
const postForUrl = async (path: string, body: object = {}): Promise<string | 'portal' | null> => {
    const response = await apiPost(path, body);
    const data = await response.json().catch(() => ({}));
    if (response.status === 409 && data.error === 'subscription_exists') return 'portal';
    if (!response.ok) return null;
    return typeof data.url === 'string' ? data.url : null;
};

// Shown instead of the app when the user is logged in but has no active subscription.
const PaywallScreen = ({ entitlement, onRefresh }: Props) => {
    const core = useCore();
    const [confirming, setConfirming] = useState(returnedFromCheckout);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const lockRef = useRef(false);
    const [plans, setPlans] = useState<Plan[]>([]);
    const branding = useBranding();

    useEffect(() => {
        let cancelled = false;
        apiFetch('/billing/plans')
            .then((response) => response.ok ? response.json() : null)
            .then((data) => {
                if (!cancelled && Array.isArray(data?.plans)) setPlans(data.plans);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, []);

    // Stripe redirects back before its webhook has necessarily reached the server: poll for a while.
    useEffect(() => {
        if (!confirming) return;
        let cancelled = false;
        let attempts = 0;
        let inFlight = false;
        const tick = async () => {
            if (inFlight) return; // a slow request must not stack up or distort the attempt count
            inFlight = true;
            attempts += 1;
            try {
                const fresh = await onRefresh();
                if (cancelled) return;
                if (fresh?.active) {
                    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
                } else if (attempts >= POLL_ATTEMPTS) {
                    setConfirming(false);
                    setError('We have not received your payment confirmation yet. If you were charged, it will unlock shortly. Try again in a minute.');
                }
            } finally {
                inFlight = false;
            }
        };
        const timer = setInterval(tick, POLL_INTERVAL);
        tick();
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [confirming]);

    const redirectTo = useCallback(async (path: string, failure: string, body: object = {}) => {
        if (lockRef.current) return;
        lockRef.current = true;
        setBusy(true);
        setError(null);
        try {
            let url = await postForUrl(path, body);
            if (url === 'portal') url = await postForUrl('/billing/portal');
            if (url === null || url === 'portal') throw new Error('no url');
            window.location.assign(url);
        } catch (_e) {
            setError(failure);
            lockRef.current = false;
            setBusy(false);
        }
    }, []);

    const onSubscribe = useCallback((planId?: string) => {
        return redirectTo('/billing/checkout', 'Could not start checkout. Please try again.', planId === undefined ? {} : { planId });
    }, []);
    const onManage = useCallback(() => redirectTo('/billing/portal', 'Could not open billing. Please try again.'), []);
    const onLogout = useCallback(() => {
        core.transport.dispatch({ action: 'Ctx', args: { action: 'Logout' } });
    }, []);

    const lapsed = entitlement.role === 'owner';

    return (
        <div className={styles['gate-container']}>
            {branding.productName ? <div className={styles['brand']}>{branding.productName}</div> : null}
            <div className={styles['title']}>
                {confirming ? 'Confirming your payment…' : lapsed ? 'Your subscription is not active' : 'A subscription is required'}
            </div>
            {branding.tagline && !confirming ? <div className={styles['message']}>{branding.tagline}</div> : null}
            {
                confirming ?
                    null
                    :
                    <React.Fragment>
                        <div className={styles['message']}>
                            {
                                lapsed ?
                                    `Your subscription status is "${entitlement.status ?? 'inactive'}". Renew it to keep watching, and to restore access for anyone you invited.`
                                    :
                                    'Subscribe to unlock the app. You can also be invited to someone else\'s plan: ask them to invite the email address of your account.'
                            }
                        </div>
                        {error !== null ? <div className={styles['message']}>{error}</div> : null}
                        <div className={styles['buttons-container']}>
                            {
                                plans.length > 1 ?
                                    plans.map((plan) => (
                                        <Button
                                            key={plan.id}
                                            className={styles['button-container']}
                                            title={plan.description || plan.name}
                                            disabled={busy}
                                            onClick={() => onSubscribe(plan.id)}
                                        >
                                            <div className={styles['label']}>
                                                {plan.name}{plan.priceLabel ? ` \u2022 ${plan.priceLabel}` : ''}{plan.seats > 0 ? ` (+${plan.seats} shared)` : ''}
                                                {plan.description ? <div className={styles['description']}>{plan.description}</div> : null}
                                            </div>
                                        </Button>
                                    ))
                                    :
                                    <Button className={styles['button-container']} title={'Subscribe'} disabled={busy} onClick={() => onSubscribe(plans[0]?.id)}>
                                        <div className={styles['label']}>{lapsed ? 'Renew subscription' : 'Subscribe'}</div>
                                    </Button>
                            }
                            {
                                lapsed ?
                                    <Button className={styles['button-container']} title={'Manage billing'} disabled={busy} onClick={onManage}>
                                        <div className={styles['label']}>Manage billing</div>
                                    </Button>
                                    :
                                    null
                            }
                            <Button className={styles['button-container']} title={'Log out'} onClick={onLogout}>
                                <div className={styles['label']}>Log out</div>
                            </Button>
                        </div>
                        {
                            branding.termsUrl || branding.privacyUrl ?
                                <div className={styles['legal']}>
                                    {branding.termsUrl ? <a href={branding.termsUrl} target={'_blank'} rel={'noreferrer noopener'}>Terms</a> : null}
                                    {branding.termsUrl && branding.privacyUrl ? ' \u2022 ' : null}
                                    {branding.privacyUrl ? <a href={branding.privacyUrl} target={'_blank'} rel={'noreferrer noopener'}>Privacy</a> : null}
                                </div>
                                :
                                null
                        }
                    </React.Fragment>
            }
        </div>
    );
};

export default PaywallScreen;
