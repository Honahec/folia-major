import { create } from 'zustand';
import type { SharedLoginDevice } from '../../../../../services/sync/sharedLoginClient';

// The settings button and command palette open the same device name editor.

export const useDeviceRenameStore = create<{ draft: SharedLoginDevice | null }>(() => ({ draft: null }));
