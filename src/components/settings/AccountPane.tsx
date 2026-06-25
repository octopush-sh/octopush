// Settings → Account (P1). Sign in / out and reach Clerk's hosted account
// portal. The OAuth/PKCE flow runs in the Rust core (opens the system browser,
// stores the session in the OS keychain); this pane only reflects + triggers it.
import { useAuth } from "../../hooks/useAuth";
import { ipc } from "../../lib/ipc";
import { pushToast } from "../Toasts";
import { PaneHeader, SectionLabel } from "./shared";

export function AccountPane() {
  const { status, signingIn, error, signIn, cancelSignIn, signOut } = useAuth();

  const openPortal = async () => {
    try {
      const url = await ipc.authAccountPortalUrl();
      await ipc.openFileInSystem(url);
    } catch (e) {
      console.error("Failed to open the account portal:", e);
      pushToast({ level: "error", title: "Couldn't open the account portal" });
    }
  };

  return (
    <>
      <PaneHeader
        eyebrow="Account"
        title="Octopus & you."
        subtitle="Octopush is free and local-first. An account unlocks premium — the multi-agent orchestration harness — and, later, sync across machines. Your provider keys and local data never leave this device."
      />

      <div className="max-w-[640px] space-y-8">
        {status.signedIn ? (
          <div className="space-y-4">
            <SectionLabel>Signed in</SectionLabel>
            <div className="rounded-lg border border-octo-hairline bg-octo-panel-2 px-4 py-4">
              <div className="font-serif text-[16px] text-octo-ivory">
                {status.name || status.email || "Signed in"}
              </div>
              {status.email && status.name && (
                <div className="mt-0.5 font-mono text-xs text-octo-mute">{status.email}</div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void openPortal()}
                  className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-sage transition-colors duration-[180ms] hover:border-[var(--brass-dim)] hover:text-octo-brass"
                >
                  Manage account ↗
                </button>
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:border-octo-rouge hover:text-octo-rouge"
                >
                  Sign out
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <SectionLabel>Sign in</SectionLabel>
            <p className="text-[13px] leading-relaxed text-octo-mute">
              Sign-in opens your browser — create an account or sign in there, then return to Octopush.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={signingIn}
                onClick={() => void signIn()}
                className="rounded-lg bg-octo-brass px-5 py-2.5 font-serif text-base text-octo-onyx transition-colors duration-[180ms] hover:bg-octo-brass-hi disabled:opacity-40"
              >
                {signingIn ? "Waiting for your browser…" : "Sign in"}
              </button>
              {signingIn && (
                <button
                  type="button"
                  onClick={() => void cancelSignIn()}
                  className="rounded-md border border-octo-hairline px-3 py-2 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:border-octo-rouge hover:text-octo-rouge"
                >
                  Cancel
                </button>
              )}
            </div>
            {error && <p className="font-mono text-xs text-octo-rouge">{error}</p>}
          </div>
        )}
      </div>
    </>
  );
}
