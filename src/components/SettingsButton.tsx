// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, speakersOf, speakerColor, weightOf, inkOn, LOOP_SPEEDS, MAP_RING_PX, type SpeakerWeight } from "../state/store";
import { openColorPicker } from "../colorPicker";
import { PALETTES } from "../palettes";
import { MODELS, modelOf } from "../ai/openai";
import { getKey, setKey, isRemembered } from "../ai/key";
import { useDialogFocus } from "../useDialogFocus";
import { Icon } from "./Icon";
import { announce } from "../announce";

// Settings popover: instant-apply controls (no save button), all persisted via ui autosave.
export function SettingsButton() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"Appearance"|"Reading"|"Media"|"Coding"|"Speakers"|"AI">("Appearance");
  const [dragSpeed, setDragSpeed] = useState<number | null>(null); // scroll slider mid-drag value (%)
  // Esc can close the modal mid-drag — React fires no blur on unmount, so an
  // uncommitted drag value would silently vanish. Commit it on close instead.
  useEffect(() => {
    if (!open && dragSpeed !== null) { setUi({ scrollSpeed: dragSpeed / 100 }); setDragSpeed(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const ref = useRef<HTMLDivElement>(null);
  const dialogRef = useDialogFocus();
  const fontSize = useStore((s) => s.ui.fontSize);
  const setFontSize = useStore((s) => s.setFontSize);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const setSidebarFontSize = useStore((s) => s.setSidebarFontSize);
  const mode = useStore((s) => s.hotbar.mode);
  const setHotbarMode = useStore((s) => s.setHotbarMode);
  const palettePos = useStore((s) => s.ui.palettePos);
  const accent = useStore((s) => s.ui.accent);
  const speakerNames = useStore((s) => s.ui.speakerNames);
  const fontFamily = useStore((s) => s.ui.fontFamily);
  const warnSize = useStore((s) => s.ui.warnSize);
  const laneWidth = useStore((s) => s.ui.laneWidth);
  const mapRing = useStore((s) => s.ui.mapRing);
  const lanePattern = useStore((s) => s.ui.lanePattern);
  const minimapDetail = useStore((s) => s.ui.minimapDetail);
  const coderName = useStore((s) => s.ui.coderName);
  const projectName = useStore((s) => s.projectName);
  const mapSounds = useStore((s) => s.ui.mapSounds);
  const setProjectName = useStore((s) => s.setProjectName);
  const mergeLines = useStore((s) => s.ui.mergeLines);
  const mergeGapOn = useStore((s) => s.ui.mergeGapOn);
  const mergeGap = useStore((s) => s.ui.mergeGap);
  const showLineNumbers = useStore((s) => s.ui.showLineNumbers);
  const scrollSpeed = useStore((s) => s.ui.scrollSpeed);
  const loopEdit = useStore((s) => s.ui.loopEdit);
  const loopSpeed = useStore((s) => s.ui.loopSpeed);
  const claimUnattributed = useStore((s) => s.claimUnattributed);
  const setUi = useStore((s) => s.setUi);
  const dark = useStore((s) => s.ui.dark);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const setZen = useStore((s) => s.setZen);

  // Modal, not a popover: it holds a lot now (per-speaker rows, AI settings), and a
  // 286px dropdown made it a long thin scroll. Same shell as the Help/AI dialogs.
  useEffect(() => {
    if (!open) return;
    // Bail while something INSIDE the dialog owns Escape: the colour picker, or a
    // speaker's rename field. This listener is on the capture phase, so a
    // stopPropagation from their own (bubble-phase) handlers can never reach it —
    // without the guard one Escape closed the inner thing AND the dialog under it,
    // instead of peeling one layer the way Escape does everywhere else.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".clrpop, .spkform")) return;
      e.stopPropagation(); setOpen(false);
    };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  }, [open]);

  // Reading = how the transcript reads; Media = the loaded audio/video;
  // Coding = lanes + keyboard workflow. One concern per tab, grouped inside.
  const TABS = ["Appearance", "Reading", "Media", "Coding", "Speakers", "AI"] as const;

  return (
    <div className="settings-wrap" ref={ref}>
      <button className="btn iconlabel" aria-expanded={open} aria-haspopup="dialog"
        title="Settings" onClick={() => setOpen((o) => !o)}>
        <Icon name="settings" size={16} /> <span className="blabel">Settings</span>
      </button>
      {open && (
        <div className="about-backdrop" onMouseDown={() => setOpen(false)}>
          <div className="about set-modal" ref={dialogRef} role="dialog" aria-modal="true"
            aria-labelledby="settings-title" onMouseDown={(e) => e.stopPropagation()}>
            <div className="about-head">
              <h2 id="settings-title">Settings</h2>
              <button className="btn iconbtn" onClick={() => setOpen(false)} title="Close (Esc)"><Icon name="x" size={16} /></button>
            </div>

            {/* left-nav tabs, not a masonry: CSS multi-column in a height-capped scroll
                container overflows sideways (fills the height, then starts a new column to
                the right). One category at a time, each panel scrolls vertically. */}
            <div className="set-body">
              <nav className="set-nav">
                {TABS.map((t) => (
                  <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>
                ))}
              </nav>
              <div className="set-panel nicescroll">
              {tab === "Appearance" && <>
                <div className="set-h">Colour</div>
                <div className="srow">
                  <span>Theme</span>
                  <div className="segmented">
                    <button className={"seg" + (!dark ? " on" : "")} onClick={() => { if (dark) toggleTheme(); }}>Light</button>
                    <button className={"seg" + (dark ? " on" : "")} onClick={() => { if (!dark) toggleTheme(); }}>Dark</button>
                  </div>
                </div>
                <div className="srow">
                  <span>Primary colour</span>
                  <div className="swatches">
                    {PALETTES.map((p) => (
                      <button key={p.id} className={"swatchbtn" + (accent === p.id ? " on" : "")}
                        style={{ background: dark ? p.dark : p.light }}
                        title={p.name} onClick={() => setUi({ accent: p.id })} />
                    ))}
                  </div>
                </div>
                <div className="set-h">Text</div>
                {/* WCAG 1.4.4 expects text to reach 200% without loss of content: from the
                    16px default that is 32px, which the old max of 30 could not even reach. */}
                <label className="srow">
                  <span>Transcript text</span>
                  <input type="range" min={12} max={48} value={fontSize} onChange={(e) => setFontSize(+e.target.value)} />
                  <span className="sval">{fontSize}</span>
                  <button className="sreset" onClick={(e) => { e.preventDefault(); setFontSize(16); }} title="Reset to 16px">Reset</button>
                </label>
                <label className="srow">
                  <span>Panel text</span>
                  <input type="range" min={11} max={36} value={sidebarFontSize} onChange={(e) => setSidebarFontSize(+e.target.value)} />
                  <span className="sval">{sidebarFontSize}</span>
                  <button className="sreset" onClick={(e) => { e.preventDefault(); setSidebarFontSize(13); }} title="Reset to 13px">Reset</button>
                </label>
                {/* "Sidebar text" undersold it: the same value sizes the code list, tabs,
                    menus, popovers, tooltips, the event list, the Browse and Summary panes
                    and the video dock. Naming one of nine made the other eight surprises. */}
                <div className="settings-note">Everything except the transcript: code list, tabs, menus, popovers, tooltips, video dock. For buttons and icons too, use browser zoom (<kbd>Ctrl</kbd> <kbd>+</kbd> / <kbd>Ctrl</kbd> <kbd>-</kbd>, <kbd>Ctrl</kbd> <kbd>0</kbd> resets).</div>
                <div className="srow">
                  <span>Reading font</span>
                  <div className="segmented fontseg">
                    <button className={"seg" + (fontFamily === "system" ? " on" : "")} onClick={() => setUi({ fontFamily: "system" })}>System</button>
                    <button className={"seg" + (fontFamily === "serif" ? " on" : "")} style={{ fontFamily: "Georgia, serif" }} onClick={() => setUi({ fontFamily: "serif" })}>Serif</button>
                    <button className={"seg" + (fontFamily === "atkinson" ? " on" : "")} style={{ fontFamily: "'Atkinson Hyperlegible', sans-serif" }} onClick={() => setUi({ fontFamily: "atkinson" })}>Atkinson</button>
                  </div>
                </div>
                <div className="settings-note"><b>Atkinson Hyperlegible</b> keeps easily-confused letters (b/d, I/l/1, O/0) distinct — designed for low vision.</div>
              </>}

              {tab === "Reading" && <>
                <div className="set-h">Layout</div>
                <div className="srow">
                  <span>Line numbers</span>
                  <div className="segmented">
                    <button className={"seg" + (!showLineNumbers ? " on" : "")} onClick={() => setUi({ showLineNumbers: false })}>Off</button>
                    <button className={"seg" + (showLineNumbers ? " on" : "")} onClick={() => setUi({ showLineNumbers: true })}>On</button>
                  </div>
                </div>
                <div className="srow">
                  <span>Speaker names</span>
                  <div className="segmented">
                    <button className={"seg" + (speakerNames === "full" ? " on" : "")} onClick={() => setUi({ speakerNames: "full" })}>Full</button>
                    <button className={"seg" + (speakerNames === "short" ? " on" : "")} onClick={() => setUi({ speakerNames: "short" })}>Short</button>
                  </div>
                </div>
                <div className="settings-note">Short shows a unique abbreviation (hover for the full name).</div>
                <div className="srow">
                  <span>Merge split lines</span>
                  <div className="segmented">
                    <button className={"seg" + (!mergeLines ? " on" : "")} onClick={() => setUi({ mergeLines: false })}>Off</button>
                    <button className={"seg" + (mergeLines ? " on" : "")} onClick={() => setUi({ mergeLines: true })}>On</button>
                  </div>
                </div>
                <div className="settings-note">Joins a speaker's unfinished lines (no . ? ! …) into one reading unit.</div>
                <div className="srow">
                  <span>Merge by pause</span>
                  <div className="segmented">
                    <button className={"seg" + (!mergeGapOn ? " on" : "")} onClick={() => setUi({ mergeGapOn: false })}>Off</button>
                    <button className={"seg" + (mergeGapOn ? " on" : "")} onClick={() => setUi({ mergeGapOn: true })}>On</button>
                  </div>
                </div>
                {mergeGapOn && (
                  <label className="srow">
                    <span>Pause gap</span>
                    <input type="range" min={1} max={15} step={1} value={mergeGap}
                      onChange={(e) => setUi({ mergeGap: +e.target.value })} />
                    <span className="sval">{mergeGap}s</span>
                    <button className="sreset" onClick={(e) => { e.preventDefault(); setUi({ mergeGap: 3 }); }} title="Reset to 3s">Reset</button>
                  </label>
                )}
                <div className="settings-note">Also joins consecutive lines from one speaker when the pause between them fits the gap. Line ends come from <code>end_timestamp</code> if the import had one, otherwise estimated from length.</div>
                <div className="srow">
                  <span>Minimap</span>
                  <div className="segmented">
                    <button className={"seg" + (minimapDetail === "detailed" ? " on" : "")} onClick={() => setUi({ minimapDetail: "detailed" })}>Detailed</button>
                    <button className={"seg" + (minimapDetail === "simplified" ? " on" : "")} onClick={() => setUi({ minimapDetail: "simplified" })}>Simple</button>
                  </div>
                </div>
                <div className="settings-note">Simple uses bigger, blockier marks. Drag the minimap's edge to widen it.</div>
                <div className="set-h">Scrolling</div>
                <label className="srow">
                  <span>Scroll distance</span>
                  {/* percent with 5% steps (the old 0.25× steps made the thumb jump);
                      committed on RELEASE — a store write per tick re-rendered the
                      whole transcript under the drag, which read as jitter */}
                  {/* 200% is the device's own speed: the app's 100% is deliberately
                      half of it, which is the readable default for a transcript */}
                  <input type="range" min={25} max={400} step={5}
                    value={dragSpeed ?? Math.round(scrollSpeed * 100)}
                    onChange={(e) => setDragSpeed(+e.target.value)}
                    onPointerUp={() => { if (dragSpeed !== null) { setUi({ scrollSpeed: dragSpeed / 100 }); setDragSpeed(null); } }}
                    onKeyUp={() => { if (dragSpeed !== null) { setUi({ scrollSpeed: dragSpeed / 100 }); setDragSpeed(null); } }}
                    onBlur={() => { if (dragSpeed !== null) { setUi({ scrollSpeed: dragSpeed / 100 }); setDragSpeed(null); } }} />
                  <span className="sval">{dragSpeed ?? Math.round(scrollSpeed * 100)}%</span>
                  <button className="sreset" onClick={(e) => { e.preventDefault(); setDragSpeed(null); setUi({ scrollSpeed: 1 }); }} title="Reset to 100%">Reset</button>
                </label>
                <div className="settings-note">How far one wheel click moves any list. 100% is half your device's default; 200% matches it.</div>
              </>}

              {tab === "Media" && <>
                <div className="settings-note"><kbd>Space</kbd> plays/pauses the loaded media, <kbd>[</kbd> and <kbd>]</kbd> change its speed — except while typing.</div>
                <div className="set-h">Editing loop</div>
                <div className="srow">
                  <span>Loop while editing</span>
                  <div className="segmented">
                    <button className={"seg" + (!loopEdit ? " on" : "")} onClick={() => setUi({ loopEdit: false })}>Off</button>
                    <button className={"seg" + (loopEdit ? " on" : "")} onClick={() => setUi({ loopEdit: true })}>On</button>
                  </div>
                </div>
                <div className="srow">
                  <span>Loop speed</span>
                  <div className="segmented loopseg">
                    {LOOP_SPEEDS.map((s) => (
                      <button key={s} className={"seg" + (loopSpeed === s ? " on" : "")}
                        onClick={() => setUi({ loopSpeed: s })}>{s}×</button>
                    ))}
                  </div>
                </div>
                <div className="settings-note">Double-click a line to loop its utterance while you correct it. The dock's own speed returns when the loop ends.</div>
              </>}

              {tab === "Coding" && <>
                <label className="srow">
                  <span>Project name</span>
                  <input type="text" className="settext" value={projectName} placeholder="e.g. Voice-UI field study"
                    onChange={(e) => setProjectName(e.target.value)} />
                </label>
                <div className="settings-note">Leads every exported filename, with the export date. Saved in the project file.</div>
                <label className="srow">
                  <span>Sounds</span>
                  <input type="checkbox" checked={mapSounds}
                    onChange={(e) => setUi({ mapSounds: e.target.checked })} />
                </label>
                <div className="settings-note">Quiet sound-marks confirm what happened — coding a line, undo and redo, joining or leaving a group, AI requests, accepts. Multimodal feedback that doesn't depend on catching a visual change.</div>
                <div className="srow">
                  <span>Selection ring</span>
                  <div className="segmented">
                    {(["xs", "sm", "md", "lg", "xl"] as const).map((sz) => (
                      <button key={sz} className={"seg" + (mapRing === sz ? " on" : "")}
                        onClick={() => setUi({ mapRing: sz })}
                        title={`${MAP_RING_PX[sz]}px around every selected code`}>{sz}</button>
                    ))}
                  </div>
                </div>
                <div className="settings-note">How heavy the ring around a selected code draws on the Code map — {MAP_RING_PX[mapRing]}px, and it holds that thickness at every zoom, so a selection stays findable with the whole codebook on screen.</div>
                <div className="srow">
                  <span>Code name style</span>
                  <div className="segmented">
                    <button className="seg" onClick={() => useStore.getState().normalizeCodeCase("lower")}
                      title="Make every code name start with a lowercase letter — one undo step">
                      start lowercase
                    </button>
                    <button className="seg" onClick={() => useStore.getState().normalizeCodeCase("capital")}
                      title="Make every code name start with a capital letter — one undo step">
                      Start with a capital
                    </button>
                  </div>
                </div>
                <div className="settings-note">One coherent first letter across the codebook (AI proposals often arrive Capitalized while hand-typed codes start lowercase). Only the first letter changes; one undo step reverses the sweep.</div>
                <label className="srow">
                  <span>Coder name</span>
                  <input type="text" className="settext" value={coderName} placeholder="Your name"
                    onChange={(e) => setUi({ coderName: e.target.value })}
                    onBlur={() => claimUnattributed()} />
                </label>
                <div className="settings-note">Written as <code>proposed_by</code> on your segments — how two coders are told apart in the exported CSV.</div>
                <div className="set-h">Lanes</div>
                <div className="srow">
                  <span>Lane width</span>
                  <div className="segmented">
                    {(["xs", "sm", "md", "lg"] as const).map((sz) => (
                      <button key={sz} className={"seg" + (laneWidth === sz ? " on" : "")} onClick={() => setUi({ laneWidth: sz })}>{sz}</button>
                    ))}
                  </div>
                </div>
                <div className="srow">
                  <span>Code patterns</span>
                  <div className="segmented">
                    <button className={"seg" + (!lanePattern ? " on" : "")} onClick={() => setUi({ lanePattern: false })}>Off</button>
                    <button className={"seg" + (lanePattern ? " on" : "")} onClick={() => setUi({ lanePattern: true })}>On</button>
                  </div>
                </div>
                <div className="settings-note">A texture as well as a colour, so codes stay apart without relying on hue.</div>
                <div className="srow">
                  <span>Mixed-speaker badge</span>
                  <div className="segmented">
                    {(["xs", "sm", "md", "lg"] as const).map((sz) => (
                      <button key={sz} className={"seg" + (warnSize === sz ? " on" : "")} onClick={() => setUi({ warnSize: sz })}>{sz}</button>
                    ))}
                  </div>
                </div>
                <div className="settings-note">The <b>!</b> on a segment whose excerpt keeps only its dominant speaker.</div>
                <div className="set-h">Shortcuts</div>
                <div className="srow">
                  <span>Hotbar 1–9</span>
                  <div className="segmented">
                    <button className={"seg" + (mode === "auto" ? " on" : "")} onClick={() => setHotbarMode("auto")}>Auto</button>
                    <button className={"seg" + (mode === "pinned" ? " on" : "")} onClick={() => setHotbarMode("pinned")}>Pinned</button>
                  </div>
                </div>
                <div className="settings-note">Auto fills the tiles with your most-used codes; pinned shows only codes you pin.</div>
                <div className="srow">
                  <span>Popup cards</span>
                  <div className="segmented">
                    <button className={"seg" + (palettePos === "auto" ? " on" : "")} onClick={() => setUi({ palettePos: "auto" })}>Near</button>
                    <button className={"seg" + (palettePos === "centered" ? " on" : "")} onClick={() => setUi({ palettePos: "centered" })}>Center</button>
                  </div>
                </div>
                <div className="settings-note">Where the code palette (<kbd>0</kbd>) and the add-event card open: next to the lines they're about, or screen-centered.</div>
              </>}

              {tab === "Speakers" && <SpeakerRows />}
              {tab === "AI" && <AiSettings />}
              </div>
            </div>

            <div className="set-foot">
              <button className="btn zenbtn" onClick={() => { setZen(true); setOpen(false); }}>
                <Icon name="eye-dotted" size={19} /> Enter zen mode
              </button>
              <span className="set-foot-note">Hides the toolbar and every panel for distraction-free reading and coding. Press Esc to exit.</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Who is in this study, and how each one looks. Derived from the transcripts, so it
// works for a 2-person interview and a 6-person focus group alike, whatever the
// speakers are called — no "the researcher is R" convention anywhere.
function SpeakerRows() {
  const ui = useStore((s) => s.ui);
  // select STABLE refs and derive — speakersOf() builds a new array on every call, and a
  // selector that returns a fresh array re-renders forever (same trap as CodeMenu)
  const transcripts = useStore((s) => s.transcripts);
  const tabs = useStore((s) => s.tabs);
  const speakers = useMemo(() => speakersOf({ transcripts, tabs }), [transcripts, tabs]);
  const setUi = useStore((s) => s.setUi);
  // never a silently blank panel — say why there's nothing here
  if (!speakers.length) return (
    <div className="settings-note">
      Import a transcript first — its speakers appear here for recolouring
      and emphasis (quiet/bold).
    </div>
  );

  const setWeight = (sp: string, w: SpeakerWeight) =>
    setUi({ speakerWeight: { ...ui.speakerWeight, [sp]: w } });

  return (
    <>
      {speakers.map((sp) => {
        const w = weightOf(ui, sp);
        return (
          <div className="srow" key={sp}>
            {/* native title, not data-tip: the custom bubble clipped over the modal */}
            <button className="spkswatch"
              style={{ background: speakerColor(ui, sp), color: inkOn(speakerColor(ui, sp)) }}
              title={`Recolour ${sp}`} aria-label={`Recolour ${sp}`}
              onClick={(e) => openColorPicker(speakerColor(ui, sp),
                (v) => setUi({ speakerColors: { ...ui.speakerColors, [sp]: v } }), e.currentTarget)}>
              {sp.slice(0, 3)}
            </button>
            <SpeakerName sp={sp} others={speakers} />
            {/* The control previews its own effect: an "A" at each weight, rather than
                three words to read (and translate). The note below carries the meaning;
                aria-label carries it for a screen reader. */}
            <div className="segmented wseg">
              {WEIGHTS.map(([id, label]) => (
                <button key={id} className={"seg " + (w === id ? "on " : "") + `wt-${id}`}
                  aria-label={`${sp}: ${label}`} aria-pressed={w === id}
                  onClick={() => setWeight(sp, id)}>A</button>
              ))}
            </div>
          </div>
        );
      })}
      <div className="settings-note">
        Click a swatch to recolour, or the name to rename that speaker in every transcript.
      </div>
    </>
  );
}

// The name, and the form to change it. Renaming rewrites the label on every line
// that carries it, so it says what it will do before it does it — including when
// the new name already belongs to another speaker, which merges the two.
function SpeakerName({ sp, others }: { sp: string; others: string[] }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(sp);
  const [err, setErr] = useState<string | null>(null);
  const open = () => { setName(sp); setErr(null); setEditing(true); };
  const commit = () => {
    const e = useStore.getState().renameSpeaker(sp, name);
    if (e) { setErr(e); return; }
    announce(`Speaker renamed to ${name.trim()}.`);
    setEditing(false);
  };
  if (!editing) {
    return (
      <button className="spkname spkrename" onClick={open}
        title={`Rename ${sp} everywhere`} aria-label={`Rename speaker ${sp}`}>
        {sp}
      </button>
    );
  }
  const merges = others.some((o) => o !== sp && o === name.trim());
  return (
    <span className="spkname spkform">
      <input value={name} autoFocus aria-label={`New name for ${sp}`}
        onChange={(e) => { setName(e.target.value); setErr(null); }}
        onKeyDown={(e) => {
          e.stopPropagation(); // the settings modal's own key handling stays out of the field
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(false);
        }} />
      <button className="btn" onClick={commit}>Rename</button>
      <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
      {err && <span className="spkerr">{err}</span>}
      {!err && merges && <span className="spknote">merges with {name.trim()}</span>}
    </span>
  );
}
const WEIGHTS: [SpeakerWeight, string][] = [
  ["quiet", "quiet — dim this speaker's words"],
  ["normal", "normal weight"],
  ["bold", "bold — emphasise this speaker's words"],
];

// Optional AI assistance. Off unless a key is entered — the app does nothing over
// the network without one, which is what keeps the "stays in your browser" promise
// true for everyone who never comes down here.
function AiSettings() {
  const ai = useStore((s) => s.ai);
  const setAi = useStore((s) => s.setAi);
  const [key, setKeyInput] = useState(getKey);
  const [remember, setRemember] = useState(isRemembered);
  const [terms, setTerms] = useState(ai.redactTerms.join(", "));

  const commitKey = (k: string, r: boolean) => { setKeyInput(k); setRemember(r); setKey(k.trim(), r); };
  const commitTerms = (v: string) => {
    setTerms(v);
    setAi({ redactTerms: v.split(",").map((t) => t.trim()).filter(Boolean) });
  };

  return (
    <>
      <div className="settings-note">
        Off until you add a key. Anything you run sends transcript lines to OpenAI —
        you approve each request and see exactly what's sent. The AI only proposes
        (marks, grounds, suggests merges); nothing is applied without your decision.
      </div>

      <div className="set-h">Access</div>
      <label className="srow aicol">
        <span>OpenAI key</span>
        <input type="password" className="aikey" placeholder="sk-…" value={key} autoComplete="off"
          onChange={(e) => commitKey(e.target.value, remember)} />
      </label>
      <label className="srow aicheck">
        <input type="checkbox" checked={remember}
          onChange={(e) => commitKey(key, e.target.checked)} />
        <span>Remember on this device</span>
      </label>
      <div className="settings-note">
        {remember
          ? "Stored in this browser until you clear it. Don't tick this on a shared machine."
          : "Kept for this session only — you'll re-enter it next time."}
      </div>

      <div className="set-h">Model</div>
      <div className="srow aicol">
        <div className="segmented aimodels">
          {MODELS.map((m) => (
            <button key={m.id} className={"seg" + (ai.model === m.id ? " on" : "")}
              title={`${m.blurb} — $${m.in}/$${m.out} per 1M tokens in/out`}
              onClick={() => setAi({ model: m.id })}>{m.name}</button>
          ))}
        </div>
      </div>
      <div className="settings-note">
        {/* modelOf, not find()! — a persisted ai.model that has since left MODELS
            (model list rotates) made this throw and killed the whole AI tab */}
        {modelOf(ai.model).blurb} · ${modelOf(ai.model).in} in /
        ${modelOf(ai.model).out} out per 1M tokens.
      </div>

      <div className="set-h">Privacy</div>
      <label className="srow aicol">
        <span>Redact before sending</span>
        <textarea className="airedact" rows={2} placeholder="Ann Lee, Acme Corp, Springfield"
          value={terms} onChange={(e) => commitTerms(e.target.value)} />
      </label>
      <div className="settings-note">
        Comma-separated. Participant names, employers, and places are replaced with
        <code> [REDACTED_n]</code> on the way out and restored on the way back.
      </div>
    </>
  );
}
