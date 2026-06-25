import { useEffect } from "react";
import { useAuthStore } from "../stores/authStore";

/** Read + drive the account session (P1). Loads the current status once on
 *  first use. Sign-in/out happen in the Rust core. */
export function useAuth() {
  const status = useAuthStore((s) => s.status);
  const loaded = useAuthStore((s) => s.loaded);
  const signingIn = useAuthStore((s) => s.signingIn);
  const error = useAuthStore((s) => s.error);
  const load = useAuthStore((s) => s.load);
  const signIn = useAuthStore((s) => s.signIn);
  const cancelSignIn = useAuthStore((s) => s.cancelSignIn);
  const signOut = useAuthStore((s) => s.signOut);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  return { status, loaded, signingIn, error, signIn, cancelSignIn, signOut };
}
