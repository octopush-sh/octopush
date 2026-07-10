import { create } from "zustand";

/** Drives the upgrade sheet (P2). Set by the run-launch gate when a Free user is
 *  over their monthly Direct-run cap; the global `<UpgradeSheet/>` reads it. */
export interface UpgradeInfo {
  feature: string;
  used: number;
  limit: number;
}

interface UpgradeState {
  info: UpgradeInfo | null;
  show: (info: UpgradeInfo) => void;
  hide: () => void;
}

export const useUpgradeStore = create<UpgradeState>((set) => ({
  info: null,
  show: (info) => set({ info }),
  hide: () => set({ info: null }),
}));
