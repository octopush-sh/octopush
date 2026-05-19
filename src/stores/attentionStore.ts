/**
 * Attention notifications — when an agent or terminal needs the user.
 *
 * In the agentic era you typically have several workspaces running in
 * parallel; without something pulling your eye to the right one, you'll
 * miss completions and leave the model idling. This store flags
 * workspaces that need attention so the rail can show a brass pulse and
 * a chime can play.
 *
 * Two kinds of attention triggers:
 *   - "chat":     a streaming agent reply finished in a workspace that
 *                 isn't currently focused.
 *   - "terminal": a PTY emitted a BEL (\x07) — the shell or running
 *                 program asked for the user's attention — while that
 *                 terminal wasn't visible.
 *
 * Flags clear automatically when the user switches to the workspace.
 * Sound is rate-limited (one chime per ~2s) so a burst of completions
 * doesn't ring the bell six times in a row.
 */

import { create } from "zustand";

export type AttentionKind = "chat" | "terminal";

export interface AttentionFlag {
  kind: AttentionKind;
  at: number; // ms timestamp of the most recent ping
}

interface AttentionState {
  /** Per-workspace flag. Absent = no attention needed. */
  flagsByWs: Record<string, AttentionFlag>;
  /** User preference — defaults to on; toggle in Settings → General. */
  soundEnabled: boolean;
  /** Internal: last chime timestamp, used for rate-limiting. */
  lastChimeAt: number;

  /** Flag `workspaceId` and (if enabled) play the chime. Idempotent
   *  within the rate-limit window. */
  ping: (workspaceId: string, kind: AttentionKind) => void;
  /** Clear the flag for a workspace (called when the user focuses it). */
  clear: (workspaceId: string) => void;
  /** Persisted toggle. */
  setSoundEnabled: (v: boolean) => void;
}

const STORAGE_KEY = "octopush.attention.soundEnabled";
const CHIME_COOLDOWN_MS = 2_000;

const readSoundPref = (): boolean => {
  if (typeof localStorage === "undefined") return true;
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === null ? true : raw === "1";
};

export const useAttentionStore = create<AttentionState>((set, get) => ({
  flagsByWs: {},
  soundEnabled: readSoundPref(),
  lastChimeAt: 0,

  ping: (workspaceId, kind) => {
    const now = Date.now();
    set((s) => ({
      flagsByWs: { ...s.flagsByWs, [workspaceId]: { kind, at: now } },
    }));
    // Sound, with cooldown so paired chat+terminal completions don't
    // produce a double-chime within the same second.
    const state = get();
    if (state.soundEnabled && now - state.lastChimeAt > CHIME_COOLDOWN_MS) {
      set({ lastChimeAt: now });
      playChime().catch(() => {
        // Audio context may be locked until the user interacts; ignore.
      });
    }
  },

  clear: (workspaceId) =>
    set((s) => {
      if (!(workspaceId in s.flagsByWs)) return s;
      const next = { ...s.flagsByWs };
      delete next[workspaceId];
      return { flagsByWs: next };
    }),

  setSoundEnabled: (v) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    }
    set({ soundEnabled: v });
  },
}));

// ── Chime synthesis ────────────────────────────────────────────────

/**
 * A short two-note brass-y chime synthesised live so we don't ship a
 * .wav. ~250ms total. Uses Web Audio API. Resolves once playback
 * actually starts (so the caller can detect autoplay rejection if it
 * matters; we don't currently care).
 */
async function playChime(): Promise<void> {
  // Lazy-init the AudioContext to avoid burning resources at boot.
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      return;
    }
  }

  const now = ctx.currentTime;
  // Two-note pleasant chime: A5 then E6, staggered ~80ms apart.
  playNote(ctx, 880, now, 0.18, 0.12);
  playNote(ctx, 1318.5, now + 0.08, 0.22, 0.1);

  // Auto-close the context once the notes have finished so we don't
  // accumulate stale ones across many chimes.
  setTimeout(() => ctx.close().catch(() => {}), 600);
}

function playNote(
  ctx: AudioContext,
  freq: number,
  start: number,
  duration: number,
  peakGain: number,
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peakGain, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}
