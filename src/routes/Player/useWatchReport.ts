// Reports how people actually watch to this fork's server (POST /auth/activity), for the operator's
// usage statistics. It counts wall-clock seconds while the video is playing (visible tab, not paused),
// sends a batch about once a minute and when leaving the player, and reports finished videos and
// playback errors as they happen. Fire-and-forget: a failed report is dropped and never affects playback.
//
// What is sent: title, content type + id, how long, the kind of stream (torrent/http/...), the HOSTNAME of the
// add-on that served it (never its path or query: those can carry personal tokens) and error codes.

import { useEffect, useRef } from 'react';
import { apiFetch } from '../../router/serverApi';

const TICK_MS = 5000;
const FLUSH_EVERY_MS = 60000;
const COMPLETED_RATIO = 0.9;

type Playing = { type: string, id: string, title: string } | null;
type VideoEvents = { on: (name: string, listener: (payload?: any) => void) => void, off: (name: string, listener: (payload?: any) => void) => void };

type Options = {
    playing: boolean,
    content: Playing,
    // playback position and length in milliseconds, when known
    position: number | null,
    duration: number | null,
    source: string | null,
    addon: string | null,
    events: VideoEvents | null,
};

const streamKind = (stream: any): string | null => {
    if (stream === null || typeof stream !== 'object') return null;
    if (typeof stream.infoHash === 'string') return 'torrent';
    if (typeof stream.ytId === 'string') return 'youtube';
    if (typeof stream.externalUrl === 'string') return 'external';
    if (typeof stream.url === 'string') return 'http';
    return 'other';
};

const addonHost = (base: unknown): string | null => {
    try {
        return typeof base === 'string' ? new URL(base).hostname : null;
    } catch (_e) {
        return null;
    }
};

const send = (body: object) => {
    apiFetch('/auth/activity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true
    }).catch(() => undefined);
};

const useWatchReport = (options: Options) => {
    const optionsRef = useRef(options);
    optionsRef.current = options;
    const pendingRef = useRef(0);
    const startedRef = useRef<string | null>(null);
    const completedRef = useRef<string | null>(null);

    // Stable id of what is being watched, to detect "same video" across flushes
    const keyOf = (content: Playing) => (content === null ? null : `${content.type}:${content.id}`);

    useEffect(() => {
        const common = () => {
            const { content, source, addon } = optionsRef.current;
            return content === null ? null : { type: content.type, id: content.id, title: content.title, source, addon };
        };

        const flush = (ended = false) => {
            const seconds = Math.round(pendingRef.current);
            const base = common();
            const { content, position, duration } = optionsRef.current;
            if (base === null || content === null) return;
            const key = keyOf(content);
            const reachedEnd = ended || (position !== null && duration !== null && duration > 0 && position / duration >= COMPLETED_RATIO);
            const completed = reachedEnd && completedRef.current !== key;
            if (seconds < 1 && !completed) return;
            pendingRef.current = 0;
            const start = startedRef.current !== key;
            startedRef.current = key;
            if (completed) completedRef.current = key;
            send({ ...base, seconds: Math.max(seconds, 1), start, completed });
        };

        let sinceFlush = 0;
        const timer = setInterval(() => {
            const { playing } = optionsRef.current;
            if (playing && document.visibilityState === 'visible') {
                pendingRef.current += TICK_MS / 1000;
            }
            sinceFlush += TICK_MS;
            if (sinceFlush >= FLUSH_EVERY_MS) {
                sinceFlush = 0;
                flush();
            }
        }, TICK_MS);

        const onHide = () => {
            if (document.visibilityState === 'hidden') flush();
        };
        const onEnded = () => flush(true);
        const onError = (error?: any) => {
            const base = common();
            if (base === null) return;
            send({
                ...base,
                event: 'error',
                code: typeof error?.code === 'number' || typeof error?.code === 'string' ? String(error.code) : 'unknown',
                critical: error?.critical === true
            });
        };

        document.addEventListener('visibilitychange', onHide);
        const events = optionsRef.current.events;
        events?.on('ended', onEnded);
        events?.on('error', onError);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onHide);
            events?.off('ended', onEnded);
            events?.off('error', onError);
            flush();
        };
    }, []);
};

export { streamKind, addonHost };
export default useWatchReport;
