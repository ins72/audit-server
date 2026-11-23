// Plans the operator manages from the dashboard (decision D31, task P1-12).
//
// A plan is a record, not env JSON: id, name, description, price text shown to buyers, shared seats and the Stripe
// price id. Rules that keep existing subscribers safe:
// - the Stripe price id can never change (subscribers are matched to their plan by it): create a new plan instead;
// - plans are archived, never deleted, so old subscriptions still resolve to a plan with the right seat count;
// - at least one plan must stay on offer.
// The PLANS environment variable only seeds an empty store the first time.

const express = require('express');
const { createJsonFile } = require('./jsonFile');

const ID = /^[a-z0-9][\w-]{0,39}$/i;
const PRICE_ID = /^price_[A-Za-z0-9]{3,100}$/;
const str = (value, max, { required = false } = {}) => {
    if (value === undefined || value === null) return required ? null : '';
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length > max || (required && trimmed === '')) return null;
    return trimmed;
};

const createPlans = ({ dataFile = null, seed = null, audit = { record() {} }, createPrice = null, canCreatePrice = null } = {}) => {
    const file = createJsonFile(dataFile, () => ({ plans: [] }));
    if (file.data.plans.length === 0 && Array.isArray(seed) && seed.length > 0) {
        file.data.plans = seed.map((plan) => ({
            id: plan.id, name: plan.name, description: plan.description || '', priceLabel: plan.priceLabel || '',
            priceId: plan.priceId, seats: plan.seats, archived: false
        }));
        file.flush();
    }

    const list = () => file.data.plans.map((plan) => ({ ...plan }));
    const find = (id) => file.data.plans.find((plan) => plan.id === id);
    const activeCount = () => file.data.plans.filter((plan) => !plan.archived).length;

    const persist = (mutate) => {
        const before = JSON.stringify(file.data.plans);
        mutate();
        if (!file.flush()) {
            file.data.plans = JSON.parse(before);
            return { ok: false, error: 'storage_unavailable' };
        }
        return { ok: true };
    };

    // Creates the plan, or edits name/description/priceLabel/seats of an existing one.
    const save = (id, body) => {
        if (typeof id !== 'string' || !ID.test(id)) return { ok: false, error: 'invalid_id' };
        if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_body' };
        const name = str(body.name, 40, { required: true });
        if (name === null) return { ok: false, error: 'invalid_value', key: 'name' };
        const description = str(body.description, 200);
        if (description === null) return { ok: false, error: 'invalid_value', key: 'description' };
        const priceLabel = str(body.priceLabel, 40);
        if (priceLabel === null) return { ok: false, error: 'invalid_value', key: 'priceLabel' };
        if (!Number.isInteger(body.seats) || body.seats < 0 || body.seats > 50) return { ok: false, error: 'invalid_value', key: 'seats' };

        const existing = find(id);
        if (existing) {
            if (body.priceId !== undefined && body.priceId !== existing.priceId) return { ok: false, error: 'price_locked' };
            const result = persist(() => Object.assign(existing, { name, description, priceLabel, seats: body.seats }));
            if (result.ok) audit.record('plan-updated', { id, name, seats: body.seats });
            return result.ok ? { ok: true, plan: { ...existing } } : result;
        }
        if (typeof body.priceId !== 'string' || !PRICE_ID.test(body.priceId)) return { ok: false, error: 'invalid_value', key: 'priceId' };
        if (file.data.plans.some((plan) => plan.priceId === body.priceId)) return { ok: false, error: 'price_in_use' };
        const plan = { id, name, description, priceLabel, priceId: body.priceId, seats: body.seats, archived: false };
        const result = persist(() => file.data.plans.push(plan));
        if (result.ok) audit.record('plan-created', { id, name, seats: body.seats });
        return result.ok ? { ok: true, plan: { ...plan } } : result;
    };

    const setArchived = (id, archived) => {
        const plan = find(id);
        if (!plan) return { ok: false, error: 'not_found' };
        if (archived && !plan.archived && activeCount() <= 1) return { ok: false, error: 'last_active_plan' };
        const result = persist(() => { plan.archived = archived; });
        if (result.ok) audit.record(archived ? 'plan-archived' : 'plan-restored', { id });
        return result.ok ? { ok: true, plan: { ...plan } } : result;
    };

    // Creates a recurring Stripe price from plain inputs (amount in major units, e.g. 9.99) and returns its id plus the
    // label to show buyers. Stripe amounts are in the smallest unit, and how many decimals a currency has comes from Intl.
    const makePrice = async (input) => {
        if (typeof createPrice !== 'function') return { ok: false, error: 'stripe_unavailable' };
        const name = str(input && input.name, 40, { required: true });
        const currency = typeof (input && input.currency) === 'string' ? input.currency.trim().toLowerCase() : '';
        const interval = input && input.interval;
        const amount = Number(input && input.amount);
        if (name === null) return { ok: false, error: 'invalid_value', key: 'name' };
        if (!/^[a-z]{3}$/.test(currency)) return { ok: false, error: 'invalid_value', key: 'currency' };
        if (!['month', 'year'].includes(interval)) return { ok: false, error: 'invalid_value', key: 'interval' };
        let format;
        try { format = new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }); } catch (_e) { return { ok: false, error: 'invalid_value', key: 'currency' }; }
        const digits = format.resolvedOptions().maximumFractionDigits;
        const unitAmount = Math.round(amount * (10 ** digits));
        if (!Number.isFinite(amount) || unitAmount < 1 || amount > 1000000) return { ok: false, error: 'invalid_value', key: 'amount' };
        try {
            const priceId = await createPrice({ name, currency, interval, unitAmount });
            audit.record('plan-price-created', { name, currency, interval, unitAmount, priceId });
            return { ok: true, priceId, priceLabel: `${format.format(amount)} / ${interval}` };
        } catch (e) {
            console.error('Creating the Stripe price failed:', e.message);
            return { ok: false, error: 'stripe_unavailable' };
        }
    };

    const adminRouter = (guard) => {
        const router = express.Router();
        router.use(guard);
        router.use(express.json({ limit: '8kb' }));
        router.use((_req, res, next) => { res.set('cache-control', 'no-store'); next(); });
        const reply = (res, result) => {
            if (result.ok) {
                res.json({ plan: result.plan });
                return;
            }
            const status = { not_found: 404, storage_unavailable: 500, price_locked: 409, price_in_use: 409, last_active_plan: 409 }[result.error] || 400;
            res.status(status).json({ error: result.error, key: result.key });
        };
        router.get('/', (_req, res) => res.json({ plans: list(), canCreatePrice: typeof canCreatePrice === 'function' ? Boolean(canCreatePrice()) : typeof createPrice === 'function' }));
        router.post('/price', async (req, res) => {
            const result = await makePrice(req.body);
            if (result.ok) res.json({ priceId: result.priceId, priceLabel: result.priceLabel });
            else res.status(result.error === 'stripe_unavailable' ? 502 : 400).json({ error: result.error, key: result.key });
        });
        router.put('/:id', (req, res) => reply(res, save(req.params.id, req.body)));
        router.post('/:id/archive', (req, res) => reply(res, setArchived(req.params.id, true)));
        router.post('/:id/restore', (req, res) => reply(res, setArchived(req.params.id, false)));
        return router;
    };

    return { list, save, setArchived, makePrice, adminRouter, flush: file.flush, isHealthy: file.isHealthy };
};

module.exports = { createPlans };
