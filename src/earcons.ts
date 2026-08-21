// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Earcons for the Code map: tiny synthesized sound-marks (WebAudio, no
// assets, offline) that confirm state changes multimodally — this app's
// audience may not catch a subtle visual change, so each mark maps 1:1 to a
// semantic action and never plays as decoration. Gated on ui.mapSounds.
import { useStore } from "./state/store";

let ctx: AudioContext | null = null;
// Lifecycle guard: construction can throw (no WebAudio), and a context can sit
// suspended (created outside a user gesture, or auto-suspended in a background
// tab) — a suspended clock would queue tones that burst on resume. Sounds must
// never break the action they decorate, so failure means silence.
const ac = (): AudioContext | null => {
  try {
    ctx ??= new AudioContext();
  } catch {
    return null;
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx.state === "running" ? ctx : null;
};

function tone(freq: number, at: number, dur: number, gain = 0.05, type: OscillatorType = "sine") {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

const on = () => useStore.getState().ui.mapSounds;

export const earcon = {
  // a code joins a merge group: short rising pair
  join() { if (!on()) return; tone(440, 0, 0.09); tone(660, 0.07, 0.11); },
  // a code leaves a merge group: falling pair
  evict() { if (!on()) return; tone(520, 0, 0.09); tone(340, 0.07, 0.12); },
  // an AI request left the device: one soft tick
  aiStart() { if (!on()) return; tone(880, 0, 0.05, 0.03, "triangle"); },
  // the AI result landed: gentle two-note resolve
  aiDone() { if (!on()) return; tone(587, 0, 0.1, 0.04); tone(880, 0.09, 0.16, 0.04); },
  // a merge was accepted: settled low-high confirmation
  accept() { if (!on()) return; tone(330, 0, 0.1, 0.05); tone(494, 0.08, 0.14, 0.05); tone(659, 0.16, 0.18, 0.04); },
  // a reject proposal was applied: settled DOWNWARD confirmation — done, but
  // something was set aside (distinct from the affirming accept)
  reject() { if (!on()) return; tone(392, 0, 0.1, 0.05); tone(294, 0.08, 0.16, 0.05); },
  // a proposal was skipped/dismissed: muted tap
  skip() { if (!on()) return; tone(300, 0, 0.06, 0.03, "triangle"); },
  // something failed: low buzz
  error() { if (!on()) return; tone(180, 0, 0.22, 0.05, "square"); },
};
