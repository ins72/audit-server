// Fetch helpers for this fork's own server (/auth, /billing). Every call has a timeout so a
// hanging server can never leave the UI stuck on a spinner.

const REQUEST_TIMEOUT = 10000;

const apiFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    return fetch(path, { credentials: 'same-origin', ...init, signal: controller.signal })
        .finally(() => clearTimeout(timer));
};

const apiPost = (path: string, body: object = {}): Promise<Response> => apiFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
});

export { apiFetch, apiPost };
