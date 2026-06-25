import { create } from "zustand";
import { ipc, type AuthStatus } from "../lib/ipc";

/** Accounts (P1). Sign-in runs the OAuth/PKCE flow in the Rust core (which opens
 *  the system browser and stores the session in the OS keychain); the frontend
 *  only reflects the resulting status. */

const SIGNED_OUT: AuthStatus = { signedIn: false, email: null, name: null };

interface AuthState {
  status: AuthStatus;
  loaded: boolean;
  signingIn: boolean;
  error: string | null;
  load: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: SIGNED_OUT,
  loaded: false,
  signingIn: false,
  error: null,

  load: async () => {
    try {
      const status = await ipc.authStatus();
      set({ status, loaded: true });
    } catch {
      set({ status: SIGNED_OUT, loaded: true });
    }
  },

  signIn: async () => {
    set({ signingIn: true, error: null });
    try {
      const status = await ipc.authBeginSignIn();
      set({ status, signingIn: false });
    } catch (e) {
      set({ signingIn: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  signOut: async () => {
    try {
      await ipc.authSignOut();
    } finally {
      set({ status: SIGNED_OUT, error: null });
    }
  },
}));
