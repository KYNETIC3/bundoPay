"use client";

/** Short, soft confirmations for the moments that matter: money moved, a transfer approved, a dispute won.
 * Sound and haptics are off until the merchant turns them on in Settings. Tones are synthesised, so there are
 * no audio files to load, and each one is under a quarter of a second. */

export type Cue = "moved" | "approved" | "won" | "error" | "tap";

const KEY = "bundo.feedback.v1";
type Prefs = { sound: boolean; haptics: boolean };
const OFF: Prefs = { sound: false, haptics: false };

export function feedbackPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...OFF, ...(JSON.parse(raw) as Partial<Prefs>) } : OFF;
  } catch {
    return OFF;
  }
}

export function setFeedbackPrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {}
}

// Notes in Hz and their start offsets in seconds: rising for good news, a soft low pair for errors.
const TONES: Record<Cue, [number, number][]> = {
  moved: [[659.25, 0], [880, 0.07]],
  approved: [[523.25, 0], [659.25, 0.06], [783.99, 0.12]],
  won: [[587.33, 0], [739.99, 0.08], [880, 0.16]],
  error: [[311.13, 0], [261.63, 0.09]],
  tap: [[1046.5, 0]],
};
const BUZZ: Record<Cue, number | number[]> = { moved: 12, approved: [10, 40, 18], won: [12, 50, 12, 50, 24], error: [30, 60, 30], tap: 6 };

let ctx: AudioContext | null = null;

function play(cue: Cue) {
  ctx ??= new AudioContext();
  const now = ctx.currentTime;
  const loud = cue === "tap" ? 0.03 : 0.07;
  for (const [hz, at] of TONES[cue]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0, now + at);
    gain.gain.linearRampToValueAtTime(loud, now + at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + at);
    osc.stop(now + at + 0.2);
  }
}

export function feedback(cue: Cue) {
  if (typeof window === "undefined") return;
  const p = feedbackPrefs();
  try {
    if (p.sound) play(cue);
    if (p.haptics) navigator.vibrate?.(BUZZ[cue]);
  } catch {
    /* audio or vibration not allowed here; the visual confirmation still shows */
  }
}
