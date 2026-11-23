import React, { ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';
import { TextInput } from 'stremio/components';
import { apiFetch, apiPost } from 'stremio/router/serverApi';
import type { Entitlement } from 'stremio/router/useServerSession';
import { Group, Row, RowButton } from '../components';
import styles from './Subscription.less';

type Invite = {
    email: string,
    invitedAt: number,
    acceptedAt: number | null,
    role?: 'member' | 'manager',
    expired?: boolean,
    confirmed?: boolean | null,
};
type InviteList = {
    max: number,
    invites: Invite[],
    emailEnabled?: boolean,
    notified?: boolean,
    you?: 'owner' | 'manager',
    expiryDays?: number | null,
};

const ERRORS: Record<string, string> = {
    invalid_email: 'That does not look like a valid email address.',
    cannot_invite_self: 'You cannot invite yourself.',
    already_joined: 'They have already joined.',
    email_disabled: 'This server does not send invitation emails.',
    email_limit_reached: 'Daily email limit reached. Try again tomorrow.',
    already_invited: 'That email is already invited.',
    seat_limit_reached: 'All seats of your plan are used.',
    owners_only: 'Only the plan owner can do that.',
    managers_only: 'Only the plan owner or a manager can manage invites.',
    invalid_role: 'That role is not valid.',
    not_joined: 'They have to join (log in with that email) before the plan can be transferred to them.',
    target_has_plan: 'That person already pays for their own plan.',
    target_has_invites: 'That person already shares a plan of their own.',
    storage_unavailable: 'The server could not save this. Please try again.',
    rate_limited: 'Too many requests. Please wait a moment.',
};
const GENERIC_ERROR = 'Something went wrong. Please try again.';

const formatDate = (timestamp?: number | null) => typeof timestamp === 'number' ? new Date(timestamp).toLocaleDateString() : null;

const Subscription = () => {
    const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
    const [list, setList] = useState<InviteList | null>(null);
    const [email, setEmail] = useState('');
    const [busy, setBusy] = useState(false);
    const lockRef = useRef(false); // state updates are async: a ref stops a fast double click from sending twice
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [devices, setDevices] = useState<{ used: number, max: number } | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const me = await apiFetch('/auth/me');
                if (!me.ok) throw new Error('me');
                const { entitlement: loaded, devices: deviceInfo } = await me.json();
                if (cancelled) return;
                setEntitlement(loaded ?? null);
                setDevices(deviceInfo ?? null);
                const managesInvites = loaded?.active === true && (loaded.role === 'owner' || (loaded.role === 'member' && loaded.canManageInvites === true));
                if (managesInvites) {
                    const invites = await apiFetch('/billing/invites');
                    if (invites.ok && !cancelled) setList(await invites.json());
                }
            } catch (_e) {
                if (!cancelled) setError('Could not load your subscription. Please try again later.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Hands the person a JSON file with everything this service stores about them
    const onDownloadData = useCallback(async () => {
        try {
            const response = await apiFetch('/auth/my-data');
            if (!response.ok) throw new Error('download');
            const url = URL.createObjectURL(await response.blob());
            const link = document.createElement('a');
            link.href = url;
            link.download = 'my-data.json';
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (_e) {
            setError('Could not download your data. Please try again later.');
        }
    }, []);

    const send = useCallback(async (path: string, body: object, onOk: (data: any) => void) => {
        if (lockRef.current) return;
        lockRef.current = true;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const response = await apiPost(path, body);
            const data = await response.json().catch(() => ({}));
            if (response.ok) onOk(data);
            else setError(ERRORS[data.error] ?? GENERIC_ERROR);
        } catch (_e) {
            setError('Could not reach the server. Please try again.');
        } finally {
            lockRef.current = false;
            setBusy(false);
        }
    }, []);

    const applyList = useCallback((data: InviteList) => {
        setList(data);
        if (data.notified === true) setNotice('Invitation emailed.');
        else if (data.emailEnabled === true && data.notified === false) setNotice('Invite saved, but the email could not be sent. Let them know yourself.');
    }, []);

    const onEmailChange = useCallback(({ target }: ChangeEvent<HTMLInputElement>) => setEmail(target.value), []);
    const onInvite = useCallback(() => {
        if (email.trim().length === 0) return;
        send('/billing/invites', { email }, (data) => {
            applyList(data);
            setEmail('');
        });
    }, [email, send, applyList]);
    const onRemove = useCallback((target: string) => {
        if (!window.confirm(`Remove ${target} from your plan? They will lose access right away.`)) return;
        send('/billing/invites/remove', { email: target }, applyList);
    }, [send, applyList]);
    const onRole = useCallback((target: string, role: 'member' | 'manager') => send('/billing/invites/role', { email: target, role }, applyList), [send, applyList]);
    const onTransfer = useCallback((target: string) => {
        if (!window.confirm(`Make ${target} the owner of this plan? They will manage billing and who shares it. You stay on the plan as a manager.`)) return;
        send('/billing/transfer', { email: target }, () => window.location.reload());
    }, [send]);
    const onResend = useCallback((target: string) => send('/billing/invites/resend', { email: target }, applyList), [send, applyList]);
    const onLeave = useCallback(() => {
        if (!window.confirm('Leave this shared plan? You will lose access until you subscribe or are invited again.')) return;
        send('/billing/leave', {}, () => window.location.reload());
    }, [send]);
    const onPortal = useCallback(() => send('/billing/portal', {}, (data) => {
        if (typeof data.url === 'string') window.location.assign(data.url);
        else setError(GENERIC_ERROR);
    }), [send]);

    if (loading) return <Group><div className={styles['message']}>Loading…</div></Group>;
    const renews = formatDate(entitlement?.currentPeriodEnd);
    const grace = formatDate(entitlement?.graceEndsAt);

    return (
        <React.Fragment>
            {error !== null && <Group><div className={`${styles['message']} ${styles['error']}`} role={'alert'}>{error}</div></Group>}
            {entitlement === null && error === null && <Group><div className={styles['message']}>Subscription information is unavailable.</div></Group>}
            {entitlement !== null && !entitlement.paywall &&
                <Group><div className={styles['message']}>This server does not require a subscription.</div></Group>}
            {entitlement?.role === 'member' &&
                <Group title={'Shared plan'}>
                    <Row
                        rowId={'shared'}
                        label={`Shared by ${entitlement.sharedBy ?? 'another subscriber'}`}
                        description={`Access ends if they remove you or their subscription ends.${entitlement.canManageInvites === true ? ' You are a manager: you can invite and remove other members below.' : ''}`}
                        stackOnPhone={true}
                    >
                        <RowButton label={'Leave plan'} variant={'danger'} disabled={busy} onClick={onLeave} />
                    </Row>
                </Group>}
            {entitlement?.role === 'granted' &&
                <Group title={'Complimentary access'}>
                    <Row rowId={'granted'} label={'Access granted by the service operator'} description={'There is nothing to manage here.'} />
                </Group>}
            {entitlement?.role === 'owner' &&
                <Group title={'Your plan'}>
                    <Row
                        rowId={'plan'}
                        label={entitlement.plan?.name ?? 'Subscription'}
                        description={`Status: ${entitlement.status ?? 'unknown'}${renews !== null ? ` · renews or ends ${renews}` : ''}`}
                        stackOnPhone={true}
                    >
                        <RowButton label={'Manage billing'} disabled={busy} onClick={onPortal} />
                    </Row>
                    {entitlement.status === 'past_due' &&
                        <div className={`${styles['message']} ${styles['error']}`}>
                            Your last payment failed. Update your billing details{grace !== null ? ` before ${grace}` : ''} to keep access.
                        </div>}
                </Group>}
            {devices !== null &&
                <Group title={'Devices'}>
                    <Row rowId={'devices'} label={`${devices.used} of ${devices.max} devices signed in`} description={'Signing in on another device signs out the one used least recently.'} />
                </Group>}
            {list !== null && list.max > 0 &&
                <Group
                    rowId={'invites'}
                    title={`Share your plan (${list.invites.length} of ${list.max})`}
                    description={`Invite people by the email of their account. They get access when they log in with it.${list.emailEnabled === true ? ' They are emailed an invitation.' : ' No email is sent, so let them know yourself.'}${typeof list.expiryDays === 'number' ? ` Unused invitations expire after ${list.expiryDays} days.` : ''}`}
                >
                    {list.invites.map((invite) => {
                        const isOwner = list.you !== 'manager';
                        const isManager = invite.role === 'manager';
                        const joined = invite.acceptedAt !== null;
                        return (
                            <div key={invite.email} className={styles['invite']}>
                                <span className={styles['email']} title={invite.email}>{invite.email}</span>
                                <span className={styles['state']}>
                                    {isManager ? 'Manager · ' : ''}
                                    {joined ? 'Joined' : invite.expired === true ? 'Expired' : invite.confirmed === false ? 'Awaiting email confirmation' : 'Pending'}
                                </span>
                                {!joined && list.emailEnabled === true &&
                                    <RowButton label={invite.expired === true ? 'Renew' : 'Resend'} disabled={busy} onClick={() => onResend(invite.email)} />}
                                {isOwner &&
                                    <RowButton label={isManager ? 'Make member' : 'Make manager'} disabled={busy} onClick={() => onRole(invite.email, isManager ? 'member' : 'manager')} />}
                                {isOwner && joined &&
                                    <RowButton label={'Make owner'} disabled={busy} onClick={() => onTransfer(invite.email)} />}
                                {(isOwner || !isManager) &&
                                    <RowButton label={'Remove'} variant={'danger'} disabled={busy} onClick={() => onRemove(invite.email)} />}
                            </div>
                        );
                    })}
                    {list.invites.length < list.max &&
                        <div className={styles['add']}>
                            <TextInput
                                className={styles['input']}
                                type={'email'}
                                value={email}
                                onChange={onEmailChange}
                                onSubmit={onInvite}
                                placeholder={'friend@example.com'}
                                aria-label={'Email address to invite'}
                                autoComplete={'off'}
                            />
                            <RowButton label={'Invite'} variant={'primary'} disabled={busy || email.trim().length === 0} onClick={onInvite} />
                        </div>}
                    {notice !== null && <div className={styles['message']} role={'status'}>{notice}</div>}
                </Group>}
            {!loading &&
                <Group title={'Your data'}>
                    <Row
                        rowId={'my-data'}
                        label={'Download my data'}
                        description={'A file with the account, sign-in, viewing and billing records this service keeps about you. To have your data erased, contact the service operator.'}
                        stackOnPhone={true}
                    >
                        <RowButton label={'Download'} onClick={onDownloadData} />
                    </Row>
                </Group>}
        </React.Fragment>
    );
};

export default Subscription;
