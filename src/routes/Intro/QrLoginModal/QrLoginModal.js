// Sign in by scanning a code with a phone: this screen asks our own link service for a code, shows it as a QR code,
// and waits until the person has confirmed it on their phone (our /account/link page). Nothing here talks to another company.
const React = require('react');
const { useTranslation } = require('react-i18next');
const PropTypes = require('prop-types');
const { ModalDialog } = require('stremio/components');
const styles = require('./styles');

const POLL_MS = 2000;
const LIFETIME_MS = 10 * 60 * 1000;

const QrLoginModal = ({ onSignedIn, onCloseRequest }) => {
    const { t } = useTranslation();
    const [state, setState] = React.useState({ status: 'loading', code: '', link: '', qr: '' });
    const [round, setRound] = React.useState(0);
    React.useEffect(() => {
        let stopped = false;
        let timer = null;
        const started = Date.now();
        setState({ status: 'loading', code: '', link: '', qr: '' });
        const poll = (code) => {
            if (stopped) return;
            if (Date.now() - started > LIFETIME_MS) {
                setState((s) => ({ ...s, status: 'expired' }));
                return;
            }
            fetch(`/api/v2/read?type=Read&code=${encodeURIComponent(code)}`, { cache: 'no-store' })
                .then((response) => response.json())
                .then((reply) => {
                    if (stopped) return;
                    if (reply && reply.result && typeof reply.result.authKey === 'string') {
                        stopped = true;
                        onSignedIn(reply.result.authKey);
                    } else {
                        timer = setTimeout(() => poll(code), POLL_MS);
                    }
                })
                .catch(() => { timer = setTimeout(() => poll(code), POLL_MS * 2); });
        };
        fetch('/api/v2/create?type=Create', { cache: 'no-store' })
            .then((response) => response.json())
            .then((reply) => {
                if (stopped) return;
                if (!reply || !reply.result || !reply.result.code) throw new Error('no code');
                const { code, link, qrcode } = reply.result;
                setState({ status: 'waiting', code, link, qr: qrcode });
                poll(code);
            })
            .catch(() => { if (!stopped) setState({ status: 'error', code: '', link: '', qr: '' }); });
        return () => { stopped = true; clearTimeout(timer); };
    }, [round]);
    const newCode = React.useCallback(() => setRound((n) => n + 1), []);
    const buttons = React.useMemo(() => {
        const list = [{ className: styles['cancel-button'], label: t('BUTTON_CANCEL'), props: { onClick: onCloseRequest } }];
        if (state.status === 'expired' || state.status === 'error') {
            list.push({ label: t('STREMIO_TV_LOGIN_NEW_LINK', 'Request a new link'), props: { onClick: newCode } });
        }
        return list;
    }, [state.status, onCloseRequest]);
    const shown = state.link.replace(/^https?:\/\//, '').replace(/\?code=.*$/, '');
    return (
        <ModalDialog className={styles['qr-login-modal-container']} title={t('QR_LOGIN_TITLE', 'Sign in with your phone')} buttons={buttons} onCloseRequest={onCloseRequest}>
            <div className={styles['qr-login']}>
                {
                    state.status === 'waiting' ?
                        <React.Fragment>
                            <img className={styles['qr']} src={state.qr} alt={''} />
                            <div className={styles['step']}>{t('LOGIN_SCAN_QR_CODE', 'Scan the QR code or go to')}</div>
                            <div className={styles['address']}>{shown}</div>
                            <div className={styles['code']}>{state.code}</div>
                            <div className={styles['hint']}>{t('QR_LOGIN_HINT', 'On your phone, approve it with one tap if you are already signed in, or sign in with your email and password. This screen continues by itself.')}</div>
                        </React.Fragment>
                        :
                        <div className={styles['hint']}>
                            {state.status === 'loading' ? t('LOADING', 'Loading') : state.status === 'expired' ? t('QR_LOGIN_EXPIRED', 'This code has expired.') : t('QR_LOGIN_ERROR', 'Could not get a code. Try again.')}
                        </div>
                }
            </div>
        </ModalDialog>
    );
};

QrLoginModal.propTypes = {
    onSignedIn: PropTypes.func.isRequired,
    onCloseRequest: PropTypes.func
};

module.exports = QrLoginModal;
