// Optional emails through Resend's HTTP API (https://resend.com): invitations and a few courtesy notices.
// Enabled only when RESEND_API_KEY, MAIL_FROM and PUBLIC_URL are set; otherwise everything works exactly as before and
// the owner tells people themselves. Plain text only (no HTML) so nothing user-supplied is ever rendered.

const SEND_TIMEOUT_MS = 8000;

const oneLine = (value) => String(value).replace(/[\r\n]+/g, ' ').trim();

// productName: the operator's product name (string or function returning it); added as a signature when set.
const createMailer = ({ apiKey, from, publicUrl, productName = '', fetchImpl = fetch }) => {
    const signature = () => {
        const name = oneLine((typeof productName === 'function' ? productName() : productName) || '');
        return name ? ['', `\u2014 ${name}`] : [];
    };
    const send = async ({ to, subject, text }) => {
        const response = await fetchImpl('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ from, to: [to], subject, text }),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
        });
        if (!response.ok) throw new Error(`Email provider answered HTTP ${response.status}`);
    };

    return {
        async sendReset({ to, resetUrl }) {
            await send({
                to,
                subject: 'Reset your password',
                text: ['Someone asked to reset the password for this email address. To choose a new one, open this link (it works once, for one hour):', '', resetUrl,
                    '', 'You will be signed out on all devices. If this was not you, ignore this email: your password stays as it is.', ...signature()].join('\n')
            });
        },

        async sendInvite({ to, ownerEmail, confirmUrl }) {
            const owner = oneLine(ownerEmail || 'Someone');
            await send({
                to,
                subject: `${owner} invited you to share their plan`,
                text: [
                    `${owner} has invited you to share their subscription.`,
                    '',
                    ...(confirmUrl
                        ? [`Confirm that this is your email address (the link works once, for 7 days): ${confirmUrl}`, '', `Then log in with this email address (${to}): ${publicUrl}`]
                        : [`Log in with this email address (${to}) to get access: ${publicUrl}`]),
                    'No account yet? Create one with this same email address first.',
                    '',
                    'If you were not expecting this, you can ignore this email.',
                    ...signature()
                ].join('\n')
            });
        },

        // kind: 'removed' | 'lapsed' | 'transferred'
        async sendNotice({ to, kind, ownerEmail }) {
            const owner = oneLine(ownerEmail || 'The plan owner');
            const notices = {
                removed: {
                    subject: `${owner} removed you from their shared plan`,
                    body: [`${owner} removed you from their shared plan, so you no longer have access through it.`, `You can subscribe yourself at ${publicUrl}`]
                },
                lapsed: {
                    subject: `The plan ${owner} shared with you has ended`,
                    body: [`The subscription ${owner} shared with you is no longer active, so your shared access has ended.`, `You can subscribe yourself at ${publicUrl}`]
                },
                transferred: {
                    subject: `${owner} made you the owner of their plan`,
                    body: [`${owner} transferred their subscription to you.`, `You can manage billing and who shares the plan in Settings > Subscription: ${publicUrl}`]
                }
            };
            const notice = notices[kind];
            if (!notice) throw new Error(`Unknown notice kind: ${kind}`);
            await send({ to, subject: notice.subject, text: [...notice.body, '', 'If this does not concern you, you can ignore this email.', ...signature()].join('\n') });
        }
    };
};

module.exports = { createMailer };
