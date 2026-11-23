import React, { useCallback } from 'react';
import { useCore } from 'stremio/core';
import Button from 'stremio/components/Button';
import type { ServerSessionStatus } from '../useServerSession';
import styles from './styles.less';

type Props = {
    status: ServerSessionStatus,
    onRetry: () => void,
    support?: string | null,
};

// Shown instead of the app until the server has confirmed the logged-in user.
const ServerSessionGate = ({ status, onRetry, support = null }: Props) => {
    const core = useCore();

    const onLogout = useCallback(() => {
        core.transport.dispatch({ action: 'Ctx', args: { action: 'Logout' } });
    }, []);

    const failed = status === 'error' || status === 'rejected' || status === 'blocked' || status === 'replaced';

    return (
        <div className={styles['gate-container']}>
            <div className={styles['title']}>
                {
                    status === 'blocked' ?
                        'This account has been blocked'
                        :
                        status === 'replaced' ?
                            'You were signed out on this device'
                            :
                            status === 'rejected' ?
                                'Your session has expired'
                                :
                                status === 'error' ?
                                    'Could not verify your account'
                                    :
                                    'Verifying your account…'
                }
            </div>
            {
                failed ?
                    <React.Fragment>
                        <div className={styles['message']}>
                            {
                                status === 'replaced' ?
                                    'This account is already in use on the maximum number of devices, and you signed in on another one. Continue here to sign that device out instead.'
                                    :
                                    status === 'blocked' ?
                                        'Access to this service has been disabled for your account. Contact the service operator if you think this is a mistake.'
                                    + (support ? ` Support: ${support}` : '')
                                        :
                                        status === 'rejected' ?
                                            'This login is no longer accepted. Log out and log in again to continue.'
                                            :
                                            'We could not reach the server to confirm your login. Check your connection and try again.'
                            }
                        </div>
                        <div className={styles['buttons-container']}>
                            {
                                status === 'error' || status === 'replaced' ?
                                    <Button className={styles['button-container']} title={status === 'replaced' ? 'Use this device' : 'Try again'} onClick={onRetry}>
                                        <div className={styles['label']}>{status === 'replaced' ? 'Use this device' : 'Try again'}</div>
                                    </Button>
                                    :
                                    null
                            }
                            <Button className={styles['button-container']} title={'Log out'} onClick={onLogout}>
                                <div className={styles['label']}>Log out</div>
                            </Button>
                        </div>
                    </React.Fragment>
                    :
                    null
            }
        </div>
    );
};

export default ServerSessionGate;
