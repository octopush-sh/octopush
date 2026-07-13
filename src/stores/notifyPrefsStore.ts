import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Notification preferences. Default ON — the fleet's whole point is running
 *  unattended, and a silent gate is a stalled crew. */
interface NotifyPrefs {
  crewNotifications: boolean;
  setCrewNotifications: (on: boolean) => void;
}

export const useNotifyPrefs = create<NotifyPrefs>()(
  persist(
    (set) => ({
      crewNotifications: true,
      setCrewNotifications: (on) => set({ crewNotifications: on }),
    }),
    {
      name: "octo-notify-prefs",
      partialize: (s) => ({ crewNotifications: s.crewNotifications }),
    },
  ),
);
