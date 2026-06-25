/**
 * Unit tests for authStore (accounts — P1).
 *
 * 1. load() reflects the backend status (signed in / out) and degrades on error
 * 2. signIn() stores the returned status and toggles signingIn
 * 3. signIn() surfaces an error without crashing
 * 4. signOut() returns to the signed-out state
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthStatus } from "../lib/ipc";

const authStatusMock = vi.fn<() => Promise<AuthStatus>>();
const authBeginSignInMock = vi.fn<() => Promise<AuthStatus>>();
const authSignOutMock = vi.fn<() => Promise<void>>();

vi.mock("../lib/ipc", () => ({
  ipc: {
    authStatus: authStatusMock,
    authBeginSignIn: authBeginSignInMock,
    authSignOut: authSignOutMock,
  },
}));

const { useAuthStore } = await import("./authStore");

const SIGNED_OUT: AuthStatus = { signedIn: false, email: null, name: null };

beforeEach(() => {
  useAuthStore.setState({ status: SIGNED_OUT, loaded: false, signingIn: false, error: null });
  authStatusMock.mockReset();
  authBeginSignInMock.mockReset();
  authSignOutMock.mockReset().mockResolvedValue(undefined);
});

describe("authStore", () => {
  it("load() reflects a signed-in backend status", async () => {
    authStatusMock.mockResolvedValue({ signedIn: true, email: "dev@octopu.sh", name: "Dev" });
    await useAuthStore.getState().load();
    const s = useAuthStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.status.signedIn).toBe(true);
    expect(s.status.email).toBe("dev@octopu.sh");
  });

  it("load() degrades to signed-out on error", async () => {
    authStatusMock.mockRejectedValue(new Error("keychain locked"));
    await useAuthStore.getState().load();
    const s = useAuthStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.status.signedIn).toBe(false);
  });

  it("signIn() stores the returned status", async () => {
    authBeginSignInMock.mockResolvedValue({ signedIn: true, email: "a@b.co", name: null });
    await useAuthStore.getState().signIn();
    const s = useAuthStore.getState();
    expect(s.signingIn).toBe(false);
    expect(s.status.signedIn).toBe(true);
    expect(s.error).toBeNull();
  });

  it("signIn() sets signingIn=true while the flow is in flight", async () => {
    let resolve!: (s: AuthStatus) => void;
    authBeginSignInMock.mockReturnValue(new Promise<AuthStatus>((r) => { resolve = r; }));
    const p = useAuthStore.getState().signIn();
    expect(useAuthStore.getState().signingIn).toBe(true);
    resolve({ signedIn: true, email: "a@b.co", name: null });
    await p;
    expect(useAuthStore.getState().signingIn).toBe(false);
  });

  it("signIn() surfaces an error and clears signingIn", async () => {
    authBeginSignInMock.mockRejectedValue(new Error("sign-in timed out"));
    await useAuthStore.getState().signIn();
    const s = useAuthStore.getState();
    expect(s.signingIn).toBe(false);
    expect(s.error).toContain("timed out");
    expect(s.status.signedIn).toBe(false);
  });

  it("signOut() returns to the signed-out state", async () => {
    useAuthStore.setState({ status: { signedIn: true, email: "a@b.co", name: null } });
    await useAuthStore.getState().signOut();
    expect(useAuthStore.getState().status.signedIn).toBe(false);
    expect(authSignOutMock).toHaveBeenCalled();
  });
});
