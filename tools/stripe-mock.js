'use strict';

// A tiny local stand-in for the Stripe API, for testing the payment flow without a real Stripe account.
//
// The server already supports STRIPE_MOCK_URL (it points the Stripe SDK's host/port/protocol here). This answers the
// two create calls the server makes — Checkout Sessions and Prices — with the minimal JSON the SDK needs, so
// "Pay on web" gets a (fake) checkout URL instead of "payments not available". It does NOT process cards or send
// webhooks; to verify that a completed payment unlocks an account, POST a signed event to /billing/webhook (see
// tools/stripe-mock.js usage in the README note / billing-link.check.js).

const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 12111);
const CHECKOUT_URL = process.env.MOCK_CHECKOUT_URL || `http://127.0.0.1:${PORT}/mock-checkout`;

const readBody = (req) => new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
});

const send = (res, obj, status = 200) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'stripe-version': '2024-06-20' });
    res.end(body);
};

const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && (url === '/healthz' || url === '/')) return send(res, { ok: true, mock: 'stripe' });
    // A fake hosted-checkout page so the flow can be followed end to end in a browser.
    if (req.method === 'GET' && url === '/mock-checkout') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><meta charset=utf-8><title>Mock Stripe Checkout</title>' +
            '<body style="font-family:sans-serif;padding:2rem"><h1>Mock Stripe Checkout</h1>' +
            '<p>This is a local test double — no real payment is taken.</p>' +
            '<p>In production this is Stripe\'s hosted checkout page. A completed payment calls your webhook, which ' +
            'unlocks the account.</p></body>');
        return;
    }

    if (req.method === 'POST') {
        await readBody(req); // consume the form body the SDK sends; the mock does not need it

        // POST /v1/checkout/sessions -> a Checkout Session the SDK reads .url from
        if (url === '/v1/checkout/sessions') {
            return send(res, {
                id: 'cs_test_mock_' + Date.now(),
                object: 'checkout.session',
                url: CHECKOUT_URL,
                payment_status: 'unpaid',
                mode: 'subscription'
            });
        }
        // POST /v1/prices -> a Price the server reads .id from
        if (url === '/v1/prices') {
            return send(res, { id: 'price_mock_' + Date.now(), object: 'price', active: true, currency: 'usd', unit_amount: 999 });
        }
        // POST /v1/billing_portal/sessions (not used by the mobile flow, but harmless to support)
        if (url === '/v1/billing_portal/sessions' || url === '/v1/billing_portal/sessions/') {
            return send(res, { id: 'bps_mock', url: CHECKOUT_URL });
        }
        // Any other create: echo a generic object so the SDK does not error
        return send(res, { id: 'obj_mock_' + Date.now(), object: 'mock' });
    }

    // GET for subscription listing (reconcile) — return an empty list so reconcile no-ops.
    if (req.method === 'GET' && url.startsWith('/v1/subscriptions')) {
        return send(res, { object: 'list', data: [], has_more: false });
    }

    send(res, { error: { message: 'Unhandled mock route: ' + req.method + ' ' + url } }, 404);
});

server.listen(PORT, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(`stripe-mock listening on http://127.0.0.1:${PORT} (checkout -> ${CHECKOUT_URL})`);
});