'use strict';

// Simulates Stripe telling the server a payment completed, to verify that access is unlocked automatically — without
// a real Stripe account or a real webhook delivery. It signs an event with the SAME webhook secret the server uses
// (STRIPE_WEBHOOK_SECRET env, or the operator Payments page value) and POSTs it to /billing/webhook.
//
// Usage: node tools/simulate-payment.js <userId> [serverUrl] [webhookSecret]
//   userId        the account id (from the operator People page / admin sessions) to grant access to
//   serverUrl     default http://192.168.1.100:8080
//   webhookSecret default whsec_mocksecret1234567890 (must match the server's configured webhook secret)

const Stripe = require('stripe');

const userId = process.argv[2];
const serverUrl = process.argv[3] || 'http://192.168.1.100:8080';
const secret = process.argv[4] || 'whsec_mocksecret1234567890';

if (!userId) {
    console.error('Usage: node tools/simulate-payment.js <userId> [serverUrl] [webhookSecret]');
    process.exit(1);
}

const stripe = new Stripe('sk_test_mockkey1234567890');
const now = Math.floor(Date.now() / 1000);
const event = {
    id: 'evt_mock_' + Date.now(),
    object: 'event',
    type: 'customer.subscription.created',
    created: now,
    data: {
        object: {
            id: 'sub_mock_' + Date.now(),
            customer: 'cus_mock_' + Date.now(),
            status: 'active',
            current_period_end: now + 30 * 24 * 60 * 60,
            metadata: { userId }
        }
    }
};
const payload = JSON.stringify(event);
const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });

fetch(serverUrl + '/billing/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload
}).then(async (response) => {
    console.log('webhook HTTP', response.status, await response.text());
    if (!response.ok) process.exit(1);
}).catch((e) => { console.error(e); process.exit(1); });