import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { ProviderConfig } from "../lib/types";

/**
 * The provider/model catalog as the app currently sees it. One shared copy so
 * every reader (ModelPicker, the Composer's cost preview) reflects a save in
 * Settings · Models without a remount. Writers call `refresh()` after
 * `save_providers`; the picker also refreshes whenever it opens, so a write
 * from any other path still shows up the next time someone looks.
 */
interface ProvidersState {
  providers: ProviderConfig[];
  loaded: boolean;
  refresh: () => Promise<void>;
}

// Refreshes can overlap (the picker opening while Settings saves); only the
// latest request may write, so a slow stale read never clobbers a newer one.
let latestRequest = 0;

export const useProvidersStore = create<ProvidersState>((set) => ({
  providers: [],
  loaded: false,
  refresh: async () => {
    const request = ++latestRequest;
    try {
      const providers = await ipc.listProviders();
      if (request !== latestRequest) return;
      set({ providers, loaded: true });
    } catch {
      // Keep the last good catalog; a failed read shouldn't blank the picker.
    }
  },
}));
