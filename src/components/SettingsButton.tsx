import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, speakersOf, speakerColor, weightOf, inkOn, type SpeakerWeight } from "../state/store";
import { openColorPicker } from "../colorPicker";
import { PALETTES } from "../palettes";
import { MODELS } from "../ai/openai";
import { getKey, setKey, isRemembered } from "../ai/key";

// Settings popover: instant-apply controls (no save button), all persisted via ui autosave.
export function SettingsButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fontSize = useStore((s) => s.ui.fontSize);
  const setFontSize = useStore((s) => s.setFontSize);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const setSidebarFontSize = useStore((s) => s.setSidebarFontSize);
  const mode = useStore((s) => s.hotbar.mode);
  const setHotbarMode = useStore((s) => s.setHotbarMode);
  const palettePos = useStore((s) => s.ui.palettePos);
  const accent = useStore((s) => s.ui.accent);
  const speakerNames = useStore((s) => s.ui.speakerNames);
  const warnSize = useStore((s) => s.ui.warnSize);
  const laneWidth = useStore((s) => s.ui.laneWidth);
  const lanePattern = useStore((s) => s.ui.lanePattern);
  const minimapDetail = useStore((s) => s.ui.minimapDetail);
  const mergeLines = useStore((s) => s.ui.mergeLines);
  const showLineNumbers = useStore((s) => s.ui.showLineNumbers);
  const setUi = useStore((s) => s.setUi);
  const dark = useStore((s) => s.ui.dark);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const setZen = useStore((s) => s.setZen);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    // stopPropagation so App's global Esc doesn't also clear the line selection
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  return (
    <div className="settings-wrap" ref={ref}>
      <button className="btn" onClick={() => setOpen((o) => !o)}>Settings</button>
      {open && (
        <div className="settings-pop nicescroll">
          <div className="settings-title">Settings</div>

          <button className="btn zenbtn" onClick={() => { setZen(true); setOpen(false); }}>Enter zen mode</button>
          <div className="settings-note">Hides the toolbar and panels for distraction-free coding. Press Esc to exit.</div>
          <div className="settings-div" />

          <div className="settings-sub">Appearance</div>
          <div className="srow">
            <span>Theme</span>
            <div className="seg">
              <button className={!dark ? "on" : ""} onClick={() => { if (dark) toggleTheme(); }}>light</button>
              <button className={dark ? "on" : ""} onClick={() => { if (!dark) toggleTheme(); }}>dark</button>
            </div>
          </div>
          <div className="srow">
            <span>Primary</span>
            <div className="swatches">
              {PALETTES.map((p) => (
                <button key={p.id} className={"swatchbtn" + (accent === p.id ? " on" : "")}
                  style={{ background: dark ? p.dark : p.light }}
                  title={p.name} aria-label={p.name} onClick={() => setUi({ accent: p.id })} />
              ))}
            </div>
          </div>
          {/* WCAG 1.4.4 expects text to reach 200% without loss of content: from the
              16px default that is 32px, which the old max of 30 could not even reach.
              48 gives real headroom for low vision without needing browser zoom (which
              also grows the chrome and narrows the reading column). */}
          <label className="srow">
            <span>Transcript text</span>
            <input type="range" min={12} max={48} value={fontSize} onChange={(e) => setFontSize(+e.target.value)} />
            <span className="sval">{fontSize}</span>
            <button className="sreset" onClick={(e) => { e.preventDefault(); setFontSize(16); }}
              title="Reset to 16px">reset</button>
          </label>
          <label className="srow">
            <span>Sidebar text</span>
            <input type="range" min={11} max={36} value={sidebarFontSize} onChange={(e) => setSidebarFontSize(+e.target.value)} />
            <span className="sval">{sidebarFontSize}</span>
            <button className="sreset" onClick={(e) => { e.preventDefault(); setSidebarFontSize(13); }}
              title="Reset to 13px">reset</button>
          </label>

          <div className="settings-sub">Transcript</div>
          <div className="srow">
            <span>Line numbers</span>
            <div className="seg">
              <button className={!showLineNumbers ? "on" : ""} onClick={() => setUi({ showLineNumbers: false })}>off</button>
              <button className={showLineNumbers ? "on" : ""} onClick={() => setUi({ showLineNumbers: true })}>on</button>
            </div>
          </div>
          <div className="srow">
            <span>Speakers</span>
            <div className="seg">
              <button className={speakerNames === "full" ? "on" : ""} onClick={() => setUi({ speakerNames: "full" })}>full</button>
              <button className={speakerNames === "short" ? "on" : ""} onClick={() => setUi({ speakerNames: "short" })}>short</button>
            </div>
          </div>
          <div className="settings-note">Short shows the first 3 characters (hover for the full name).</div>
          <SpeakerRows />
          <div className="srow">
            <span>Merge lines</span>
            <div className="seg">
              <button className={!mergeLines ? "on" : ""} onClick={() => setUi({ mergeLines: false })}>off</button>
              <button className={mergeLines ? "on" : ""} onClick={() => setUi({ mergeLines: true })}>on</button>
            </div>
          </div>
          <div className="settings-note">Joins consecutive same-speaker lines that don't end in . ? ! … into one unit.</div>
          <div className="srow">
            <span>Minimap</span>
            <div className="seg">
              <button className={minimapDetail === "detailed" ? "on" : ""} onClick={() => setUi({ minimapDetail: "detailed" })}>detailed</button>
              <button className={minimapDetail === "simplified" ? "on" : ""} onClick={() => setUi({ minimapDetail: "simplified" })}>simple</button>
            </div>
          </div>
          <div className="settings-note">Drag the minimap's left edge to resize it.</div>

          <div className="settings-sub">Codes</div>
          <div className="srow">
            <span>Lane width</span>
            <div className="seg">
              {(["xs", "sm", "md", "lg"] as const).map((sz) => (
                <button key={sz} className={laneWidth === sz ? "on" : ""} onClick={() => setUi({ laneWidth: sz })}>{sz}</button>
              ))}
            </div>
          </div>
          <div className="srow">
            <span>Warning size</span>
            <div className="seg">
              {(["xs", "sm", "md", "lg"] as const).map((sz) => (
                <button key={sz} className={warnSize === sz ? "on" : ""} onClick={() => setUi({ warnSize: sz })}>{sz}</button>
              ))}
            </div>
          </div>
          <div className="settings-note">Lane bar width and the near-balanced (⚠) marker size.</div>
          <div className="srow">
            <span>Code patterns</span>
            <div className="seg">
              <button className={!lanePattern ? "on" : ""} onClick={() => setUi({ lanePattern: false })}>off</button>
              <button className={lanePattern ? "on" : ""} onClick={() => setUi({ lanePattern: true })}>on</button>
            </div>
          </div>
          <div className="settings-note">
            Gives each code a texture as well as a colour, so codes stay apart without relying
            on hue — turn on if similar colours are hard to tell apart.
          </div>
          <div className="srow">
            <span>Hotbar</span>
            <div className="seg">
              <button className={mode === "auto" ? "on" : ""} onClick={() => setHotbarMode("auto")}>auto</button>
              <button className={mode === "pinned" ? "on" : ""} onClick={() => setHotbarMode("pinned")}>pinned</button>
            </div>
          </div>
          <div className="srow">
            <span>Cmd palette</span>
            <div className="seg">
              <button className={palettePos === "auto" ? "on" : ""} onClick={() => setUi({ palettePos: "auto" })}>near</button>
              <button className={palettePos === "centered" ? "on" : ""} onClick={() => setUi({ palettePos: "centered" })}>center</button>
            </div>
          </div>

          <div className="settings-div" />
          <AiSettings />
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
  if (!speakers.length) return null;

  const setWeight = (sp: string, w: SpeakerWeight) =>
    setUi({ speakerWeight: { ...ui.speakerWeight, [sp]: w } });

  return (
    <>
      <div className="settings-sub">Speakers</div>
      {speakers.map((sp) => {
        const w = weightOf(ui, sp);
        return (
          <div className="srow" key={sp}>
            <button className="spkswatch"
              style={{ background: speakerColor(ui, sp), color: inkOn(speakerColor(ui, sp)) }}
              data-tip={`Recolour ${sp}`} aria-label={`Recolour ${sp}`}
              onClick={() => openColorPicker(speakerColor(ui, sp),
                (v) => setUi({ speakerColors: { ...ui.speakerColors, [sp]: v } }))}>
              {sp.slice(0, 3)}
            </button>
            <span className="spkname">{sp}</span>
            {/* The control previews its own effect: an "A" at each weight, rather than
                three words to read (and translate). data-tip, not title — the native
                tooltip is a fixed ~12px, which is the wrong thing to hand someone
                who is here because 12px is too small. */}
            <div className="seg wseg">
              {WEIGHTS.map(([id, label]) => (
                // data-tip is short on purpose: it only has to NAME the state the icon
                // replaced, and the tip scales with the text size, so a sentence here
                // would grow wider than the popover and clip. The note below carries
                // the meaning; aria-label carries it for anyone not seeing the tip.
                <button key={id} className={(w === id ? "on " : "") + `wt-${id}`}
                  data-tip={id[0].toUpperCase() + id.slice(1)}
                  aria-label={`${sp}: ${label}`} aria-pressed={w === id}
                  onClick={() => setWeight(sp, id)}>A</button>
              ))}
            </div>
          </div>
        );
      })}
      <div className="settings-note">
        Click a swatch to recolour. Set how loudly each speaker's words are set: <b>quiet</b>
        for the interviewer, so the participants carry the page — <b>bold</b> for whoever
        you're following. Guessed on import; correct it here.
      </div>
    </>
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
      <div className="settings-sub">AI assistance <span className="opt">optional</span></div>
      <div className="settings-note">
        Off until you add a key. Anything you run sends transcript lines to OpenAI —
        you approve each request and see exactly what's sent.
      </div>

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

      <div className="srow aicol">
        <span>Model</span>
        <div className="seg aimodels">
          {MODELS.map((m) => (
            <button key={m.id} className={ai.model === m.id ? "on" : ""}
              title={`${m.blurb} — $${m.in}/$${m.out} per 1M tokens in/out`}
              onClick={() => setAi({ model: m.id })}>{m.name}</button>
          ))}
        </div>
      </div>
      <div className="settings-note">
        {MODELS.find((m) => m.id === ai.model)!.blurb} · ${MODELS.find((m) => m.id === ai.model)!.in} in /
        ${MODELS.find((m) => m.id === ai.model)!.out} out per 1M tokens.
      </div>

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
