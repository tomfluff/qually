// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Earcons for the Code map: tiny synthesized sound-marks (WebAudio, no
// assets, offline) that confirm state changes multimodally — this app's
// audience may not catch a subtle visual change, so each mark maps 1:1 to a
// semantic action and never plays as decoration. Gated on ui.mapSounds.
//
// This module imports NOTHING. The store sounds undo, coding and deletion, so
// reading the store from here would close an import cycle — which deadlocked
// vitest's module graph whenever the store was imported first. The setting is
// pushed IN instead: App mirrors ui.mapSounds through setSounds.

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

// default ON, matching the store's own default: a sound that only starts
// working after App's first effect would miss the actions taken before it
let sounds = true;
export const setSounds = (v: boolean) => { sounds = v; };
const on = () => sounds;

export const earcon = {
  // a code joins a merge group: short rising pair
  join() { if (!on()) return; tone(440, 0, 0.09); tone(660, 0.07, 0.11); },
  // a code leaves a merge group: falling pair
  evict() { if (!on()) return; tone(520, 0, 0.09); tone(340, 0.07, 0.12); },
  // drag telemetry, one notch quieter than the commits they preview.
  // (No pick-up mark: it fired on every drag including the ones that go
  // nowhere, so it carried no information the crossings do not.)
  // the held chip crosses INTO a group's field (would join on release)
  hoverIn() { if (!on()) return; tone(587, 0, 0.06, 0.022); },
  // the held chip crosses OUT of a group's field (would leave on release)
  hoverOut() { if (!on()) return; tone(415, 0, 0.07, 0.022); },
  // an AI request left the device: a double tick. Two syllables for a send,
  // and the COUNT is what tells it apart from the single-blip marks — a 2
  // semitone gap at 50ms is not a difference anyone can hear.
  aiStart() { if (!on()) return; tone(880, 0, 0.04, 0.03, "triangle"); tone(880, 0.07, 0.04, 0.03, "triangle"); },
  // the AI result landed: gentle two-note resolve
  aiDone() { if (!on()) return; tone(587, 0, 0.1, 0.04); tone(880, 0.09, 0.16, 0.04); },
  // a merge was accepted: settled low-high confirmation
  accept() { if (!on()) return; tone(330, 0, 0.1, 0.05); tone(494, 0.08, 0.14, 0.05); tone(659, 0.16, 0.18, 0.04); },
  // a reject proposal was applied: settled DOWNWARD confirmation — done, but
  // something was set aside (distinct from the affirming accept)
  reject() { if (!on()) return; tone(392, 0, 0.1, 0.05); tone(294, 0.08, 0.16, 0.05); },
  // a proposal was skipped/dismissed: muted tap
  skip() { if (!on()) return; tone(300, 0, 0.06, 0.03, "triangle"); },
  // the code palette opened: a soft short blip — an invitation, not a commit.
  // Triangle, so it can't be confused with the sine coding marks it precedes.
  open() { if (!on()) return; tone(659, 0, 0.05, 0.03, "triangle"); },
  // a code was applied to a selection: the app's most frequent act, so the
  // mark is short and unobtrusive — one clean note, no interval.
  // (0.05 gain: the earlier 0.035 was reported inaudible on laptop speakers)
  code() { if (!on()) return; tone(784, 0, 0.09, 0.05); },
  // a coded segment was removed: the same note a fifth down
  uncode() { if (!on()) return; tone(523, 0, 0.09, 0.05); },
  // a step was undone: a backwards sweep, high to low
  undo() { if (!on()) return; tone(659, 0, 0.07, 0.035, "triangle"); tone(494, 0.06, 0.1, 0.035, "triangle"); },
  // and redone: the same sweep forwards
  redo() { if (!on()) return; tone(494, 0, 0.07, 0.035, "triangle"); tone(659, 0.06, 0.1, 0.035, "triangle"); },
  // the edge of the history: nothing there to undo or redo
  nothing() { if (!on()) return; tone(233, 0, 0.09, 0.025, "triangle"); },
  // an arrangement settled (Clean up, Reset layout, a group moved): one note
  // that RESTS. Told apart by duration, not pitch — every other single mark
  // is under 0.1s, so this is the only one that hangs; two-note shapes were
  // all taken (rising sine = join/aiDone, falling = evict/reject, falling
  // triangle = undo), and marks separated only by register are marks nobody
  // can tell apart.
  settle() { if (!on()) return; tone(392, 0, 0.3, 0.03); },
  // something failed: low buzz
  error() { if (!on()) return; tone(180, 0, 0.22, 0.05, "square"); },
};
