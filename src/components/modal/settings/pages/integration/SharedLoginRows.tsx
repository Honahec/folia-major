import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { omni } from '../../../../../services/onlineMusic/omni';
import {
    enrollSharedLogin, getSharedLoginState, initializeSharedLogin, listSharedLoginDevices,
    revokeSharedLoginDevice, watchSharedLoginState, type SharedLoginDevice,
} from '../../../../../services/sync/sharedLoginClient';
import { Button, Row, Status, TextField } from '../../kit';
import { O } from './options';

// Connect the device here, then use the usual music account window to sign in.

export const SharedLoginRows = () => {
    const { t } = useTranslation();
    const state = useSyncExternalStore(watchSharedLoginState, getSharedLoginState);
    const [origin, setOrigin] = useState('');
    const [token, setToken] = useState('');
    const [label, setLabel] = useState('');
    const [otherDevices, setOtherDevices] = useState<{ forDevice: string; items: SharedLoginDevice[] } | null>(null);
    const device = state.device;
    const devices = device ? [
        device,
        ...(otherDevices?.forDevice === device.id ? otherDevices.items.filter(item => item.id !== device.id) : []),
    ] : [];
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<'token' | 'connection' | null>(null);
    const desktop = Boolean(window.electron?.enrollSharedLogin);

    useEffect(() => { void initializeSharedLogin(); }, []);
    useEffect(() => {
        if (!device) return;
        let canceled = false;
        void listSharedLoginDevices().then(result => {
            if (!canceled) setOtherDevices({ forDevice: device.id, items: result });
        }).catch(() => {
            if (!canceled) setStatus('connection');
        });
        return () => { canceled = true; };
    }, [device]);

    if (!state.available) return null;

    const connect = async () => {
        setBusy(true);
        setStatus(null);
        try {
            const result = await enrollSharedLogin(origin.trim(), token.trim(), label.trim());
            if (result === 201) {
                setToken('');
                await omni.refreshSharedLoginAccounts();
            } else {
                setStatus(result === 401 ? 'token' : 'connection');
            }
        } catch {
            setStatus('connection');
        } finally {
            setBusy(false);
        }
    };
    const revoke = async (device: SharedLoginDevice) => {
        setBusy(true);
        setStatus(null);
        try {
            if (!await revokeSharedLoginDevice(device.id)) {
                setStatus('connection');
                return;
            }
            setOtherDevices(previous => previous && {
                ...previous, items: previous.items.filter(item => item.id !== device.id),
            });
            if (state.device?.id === device.id) await omni.refreshSharedLoginAccounts();
        } catch {
            setStatus('connection');
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Row option={O.sharedLogin} hint={t('options.sharedLoginHint')}>
                {state.device && <Status tone="ok">{t('options.sharedLoginConnected')}</Status>}
            </Row>
            {state.device ? (
                devices.map(device => (
                    <Row sub key={device.id} label={device.label}>
                        <Button disabled={busy} onClick={() => void revoke(device)}>
                            {t(device.id === state.device?.id ? 'options.sharedLoginDisconnect' : 'options.sharedLoginRevoke')}
                        </Button>
                    </Row>
                ))
            ) : (
                <>
                    {desktop && (
                        <Row sub label={t('options.r2SyncWorkerUrl')}>
                            <TextField type="url" value={origin} onChange={setOrigin} placeholder="https://folia.example" />
                        </Row>
                    )}
                    <Row sub label={t('options.sharedLoginDeviceName')}>
                        <TextField value={label} onChange={setLabel} />
                    </Row>
                    <Row sub label={t('options.sharedLoginToken')}>
                        <TextField type="password" value={token} onChange={setToken} />
                        <Button
                            variant="primary"
                            disabled={busy || !/^[a-f0-9]{64}$/.test(token.trim()) || !label.trim() || (desktop && !origin.trim())}
                            onClick={() => void connect()}
                        >
                            {t('options.sharedLoginConnect')}
                        </Button>
                    </Row>
                </>
            )}
            {status && (
                <Row sub label={(
                    <Status tone="error">
                        {t(status === 'token' ? 'options.sharedLoginInvalidToken' : 'options.sharedLoginError')}
                    </Status>
                )} />
            )}
        </>
    );
};
