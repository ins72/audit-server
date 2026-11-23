import React, { createContext, useContext } from 'react';
import { WHITELISTED_HOSTS } from 'stremio/common/CONSTANTS';
import { name, isMobile } from './device';
import useShell from './shell/useShell';
import { ownAccounts, warningUrl } from '../brandLinks';

interface PlatformContext {
    name: string;
    isMobile: boolean;
    shell: Shell;
    openExternal: (url: string) => void;
}

const PlatformContext = createContext<PlatformContext>({} as PlatformContext);

type Props = {
    children: JSX.Element;
};

const PlatformProvider = ({ children }: Props) => {
    const shell = useShell();

    const openExternal = (url: string) => {
        try {
            const { hostname } = new URL(url);
            // With own accounts this site and Trakt (our server's sign-in) are trusted, and the "you are leaving" page is ours
            const own = ownAccounts();
            const trusted = own ? [...WHITELISTED_HOSTS, window.location.hostname, 'trakt.tv'] : WHITELISTED_HOSTS;
            const isWhitelisted = trusted.some((host: string) =>
                hostname === host || hostname.endsWith('.' + host)
            );
            const finalUrl = !isWhitelisted ? `${warningUrl()}#${encodeURIComponent(url)}` : url;

            window.open(finalUrl, '_blank');
        } catch (e) {
            console.error('Failed to parse external url:', e);
        }
    };

    return (
        <PlatformContext.Provider value={{ openExternal, shell, name, isMobile }}>
            {children}
        </PlatformContext.Provider>
    );
};

const usePlatform = () => {
    return useContext(PlatformContext);
};

export {
    PlatformProvider,
    usePlatform
};
