// Copyright (C) 2017-2025 Smart code 203358507

import React from 'react';
import { flushSync } from 'react-dom';
import { Routes as RRoutes, Route as RRoute, useLocation, useNavigate, useNavigationType, matchPath } from 'react-router';
import type { Location } from 'react-router';
import { useProfile } from 'stremio/common';
import { supportsViewTransitions } from 'stremio/common/Platform/device';
import routerPaths from './routerPaths';
import Route from './Route';
import ServerSessionGate from './ServerSessionGate';
import PaywallScreen from './PaywallScreen';
import useServerSession from './useServerSession';
import useBranding from './useBranding';

type RouterPath = typeof routerPaths[number];
type CachedView = {
    key: string,
    location: Location,
    route: RouterPath,
};

const VIEW_COUNT = Math.max(...routerPaths.map((route) => route.view)) + 1;

const getRouteForLocation = (location: Location) => {
    return routerPaths.find((route) => matchPath({ path: route.path, end: true }, location.pathname));
};

const getNextViews = (currentViews: (CachedView | null)[], location: Location) => {
    const route = getRouteForLocation(location);
    if (!route) {
        return currentViews;
    }

    return Array.from({ length: VIEW_COUNT }, (_, index) => {
        if (index < route.view) {
            return currentViews[index] || null;
        }

        if (index === route.view) {
            return {
                key: `${route.view}:${route.path}`,
                location,
                route,
            };
        }

        return null;
    });
};

const RETURN_PATH_KEY = 'returnPathAfterLogin';

// A logged-out visitor who opens a deep link is sent to the login screen; remember where they were going.
const rememberReturnPath = (path: string) => {
    try {
        sessionStorage.setItem(RETURN_PATH_KEY, path);
    } catch (_e) { /* storage can be unavailable (private mode): the user just lands on the home page */ }
};

const clearReturnPath = () => {
    try {
        sessionStorage.removeItem(RETURN_PATH_KEY);
    } catch (_e) { /* ignore */ }
};

// Returns the remembered in-app path once, and only if it is a plain local path.
const takeReturnPath = (): string | null => {
    try {
        const path = sessionStorage.getItem(RETURN_PATH_KEY);
        sessionStorage.removeItem(RETURN_PATH_KEY);
        return path !== null && path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/intro') ? path : null;
    } catch (_e) {
        return null;
    }
};

const Routes = () => {
    const location = useLocation();
    const navigate = useNavigate();
    const navigationType = useNavigationType();
    const profile = useProfile();
    const previousAuthRef = React.useRef(profile.auth);
    const serverSession = useServerSession(profile);
    const branding = useBranding();
    // The browser tab shows the operator's product name once they have set one.
    React.useEffect(() => {
        if (branding.productName) document.title = branding.productName;
    }, [branding.productName]);
    const [views, setViews] = React.useState<(CachedView | null)[]>(() => getNextViews([], location));

    /**
     * Replaced onRouteChange with following useEffect:
     */
    React.useEffect(() => {
        // Handle redirect if user logs out
        const justLoggedOut = previousAuthRef.current !== null && profile.auth === null;
        if (justLoggedOut) {
            previousAuthRef.current = profile.auth;
            clearReturnPath(); // the next person to log in must not inherit this user's last page
            navigate('/intro', { replace: true });
        }

        // Handle redirect if user is logged in on intro screen (back to the link they originally opened, if any)
        if (profile.auth !== null && location.pathname === '/intro') {
            navigate(takeReturnPath() ?? '/', { replace: true });
        }

        // No guest access: anyone who is not logged in only gets the intro (login) screen
        if (profile.auth === null && location.pathname !== '/intro') {
            if (!justLoggedOut) rememberReturnPath(`${location.pathname}${location.search}`);
            navigate('/intro', { replace: true });
        }
        previousAuthRef.current = profile.auth;
    }, [location.pathname, profile.auth]);

    React.useLayoutEffect(() => {
        const updateViews = () => setViews((currentViews) => getNextViews(currentViews, location));

        if (
            navigationType === 'PUSH' &&
            supportsViewTransitions &&
            typeof document.startViewTransition === 'function' &&
            !window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ) {
            document.startViewTransition(() => flushSync(updateViews));
        } else {
            updateViews();
        }
    }, [location, navigationType]);

    const visibleViews = views.filter((view): view is CachedView => view !== null);

    // Nothing but the login screen renders until the server has confirmed the logged-in user
    if (profile.auth === null && location.pathname !== '/intro') {
        return null;
    }

    if (profile.auth !== null && serverSession.status !== 'verified') {
        return <ServerSessionGate status={serverSession.status} onRetry={serverSession.retry} support={serverSession.support} />;
    }

    // Logged in and verified, but the server did not report an entitlement: fail closed
    if (profile.auth !== null && serverSession.entitlement === null) {
        return <ServerSessionGate status={'error'} onRetry={serverSession.retry} />;
    }

    // Logged in but no active subscription (and not invited to one): paywall instead of the app
    if (profile.auth !== null && serverSession.entitlement !== null && !serverSession.entitlement.active) {
        return <PaywallScreen entitlement={serverSession.entitlement} onRefresh={serverSession.refresh} />;
    }

    return (
        <div className={'routes-container'}>
            {
                visibleViews.map((view, index) => (
                    <RRoutes key={view.key} location={view.location}>
                        <RRoute
                            path={view.route.path}
                            element={<Route component={view.route.element} focused={index === visibleViews.length - 1} />}
                        />
                    </RRoutes>
                ))
            }
        </div>
    );
};

export default Routes;
