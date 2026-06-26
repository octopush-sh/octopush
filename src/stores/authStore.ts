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
  /** Set while a user-initiated cancel is in flight, so signIn()'s resulting
   *  rejection is treated as a cancel (not a red error) without sniffing the
   *  backend error string. */
  cancelling: boolean;
  error: string | null;
  load: () => Promise<void>;
  signIn: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-fetch identity from Clerk (picks up a plan change after subscribing). */
  refresh: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: SIGNED_OUT,
  loaded: false,
  signingIn: false,
  cancelling: false,
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
    set({ signingIn: true, error: null, cancelling: false });
    try {
      const status = await ipc.authBeginSignIn();
      set({ status, signingIn: false });
    } catch (e) {
      // If the user cancelled, the backend rejection isn't an error to surface.
      const cancelled = get().cancelling;
      const msg = e instanceof Error ? e.message : String(e);
      set({ signingIn: false, cancelling: false, error: cancelled ? null : msg });
    }
  },

  cancelSignIn: async () => {
    set({ cancelling: true });
    try {
      await ipc.authCancelSignIn();
    } catch {
      /* best-effort — the in-flight sign-in will resolve shortly anyway */
    }
    set({ signingIn: false });
  },

  signOut: async () => {
    try {
      await ipc.authSignOut();
    } finally {
      set({ status: SIGNED_OUT, error: null });
    }
  },

  refresh: async () => {
    try {
      const status = await ipc.authRefresh();
      set({ status });
    } catch {
      /* best-effort — keep the cached status on a transient failure */
    }
  },
}));
