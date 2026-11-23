// Stripe subscription paywall + plans + account sharing by email.
//
// Identity is the Stremio user id/email verified by server/auth.js. A plan has a Stripe price and a number
// of shareable seats. The owner of a subscription can invite that many other emails; when an invited person
// logs in (their email is verified by Stremio, so it cannot be spoofed) they get access for as long as the
// owner's subscription is active. Invited emails are stored in plain text on purpose so they can be read
// from /admin/billing.

const crypto = require('crypto');
const express = require('express');
const { createJsonFile } = require('./jsonFile');
const { createRateLimiter } = require('./security');

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = new Set(['active', 'trialing']);
// Stripe still holds a subscription for these: starting another checkout would bill the user twice.
const BLOCKS_NEW_CHECKOUT = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);
// Worth re-reading from Stripe when the local state may be stale (missed webhook).
const RECONCILE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_STORED_EVENTS = 500;
const MAX_INVITE_EMAILS_PER_DAY = 10;
const CONFIRM_TOKEN_TTL_MS = 7 * DAY_MS;
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const RECONCILE_MAX_PER_RUN = 500;
const RECONCILE_CONCURRENCY = 5;

const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const createBilling = (options) => {
    const {
        stripe,
        enabled = false,
        // Single-plan shorthand: one Stripe price with `maxInvites` shareable seats.
        priceId,
        maxInvites = 2,
        // Multiple plans: [{ id, name, priceId, seats, description?, priceLabel?, archived? }], or a function returning
        // that list so the operator can change plans live (server/plans.js). Overrides priceId/maxInvites.
        // Archived plans are no longer offered but still recognised for existing subscribers.
        plans: plansOption = null,
        webhookSecret,
        publicUrl,
        // Keep access this long after a failed renewal payment while Stripe retries the card.
        pastDueGraceMs = 3 * DAY_MS,
        // Periodically re-read subscriptions from Stripe in case a webhook was missed. 0 disables.
        reconcileIntervalMs = 0,
        now = Date.now,
        // async ({ to, ownerEmail }) => void; optional. When set, invitees are emailed.
        sendInviteEmail = null,
        dataFile = null,
        audit = { record() {} },
        // Let Stripe Tax add VAT/sales tax at checkout (needs Stripe Tax enabled and a tax-code-bearing price/product)
        automaticTax = false,
        // Invited people must open a one-time link emailed to them before the invite grants access: proves they own
        // the address (Stremio may not verify emails). Requires sendInviteEmail.
        confirmInvites = false,
        // Pending invites nobody used within this time stop granting access (0 = never expire).
        inviteExpiryMs = 30 * DAY_MS,
        // async ({ to, kind: 'removed' | 'lapsed' | 'transferred', ownerEmail }) => void; optional courtesy emails.
        sendNotice = null,
        // Dev/test only: (user, plan) => checkout URL. When set, checkout returns this URL instead of calling Stripe
        // (used with the local mock so "Pay on web" opens a reachable test page that unlocks the account).
        mockCheckout = null,
        requireSession,
        adminGuard
    } = options;

    // Stripe config may be a plain value or a getter (function). Getters let the operator add/change keys at runtime
    // without recreating billing: the Stripe client, the paywall switch and the webhook secret are read live.
    const liveStripe = typeof stripe === 'function' ? stripe : () => stripe;
    const liveEnabled = typeof enabled === 'function' ? enabled : () => enabled;
    const liveWebhookSecret = typeof webhookSecret === 'function' ? webhookSecret : () => webhookSecret;

    const allPlans = () => {
        const list = typeof plansOption === 'function' ? plansOption() : plansOption;
        return Array.isArray(list) && list.length > 0 ? list : [{ id: 'default', name: 'Subscription', priceId, seats: maxInvites }];
    };
    const activePlans = () => allPlans().filter((plan) => !plan.archived);
    const findPlan = (id) => allPlans().find((plan) => plan.id === id);
    const defaultPlan = () => activePlans()[0] || allPlans()[0];

    // The plans actually configured (from the plan store / PLANS), without the single-plan fallback. The paywall is in
    // effect when it is switched on (Stripe env) OR an operator is offering at least one plan: clients read this and
    // show the upgrade dialog to anyone not entitled, without needing Stripe configured just to gate.
    const configuredPlans = () => {
        const list = typeof plansOption === 'function' ? plansOption() : plansOption;
        return Array.isArray(list) ? list.filter((plan) => plan && !plan.archived) : [];
    };
    const gating = () => liveEnabled() || configuredPlans().length > 0;

    const file = createJsonFile(dataFile, () => ({ owners: {}, customers: {}, invites: {}, grants: {}, events: [] }));
    const state = file.data;
    const mutateLimiter = createRateLimiter({ max: 30 });
    const emailLog = new Map(); // ownerId -> timestamps of invite emails sent in the last 24h

    const planOf = (owner) => findPlan(owner?.planId) || defaultPlan();
    const seatsFor = (owner) => planOf(owner).seats;

    const isActive = (owner) => {
        if (!owner) return false;
        if (ACTIVE_STATUSES.has(owner.status)) return true;
        if (owner.status === 'past_due') return now() - (owner.pastDueSince || 0) < pastDueGraceMs;
        return false;
    };
    const invitesOf = (ownerId) => state.invites[ownerId] || [];

    // email -> owner ids that invited it (so a login does not scan every owner)
    const inviteIndex = new Map();
    const rebuildIndex = () => {
        inviteIndex.clear();
        for (const [ownerId, invites] of Object.entries(state.invites)) {
            for (const invite of invites) {
                if (!inviteIndex.has(invite.email)) inviteIndex.set(invite.email, new Set());
                inviteIndex.get(invite.email).add(ownerId);
            }
        }
    };
    rebuildIndex();

    const isExpired = (invite) => inviteExpiryMs > 0 && invite.acceptedAt === null && now() - invite.invitedAt > inviteExpiryMs;

    // The active shared plan this verified user may use through an invitation (first use accepts the invite).
    const findMembership = (user) => {
        const email = normalizeEmail(user.email);
        for (const ownerId of inviteIndex.get(email) || []) {
            const owner = state.owners[ownerId];
            if (!isActive(owner)) continue;
            const invites = invitesOf(ownerId);
            const position = invites.findIndex((item) => item.email === email);
            // After a downgrade only the first `seats` invitees keep access
            if (position === -1 || position >= seatsFor(owner)) continue;
            const invite = invites[position];
            if (confirmInvites && !invite.confirmedAt) continue;
            if (isExpired(invite)) continue;
            if (invite.acceptedAt === null) {
                invite.acceptedAt = now();
                invite.acceptedBy = user.id;
                file.save();
            }
            return { ownerId, owner, invite };
        }
        return null;
    };

    // Courtesy emails; never fail the action they describe.
    const notify = (to, kind, ownerEmail) => {
        if (sendNotice === null) return;
        Promise.resolve().then(() => sendNotice({ to, kind, ownerEmail: ownerEmail || '' }))
            .catch((e) => console.error(`Could not send "${kind}" notice to ${to}:`, e.message));
    };
    // Owners whose plan just stopped being active (their members get told once the change is safely saved).
    const lapsed = [];
    const flushLapses = () => {
        for (const ownerId of lapsed.splice(0)) {
            const owner = state.owners[ownerId];
            invitesOf(ownerId).filter((invite) => invite.acceptedAt !== null).forEach((invite) => notify(invite.email, 'lapsed', owner?.email));
        }
    };

    // What the given verified user is allowed to do right now.
    const entitlementFor = (user) => {
        if (!gating()) {
            return { active: true, role: 'free', paywall: false };
        }
        const email = normalizeEmail(user.email);
        const own = state.owners[user.id];
        if (isActive(own)) {
            // Keep the owner's verified Stremio email on record (shown to members and in /admin/billing)
            if (own.email !== email) {
                own.email = email;
                file.save();
            }
            const plan = planOf(own);
            return {
                active: true,
                role: 'owner',
                paywall: true,
                status: own.status,
                plan: { id: plan.id, name: plan.name },
                currentPeriodEnd: own.currentPeriodEnd || null,
                graceEndsAt: own.status === 'past_due' ? (own.pastDueSince || 0) + pastDueGraceMs : null,
                invites: { used: invitesOf(user.id).length, max: plan.seats }
            };
        }
        if (state.grants[email]) {
            return { active: true, role: 'granted', paywall: true };
        }
        const membership = findMembership(user);
        if (membership !== null) {
            return {
                active: true,
                role: 'member',
                paywall: true,
                sharedBy: membership.owner.email || null,
                memberRole: membership.invite.role || 'member',
                canManageInvites: membership.invite.role === 'manager',
                invites: { used: invitesOf(membership.ownerId).length, max: seatsFor(membership.owner) }
            };
        }
        return { active: false, role: own ? 'owner' : 'none', paywall: true, status: own ? own.status : null };
    };

    // The account that holds the household's shared profile list: the owner's own id for an active owner, the owner's
    // id for a member, or null when there is no household (so the caller keeps its own list). Any member writes the same
    // list, so the whole family's profiles stay in step across devices.
    const householdOwnerId = (user) => {
        if (!user || !user.id) return null;
        if (!gating()) return user.id;
        if (isActive(state.owners[user.id])) return user.id;
        const membership = findMembership(user);
        return membership !== null ? membership.ownerId : null;
    };

    // Guard for server routes that serve paid content.
    const requireEntitlement = (req, res, next) => {
        requireSession(req, res, () => {
            const entitlement = entitlementFor(req.session);
            if (!entitlement.active) {
                res.status(402).json({ error: 'payment_required' });
                return;
            }
            req.entitlement = entitlement;
            next();
        });
    };

    // ---- Stripe state ---------------------------------------------------------------

    const periodEnd = (subscription) => {
        const seconds = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
        return typeof seconds === 'number' ? seconds * 1000 : null;
    };

    // The price on the subscription is authoritative (it follows plan switches made in the Stripe portal);
    // checkout metadata and the previous value are fallbacks.
    const planIdFor = (subscription, existing) => {
        const byPrice = allPlans().find((plan) => plan.priceId === subscription.items?.data?.[0]?.price?.id);
        if (byPrice) return byPrice.id;
        const fromMetadata = subscription.metadata?.planId;
        if (fromMetadata && findPlan(fromMetadata)) return fromMetadata;
        return existing?.planId || defaultPlan().id;
    };

    const applySubscription = (subscription, eventCreated, forcedStatus) => {
        // The customer map is authoritative (it follows ownership transfers); metadata is the first-seen fallback.
        const userId = state.customers[subscription.customer] || subscription.metadata?.userId;
        if (!userId) {
            console.warn(`Stripe subscription ${subscription.id} has no userId metadata, ignoring`);
            return;
        }
        const status = forcedStatus || subscription.status;
        const existing = state.owners[userId];
        // Stripe does not guarantee delivery order: never let an older event overwrite a newer one.
        if (existing && existing.lastEventAt && eventCreated < existing.lastEventAt) return;
        // A second, different subscription must not clobber an active one. Record it so the operator
        // can refund it: this happens when someone pays in two checkout tabs.
        if (existing && existing.subscriptionId && existing.subscriptionId !== subscription.id && isActive(existing)) {
            if (LIVE_STATUSES.has(status)) {
                const duplicates = new Set(existing.duplicateSubscriptions || []);
                duplicates.add(subscription.id);
                existing.duplicateSubscriptions = [...duplicates];
                console.warn(`User ${userId} has a duplicate Stripe subscription ${subscription.id}; refund or cancel it`);
            }
            return;
        }
        const sameSubscription = existing && existing.subscriptionId === subscription.id;
        const wasActive = isActive(existing);
        state.owners[userId] = {
            ...existing,
            customerId: subscription.customer,
            subscriptionId: subscription.id,
            planId: planIdFor(subscription, existing),
            status,
            currentPeriodEnd: periodEnd(subscription),
            pastDueSince: status === 'past_due' ? (sameSubscription && existing.pastDueSince ? existing.pastDueSince : now()) : null,
            lastEventAt: eventCreated,
            updatedAt: now()
        };
        state.customers[subscription.customer] = userId;
        if (wasActive && !isActive(state.owners[userId])) lapsed.push(userId);
    };

    const handleEvent = (event) => {
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                const userId = session.client_reference_id;
                if (session.mode !== 'subscription' || !userId || !session.customer) return;
                const existing = state.owners[userId];
                state.customers[session.customer] = userId;
                const settled = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
                // Provisional record only. It deliberately does not claim an event time: the subscription
                // event (or the reconcile job) that follows is the authority, whatever order they arrive in.
                state.owners[userId] = {
                    ...existing,
                    customerId: session.customer,
                    subscriptionId: existing?.subscriptionId || session.subscription || null,
                    planId: existing?.planId || (findPlan(session.metadata?.planId) ? session.metadata.planId : defaultPlan().id),
                    email: normalizeEmail(session.customer_details?.email) || existing?.email || null,
                    status: existing?.status || (settled ? 'active' : 'incomplete'),
                    updatedAt: now()
                };
                return;
            }
            case 'customer.subscription.created':
            case 'customer.subscription.updated':
                applySubscription(event.data.object, event.created);
                return;
            case 'customer.subscription.deleted':
                applySubscription(event.data.object, event.created, 'canceled');
                return;
            default:
        }
    };

    let lastWebhookAt = null; // health panel only; resets on restart
    const webhook = (req, res) => {
        let event;
        try {
            event = liveStripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'], liveWebhookSecret());
        } catch (_e) {
            res.status(400).json({ error: 'invalid_signature' });
            return;
        }
        if (state.events.includes(event.id)) {
            res.json({ received: true, duplicate: true });
            return;
        }
        const before = JSON.stringify({ owners: state.owners, customers: state.customers });
        const undo = () => Object.assign(state, JSON.parse(before));
        try {
            handleEvent(event);
        } catch (e) {
            undo();
            lapsed.length = 0;
            console.error('Stripe webhook handler failed:', e);
            res.status(500).json({ error: 'handler_failed' }); // Stripe will retry
            return;
        }
        state.events.push(event.id);
        if (state.events.length > MAX_STORED_EVENTS) state.events.splice(0, state.events.length - MAX_STORED_EVENTS);
        // Only acknowledge once the data is on disk: Stripe never resends an event we answered 200 to.
        // On failure, forget the event id so Stripe's retry is processed again.
        if (!file.flush()) {
            state.events.pop();
            undo();
            lapsed.length = 0;
            res.status(500).json({ error: 'storage_unavailable' });
            return;
        }
        flushLapses();
        lastWebhookAt = Date.now();
        res.json({ received: true });
    };

    // Safety net for missed webhooks (downtime, misconfiguration): re-read subscriptions whose
    // billing period has ended (or that never got a subscription event) from Stripe and apply the truth.
    const reconcile = async () => {
        if (!liveEnabled() || !liveStripe()) return;
        const due = Object.entries(state.owners).filter(([, owner]) => owner.subscriptionId && RECONCILE_STATUSES.has(owner.status) &&
            !(owner.currentPeriodEnd && owner.currentPeriodEnd > now()));
        // Bounded work per run (the next run continues), a few Stripe calls at a time to respect its rate limits.
        const batch = due.slice(0, RECONCILE_MAX_PER_RUN);
        const checkOne = async ([userId, owner]) => {
            const stampBefore = owner.lastEventAt;
            try {
                const subscription = await liveStripe().subscriptions.retrieve(owner.subscriptionId);
                // A webhook handled while we waited on Stripe is newer than what we just read: keep it.
                if (state.owners[userId]?.lastEventAt !== stampBefore) return;
                applySubscription({ ...subscription, metadata: { ...subscription.metadata, userId } }, Math.floor(now() / 1000));
            } catch (e) {
                if (e.code === 'resource_missing' || e.statusCode === 404) {
                    if (isActive(owner)) lapsed.push(userId);
                    owner.status = 'canceled';
                    owner.updatedAt = now();
                } else {
                    console.error(`Reconcile failed for ${userId}:`, e.message);
                }
            }
        };
        for (let i = 0; i < batch.length; i += RECONCILE_CONCURRENCY) {
            await Promise.all(batch.slice(i, i + RECONCILE_CONCURRENCY).map(checkOne));
        }
        if (file.flush()) flushLapses(); else lapsed.length = 0;
    };

    if (reconcileIntervalMs > 0) {
        const timer = setInterval(() => {
            reconcile().catch((e) => console.error('Reconcile failed:', e));
        }, reconcileIntervalMs);
        timer.unref();
    }

    // ---- Routes ---------------------------------------------------------------------

    // Creates a Stripe Checkout Session for [user]. Shared by the cookie route and the account-key route
    // (Alder's "Pay on web"), so a payment is always linked to the paying account the same way.
    const startCheckout = async (user, requestedPlanId) => {
        if (!liveEnabled() || !liveStripe()) return { error: 'paywall_disabled' };
        if (entitlementFor(user).active) return { error: 'already_entitled' };
        const own = state.owners[user.id];
        // Stripe still holds a subscription (e.g. a failed payment past the grace period): another checkout
        // would bill twice. The card is fixed in the portal instead.
        if (own?.subscriptionId && BLOCKS_NEW_CHECKOUT.has(own.status)) return { error: 'subscription_exists' };
        const offered = activePlans();
        const plan = requestedPlanId === undefined && offered.length === 1 ? offered[0] : offered.find((candidate) => candidate.id === requestedPlanId);
        if (!plan) return { error: 'invalid_plan' };
        // Dev/test: hand back the local test-checkout page instead of a real Stripe session.
        if (typeof mockCheckout === 'function') return { url: mockCheckout(user, plan) };
        const session = await liveStripe().checkout.sessions.create({
            mode: 'subscription',
            line_items: [{ price: plan.priceId, quantity: 1 }],
            client_reference_id: user.id,
            ...(own?.customerId ? { customer: own.customerId } : { customer_email: user.email }),
            metadata: { userId: user.id, planId: plan.id },
            subscription_data: { metadata: { userId: user.id, planId: plan.id } },
            allow_promotion_codes: true,
            ...(automaticTax ? { automatic_tax: { enabled: true }, billing_address_collection: 'required', customer_update: { address: 'auto', name: 'auto' } } : {}),
            success_url: `${publicUrl}/?checkout=success#/`,
            cancel_url: `${publicUrl}/?checkout=cancelled#/`
        });
        return { url: session.url };
    };

    const router = express.Router();
    router.use(express.json({ limit: '4kb' }));
    router.use((_req, res, next) => {
        res.set('cache-control', 'no-store');
        next();
    });

    // Plans the UI may offer. The Stripe price ids stay on the server.
    router.get('/plans', requireSession, (_req, res) => {
        res.json({
            plans: activePlans().map(({ id, name, description, seats, priceLabel }) => ({ id, name, description: description || '', priceLabel: priceLabel || '', seats }))
        });
    });

    router.post('/checkout', requireSession, mutateLimiter, async (req, res) => {
        try {
            const out = await startCheckout(req.session, req.body?.planId);
            if (out.url) { res.json({ url: out.url }); return; }
            const status = out.error === 'invalid_plan' ? 400 : (out.error === 'paywall_disabled' ? 404 : 409);
            res.status(status).json({ error: out.error });
        } catch (e) {
            console.error('Stripe checkout failed:', e.message);
            res.status(502).json({ error: 'stripe_unavailable' });
        }
    });

    router.post('/portal', requireSession, mutateLimiter, async (req, res) => {
        const own = state.owners[req.session.id];
        if (!liveEnabled() || !own?.customerId) {
            res.status(404).json({ error: 'no_subscription' });
            return;
        }
        try {
            const session = await liveStripe().billingPortal.sessions.create({
                customer: own.customerId,
                return_url: `${publicUrl}/#/settings/subscription`
            });
            res.json({ url: session.url });
        } catch (e) {
            console.error('Stripe portal failed:', e.message);
            res.status(502).json({ error: 'stripe_unavailable' });
        }
    });

    // Dev/test only: record an active subscription for [userId] as if a payment had completed (no Stripe, no card).
    // Used by the local mock checkout page so the full "pay → unlock" flow can be exercised end to end.
    const mockActivate = (userId, planId) => {
        if (typeof userId !== 'string' || !userId) return { ok: false, error: 'invalid_user' };
        const plan = findPlan(planId) || defaultPlan();
        const seconds = Math.floor(now() / 1000);
        applySubscription({
            id: 'sub_mock_' + Date.now(),
            customer: 'cus_mock_' + Date.now(),
            status: 'active',
            current_period_end: seconds + 30 * 24 * 60 * 60,
            metadata: { userId, planId: plan.id }
        }, seconds);
        file.flush();
        return { ok: true, plan: plan.id };
    };

    // The link in the invitation email. No session needed (the invitee may not be logged in on this device):
    // possession of the one-time token proves they own the mailbox. Wrong guesses are rate limited.
    const confirmLimiter = createRateLimiter({ max: 20, countOnlyFailures: true });
    router.get('/confirm', confirmLimiter, (req, res) => {
        const token = typeof req.query.token === 'string' ? req.query.token : '';
        const hash = token.length > 0 && token.length <= 128 ? hashToken(token) : null;
        let found = null;
        if (confirmInvites && hash !== null) {
            for (const invites of Object.values(state.invites)) {
                found = invites.find((invite) => invite.confirmHash === hash) || null;
                if (found) break;
            }
        }
        if (found === null || now() - (found.confirmSentAt || 0) > CONFIRM_TOKEN_TTL_MS) {
            res.status(404).type('text/plain').send('This confirmation link is invalid or has expired. Ask the person who invited you to resend it.');
            return;
        }
        if (!found.confirmedAt) {
            found.confirmedAt = now();
            found.confirmHash = null; // one-time
            if (!file.flush()) {
                found.confirmedAt = null;
                found.confirmHash = hash;
                res.status(500).type('text/plain').send('Could not save the confirmation. Please try the link again.');
                return;
            }
            audit.record('invite-confirmed', { invitee: found.email });
        }
        res.redirect(303, `${publicUrl}/?invite=confirmed#/`);
    });

    // Only an owner whose plan is currently active may manage (or send) invitations.
    const requireOwner = (req, res, next) => {
        const entitlement = liveEnabled() ? entitlementFor(req.session) : null;
        if (entitlement === null || entitlement.role !== 'owner' || !entitlement.active) {
            res.status(403).json({ error: 'owners_only' });
            return;
        }
        req.seats = entitlement.invites.max;
        req.ownerId = req.session.id;
        next();
    };

    // The owner, or a member the owner made a manager, may manage the invitations of the shared plan.
    const requireManager = (req, res, next) => {
        const entitlement = liveEnabled() ? entitlementFor(req.session) : null;
        if (entitlement !== null && entitlement.active && entitlement.role === 'owner') {
            req.ownerId = req.session.id;
            req.ownerEmail = normalizeEmail(req.session.email);
            req.seats = entitlement.invites.max;
            req.isOwner = true;
            next();
            return;
        }
        if (entitlement !== null && entitlement.active && entitlement.role === 'member' && entitlement.canManageInvites) {
            const membership = findMembership(req.session);
            if (membership !== null) {
                req.ownerId = membership.ownerId;
                req.ownerEmail = membership.owner.email || '';
                req.seats = seatsFor(membership.owner);
                req.isOwner = false;
                next();
                return;
            }
        }
        res.status(403).json({ error: 'managers_only' });
    };

    // Persist before answering; if the disk write fails, undo the in-memory change and say so.
    const commit = (res, revert) => {
        if (file.flush()) return true;
        revert();
        rebuildIndex();
        res.status(500).json({ error: 'storage_unavailable' });
        return false;
    };

    const publicInvite = (invite) => ({
        email: invite.email,
        name: invite.name || null,
        color: Number.isFinite(invite.color) ? invite.color : null,
        invitedAt: invite.invitedAt,
        acceptedAt: invite.acceptedAt,
        role: invite.role || 'member',
        expired: isExpired(invite),
        confirmed: confirmInvites ? Boolean(invite.confirmedAt) : null
    });
    const inviteView = (ownerId, seats, isOwner = true) => ({
        max: seats,
        invites: invitesOf(ownerId).map(publicInvite),
        emailEnabled: sendInviteEmail !== null,
        confirmationRequired: confirmInvites,
        you: isOwner ? 'owner' : 'manager',
        expiryDays: inviteExpiryMs > 0 ? Math.round(inviteExpiryMs / DAY_MS) : null
    });
    // Fresh one-time token for an invite (any earlier link stops working). Returns the url to email.
    const issueConfirmation = (invite) => {
        const token = crypto.randomBytes(32).toString('base64url');
        invite.confirmHash = hashToken(token);
        invite.confirmSentAt = now();
        return `${publicUrl}/billing/confirm?token=${token}`;
    };

    // Cap on invite emails per owner per day, so invite/remove loops cannot be used to spam addresses.
    const mayEmail = (ownerId) => {
        const cutoff = now() - DAY_MS;
        const recent = (emailLog.get(ownerId) || []).filter((time) => time > cutoff);
        emailLog.set(ownerId, recent);
        if (recent.length >= MAX_INVITE_EMAILS_PER_DAY) return false;
        recent.push(now());
        return true;
    };

    router.get('/invites', requireSession, requireManager, (req, res) => {
        res.json(inviteView(req.ownerId, req.seats, req.isOwner));
    });

    router.post('/invites', requireSession, mutateLimiter, requireManager, async (req, res) => {
        const email = normalizeEmail(req.body?.email);
        if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
            res.status(400).json({ error: 'invalid_email' });
            return;
        }
        if (email === normalizeEmail(req.session.email) || email === normalizeEmail(req.ownerEmail)) {
            res.status(400).json({ error: 'cannot_invite_self' });
            return;
        }
        const invites = invitesOf(req.ownerId);
        if (invites.some((invite) => invite.email === email)) {
            res.status(409).json({ error: 'already_invited' });
            return;
        }
        if (invites.length >= req.seats) {
            res.status(409).json({ error: 'seat_limit_reached', max: req.seats });
            return;
        }
        const previous = state.invites[req.ownerId];
        // Only the owner can appoint managers
        const role = req.isOwner && req.body?.role === 'manager' ? 'manager' : 'member';
        const invite = { email, invitedAt: now(), acceptedAt: null, acceptedBy: null, role };
        const confirmUrl = confirmInvites ? issueConfirmation(invite) : undefined;
        state.invites[req.ownerId] = [...invites, invite];
        rebuildIndex();
        if (!commit(res, () => {
            if (previous === undefined) delete state.invites[req.ownerId];
            else state.invites[req.ownerId] = previous;
        })) return;
        audit.record('invite', { by: req.session.email, owner: req.ownerEmail, invitee: email });
        // The invite is already saved; a failed email must never undo or fail it.
        let notified = false;
        if (sendInviteEmail !== null && mayEmail(req.ownerId)) {
            try {
                await sendInviteEmail({ to: email, ownerEmail: req.ownerEmail, ...(confirmUrl ? { confirmUrl } : {}) });
                notified = true;
            } catch (e) {
                console.error(`Could not email invite to ${email}:`, e.message);
            }
        }
        res.status(201).json({ ...inviteView(req.ownerId, req.seats, req.isOwner), notified });
    });

    router.post('/invites/remove', requireSession, mutateLimiter, requireManager, (req, res) => {
        const email = normalizeEmail(req.body?.email);
        const invites = invitesOf(req.ownerId);
        if (!invites.some((invite) => invite.email === email)) {
            res.status(404).json({ error: 'not_invited' });
            return;
        }
        const target = invites.find((invite) => invite.email === email);
        if (!req.isOwner && target.role === 'manager') {
            res.status(403).json({ error: 'owners_only' });
            return;
        }
        state.invites[req.ownerId] = invites.filter((invite) => invite.email !== email);
        rebuildIndex();
        if (!commit(res, () => { state.invites[req.ownerId] = invites; })) return;
        audit.record('invite-removed', { by: req.session.email, owner: req.ownerEmail, invitee: email });
        if (target.acceptedAt !== null && mayEmail(req.ownerId)) notify(email, 'removed', req.ownerEmail);
        res.json(inviteView(req.ownerId, req.seats, req.isOwner));
    });

    // Send the invitation email again (only while it is still pending, and within the daily email cap).
    router.post('/invites/resend', requireSession, mutateLimiter, requireManager, async (req, res) => {
        const email = normalizeEmail(req.body?.email);
        const invite = invitesOf(req.ownerId).find((item) => item.email === email);
        if (!invite) {
            res.status(404).json({ error: 'not_invited' });
            return;
        }
        if (invite.acceptedAt !== null) {
            res.status(409).json({ error: 'already_joined' });
            return;
        }
        if (sendInviteEmail === null) {
            res.status(409).json({ error: 'email_disabled' });
            return;
        }
        if (!mayEmail(req.ownerId)) {
            res.status(429).json({ error: 'email_limit_reached' });
            return;
        }
        // A resend also renews the invitation (restarts its expiry) and, when confirmation is on, replaces the link.
        const previousInvite = { invitedAt: invite.invitedAt, confirmHash: invite.confirmHash, confirmSentAt: invite.confirmSentAt };
        invite.invitedAt = now();
        let confirmUrl;
        if (confirmInvites) confirmUrl = issueConfirmation(invite);
        if (!commit(res, () => Object.assign(invite, previousInvite))) return;
        let notified = false;
        try {
            await sendInviteEmail({ to: email, ownerEmail: req.ownerEmail, ...(confirmUrl ? { confirmUrl } : {}) });
            notified = true;
        } catch (e) {
            console.error(`Could not email invite to ${email}:`, e.message);
        }
        audit.record('invite-resent', { by: req.session.email, owner: req.ownerEmail, invitee: email, notified });
        res.json({ ...inviteView(req.ownerId, req.seats, req.isOwner), notified });
    });

    // Owner promotes a member to manager (may invite, remove and resend, but not touch billing or other managers) or demotes.
    router.post('/invites/role', requireSession, mutateLimiter, requireOwner, (req, res) => {
        const email = normalizeEmail(req.body?.email);
        const role = req.body?.role;
        if (role !== 'member' && role !== 'manager') {
            res.status(400).json({ error: 'invalid_role' });
            return;
        }
        const invite = invitesOf(req.ownerId).find((item) => item.email === email);
        if (!invite) {
            res.status(404).json({ error: 'not_invited' });
            return;
        }
        const previous = invite.role;
        invite.role = role;
        if (!commit(res, () => { invite.role = previous; })) return;
        audit.record('member-role', { owner: req.session.email, member: email, role });
        res.json(inviteView(req.ownerId, req.seats));
    });

    // Hand the plan (and its billing relationship) to a member who has joined. The previous owner stays on as a manager.
    router.post('/transfer', requireSession, mutateLimiter, requireOwner, async (req, res) => {
        const email = normalizeEmail(req.body?.email);
        const oldId = req.ownerId;
        const invites = invitesOf(oldId);
        const target = invites.find((invite) => invite.email === email);
        if (!target) {
            res.status(404).json({ error: 'not_invited' });
            return;
        }
        if (target.acceptedAt === null || !target.acceptedBy || target.acceptedBy === oldId) {
            res.status(409).json({ error: 'not_joined' });
            return;
        }
        const newId = target.acceptedBy;
        const targetOwn = state.owners[newId];
        if (targetOwn && (isActive(targetOwn) || LIVE_STATUSES.has(targetOwn.status))) {
            res.status(409).json({ error: 'target_has_plan' });
            return;
        }
        if (invitesOf(newId).length > 0) {
            res.status(409).json({ error: 'target_has_invites' });
            return;
        }
        const snapshot = JSON.stringify({ owners: state.owners, customers: state.customers, invites: state.invites });
        const record = state.owners[oldId];
        const oldEmail = normalizeEmail(req.session.email);
        state.owners[newId] = { ...record, email };
        delete state.owners[oldId];
        if (record.customerId) state.customers[record.customerId] = newId;
        state.invites[newId] = [
            ...invites.filter((invite) => invite.email !== email),
            {
                email: oldEmail,
                invitedAt: now(),
                acceptedAt: now(),
                acceptedBy: oldId,
                role: 'manager',
                ...(confirmInvites ? { confirmedAt: now(), confirmHash: null } : {})
            }
        ];
        delete state.invites[oldId];
        rebuildIndex();
        if (!commit(res, () => Object.assign(state, JSON.parse(snapshot)))) return;
        audit.record('ownership-transferred', { from: oldEmail, to: email });
        notify(email, 'transferred', oldEmail);
        // Best effort: keep Stripe's own metadata in step (our customer map already routes events correctly)
        if (liveStripe() && record.subscriptionId) {
            liveStripe().subscriptions.update(record.subscriptionId, { metadata: { userId: newId } })
                .catch((e) => console.error('Could not update Stripe subscription metadata after transfer:', e.message));
        }
        res.json({ ok: true });
    });

    // A member leaves a plan that was shared with them (removes their own seat from every owner).
    router.post('/leave', requireSession, mutateLimiter, (req, res) => {
        const email = normalizeEmail(req.session.email);
        const holders = [...(inviteIndex.get(email) || [])];
        if (holders.length === 0) {
            res.status(404).json({ error: 'not_a_member' });
            return;
        }
        const previous = Object.fromEntries(holders.map((ownerId) => [ownerId, invitesOf(ownerId)]));
        for (const ownerId of holders) state.invites[ownerId] = invitesOf(ownerId).filter((invite) => invite.email !== email);
        rebuildIndex();
        if (!commit(res, () => Object.assign(state.invites, previous))) return;
        audit.record('member-left', { member: email, owners: holders.length });
        res.json({ ok: true });
    });

    // Plain-text overview for the operator: who pays and who they invited.
    const admin = express.Router();
    admin.use(adminGuard);
    admin.use(express.json({ limit: '4kb' }));

    // Complimentary access for an email (testers, friends, refunds): no Stripe involved, revocable.
    admin.post('/grants', (req, res) => {
        const email = normalizeEmail(req.body?.email);
        const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 200) : '';
        if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
            res.status(400).json({ error: 'invalid_email' });
            return;
        }
        const previous = state.grants[email];
        state.grants[email] = { note, grantedAt: previous?.grantedAt || now() };
        if (!commit(res, () => {
            if (previous === undefined) delete state.grants[email];
            else state.grants[email] = previous;
        })) return;
        audit.record('grant', { email, note });
        res.status(201).json({ email, ...state.grants[email] });
    });

    admin.post('/grants/remove', (req, res) => {
        const email = normalizeEmail(req.body?.email);
        const previous = state.grants[email];
        if (!previous) {
            res.status(404).json({ error: 'not_granted' });
            return;
        }
        delete state.grants[email];
        if (!commit(res, () => { state.grants[email] = previous; })) return;
        audit.record('grant-revoked', { email });
        res.json({ ok: true });
    });

    // Erase everything billing knows about an email: their invitations (as inviter and invitee), comp grant and
    // owner record. Refused while their Stripe subscription is live: cancel it in Stripe first.
    // Operator removes one invitee from an owner's plan (abuse, a mistyped address, a request by email).
    admin.post('/billing/invites/remove', (req, res) => {
        const ownerEmail = normalizeEmail(req.body?.owner);
        const email = normalizeEmail(req.body?.email);
        const ownerId = Object.keys(state.owners).find((userId) => state.owners[userId].email === ownerEmail);
        const invites = ownerId === undefined ? [] : invitesOf(ownerId);
        const target = invites.find((invite) => invite.email === email);
        if (!target) {
            res.status(404).json({ error: 'not_invited' });
            return;
        }
        state.invites[ownerId] = invites.filter((invite) => invite.email !== email);
        rebuildIndex();
        if (!commit(res, () => { state.invites[ownerId] = invites; })) return;
        audit.record('invite-removed-by-operator', { owner: ownerEmail, invitee: email });
        if (target.acceptedAt !== null && mayEmail(ownerId)) notify(email, 'removed', ownerEmail);
        res.json({ ok: true });
    });

    admin.post('/billing/erase', (req, res) => {
        const email = normalizeEmail(req.body?.email);
        if (!email) {
            res.status(400).json({ error: 'invalid_email' });
            return;
        }
        const ownerIds = Object.entries(state.owners)
            .filter(([userId, owner]) => owner.email === email)
            .map(([userId]) => userId);
        if (ownerIds.some((userId) => isActive(state.owners[userId]) || LIVE_STATUSES.has(state.owners[userId].status))) {
            res.status(409).json({ error: 'subscription_live' });
            return;
        }
        const before = JSON.stringify({ owners: state.owners, customers: state.customers, invites: state.invites, grants: state.grants });
        for (const userId of ownerIds) {
            delete state.customers[state.owners[userId].customerId];
            delete state.owners[userId];
            delete state.invites[userId];
        }
        for (const [userId, invites] of Object.entries(state.invites)) {
            state.invites[userId] = invites.filter((invite) => invite.email !== email);
        }
        delete state.grants[email];
        rebuildIndex();
        if (!commit(res, () => { Object.assign(state, JSON.parse(before)); })) return;
        audit.record('erase-billing', { email, owners: ownerIds.length });
        res.json({ ok: true, ownersErased: ownerIds.length });
    });

    // Everything billing stores about one email (data-access requests): owner record, invitations as inviter and invitee, grant.
    const exportEmail = (rawEmail) => {
        const email = normalizeEmail(rawEmail);
        const owners = Object.entries(state.owners)
            .filter(([, owner]) => owner.email === email)
            .map(([userId, owner]) => ({ userId, ...owner, invites: invitesOf(userId).map(({ confirmHash, ...invite }) => invite) }));
        const invitedBy = Object.entries(state.invites)
            .filter(([, invites]) => invites.some((invite) => invite.email === email))
            .map(([ownerId, invites]) => ({ ownerEmail: state.owners[ownerId]?.email || null, invite: (({ confirmHash, ...rest }) => rest)(invites.find((invite) => invite.email === email)) }));
        return { email, owners, invitedBy, grant: state.grants[email] || null };
    };
    admin.get('/billing/export', (req, res) => {
        res.set('cache-control', 'no-store');
        res.json(exportEmail(req.query.email));
    });

    admin.get('/billing', (_req, res) => {
        res.set('cache-control', 'no-store');
        const owners = Object.entries(state.owners).map(([userId, owner]) => ({
            userId,
            email: owner.email || null,
            status: owner.status,
            active: isActive(owner),
            plan: planOf(owner).id,
            seats: seatsFor(owner),
            currentPeriodEnd: owner.currentPeriodEnd || null,
            pastDueSince: owner.pastDueSince || null,
            stripeCustomerId: owner.customerId || null,
            stripeSubscriptionId: owner.subscriptionId || null,
            duplicateSubscriptions: owner.duplicateSubscriptions || [],
            // everything except the one-time confirmation secret
            invites: invitesOf(userId).map(({ confirmHash, ...rest }) => ({ ...rest, confirmed: confirmInvites ? Boolean(rest.confirmedAt) : null }))
        }));
        res.json({
            active: owners.filter((owner) => owner.active).length,
            total: owners.length,
            owners,
            grants: Object.entries(state.grants).map(([email, grant]) => ({ email, ...grant }))
        });
    });

    // ---- Account-key (app) sharing: the same invite graph, driven by an authKey instead of a cookie session ----
    // The native app has no cookie, so these mirror the cookie routes above but take a resolved { id, email } user and
    // answer plain objects ({ ok, ... } / { error }) instead of writing to res. The rules are identical: only an active
    // owner or a member-manager may invite/remove/resend; only the owner may change roles. Plans/seats are unchanged.

    // The manager context for a user (owner, or a member the owner made a manager), or null.
    const managerContext = (user) => {
        const entitlement = entitlementFor(user);
        if (entitlement.active && entitlement.role === 'owner') {
            return { ownerId: user.id, ownerEmail: normalizeEmail(user.email), seats: entitlement.invites.max, isOwner: true };
        }
        if (entitlement.active && entitlement.role === 'member' && entitlement.canManageInvites) {
            const membership = findMembership(user);
            if (membership) {
                return { ownerId: membership.ownerId, ownerEmail: membership.owner.email || '', seats: seatsFor(membership.owner), isOwner: false };
            }
        }
        return null;
    };

    // Persist for a non-req caller; undo the in-memory change and return false if the disk write fails.
    const commitCore = (revert) => {
        if (file.flush()) return true;
        revert();
        rebuildIndex();
        return false;
    };

    // The sharing group for a user: the owner sees the member list and seat usage; a member sees who shared with them.
    // This is the "link as a group" view the app renders — the plan's invite list is the household.
    const householdFor = (user) => {
        const entitlement = entitlementFor(user);
        const base = { role: entitlement.role, active: entitlement.active, paywall: entitlement.paywall, plan: entitlement.plan || null };
        if (entitlement.active && entitlement.role === 'owner') {
            const invites = invitesOf(user.id);
            return {
                ...base, role: 'owner', canManage: true, canManageBilling: true,
                // Seats/used count the owner too, so the UI's "1 of 2 seats" includes the person who pays.
                seats: entitlement.invites.max + 1, used: invites.length + 1,
                inviteeSeats: entitlement.invites.max, invitees: invites.length,
                emailEnabled: sendInviteEmail !== null, confirmationRequired: confirmInvites,
                expiryDays: inviteExpiryMs > 0 ? Math.round(inviteExpiryMs / DAY_MS) : null,
                owner: { name: user.name || null, email: user.email },
                members: invites.map((invite) => ({
                    email: invite.email,
                    name: invite.name || null,
                    color: Number.isFinite(invite.color) ? invite.color : null,
                    role: invite.role || 'member',
                    joined: invite.acceptedAt !== null,
                    expired: isExpired(invite),
                    confirmed: confirmInvites ? Boolean(invite.confirmedAt) : null
                }))
            };
        }
        if (entitlement.active && entitlement.role === 'member') {
            const membership = findMembership(user);
            const memberView = membership ? {
                members: invitesOf(membership.ownerId).map((invite) => ({
                    email: invite.email,
                    name: invite.name || null,
                    color: Number.isFinite(invite.color) ? invite.color : null,
                    role: invite.role || 'member',
                    joined: invite.acceptedAt !== null,
                    expired: isExpired(invite),
                    confirmed: confirmInvites ? Boolean(invite.confirmedAt) : null
                }))
            } : {};
            return {
                ...base, role: 'member', sharedBy: entitlement.sharedBy || null,
                memberRole: entitlement.memberRole || 'member',
                canManage: entitlement.canManageInvites === true, canManageBilling: false,
                seats: entitlement.invites.max + 1, used: entitlement.invites.used + 1,
                inviteeSeats: entitlement.invites.max, invitees: entitlement.invites.used,
                emailEnabled: sendInviteEmail !== null, confirmationRequired: confirmInvites,
                ...memberView
            };
        }
        return { ...base, canManage: false, canManageBilling: false };
    };

    const accountInviteList = (user) => {
        const ctx = managerContext(user);
        if (!ctx) return { error: 'managers_only' };
        return { ok: true, ...inviteView(ctx.ownerId, ctx.seats, ctx.isOwner) };
    };

    const accountInviteCreate = async (user, body = {}) => {
        const ctx = managerContext(user);
        if (!ctx) return { error: 'managers_only' };
        const email = normalizeEmail(body.email);
        if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return { error: 'invalid_email' };
        if (email === normalizeEmail(user.email) || email === normalizeEmail(ctx.ownerEmail)) return { error: 'cannot_invite_self' };
        const invites = invitesOf(ctx.ownerId);
        if (invites.some((invite) => invite.email === email)) return { error: 'already_invited' };
        if (invites.length >= ctx.seats) return { error: 'seat_limit_reached', max: ctx.seats };
        const previous = state.invites[ctx.ownerId];
        // Only the owner can appoint managers.
        const role = ctx.isOwner && body.role === 'manager' ? 'manager' : 'member';
        // Optional display name/colour so the invitee shows as a named profile in the group, not just an email.
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
        const color = Number.isFinite(body.color) ? body.color | 0 : null;
        const invite = { email, invitedAt: now(), acceptedAt: null, acceptedBy: null, role,
            ...(name ? { name } : {}), ...(color !== null ? { color } : {}) };
        const confirmUrl = confirmInvites ? issueConfirmation(invite) : undefined;
        state.invites[ctx.ownerId] = [...invites, invite];
        rebuildIndex();
        if (!commitCore(() => {
            if (previous === undefined) delete state.invites[ctx.ownerId];
            else state.invites[ctx.ownerId] = previous;
        })) return { error: 'storage_unavailable' };
        audit.record('invite', { by: user.email, owner: ctx.ownerEmail, invitee: email });
        let notified = false;
        if (sendInviteEmail !== null && mayEmail(ctx.ownerId)) {
            try {
                await sendInviteEmail({ to: email, ownerEmail: ctx.ownerEmail, ...(confirmUrl ? { confirmUrl } : {}) });
                notified = true;
            } catch (e) {
                console.error(`Could not email invite to ${email}:`, e.message);
            }
        }
        return { ok: true, ...inviteView(ctx.ownerId, ctx.seats, ctx.isOwner), notified };
    };

    const accountInviteRemove = (user, rawEmail) => {
        const ctx = managerContext(user);
        if (!ctx) return { error: 'managers_only' };
        const email = normalizeEmail(rawEmail);
        const invites = invitesOf(ctx.ownerId);
        if (!invites.some((invite) => invite.email === email)) return { error: 'not_invited' };
        const target = invites.find((invite) => invite.email === email);
        if (!ctx.isOwner && target.role === 'manager') return { error: 'owners_only' };
        state.invites[ctx.ownerId] = invites.filter((invite) => invite.email !== email);
        rebuildIndex();
        if (!commitCore(() => { state.invites[ctx.ownerId] = invites; })) return { error: 'storage_unavailable' };
        audit.record('invite-removed', { by: user.email, owner: ctx.ownerEmail, invitee: email });
        if (target.acceptedAt !== null && mayEmail(ctx.ownerId)) notify(email, 'removed', ctx.ownerEmail);
        return { ok: true, ...inviteView(ctx.ownerId, ctx.seats, ctx.isOwner) };
    };

    const accountInviteRole = (user, rawEmail, role) => {
        const ctx = managerContext(user);
        if (!ctx) return { error: 'managers_only' };
        if (!ctx.isOwner) return { error: 'owners_only' };
        if (role !== 'member' && role !== 'manager') return { error: 'invalid_role' };
        const email = normalizeEmail(rawEmail);
        const invite = invitesOf(ctx.ownerId).find((item) => item.email === email);
        if (!invite) return { error: 'not_invited' };
        const previous = invite.role;
        invite.role = role;
        if (!commitCore(() => { invite.role = previous; })) return { error: 'storage_unavailable' };
        audit.record('member-role', { owner: user.email, member: email, role });
        return { ok: true, ...inviteView(ctx.ownerId, ctx.seats, ctx.isOwner) };
    };

    // Rename or recolour an invitee so their tile shows a chosen name/colour (any manager; the row is still keyed by email).
    const accountInviteUpdate = (user, rawEmail, body = {}) => {
        const ctx = managerContext(user);
        if (!ctx) return { error: 'managers_only' };
        const email = normalizeEmail(rawEmail);
        const invite = invitesOf(ctx.ownerId).find((item) => item.email === email);
        if (!invite) return { error: 'not_invited' };
        const previous = { name: invite.name, color: invite.color };
        if (typeof body.name === 'string') {
            const name = body.name.trim().slice(0, 60);
            if (name) invite.name = name; else delete invite.name;
        }
        if (Number.isFinite(body.color)) invite.color = body.color | 0; else if (body.color === null) delete invite.color;
        if (!commitCore(() => {
            if (previous.name === undefined) delete invite.name; else invite.name = previous.name;
            if (previous.color === undefined) delete invite.color; else invite.color = previous.color;
        })) return { error: 'storage_unavailable' };
        audit.record('member-update', { owner: user.email, member: email });
        return { ok: true, ...inviteView(ctx.ownerId, ctx.seats, ctx.isOwner) };
    };

    // Resend a pending invite (renews expiry, replaces the confirmation link). Any manager.
    const accountInviteResend = async (user, rawEmail) => {
        const ctx = managerContext(user);
        if (!ctx) return { error: 'managers_only' };
        const email = normalizeEmail(rawEmail);
        const invite = invitesOf(ctx.ownerId).find((item) => item.email === email);
        if (!invite) return { error: 'not_invited' };
        if (invite.acceptedAt !== null) return { error: 'already_joined' };
        if (sendInviteEmail === null) return { error: 'email_disabled' };
        if (!mayEmail(ctx.ownerId)) return { error: 'email_limit_reached' };
        const previous = { invitedAt: invite.invitedAt, confirmHash: invite.confirmHash, confirmSentAt: invite.confirmSentAt };
        invite.invitedAt = now();
        const confirmUrl = confirmInvites ? issueConfirmation(invite) : undefined;
        if (!commitCore(() => Object.assign(invite, previous))) return { error: 'storage_unavailable' };
        let notified = false;
        try {
            await sendInviteEmail({ to: email, ownerEmail: ctx.ownerEmail, ...(confirmUrl ? { confirmUrl } : {}) });
            notified = true;
        } catch (e) {
            console.error(`Could not email invite to ${email}:`, e.message);
        }
        audit.record('invite-resent', { by: user.email, owner: ctx.ownerEmail, invitee: email, notified });
        return { ok: true, ...inviteView(ctx.ownerId, ctx.seats, ctx.isOwner), notified };
    };

    // Hand the plan to a member who has joined; the previous owner stays on as a manager. Owner only.
    const accountInviteTransfer = (user, rawEmail) => {
        const ctx = managerContext(user);
        if (!ctx || !ctx.isOwner) return { error: 'owners_only' };
        const email = normalizeEmail(rawEmail);
        const oldId = ctx.ownerId;
        const invites = invitesOf(oldId);
        const target = invites.find((invite) => invite.email === email);
        if (!target) return { error: 'not_invited' };
        if (target.acceptedAt === null || !target.acceptedBy || target.acceptedBy === oldId) return { error: 'not_joined' };
        const newId = target.acceptedBy;
        const targetOwn = state.owners[newId];
        if (targetOwn && (isActive(targetOwn) || LIVE_STATUSES.has(targetOwn.status))) return { error: 'target_has_plan' };
        if (invitesOf(newId).length > 0) return { error: 'target_has_invites' };
        const snapshot = JSON.stringify({ owners: state.owners, customers: state.customers, invites: state.invites });
        const record = state.owners[oldId];
        const oldEmail = normalizeEmail(user.email);
        state.owners[newId] = { ...record, email };
        delete state.owners[oldId];
        if (record.customerId) state.customers[record.customerId] = newId;
        state.invites[newId] = [
            ...invites.filter((invite) => invite.email !== email),
            {
                email: oldEmail, invitedAt: now(), acceptedAt: now(), acceptedBy: oldId, role: 'manager',
                ...(confirmInvites ? { confirmedAt: now(), confirmHash: null } : {})
            }
        ];
        delete state.invites[oldId];
        rebuildIndex();
        if (!commitCore(() => Object.assign(state, JSON.parse(snapshot)))) return { error: 'storage_unavailable' };
        audit.record('ownership-transferred', { from: oldEmail, to: email });
        notify(email, 'transferred', oldEmail);
        if (liveStripe() && record.subscriptionId) {
            liveStripe().subscriptions.update(record.subscriptionId, { metadata: { userId: newId } })
                .catch((e) => console.error('Could not update Stripe subscription metadata after transfer:', e.message));
        }
        return { ok: true };
    };

    // A member leaves a plan shared with them (removes their own seat from every owner).
    const accountLeave = (user) => {
        const email = normalizeEmail(user.email);
        const holders = [...(inviteIndex.get(email) || [])];
        if (holders.length === 0) return { error: 'not_a_member' };
        const previous = Object.fromEntries(holders.map((ownerId) => [ownerId, invitesOf(ownerId)]));
        for (const ownerId of holders) state.invites[ownerId] = invitesOf(ownerId).filter((invite) => invite.email !== email);
        rebuildIndex();
        if (!commitCore(() => Object.assign(state.invites, previous))) return { error: 'storage_unavailable' };
        audit.record('member-left', { member: email, owners: holders.length });
        return { ok: true };
    };

    // Plans the UI may offer (price ids stay on the server).
    const publicPlans = () => activePlans().map(({ id, name, description, seats, priceLabel }) => ({ id, name, description: description || '', priceLabel: priceLabel || '', seats }));

    // A payment is linked to the account whose verified identity (user.id/email) owns the Stripe subscription/customer.
    // Clients that authenticate with an account key (no cookie session) resolve the same identity through accounts.lookup,
    // so this reports exactly what /auth/me would: the entitlement for that account, the plans it could buy and where to pay.
    const statusFor = (user) => ({
        paywallEnabled: gating(),
        entitlement: entitlementFor(user),
        household: householdFor(user),
        plans: publicPlans(),
        webUrl: publicUrl || null
    });

    return { router, admin, webhook, lastWebhookAt: () => lastWebhookAt, exportEmail, entitlementFor, requireEntitlement, statusFor, startCheckout, mockActivate, reconcile, flush: file.flush, isHealthy: file.isHealthy, householdFor, householdOwnerId, accountInviteList, accountInviteCreate, accountInviteRemove, accountInviteRole, accountInviteUpdate, accountInviteResend, accountInviteTransfer, accountLeave };
};

module.exports = { createBilling };
