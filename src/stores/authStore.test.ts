/**
 * Unit tests for authStore (accounts — P1 + finalize).
 *
 * Covers load() (signed in/out + error degrade), signIn() (status, in-flight
 * toggle, error surfacing), cancelSignIn() (clears state; a cancel is not
 * surfaced as an error), and signOut().
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthStatus } from "../lib/ipc";

const authStatusMock = vi.fn<() => Promise<AuthStatus>>();
const authBeginSignInMock = vi.fn<() => Promise<AuthStatus>>();
const authSignOutMock = vi.fn<() => Promise<void>>();
const authCancelSignInMock = vi.fn<() => Promise<void>>();

vi.mock("../lib/ipc", () => ({
  ipc: {
    authStatus: authStatusMock,
    authBeginSignIn: authBeginSignInMock,
    authCancelSignIn: authCancelSignInMock,
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
  authCancelSignInMock.mockReset().mockResolvedValue(undefined);
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

  it("cancelSignIn() calls the backend and clears signingIn", async () => {
    useAuthStore.setState({ signingIn: true });
    await useAuthStore.getState().cancelSignIn();
    expect(authCancelSignInMock).toHaveBeenCalled();
    expect(useAuthStore.getState().signingIn).toBe(false);
  });

  it("a user-cancelled sign-in is not surfaced as an error", async () => {
    let reject!: (e: Error) => void;
    authBeginSignInMock.mockReturnValue(new Promise<AuthStatus>((_, r) => { reject = r; }));
    const p = useAuthStore.getState().signIn();
    await useAuthStore.getState().cancelSignIn(); // marks cancelling + clears signingIn
    reject(new Error("Sign-in cancelled."));
    await p;
    const s = useAuthStore.getState();
    expect(s.signingIn).toBe(false);
    expect(s.error).toBeNull();
  });

  it("cancelSignIn() clears signingIn even if the backend call fails", async () => {
    authCancelSignInMock.mockRejectedValue(new Error("ipc down"));
    useAuthStore.setState({ signingIn: true });
    await useAuthStore.getState().cancelSignIn();
    expect(useAuthStore.getState().signingIn).toBe(false);
  });
});
