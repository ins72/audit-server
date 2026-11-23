// Operator panel. Everything user-controlled (emails, notes) is inserted with textContent, never as HTML.
(() => {
    const $ = (id) => document.getElementById(id);
    let token = '';
    try { token = sessionStorage.getItem('operatorToken') || ''; } catch (_e) { /* ignore */ }
    $('token').value = token;

    const api = async (path, body, method) => {
        const response = await fetch(path, {
            method: method || (body === undefined ? 'GET' : 'POST'),
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 404 || response.status === 401) throw new Error('Wrong token');
        if (response.status === 429) throw new Error('Too many wrong attempts, wait a minute');
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
    };

    const cell = (row, text) => {
        const td = document.createElement('td');
        td.textContent = text === null || text === undefined ? '' : String(text);
        row.appendChild(td);
        return td;
    };
    const action = (row, label, handler) => {
        const td = document.createElement('td');
        const button = document.createElement('button');
        button.textContent = label;
        button.addEventListener('click', async () => {
            button.disabled = true;
            try { await handler(); await load(); } catch (e) { status(e.message, true); button.disabled = false; }
        });
        td.appendChild(button);
        row.appendChild(td);
    };
    const date = (ms) => ms ? new Date(ms).toLocaleString() : '';
    const status = (text, isError = false) => {
        $('status').textContent = text;
        $('status').className = isError ? 'error' : 'muted';
    };
    const fill = (id, rows) => {
        $(id).replaceChildren(...rows);
    };
    const erase = async (email) => {
        if (!window.confirm(`Erase all stored data for ${email}? Cancel their Stripe subscription first.`)) throw new Error('Cancelled');
        await api('/admin/billing/erase', { email });
        await api('/admin/users/erase', { email });
    };

    // Settings form: one input per field the server describes; empty = use the default. Values go in via .value / textContent only.
    const renderSettings = (config) => {
        // A few fields hold a list or paragraphs (the starting add-ons, an announcement body): a textarea so they
        // can span lines. Everything else stays a single-line input.
        const multiline = new Set(['defaultAddons', 'announcementBody']);
        const rows = Object.entries(config.fields).map(([key, field]) => {
            const row = document.createElement('div');
            row.className = 'row';
            const label = document.createElement('label');
            label.textContent = field.label;
            label.style.minWidth = '9rem';
            const value = config.overridden.includes(key) ? config.settings[key] : '';
            const input = multiline.has(key) ? document.createElement('textarea') : document.createElement('input');
            if (multiline.has(key)) {
                input.rows = 3;
                input.style.cssText = 'flex:1;min-width:14rem;font:inherit;background:#1b1a22;color:inherit;border:1px solid #444;border-radius:6px;padding:.4rem .6rem';
            }
            input.id = `setting-${key}`;
            input.dataset.key = key;
            input.value = value;
            input.placeholder = config.defaults[key] ? `default: ${config.defaults[key]}` : field.hint;
            const hint = document.createElement('span');
            hint.className = 'muted';
            hint.textContent = field.hint;
            row.append(label, input, hint);
            return row;
        });
        const save = document.createElement('button');
        save.textContent = 'Save settings';
        save.addEventListener('click', async () => {
            const patch = {};
            $('settings').querySelectorAll('input, textarea').forEach((input) => { patch[input.dataset.key] = input.value; });
            save.disabled = true;
            try { await api('/admin/settings', patch, 'PUT'); status('Settings saved'); await load(); } catch (e) { status(e.message, true); save.disabled = false; }
        });
        $('settings').replaceChildren(...rows, save);
    };

    // Payments: Stripe keys entered here. Only a masked hint comes back; the server rebuilds Stripe/billing on save.
    const renderPayments = (info) => {
        const stripe = info.stripe || {};
        const webhook = info.webhook || {};
        $('payStripeHint').textContent = stripe.configured ? `set (${stripe.hint}) — leave blank to keep` : 'not set';
        $('payWebhookHint').textContent = webhook.configured ? `set (${webhook.hint}) — leave blank to keep` : 'not set';
    };
    $('paySave').addEventListener('click', async () => {
        const patch = {};
        const secret = $('payStripe').value.trim();
        const webhook = $('payWebhook').value.trim();
        if (secret) patch.stripeSecretKey = secret;
        if (webhook) patch.stripeWebhookSecret = webhook;
        if (!Object.keys(patch).length) { status('Enter a Stripe key or webhook secret to save', true); return; }
        try {
            await api('/admin/payments', patch, 'PUT');
            $('payStripe').value = ''; $('payWebhook').value = '';
            status('Payment keys saved'); await load();
        } catch (e) {
            status(({ invalid_value: 'Check the key format (sk_… / whsec_…)', unknown_key: 'Unknown field', storage_unavailable: 'Could not save the keys' })[e.message] || e.message, true);
        }
    });
    $('payClear').addEventListener('click', async () => {
        if (!window.confirm('Clear the saved Stripe keys? Payments fall back to the environment, if set.')) return;
        try { await api('/admin/payments', { stripeSecretKey: '', stripeWebhookSecret: '' }, 'PUT'); status('Payment keys cleared'); await load(); }
        catch (e) { status(e.message, true); }
    });

    // Plans: edit fills the form; the Stripe price id is locked once a plan exists (the server enforces it too).
    const renderPlans = (plans) => {
        fill('plans', plans.map((plan) => {
            const row = document.createElement('tr');
            cell(row, `${plan.name} (${plan.id})`);
            cell(row, plan.priceLabel);
            cell(row, plan.seats);
            cell(row, plan.priceId);
            cell(row, plan.archived ? 'Archived' : 'On offer');
            action(row, 'Edit', async () => {
                $('planId').value = plan.id; $('planId').disabled = true;
                $('planName').value = plan.name; $('planPrice').value = plan.priceLabel;
                $('planSeats').value = plan.seats; $('planDescription').value = plan.description;
                $('planStripe').value = plan.priceId; $('planStripe').disabled = true;
            });
            action(row, plan.archived ? 'Restore' : 'Archive', () => api(`/admin/plans/${encodeURIComponent(plan.id)}/${plan.archived ? 'restore' : 'archive'}`, {}));
            return row;
        }));
    };
    $('priceCreate').addEventListener('click', async () => {
        const name = $('planName').value.trim();
        if (!name) { status('Fill in the plan name first: it becomes the product name in Stripe', true); return; }
        try {
            const made = await api('/admin/plans/price', { name, amount: $('priceAmount').value, currency: $('priceCurrency').value, interval: $('priceInterval').value });
            if (!$('planStripe').disabled) $('planStripe').value = made.priceId;
            if (!$('planPrice').value.trim()) $('planPrice').value = made.priceLabel;
            status(`Stripe price created (${made.priceId}). Now press Save plan.`);
        } catch (e) {
            status(({ invalid_value: 'Check the amount, currency and name', stripe_unavailable: 'Stripe did not accept that: check the keys and try again' })[e.message] || e.message, true);
        }
    });
    $('planSave').addEventListener('click', async () => {
        const body = { name: $('planName').value, description: $('planDescription').value, priceLabel: $('planPrice').value, seats: Number($('planSeats').value) };
        if (!$('planStripe').disabled) body.priceId = $('planStripe').value.trim();
        try {
            await api(`/admin/plans/${encodeURIComponent($('planId').value.trim())}`, body, 'PUT');
            ['planId', 'planName', 'planPrice', 'planDescription', 'planStripe'].forEach((id) => { $(id).value = ''; $(id).disabled = false; });
            $('planSeats').value = 0;
            status('Plan saved');
            await load();
        } catch (e) {
            const messages = { price_locked: 'The Stripe price cannot be changed: create a new plan', price_in_use: 'That Stripe price belongs to another plan', last_active_plan: 'Keep at least one plan on offer', invalid_id: 'Id: letters, numbers, - or _ only', invalid_value: 'Check the fields' };
            status(messages[e.message] || e.message, true);
        }
    });

    // Pages: one section visible at a time, chosen by the address (#/people), so every page can be bookmarked and the back button works.
    const PAGES = ['overview', 'people', 'subscribers', 'plans', 'payments', 'settings', 'statistics', 'content', 'activity', 'person'];
    let latest = null; // last data loaded, so the person page can be drawn without asking for everything again
    const showPage = (scroll = true) => {
        const match = window.location.hash.match(/^#\/(\w+)(?:\/(.+))?/) || [];
        const current = PAGES.includes(match[1]) ? match[1] : 'overview';
        PAGES.forEach((name) => { $(`page-${name}`).hidden = name !== current; });
        // A person belongs under People in the navigation.
        const navPage = current === 'person' ? 'people' : current;
        document.querySelectorAll('#nav a').forEach((link) => {
            if (link.dataset.nav === navPage) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
        });
        document.title = `${current === 'person' ? 'Person' : `${current.charAt(0).toUpperCase()}${current.slice(1)}`} · Operator`;
        if (scroll === true) window.scrollTo(0, 0);
        if (current === 'person' && match[2]) renderPerson(decodeURIComponent(match[2]));
    };
    const renderPerson = async (email) => {
        $('personTitle').textContent = email;
        if (!token || !latest) { $('personFlags').textContent = 'Load the panel with the operator token first.'; return; }
        const { billing, sessions, log } = latest;
        const lower = email.toLowerCase();
        let detail = null;
        try { detail = (await api(`/admin/stats/user?email=${encodeURIComponent(email)}`)).users[0]; } catch (_e) { /* not found: erased or never signed in */ }
        const row = sessions.users.find((user) => user.email && user.email.toLowerCase() === lower);
        const blocked = sessions.banned.some((entry) => entry.email.toLowerCase() === lower);
        const owner = billing.owners.find((entry) => entry.email && entry.email.toLowerCase() === lower);
        const hostedBy = billing.owners.find((entry) => entry.invites.some((invite) => invite.email.toLowerCase() === lower));
        const grant = billing.grants.find((entry) => entry.email.toLowerCase() === lower);
        $('personFlags').textContent = [row && row.online ? '● online now' : '', blocked ? '⛔ blocked' : '', !detail ? 'No sign-in record' : ''].filter(Boolean).join(' · ');
        const watch = detail && detail.watch;
        const tiles = [
            ['First seen', detail ? date(detail.firstSeen) : '–', ''],
            ['Last seen', detail ? date(detail.lastSeen) : '–', ''],
            ['Sign-ins', detail ? detail.logins : '–', ''],
            ['Hours watched', watch ? Math.round(watch.seconds / 360) / 10 : 0, `${watch ? watch.plays : 0} plays`]
        ];
        $('personTiles').replaceChildren(...tiles.map(([label, value, note]) => {
            const box = document.createElement('div'); box.className = 'tile';
            const big = document.createElement('b'); big.textContent = value;
            if (String(value).length > 12) big.className = 'long';
            const name = document.createElement('div'); name.textContent = label;
            const small = document.createElement('span'); small.textContent = note;
            box.append(big, name, small);
            return box;
        }));
        $('personNote').value = detail && detail.note ? detail.note : '';
        $('personNote').disabled = !detail;
        $('personNoteSave').disabled = !detail;
        $('personNoteSave').onclick = async () => {
            try { await api('/admin/note', { email, note: $('personNote').value }); status('Note saved'); await load(); } catch (e) { status(e.message === 'note_too_long' ? 'Notes can be 500 characters at most' : e.message, true); }
        };
        const access = [];
        if (owner) access.push(`Pays for the ${owner.plan} plan (${owner.status}${owner.active ? '' : ', inactive'}); ${owner.invites.length} of ${owner.seats} shared seats used${owner.currentPeriodEnd ? `; renews or ends ${date(owner.currentPeriodEnd)}` : ''}.`);
        if (hostedBy) access.push(`Invited to ${hostedBy.email}'s ${hostedBy.plan} plan.`);
        if (grant) access.push(`Complimentary access${grant.note ? ` (${grant.note})` : ''}.`);
        $('personAccess').textContent = access.length ? access.join(' ') : 'No plan, invitation or grant.';
        const buttons = [];
        const button = (label, handler) => {
            const el = document.createElement('button');
            el.textContent = label;
            el.addEventListener('click', async () => {
                el.disabled = true;
                try { await handler(); await load(); } catch (e) { status(e.message, true); el.disabled = false; }
            });
            buttons.push(el);
        };
        button('Sign out everywhere', () => api('/admin/signout', { email }));
        button(blocked ? 'Unblock' : 'Block', () => api(blocked ? '/admin/unban' : '/admin/ban', { email }));
        button(grant ? 'Revoke complimentary access' : 'Give complimentary access', () => api(grant ? '/admin/grants/remove' : '/admin/grants', { email }));
        button('Erase all data', async () => { await erase(email); window.location.hash = '#/people'; });
        $('personActions').replaceChildren(...buttons);
        // Own account service: only present when OWN_ACCOUNTS is on (the endpoint answers 404 otherwise)
        $('personAccountBox').hidden = true;
        try {
            const info = await api(`/admin/accounts/info?email=${encodeURIComponent(email)}`);
            $('personAccountBox').hidden = false;
            $('personAccount').textContent = `Registered ${date(info.registered)} · ${info.devices} signed-in device${info.devices === 1 ? '' : 's'} · ${info.libraryItems} library item${info.libraryItems === 1 ? '' : 's'} · ${info.addons === null ? 'standard add-ons' : `${info.addons} add-ons`}${info.resetPending ? ' · password reset link pending' : ''}`;
            const own = [];
            const ownButton = (label, handler, disabled) => {
                const el = document.createElement('button');
                el.textContent = label;
                el.disabled = !!disabled;
                el.addEventListener('click', async () => { el.disabled = true; try { await handler(); } catch (e) { status(e.message, true); } el.disabled = !!disabled; });
                own.push(el);
            };
            ownButton('Send password reset email', async () => {
                const result = await api('/admin/accounts/reset', { email });
                status(result.sent ? 'Reset email sent' : result.reason === 'too_many' ? 'Already sent a few times this hour' : 'Email is not set up (RESEND_API_KEY, MAIL_FROM, PUBLIC_URL)', !result.sent);
            }, !info.mailConfigured);
            ownButton('Sign out their devices', async () => { await api('/admin/accounts/signout', { email }); status('Signed out on our service'); await renderPerson(email); });
            ownButton('Download their data', async () => {
                const response = await fetch(`/admin/accounts/export?email=${encodeURIComponent(email)}`, { headers: { authorization: `Bearer ${token}` } });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const link = document.createElement('a');
                link.href = URL.createObjectURL(await response.blob());
                link.download = `account-data-${email.replace(/[^a-z0-9@.-]/gi, '_')}.json`;
                link.click();
                URL.revokeObjectURL(link.href);
            });
            $('personAccountActions').replaceChildren(...own);
        } catch (_e) { /* not enabled, or no account here */ }
        $('personLogins').textContent = detail && detail.recentLogins.length ? detail.recentLogins.slice(0, 20).map(date).join(' · ') : 'None recorded.';
        fill('personAudit', log.entries.filter((entry) => Object.values(entry).some((value) => typeof value === 'string' && value.toLowerCase() === lower)).slice(0, 30).map((entry) => {
            const tr = document.createElement('tr');
            cell(tr, date(entry.at)); cell(tr, entry.action);
            return tr;
        }));
    };
    window.addEventListener('hashchange', () => showPage(true));
    showPage();

    // Overview: the numbers an operator checks first; each tile opens the page behind it.
    const renderTiles = ({ sessions, billing, stats, healthReport }) => {
        const paying = billing.owners.filter((owner) => owner.active).length;
        const tiles = [
            ['People', sessions.total, 'people', `${sessions.online} online now`],
            ['Active in 7 days', stats.enabled ? stats.totals.activeLast7d : '–', 'statistics', stats.enabled ? `${stats.totals.activationPercent ?? '–'}% have watched` : 'statistics off'],
            ['Subscribers', paying, 'subscribers', `${billing.owners.length} in total`],
            ['Blocked', sessions.banned.length, 'people', 'accounts']
        ];
        $('tiles').replaceChildren(...tiles.map(([label, value, page, note]) => {
            const box = document.createElement('div');
            box.className = 'tile';
            const link = document.createElement('a');
            link.href = `#/${page}`;
            const big = document.createElement('b'); big.textContent = value;
            const name = document.createElement('div'); name.textContent = label;
            const small = document.createElement('span'); small.textContent = note;
            link.append(big, name, small);
            box.appendChild(link);
            return box;
        }));
        const dot = $('dot-overview');
        dot.hidden = false;
        dot.className = `dot ${healthReport.overall === 'ok' ? '' : healthReport.overall}`;
        dot.title = healthReport.overall === 'ok' ? 'All checks pass' : 'Some setup checks need attention';
    };

    // Jump box in the header: type part of an email or a page name; Enter opens the first match; "/" focuses the box.
    const PAGE_NAMES = { overview: 'Overview', people: 'People', subscribers: 'Subscribers', plans: 'Plans', payments: 'Payments', settings: 'Settings', statistics: 'Statistics', content: 'Content and playback', activity: 'Activity' };
    let jumpTimer = null;
    let jumpSeq = 0;
    const closeJump = () => { $('jumpResults').hidden = true; $('jumpResults').replaceChildren(); };
    const runJump = async () => {
        const query = $('jump').value.trim().toLowerCase();
        const seq = (jumpSeq += 1);
        if (!query) { closeJump(); return; }
        const links = Object.entries(PAGE_NAMES).filter(([, name]) => name.toLowerCase().includes(query)).map(([key, name]) => [`#/${key}`, name, 'page']);
        let people = [];
        if (token) {
            try { people = (await api(`/admin/sessions?limit=6&q=${encodeURIComponent(query)}`)).users.filter((user) => user.email).map((user) => [`#/person/${encodeURIComponent(user.email)}`, user.email, 'person']); } catch (_e) { /* ignore: the page list still works */ }
        }
        if (seq !== jumpSeq) return; // a newer keystroke is already running
        const all = [...people, ...links];
        $('jumpResults').replaceChildren(...(all.length ? all : [['', 'No match', '']]).map(([href, label, kind]) => {
            const a = document.createElement('a');
            if (href) a.href = href;
            a.textContent = label;
            if (kind) { const small = document.createElement('small'); small.textContent = kind; a.appendChild(small); }
            a.addEventListener('click', () => { $('jump').value = ''; closeJump(); });
            return a;
        }));
        $('jumpResults').firstChild.classList.add('active');
        $('jumpResults').hidden = false;
    };
    $('jump').addEventListener('input', () => { clearTimeout(jumpTimer); jumpTimer = setTimeout(runJump, 200); });
    $('jump').addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { $('jump').value = ''; closeJump(); $('jump').blur(); }
        if (event.key === 'Enter') {
            const first = $('jumpResults').querySelector('a[href]');
            if (first) { window.location.hash = first.getAttribute('href'); $('jump').value = ''; closeJump(); $('jump').blur(); }
        }
    });
    document.addEventListener('click', (event) => { if (!event.target.closest('.jump')) closeJump(); });
    document.addEventListener('keydown', (event) => {
        if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); $('jump').focus(); }
    });

    const SLOT_IMAGE = { logo: '/images/logo.png', symbol: '/images/stremio_symbol.png', icon: '/images/icon.png' };
    const renderBrand = (data) => {
        $('brand').replaceChildren(...Object.entries(data.slots).map(([slot, info]) => {
            const card = document.createElement('div'); card.className = 'brand-card';
            const title = document.createElement('strong'); title.textContent = info.label;
            const preview = document.createElement('div'); preview.className = 'preview';
            const img = document.createElement('img'); img.alt = info.label; img.src = `${SLOT_IMAGE[slot]}?v=${info.updatedAt || 0}`;
            preview.appendChild(img);
            const hint = document.createElement('span'); hint.className = 'muted'; hint.textContent = info.custom ? `Your image: ${info.width} x ${info.height}, ${Math.round(info.bytes / 1024)} KB. ${info.hint}` : `Standard image. ${info.hint}`;
            const file = document.createElement('input'); file.type = 'file'; file.accept = 'image/png';
            const actions = document.createElement('div'); actions.className = 'row';
            const upload = document.createElement('button'); upload.textContent = 'Upload';
            const reset = document.createElement('button'); reset.textContent = 'Back to standard'; reset.disabled = !info.custom;
            const send = async (method, body) => {
                const response = await fetch(`/admin/brand/${slot}`, { method, headers: body ? { authorization: `Bearer ${token}`, 'content-type': 'image/png' } : { authorization: `Bearer ${token}` }, body });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error({ invalid_image: 'That is not a PNG file', invalid_dimensions: 'The size does not fit this slot (see the hint)', image_too_large: 'The file is over 1 MB' }[result.error] || result.error || `HTTP ${response.status}`);
                renderBrand(result);
            };
            upload.addEventListener('click', async () => {
                if (!file.files[0]) { status('Choose a PNG file first', true); return; }
                try { await send('PUT', await file.files[0].arrayBuffer()); status('Image saved'); } catch (e) { status(e.message, true); }
            });
            reset.addEventListener('click', async () => {
                try { await send('DELETE'); status('Back to the standard image'); } catch (e) { status(e.message, true); }
            });
            actions.append(upload, reset);
            card.append(title, preview, hint, file, actions);
            return card;
        }));
    };

    const PAGE = 100;
    let userOffset = 0;
    const renderUserPage = (sessions) => {
        const from = sessions.matched === 0 ? 0 : sessions.offset + 1;
        const to = Math.min(sessions.offset + sessions.limit, sessions.matched);
        $('userPage').textContent = sessions.matched === 0 ? 'No one matches' : `Showing ${from}-${to} of ${sessions.matched}${sessions.matched === sessions.total ? '' : ` (${sessions.total} in total)`}`;
        $('userPrev').disabled = sessions.offset === 0;
        $('userNext').disabled = sessions.offset + sessions.limit >= sessions.matched;
    };
    let searchTimer = null;
    $('userSearch').addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { userOffset = 0; load(); }, 300);
    });
    $('userPrev').addEventListener('click', () => { userOffset = Math.max(0, userOffset - PAGE); load(); });
    $('userNext').addEventListener('click', () => { userOffset += PAGE; load(); });

    const ICON = { ok: '● OK', warn: '▲ Fix soon', fail: '✖ Fix now', off: '○ Off' };
    const renderHealth = (report) => {
        const c = report.counts;
        $('healthSummary').textContent = `${report.overall === 'ok' ? 'All good' : report.overall === 'warn' ? 'Works, but needs attention' : 'Needs fixing before going live'} · ${c.ok} ok, ${c.warn} to improve, ${c.fail} broken, ${c.off} off · version ${report.system.version} · up ${Math.round(report.system.uptimeSeconds / 60)} min · Node ${report.system.node}`;
        fill('health', report.items.map((item) => {
            const row = document.createElement('tr');
            row.className = `health-${item.status}`;
            cell(row, item.group);
            cell(row, `${item.label}: ${item.detail}`);
            cell(row, ICON[item.status]);
            cell(row, item.status === 'ok' ? '' : item.fix || '');
            return row;
        }));
    };

    const load = async () => {
        status('Loading…');
        try {
            const [sessions, billing, log, stats, config, planList, payments, healthReport, brandStatus] = await Promise.all([api(`/admin/sessions?limit=${PAGE}&offset=${userOffset}&q=${encodeURIComponent($('userSearch').value.trim())}`), api('/admin/billing'), api('/admin/audit'), api('/admin/stats?days=14&fresh=1'), api('/admin/settings'), api('/admin/plans'), api('/admin/payments'), api('/admin/health'), api('/admin/brand')]);
            renderHealth(healthReport);
            renderBrand(brandStatus);
            renderSettings(config);
            renderPayments(payments);
            renderPlans(planList.plans);
            $('priceRow').hidden = !planList.canCreatePrice;
            try { sessionStorage.setItem('operatorToken', token); } catch (_e) { /* ignore */ }
            $('online').textContent = `${sessions.online} online of ${sessions.total} users`;
            renderUserPage(sessions);
            fill('users', sessions.users.map((user) => {
                const row = document.createElement('tr');
                const emailCell = cell(row, '');
                if (user.email) {
                    const link = document.createElement('a');
                    link.href = `#/person/${encodeURIComponent(user.email)}`;
                    link.textContent = user.email;
                    link.style.color = 'inherit';
                    emailCell.appendChild(link);
                } else emailCell.textContent = '(erased)';
                cell(row, `${user.online ? '● ' : ''}${date(user.lastSeen)}`);
                cell(row, user.logins);
                if (user.email) {
                    action(row, 'Sign out', () => api('/admin/signout', { email: user.email }));
                    action(row, 'Block', () => api('/admin/ban', { email: user.email }));
                    action(row, 'Erase', () => erase(user.email));
                } else cell(row, 'erased');
                return row;
            }));
            fill('banned', sessions.banned.map((entry) => {
                const row = document.createElement('tr');
                cell(row, entry.email);
                cell(row, entry.note);
                cell(row, date(entry.at));
                action(row, 'Unblock', () => api('/admin/unban', { email: entry.email }));
                return row;
            }));
            const t = stats.totals;
            const span = (minutes) => (minutes === null ? '–' : minutes >= 120 ? `${Math.round(minutes / 6) / 10} h` : `${minutes} min`);
            const pct = (value) => (value === null || value === undefined ? '–' : `${value}%`);
            const trend = (entry) => (entry[2] === null ? 'new this week' : `${entry[2] > 0 ? '+' : ''}${entry[2]}% vs last week`);
            const statTiles = stats.enabled ? [
                ['Users', t.users, trend(stats.trends.newUsers)],
                ['Active in 7 days', t.activeLast7d, `${t.activeToday} today · ${t.activeLast30d} in 30 days · stickiness ${pct(t.stickinessPercent)}`],
                ['Have watched', pct(t.activationPercent), `${t.everWatched} watched · ${t.neverWatched} never did`],
                ['Hours watched', Math.round(t.hoursWatched * 10) / 10, `${t.avgMinutesPerPlay === null ? '' : `${span(t.avgMinutesPerPlay)} per play · `}${trend(stats.trends.hoursWatched)}`],
                ['Time to first play', span(t.medianMinutesToFirstWatch), 'median, from first sign-in'],
                ['Retention day 1 / 7 / 30', ['day1', 'day7', 'day30'].map((key) => pct(stats.retention[key].percent)).join(' / '), `people who came back · ${pct(t.retention7d)} active in the last 7 days`],
                ['Logins this week', stats.trends.logins[0], trend(stats.trends.logins)],
                ['Paying or shared', pct(stats.conversionPercent), Object.entries(stats.roles).map(([role, count]) => `${role} ${count}`).join(', ') || 'no plans yet'],
                ['Saw upgrade dialog', stats.upgrade ? stats.upgrade.seen : 0,
                    stats.upgrade && stats.upgrade.converted != null
                        ? `${stats.upgrade.views || stats.upgrade.seen} views · ${stats.upgrade.converted} upgraded · see funnel below`
                        : 'see funnel below']
            ] : [];
            $('statsTiles').replaceChildren(...statTiles.map(([label, value, note]) => {
                const box = document.createElement('div');
                box.className = 'tile';
                const big = document.createElement('b'); big.textContent = value;
                const name = document.createElement('div'); name.textContent = label;
                const small = document.createElement('span'); small.textContent = note;
                box.append(big, name, small);
                return box;
            }));
            const depth = stats.watchDepth;
            $('statsTotals').textContent = stats.enabled ?
                `Watchers by total time: under 1 h ${depth.under1h}, 1-5 h ${depth.from1to5h}, 5-20 h ${depth.from5to20h}, 20+ h ${depth.over20h}` +
                `${stats.byType.length ? ` · hours by type: ${stats.byType.map((entry) => `${entry.type} ${entry.hours}`).join(', ')}` : ''}`
                : 'Statistics are switched off (WATCH_STATS=false).';
            // Upgrade funnel: how many saw the upgrade dialog vs how many then upgraded.
            (() => {
                const box = $('statsUpgrade');
                const up = stats.upgrade;
                if (!stats.enabled || !up) { box.innerHTML = ''; const p = document.createElement('div'); p.className = 'empty'; p.textContent = stats.enabled ? 'No upgrade dialog has been shown yet.' : 'Statistics are switched off.'; box.appendChild(p); return; }
                const seen = up.seen || 0;
                const converted = up.converted || 0;
                const views = up.views || 0;
                const convPct = up.conversionPercent;
                if (seen === 0) { box.replaceChildren(); const p = document.createElement('div'); p.className = 'empty'; p.textContent = 'No upgrade dialog has been shown yet.'; box.appendChild(p); return; }
                const max = Math.max(seen, 1);
                const step = (label, value, color) => {
                    const wrap = document.createElement('div'); wrap.className = 'step';
                    const lab = document.createElement('div'); lab.className = 'lab';
                    const name = document.createElement('span'); name.textContent = label;
                    const num = document.createElement('b'); num.textContent = value;
                    lab.append(name, num);
                    const track = document.createElement('div'); track.className = 'bar';
                    const fill = document.createElement('i'); fill.style.width = `${Math.round((value / max) * 100)}%`; fill.style.background = color;
                    track.appendChild(fill);
                    wrap.append(lab, track);
                    return wrap;
                };
                box.replaceChildren(
                    step('People who saw the dialog', seen, '#7b5bf5'),
                    step('Upgraded after seeing it', converted, '#3ecf8e')
                );
                // Repeat views: one person can see the dialog many times; we still count them once above, and note the total here.
                const viewNote = document.createElement('div'); viewNote.className = 'empty'; viewNote.style.opacity = '.8';
                const repeats = views > seen ? ` · ${views - seen} repeat view${views - seen === 1 ? '' : 's'}` : '';
                viewNote.textContent = `Shown ${views} time${views === 1 ? '' : 's'} in total to ${seen} ${seen === 1 ? 'person' : 'people'}${repeats}`;
                box.appendChild(viewNote);
                const conv = document.createElement('div'); conv.className = 'conv';
                const pctText = convPct === null || convPct === undefined ? '–' : `${convPct}%`;
                const b = document.createElement('b'); b.textContent = pctText;
                const rest = document.createTextNode(` conversion · ${converted} of ${seen} who saw the dialog upgraded`);
                conv.append(b, rest);
                box.appendChild(conv);
            })();
            // Bar chart of active people per day (oldest on the left), drawn as SVG from the daily series.
            const days = stats.daily.slice();
            const svgNs = 'http://www.w3.org/2000/svg';
            const maxActive = Math.max(1, ...days.map((entry) => entry.activeUsers));
            const svg = document.createElementNS(svgNs, 'svg');
            svg.setAttribute('viewBox', `0 0 ${days.length * 30} 100`);
            days.forEach((entry, index) => {
                const height = Math.round((entry.activeUsers / maxActive) * 78);
                const bar = document.createElementNS(svgNs, 'rect');
                bar.setAttribute('x', index * 30 + 4); bar.setAttribute('width', 22);
                bar.setAttribute('y', 82 - height); bar.setAttribute('height', Math.max(height, entry.activeUsers > 0 ? 1 : 0));
                bar.setAttribute('rx', 2); bar.setAttribute('fill', '#7b5bf5');
                const tip = document.createElementNS(svgNs, 'title');
                tip.textContent = `${entry.day}: ${entry.activeUsers} active, ${entry.logins} logins, ${entry.hoursWatched} h watched`;
                bar.appendChild(tip);
                svg.appendChild(bar);
                if (index % 2 === 0) {
                    const label = document.createElementNS(svgNs, 'text');
                    label.setAttribute('x', index * 30 + 15); label.setAttribute('y', 96); label.setAttribute('text-anchor', 'middle');
                    label.textContent = entry.day.slice(5);
                    svg.appendChild(label);
                }
            });
            $('statsChart').replaceChildren(svg);
            // Weekly trend of active-user-days and watcher-days (this week vs last), so the two backend trend
            // series are visible and not only computed.
            $('statsActiveTrend').textContent = stats.enabled ?
                `This week vs last: ${stats.trends.activeUserDays[0]} active-user-days (${trend(stats.trends.activeUserDays)}) · ${stats.trends.watcherDays[0]} watcher-days (${trend(stats.trends.watcherDays)})`
                : '';
            fill('statsDaily', stats.daily.slice().reverse().map((entry) => {
                const row = document.createElement('tr');
                [entry.day, entry.newUsers, entry.logins, entry.activeUsers, entry.watchers, entry.hoursWatched].forEach((value) => cell(row, value));
                return row;
            }));
            fill('statsRisk', stats.atRisk.map((entry) => {
                const row = document.createElement('tr');
                [entry.email, entry.role, date(entry.lastSeen), entry.logins].forEach((value) => cell(row, value));
                return row;
            }));
            fill('statsContent', stats.topContent.map((entry) => {
                const row = document.createElement('tr');
                [entry.title || entry.id, entry.type, entry.hours, entry.plays, entry.completionPercent === null ? '–' : `${entry.completionPercent}%`, entry.errors].forEach((value) => cell(row, value));
                return row;
            }));
            fill('statsViewers', stats.topUsers.map((entry) => {
                const row = document.createElement('tr');
                [entry.email, entry.hours, entry.plays, date(entry.lastWatchAt)].forEach((value) => cell(row, value));
                return row;
            }));
            fill('statsBounce', stats.neverWatched.map((entry) => {
                const row = document.createElement('tr');
                [entry.email, date(entry.firstSeen), date(entry.lastSeen), entry.logins].forEach((value) => cell(row, value));
                return row;
            }));
            // Shift the UTC hour histogram into the operator's local time zone
            const shift = -Math.round(new Date().getTimezoneOffset() / 60);
            const local = new Array(24).fill(0);
            stats.hoursOfDayUtc.forEach((hours, utcHour) => { local[(utcHour + shift + 24) % 24] += hours; });
            const pb = stats.playback;
            const list = (rows, unit = '') => rows.map((row) => `${row.name} ${row.count ?? row.hours}${unit}`).join(', ') || '–';
            $('statsPlayback').textContent = `${pb.plays} plays · ${pb.completions} finished (${pb.completionPercent ?? '–'}% watched to the end) · ${pb.errors} errors (${pb.criticalErrors} critical, ${pb.errorsPer100Plays ?? '–'} per 100 plays)` +
                ` · by stream type: ${stats.bySource.map((row) => `${row.name} ${row.plays} plays/${row.errors} errors`).join(', ') || '–'}` +
                ` · top error codes: ${stats.errorCodes.map((row) => `${row.code} ×${row.count}`).join(', ') || '–'}`;
            fill('statsAddons', stats.byAddon.map((entry) => {
                const row = document.createElement('tr');
                [entry.name, entry.plays, entry.hours, entry.errors, entry.errorsPer100Plays ?? '–'].forEach((value) => cell(row, value));
                return row;
            }));
            $('statsDevices').textContent = `Form factor: ${list(stats.devices.form)} · System: ${list(stats.devices.os)} · Browser: ${list(stats.devices.browser)} · Language: ${list(stats.devices.language)}`;
            $('statsHours').textContent = local.some((value) => value > 0) ?
                local.map((value, hour) => `${String(hour).padStart(2, '0')}h ${Math.round(value * 10) / 10}`).join(' · ')
                : 'No watch time recorded yet.';
            const auditRow = (entry) => {
                const row = document.createElement('tr');
                cell(row, date(entry.at));
                cell(row, entry.action);
                const { at, action: name, ...rest } = entry;
                cell(row, Object.values(rest).join(' · '));
                return row;
            };
            fill('audit', log.entries.slice(0, 100).map(auditRow));
            fill('auditShort', log.entries.slice(0, 8).map(auditRow));
            renderTiles({ sessions, billing, stats, healthReport });
            latest = { sessions, billing, log };
            showPage(false);
            fill('owners', billing.owners.map((owner) => {
                const row = document.createElement('tr');
                cell(row, owner.email);
                cell(row, owner.plan);
                cell(row, `${owner.status}${owner.active ? '' : ' (inactive)'}${owner.duplicateSubscriptions.length ? ' ⚠ duplicate subscription' : ''}`);
                cell(row, date(owner.currentPeriodEnd));
                const invited = document.createElement('td');
                owner.invites.forEach((invite) => {
                    const item = document.createElement('div');
                    item.textContent = `${invite.email} (${invite.acceptedAt ? 'joined' : 'pending'}) `;
                    const button = document.createElement('button');
                    button.textContent = 'Remove';
                    button.addEventListener('click', async () => {
                        if (!window.confirm(`Remove ${invite.email} from ${owner.email}'s plan?`)) return;
                        button.disabled = true;
                        try { await api('/admin/billing/invites/remove', { owner: owner.email, email: invite.email }); await load(); } catch (e) { status(e.message, true); button.disabled = false; }
                    });
                    item.appendChild(button);
                    invited.appendChild(item);
                });
                if (owner.invites.length === 0) invited.textContent = `0 of ${owner.seats}`;
                row.appendChild(invited);
                if (owner.email) action(row, 'Erase', () => erase(owner.email)); else cell(row, '');
                return row;
            }));
            fill('grants', billing.grants.map((grant) => {
                const row = document.createElement('tr');
                cell(row, grant.email);
                cell(row, grant.note);
                cell(row, date(grant.grantedAt));
                action(row, 'Revoke', () => api('/admin/grants/remove', { email: grant.email }));
                return row;
            }));
            status(`Updated ${new Date().toLocaleTimeString()}`);
        } catch (e) {
            status(e.message, true);
        }
    };

    $('load').addEventListener('click', () => { token = $('token').value.trim(); load(); });
    $('token').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('load').click(); });
    $('grant').addEventListener('click', async () => {
        try {
            await api('/admin/grants', { email: $('grantEmail').value, note: $('grantNote').value });
            $('grantEmail').value = '';
            $('grantNote').value = '';
            await load();
        } catch (e) {
            status(e.message, true);
        }
    });
    $('ban').addEventListener('click', async () => {
        try {
            await api('/admin/ban', { email: $('banEmail').value, note: $('banNote').value });
            $('banEmail').value = '';
            $('banNote').value = '';
            await load();
        } catch (e) {
            status(e.message, true);
        }
    });
    if (token) load();
})();
