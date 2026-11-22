import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { omni } from '../../../../../services/onlineMusic/omni';
import {
    getSharedLoginState, listSharedLoginDevices,
    renameSharedLoginDevice, revokeSharedLoginDevice, watchSharedLoginState, type SharedLoginDevice,
} from '../../../../../services/sync/sharedLoginClient';
import { Button, Row, Status, TextField } from '../../kit';
import { useDeviceRenameStore } from './deviceRenameStore';

// Connect the device here, then use the usual music account window to sign in.

export const SyncDeviceRows = ({ deviceId }: { deviceId: string | undefined }) => {
    const { t } = useTranslation();
    const state = useSyncExternalStore(watchSharedLoginState, getSharedLoginState);
    const [otherDevices, setOtherDevices] = useState<{ forDevice: string; items: SharedLoginDevice[] } | null>(null);
    const device = state.device?.id === deviceId ? state.device : null;
    const devices = device ? [
        device,
        ...(otherDevices?.forDevice === device.id ? otherDevices.items.filter(item => item.id !== device.id) : []),
    ] : [];
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState(false);
    const rename = useDeviceRenameStore(state => state.draft);
    const setRename = (draft: SharedLoginDevice | null) => useDeviceRenameStore.setState({ draft });

    useEffect(() => {
        if (!device) return;
        let canceled = false;
        void listSharedLoginDevices().then(result => {
            if (!canceled) setOtherDevices({ forDevice: device.id, items: result });
        }).catch(() => {
            if (!canceled) setStatus(true);
        });
        return () => { canceled = true; };
    }, [device]);

    if (!device) return null;
    const editing = rename?.id === device.id ? rename : null;

    const saveName = async () => {
        const label = editing?.label.trim();
        if (!label || label.length > 80) return;
        setBusy(true);
        setStatus(false);
        try {
            if (await renameSharedLoginDevice(device.id, label)) setRename(null);
            else setStatus(true);
        } catch {
            setStatus(true);
        } finally {
            setBusy(false);
        }
    };

    const revoke = async (device: SharedLoginDevice) => {
        setBusy(true);
        setStatus(false);
        try {
            if (!await revokeSharedLoginDevice(device.id)) {
                setStatus(true);
                return;
            }
            setOtherDevices(previous => previous && {
                ...previous, items: previous.items.filter(item => item.id !== device.id),
            });
            if (state.device?.id === device.id) await omni.refreshSharedLoginAccounts();
        } catch {
            setStatus(true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Row sub label={t('options.sharedLoginHint')}>
                <Status tone="ok">{t('options.sharedLoginConnected')}</Status>
            </Row>
            {devices.map(item => (
                <Row sub key={item.id} label={item.label}>
                    {item.id === device.id && !editing && (
                        <Button disabled={busy} onClick={() => setRename(device)}>{t('options.sharedLoginRename')}</Button>
                    )}
                    <Button disabled={busy} onClick={() => void revoke(item)}>
                        {t(item.id === device.id ? 'options.sharedLoginDisconnect' : 'options.sharedLoginRevoke')}
                    </Button>
                </Row>
            ))}
            {editing && (
                <Row sub label={t('options.sharedLoginDeviceName')}>
                    <TextField value={editing.label} onChange={label => setRename({ id: device.id, label })}
                        disabled={busy} />
                    <Button disabled={busy || !editing.label.trim() || editing.label.trim().length > 80}
                        onClick={() => void saveName()}>{t('options.save')}</Button>
                    <Button disabled={busy} onClick={() => setRename(null)}>{t('options.sharedLoginCancelRename')}</Button>
                </Row>
            )}
            {status && (
                <Row sub label={(
                    <Status tone="error">
                        {t('options.sharedLoginError')}
                    </Status>
                )} />
            )}
        </>
    );
};
