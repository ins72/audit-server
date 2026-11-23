// Runs first inside the core's web worker. When the worker was started with ?api=own, calls the core makes to
// the stock account service (https://api.strem.io/api/<name>) go to this site's own /api/<name> instead.
// Everything else (Cinemeta, other add-ons, images) is left alone.
(function redirectApi() {
    if (!/[?&]api=own(&|$)/.test(self.location.search)) return;
    // The account API, and the Trakt add-on the core installs from the stock site
    // Each stock service the core calls and where it lives on this site: the account API, the Trakt add-on and the ratings service
    const rules = [
        [/^https:\/\/api\.strem\.io\//i, '/'],
        [/^https:\/\/www\.strem\.io(?=\/trakt\/addon\/)\//i, '/'],
        [/^https:\/\/likes\.stremio\.com\//i, '/likes/'],
        // QR / code sign-in service (the core has it built in, other apps use it): same paths on our site
        [/^https:\/\/link\.stremio\.com\//i, '/']
    ];
    const rewrite = (url) => {
        for (const [pattern, prefix] of rules) {
            if (pattern.test(url)) return url.replace(pattern, `${self.location.origin}${prefix}`);
        }
        return null;
    };
    const original = self.fetch.bind(self);
    self.fetch = function(input, init) {
        const textTarget = typeof input === 'string' ? rewrite(input) : null;
        if (textTarget) return original(textTarget, init);
        const requestTarget = input && typeof input.url === 'string' ? rewrite(input.url) : null;
        if (requestTarget) {
            // The core hands over a Request object: rebuild it for our address (its body is plain JSON text)
            const target = requestTarget;
            const hasBody = input.method !== 'GET' && input.method !== 'HEAD';
            return (hasBody ? input.text() : Promise.resolve(undefined)).then((body) => original(target, {
                method: input.method, headers: input.headers, body, signal: input.signal, ...init
            }));
        }
        return original(input, init);
    };
})();
