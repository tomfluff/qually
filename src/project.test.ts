// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The project file is the save file: if it loses anything, work is gone. These tests
// exercise the full round trip through the REAL store, and prove the hand-rolled ZIP
// is an archive a real unzipper accepts (it's written to disk and read back with
// Node's own zlib-free store-only path via a structural check + `unzip -t` when
// available — see zip.test.ts).
import { beforeAll, test, expect } from "vitest";
import { parseProject, statsOf, FORMAT, VERSION, ProjectError } from "./project";
import { linesOf } from "./state/store";

let useStore: typeof import("./state/store").useStore;

beforeAll(async () => {
  const mem: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => { for (const k in mem) delete mem[k]; },
    key: () => null, length: 0,
  } as Storage;
  ({ useStore } = await import("./state/store"));

  await useStore.getState().importFiles([new File([
    `line_id,timestamp,speaker,text,codes
1,00:00:03,R,How do you read a chart?,
2,00:00:09,P,I kept losing the ticket marks.,magnification
3,00:00:15,P,I hate this heat map.,
`,
  ], "P01.csv")]);
  const s = useStore.getState();
  s.editLine("P01", 2, "I kept losing the tick marks.");           // a correction
  s.setColor("magnification", "#123456");                           // a color
  s.setDef("magnification", "zooming to read detail");              // a definition
  s.togglePin("magnification");                                     // a hotbar pin
  s.addFlags("P01", { 3: [{ quote: "I hate this heat map", reason: "strong dislike", lens: "evaluation" }] },
    useStore.getState().transcripts.P01.lines, ["evaluation"]);     // an AI noticing
  s.logAiCall({ at: "2026-07-14T00:00:00Z", model: "gpt-5.6-luna", task: "scan:evaluation", pid: "P01",
    lines: 3, redactions: 0, inTok: 100, outTok: 20, costUsd: 0.0002 });
  s.setAi({ redactTerms: ["Ann Lee"] });
  s.markStretch({ pid: "P01", start: 1, end: 2, dim: "condition", value: "baseline" }); // a stretch
});

test("the project file carries everything that is the research work", () => {
  const p = parseProject(useStore.getState().exportProject());
  expect(p.format).toBe(FORMAT);
  // stamped v1: this project carries no AI-proposed section, so there is
  // nothing in it an older build could misread (see exportProject)
  expect(p.version).toBe(1);
  // the correction — the thing a CSV re-import would silently revert
  const l2 = p.transcripts.P01.lines[1];
  expect(l2.text).toBe("I kept losing the tick marks.");
  expect(l2.orig).toBe("I kept losing the ticket marks.");
  // colors, definitions, pins, AI marks, provenance, settings
  expect(p.codebook.magnification).toMatchObject({ color: "#123456", def: "zooming to read detail" });
  expect(p.hotbar.pinned).toContain("magnification");
  expect(p.aiFlags["P01:3"].spans[0]).toMatchObject({ lens: "evaluation", quote: "I hate this heat map" });
  expect(p.aiLog).toHaveLength(1);
  expect(p.ai.redactTerms).toEqual(["Ann Lee"]);
  expect(p.segments).toHaveLength(1);
  // what a span of talk belongs to is study data — it must survive the file
  expect(p.stretches).toEqual([{ pid: "P01", start: 1, end: 2, dim: "condition", value: "baseline" }]);
});

test("the API key never enters the project file", () => {
  const json = useStore.getState().exportProject();
  expect(json).not.toContain("sk-");
  expect(JSON.parse(json)).not.toHaveProperty("key");
  // and UI prefs stay out — a colleague shouldn't inherit your font size
  expect(JSON.parse(json)).not.toHaveProperty("ui");
});

test("opening a project restores the workspace exactly", () => {
  const json = useStore.getState().exportProject();
  const before = statsOf(parseProject(json));

  // wipe the workspace, as a fresh browser would be
  useStore.setState({ transcripts: {}, segments: [], codebook: {}, tabs: [], active: "browse", aiFlags: {}, aiLog: [] });
  expect(useStore.getState().segments).toHaveLength(0);

  useStore.getState().openProject(parseProject(json));
  const s = useStore.getState();
  expect(s.transcripts.P01.lines[1].text).toBe("I kept losing the tick marks.");
  expect(s.transcripts.P01.lines[1].orig).toBe("I kept losing the ticket marks.");
  expect(s.codebook.magnification.color).toBe("#123456");
  expect(s.aiFlags["P01:3"].spans[0].lens).toBe("evaluation");
  expect(s.segments).toHaveLength(before.segments);
  expect(s.tabs).toEqual(["P01"]);
  // nextSid must clear existing sids or the next segment collides
  expect(s.nextSid).toBeGreaterThan(Math.max(...s.segments.map((x) => x.sid)));
});

test("a newer project file is refused, not half-loaded", () => {
  const j = JSON.parse(useStore.getState().exportProject());
  j.version = VERSION + 1;
  expect(() => parseProject(JSON.stringify(j))).toThrow(ProjectError);
  expect(() => parseProject(JSON.stringify(j))).toThrow(/newer version/);
});

test("a non-project JSON file is refused", () => {
  expect(() => parseProject('{"hello":"world"}')).toThrow(/isn't a QuAlly project/);
  expect(() => parseProject("not json at all")).toThrow(/valid JSON/);
});

test("the codebook CSV round-trips colors and definitions", async () => {
  const csv = useStore.getState().exportCodebook();
  expect(csv).toContain("#123456");
  useStore.setState({ codebook: {} });
  await useStore.getState().importFiles([new File([csv], "codebook.csv")]);
  expect(useStore.getState().codebook.magnification).toMatchObject({
    color: "#123456", def: "zooming to read detail",
  });
});

test("the transcript CSV exports the CORRECTED text, so a bundle isn't stale", () => {
  const csv = useStore.getState().exportTranscript("P01");
  expect(csv).toContain("I kept losing the tick marks.");   // corrected
  expect(csv).toContain("I kept losing the ticket marks."); // original, in its own column
});

// An export is the evidence trail. A translated transcript has to come back out
// carrying BOTH texts: one that wrote only the English would leave a reader of
// the file no way back to what was actually said.
test("a translation round-trips through the transcript CSV, beside the source", async () => {
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,end_timestamp,speaker,text,text_en,codes\n" +
    "1,0:01,0:04,R,\u30c1\u30e3\u30fc\u30c8\u3092\u3069\u3046\u8aad\u307f\u307e\u3059\u304b,How do you read a chart?,\n" +
    "2,0:05,0:09,P,\u62e1\u5927\u3057\u307e\u3059,,\n",
  ], "JP01.csv")]);
  const lines = useStore.getState().transcripts.JP01.lines;
  expect(lines[0]).toMatchObject({ text: "\u30c1\u30e3\u30fc\u30c8\u3092\u3069\u3046\u8aad\u307f\u307e\u3059\u304b", en: "How do you read a chart?" });
  // a blank text_en is NOT a translation to nothing — the field stays absent
  expect(lines[1].en).toBeUndefined();

  const csv = useStore.getState().exportTranscript("JP01");
  expect(csv.split("\r\n")[0]).toBe("line_id,timestamp,end_timestamp,speaker,text,text_en,original");
  expect(csv).toContain("How do you read a chart?");
  expect(csv).toContain("\u30c1\u30e3\u30fc\u30c8\u3092\u3069\u3046\u8aad\u307f\u307e\u3059\u304b");

  // and back in again, unchanged
  await useStore.getState().importFiles([new File([csv], "JP02.csv")]);
  expect(useStore.getState().transcripts.JP02.lines[0].en).toBe("How do you read a chart?");
});

// The column is optional, and a transcript that never had one must not grow it:
// an untranslated export gaining an empty text_en would tell every later reader
// that a translation was attempted and came back blank.
test("a transcript with no translation exports no text_en column", () => {
  expect(useStore.getState().exportTranscript("P01")).not.toContain("text_en");
});

// Who the interviewer is, and any speaker recolouring, is a property of the STUDY,
// not a display preference like font size — so it has to survive a project round trip.
// It didn't: speakerColors/speakerWeight live in ui, and exportProject excludes ui.
test("speaker colours and weights survive a project round trip", () => {
  const s = useStore.getState();
  s.setUi({ speakerColors: { R: "#abcdef" }, speakerWeight: { R: "quiet", P: "bold" } });

  const json = useStore.getState().exportProject();
  useStore.setState({ ui: { ...useStore.getState().ui, speakerColors: {}, speakerWeight: {} } });

  useStore.getState().openProject(parseProject(json));
  const ui = useStore.getState().ui;
  expect(ui.speakerColors.R).toBe("#abcdef");
  expect(ui.speakerWeight).toMatchObject({ R: "quiet", P: "bold" });
});

// A project written before the speaker map existed carries none. It must still open
// with the interviewer quieted rather than everyone flat.
test("a pre-speakers project file re-guesses the interviewer", () => {
  const j = JSON.parse(useStore.getState().exportProject());
  delete j.speakers;                                    // as an older QuAlly wrote it
  j.transcripts = { FG: { lines: [
    { id: 1, ts: "00:00:01", speaker: "Interviewer", text: "how do you read it" },
    { id: 2, ts: "00:00:05", speaker: "Rachel", text: "I squint" },
  ] } };
  j.tabs = ["FG"];

  useStore.setState({ ui: { ...useStore.getState().ui, speakerColors: {}, speakerWeight: {} } });
  useStore.getState().openProject(parseProject(JSON.stringify(j)));

  const w = useStore.getState().ui.speakerWeight;
  expect(w.Interviewer).toBe("quiet");
  expect(w.Rachel).toBeUndefined(); // a participant is never quieted by the guess
});

// The point of the whole feature: what a code QUOTES follows the reading
// language, and the export carries both so the evidence trail survives. If
// these two ever disagree, a quote in a paper stops matching its own data.
test("an excerpt and its export follow the reading language, and keep the source", async () => {
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text,text_en\n" +
    "1,0:01,P,\u62e1\u5927\u3057\u307e\u3059,I zoom in.\n" +
    "2,0:05,P,\u7dda\u3092\u8ffd\u3044\u307e\u3059,I follow the line.\n",
  ], "JP.csv")]);
  const st = useStore.getState();
  st.addSegment("JP", 1, 2, "zooming");

  // reading the source: unchanged behaviour, and no second column invented
  expect(st.exportCSV()).toContain("\u62e1\u5927\u3057\u307e\u3059 \u7dda\u3092\u8ffd\u3044\u307e\u3059");
  expect(st.exportCSV()).not.toContain("excerpt_source");

  useStore.getState().setUi({ lang: "en" });
  const en = useStore.getState().exportCSV();
  expect(en).toContain("I zoom in. I follow the line.");
  // the source rides along in its own column — an export may never carry only
  // a translation, or the file loses the way back to what was said
  expect(en.split("\r\n")[0]).toContain("excerpt_source");
  expect(en).toContain("\u62e1\u5927\u3057\u307e\u3059 \u7dda\u3092\u8ffd\u3044\u307e\u3059");

  useStore.getState().setUi({ lang: "source" });
});

// A study with no translation must be byte-identical whatever the switch says —
// this is what lets the language reach the excerpt rule and the AI payloads at
// all without touching a single project that exists today.
test("the reading language changes nothing for a study that has no translation", () => {
  // only the untranslated transcripts: the JP one above deliberately does change
  const { transcripts } = useStore.getState();
  const plain = Object.fromEntries(Object.entries(transcripts).filter(([pid]) => pid !== "JP"));
  useStore.setState({ transcripts: plain,
    segments: useStore.getState().segments.filter((x) => x.pid !== "JP") });

  const before = useStore.getState().exportCSV();
  useStore.getState().setUi({ lang: "en" });
  const after = useStore.getState().exportCSV();
  useStore.getState().setUi({ lang: "source" });
  expect(after).toBe(before);
  expect(after).not.toContain("excerpt_source");
});

// A scan hashes the text it was handed, and it is handed what is on screen.
// Validating those marks against the STORED source dropped every one of them —
// in both readings — so a run under an English reading was paid for and then
// invisible. The export validates the same way the transcript does, so this
// pins both halves of that agreement.
test("marks bought under an English reading are the marks that come back", async () => {
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text,text_en\n" +
    "1,0:01,P,\u62e1\u5927\u3057\u307e\u3059,I zoom in really close.\n",
  ], "SCAN.csv")]);
  useStore.getState().setUi({ lang: "en" });

  // exactly what AiCheckModal hands addFlags: the RESOLVED lines
  const scanned = linesOf(useStore.getState().transcripts, "en", "SCAN");
  expect(scanned[0].text).toBe("I zoom in really close.");
  useStore.getState().addFlags("SCAN",
    { 1: [{ lens: "hedging", quote: "really close", reason: "vague degree" }] },
    scanned as never, ["hedging"]);

  const csv = useStore.getState().exportNotices();
  expect(csv).toContain("really close");
  expect(csv).toContain("vague degree");
  // written against the words the model actually saw
  expect(csv).toContain("I zoom in really close.");

  // and the file does not depend on which switch is thrown when it is written:
  // a mark made in one reading is still in "every observation" from the other
  useStore.getState().setUi({ lang: "source" });
  const fromSource = useStore.getState().exportNotices();
  expect(fromSource).toContain("vague degree");
  expect(fromSource).toBe(csv);

  // exactly once, though — an untranslated line is the same text in both
  // readings, and both passes would otherwise write it out
  expect(fromSource.split("vague degree").length - 1).toBe(1);
});

// The Apply-fix button announced "Fixed: X is now Y" whatever happened. On a
// line being read as a translation the store refuses (a repair rewrites what
// was SPOKEN and must never write the translation over it) — so the app was
// telling the researcher it had changed the transcript when it had not.
test("a repair says whether it actually happened", () => {
  const st = useStore.getState();
  const line = st.transcripts.SCAN.lines[0];
  expect(line.text).toBe("\u62e1\u5927\u3057\u307e\u3059");

  // a quote that is not in the spoken line — an English mark, or one an edit moved
  expect(st.applyFix("SCAN", line.id, "really close", "very close")).toBe(false);
  expect(useStore.getState().transcripts.SCAN.lines[0].text).toBe("\u62e1\u5927\u3057\u307e\u3059");

  // and a real repair still reports true and lands
  expect(useStore.getState().applyFix("SCAN", line.id, "\u62e1\u5927", "\u30ba\u30fc\u30e0")).toBe(true);
  expect(useStore.getState().transcripts.SCAN.lines[0].text).toContain("\u30ba\u30fc\u30e0");
});

// Reading English, the editor edits the TRANSLATION — that is the text on
// screen, and in a study read in English it is what the excerpts quote. It used
// to write the spoken field whatever you were reading, so the display did not
// change (the edit looked ignored) and the record of what was said was gone.
test("an edit under an English reading corrects the translation, not the source", async () => {
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text,text_en\n" +
    "1,0:01,P,\u62e1\u5927\u3057\u307e\u3059,I zoom.\n" +
    "2,0:05,P,\u306f\u3044,\n",
  ], "ED.csv")]);
  const line = () => useStore.getState().transcripts.ED.lines[0];

  useStore.getState().editLine("ED", 1, "I zoom right in.", "en");
  expect(line().en).toBe("I zoom right in.");
  expect(line().text).toBe("\u62e1\u5927\u3057\u307e\u3059");   // untouched
  expect(line().enOrig).toBe("I zoom.");                            // its own trail
  expect(line().orig).toBeUndefined();                              // not the source's

  // the source is still correctable, and keeps its own original
  useStore.getState().editLine("ED", 1, "\u30ba\u30fc\u30e0\u3057\u307e\u3059", "text");
  expect(line().orig).toBe("\u62e1\u5927\u3057\u307e\u3059");
  expect(line().enOrig).toBe("I zoom.");   // the other trail is undisturbed

  // editing back to where it started clears the mark rather than claiming a change
  useStore.getState().editLine("ED", 1, "I zoom.", "en");
  expect(line().enOrig).toBeUndefined();
  expect(line().en).toBe("I zoom.");
});

// A line with NO translation, read in English, shows the spoken words — there
// the act is writing the translation, and it must not touch the source.
test("writing a translation for an untranslated line leaves the spoken text alone", () => {
  useStore.getState().editLine("ED", 2, "Yes.", "en");
  const l = useStore.getState().transcripts.ED.lines[1];
  expect(l.en).toBe("Yes.");
  expect(l.text).toBe("\u306f\u3044");
  // nothing was there before, so there is no earlier translation to remember
  expect(l.enOrig).toBeUndefined();
});

test("both kinds of correction round-trip, and the audit says which is which", async () => {
  // correct both texts of the same line, and leave both corrections standing
  useStore.getState().editLine("ED", 1, "I zoom right in.", "en");
  const csv = useStore.getState().exportTranscript("ED");
  expect(csv.split("\r\n")[0])
    .toBe("line_id,timestamp,speaker,text,text_en,original,text_en_original");

  const edits = useStore.getState().exportEdits();
  expect(edits.split("\r\n")[0]).toBe("pid,line_id,timestamp,speaker,field,original,corrected");
  expect(edits).toContain(",text,");      // the transcription correction
  expect(edits).toContain(",text_en,");   // and the translation one

  // and back in again, both trails intact
  await useStore.getState().importFiles([new File([csv], "ED2.csv")]);
  const l = useStore.getState().transcripts.ED2.lines[0];
  expect(l).toMatchObject({
    text: "\u30ba\u30fc\u30e0\u3057\u307e\u3059", orig: "\u62e1\u5927\u3057\u307e\u3059",
    en: "I zoom right in.", enOrig: "I zoom.",
  });
});

// A hand-edited project file can put anything on a line, and these fields do not
// fail politely: orig/enOrig reach tinyDiff and text/en reach the excerpt rule,
// both INSIDE render — and persist rehydrates the same value, so the white
// screen returns every time the app opens. Filtered once, at the boundary.
test("a line whose fields are the wrong type loads without them, not with them", () => {
  const p = parseProject(JSON.stringify({
    format: FORMAT, version: VERSION, savedAt: "", segments: [], codebook: {},
    transcripts: { P: { lines: [
      { id: 1, ts: "0:01", speaker: "P", text: "fine", orig: 7, en: {}, enOrig: [] },
      { id: 2, ts: 5, speaker: null, text: undefined },
      { nope: true },                       // no id at all — not a line
    ] } },
  }));
  const lines = p.transcripts.P.lines;
  expect(lines).toHaveLength(2);            // the id-less row is gone
  expect(lines[0]).toEqual({ id: 1, ts: "0:01", speaker: "P", text: "fine" });
  // a non-string is ABSENT rather than coerced: "7" is not a previous text
  expect("orig" in lines[0]).toBe(false);
  expect("en" in lines[0]).toBe(false);
  expect("enOrig" in lines[0]).toBe(false);
  // and the required three fall back rather than reaching render as non-strings
  expect(lines[1]).toEqual({ id: 2, ts: "", speaker: "P", text: "" });
});

// The version only bumps on a semantic change, so a same-version file written by
// a slightly newer build can carry a per-line field this one has never heard of.
// Deleting it on load would lose it on the next save — the field is inert here,
// the WRONG-TYPED known field is the danger.
test("a line field this build does not know survives the round trip", () => {
  const p = parseProject(JSON.stringify({
    format: FORMAT, version: VERSION, savedAt: "", segments: [], codebook: {},
    transcripts: { P: { lines: [{ id: 1, ts: "", speaker: "P", text: "hi", futureThing: 42 }] } },
  }));
  expect((p.transcripts.P.lines[0] as unknown as { futureThing: number }).futureThing).toBe(42);
});

// `src` is runtime-only — viewLines adds it to a resolved copy, and the excerpt
// rule weighs it over `text`. Carried in from a file it would quietly decide
// which speaker a code quotes, from a field nothing ever writes.
test("a stored src is dropped, whatever the file says", () => {
  const p = parseProject(JSON.stringify({
    format: FORMAT, version: VERSION, savedAt: "", segments: [], codebook: {},
    transcripts: { P: { lines: [{ id: 1, ts: "", speaker: "P", text: "hi", src: "not this" }] } },
  }));
  expect("src" in p.transcripts.P.lines[0]).toBe(false);
});

// A pre-correction translation with no translation to be the original OF would
// make the edit mark diff the English against the source.
test("a stray enOrig with no en is dropped", () => {
  const p = parseProject(JSON.stringify({
    format: FORMAT, version: VERSION, savedAt: "", segments: [], codebook: {},
    transcripts: { P: { lines: [{ id: 1, ts: "", speaker: "P", text: "hi", enOrig: "Hello" }] } },
  }));
  expect("enOrig" in p.transcripts.P.lines[0]).toBe(false);
});

// Undo does not cover transcripts, so a re-import that lands on top of
// translation work destroys it for good. The guard has to see that work: a
// CORRECTED translation says so in enOrig, and one WRITTEN where the file had
// none says nothing on the line — it is found by asking the incoming file.
test("re-importing over translation work asks first", async () => {
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text,text_en\n1,0:01,P,\u306f\u3044,\n",
  ], "RT.csv")]);
  expect(useStore.getState().pendingImports).toHaveLength(0);

  // a translation written where the file had none — nothing on the line says so
  useStore.getState().editLine("RT", 1, "Yes.", "en");
  expect(useStore.getState().transcripts.RT.lines[0].enOrig).toBeUndefined();

  // the same file back again would silently take it away
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text,text_en\n1,0:01,P,\u306f\u3044,\n",
  ], "RT.csv")]);
  expect(useStore.getState().pendingImports).toHaveLength(1);
  expect(useStore.getState().transcripts.RT.lines[0].en).toBe("Yes.");  // untouched meanwhile
  useStore.setState({ pendingImports: [] });

  // a file that BRINGS the translation is not taking anything away
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text,text_en\n1,0:01,P,\u306f\u3044,Yes.\n",
  ], "RT.csv")]);
  expect(useStore.getState().pendingImports).toHaveLength(0);
});

// Find-and-replace follows the READING, and the reading resolves per line. The
// first cut of that decided once for the whole transcript, which invented a
// translation on a line that had none — the display then showed the
// replacement while the spoken text kept the word being replaced away.
test("replace under an English reading rewrites what each line is showing", async () => {
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text,text_en\n" +
    "1,0:01,P,\u30d3\u30fc\u30b3\u30f3\u3067\u3059,the beacon helped\n" +
    "2,0:05,P,beacon in the source only,\n",
  ], "MIX.csv")]);
  const lines = () => useStore.getState().transcripts.MIX.lines;

  const n = useStore.getState().replaceInTranscript("MIX", "beacon", "system", undefined, "en");
  expect(n).toBe(2);   // BOTH — the untranslated line is showing its source

  // the translated line: its translation changed, its spoken words did not
  expect(lines()[0].en).toBe("the system helped");
  expect(lines()[0].text).toBe("\u30d3\u30fc\u30b3\u30f3\u3067\u3059");
  expect(lines()[0].enOrig).toBe("the beacon helped");

  // the untranslated line: its source changed, and no translation was invented
  expect(lines()[1].text).toBe("system in the source only");
  expect(lines()[1].en).toBeUndefined();
  expect(lines()[1].orig).toBe("beacon in the source only");
});

test("the same replace under a Source reading never touches a translation", async () => {
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text,text_en\n1,0:01,P,beacon here,beacon there\n",
  ], "SRC.csv")]);
  useStore.getState().replaceInTranscript("SRC", "beacon", "system", undefined, "source");
  const l = useStore.getState().transcripts.SRC.lines[0];
  expect(l.text).toBe("system here");
  expect(l.en).toBe("beacon there");     // untouched
  expect(l.enOrig).toBeUndefined();
});

// The three fields the boundary used to wave straight through, and the three
// that white-screen hardest: Tabs.tsx maps over `tabs` every render,
// ExportMenu's SELECTORS read segment.proposedBy.trim(), and BrowseView reads
// codebook[c].parked. A throw inside render is permanent — persist rehydrates
// the same value on reload — and openProject has already replaced the workspace
// by then, so the researcher is left with neither project.
const hostile = (over: Record<string, unknown>) => parseProject(JSON.stringify({
  format: FORMAT, version: VERSION, savedAt: "",
  transcripts: { P01: { lines: [{ id: 1, ts: "0:01", speaker: "P", text: "hi" }] } },
  segments: [], codebook: {}, ...over,
}));

test("a segment with wrong-typed fields is repaired, not loaded as-is", () => {
  const p = hostile({ segments: [
    null,
    { sid: "x", pid: "P01", start: 1, end: 2 },          // no usable id
    { sid: 2, pid: 5, start: 1, end: 2 },                 // no usable pid
    { sid: 3, pid: "P01", start: 4, end: 2, code: 9, notes: { a: 1 }, proposedBy: "  " },
  ] });
  expect(p.segments).toHaveLength(1);
  const s = p.segments[0];
  expect(s.sid).toBe(3);
  expect([s.start, s.end]).toEqual([2, 4]);        // normalised low -> high
  expect(s.code).toBe("");                          // a number is not a code name
  expect(s.notes).toBe("");                         // an object would throw in render
  expect(s.proposedBy).toBe("(default)");           // never blank: it is the intercoder column
  // ABSENT means a file from before the field, which is accepted; PRESENT but
  // unreadable is not a verdict anyone passed and must not become evidence
  expect(s.status).toBe("accepted");
  expect(hostile({ segments: [{ sid: 1, pid: "P01", start: 1, end: 2, status: { v: "rejected" } }] })
    .segments[0].status).toBe("candidate");
});

// A usable KEY with an unusable value is still a code the researcher made, and
// its segments still name it — dropping the entry strands them.
test("a codebook entry with an unusable value is repaired, not dropped", () => {
  const p = hostile({ codebook: { a: null, b: { color: 1, def: 2 }, c: { color: "#123456", def: "d" } } });
  expect(Object.keys(p.codebook).sort()).toEqual(["a", "b", "c"]);
  expect(p.codebook.a.color).toBe("#888888");
  expect(p.codebook.b.def).toBe("");
  expect(p.codebook.c.color).toBe("#123456");
});

// "__proto__" is a name a person can type. Assigned into a plain object it
// mutates the prototype instead of adding a key, and the code disappears.
test("a code named __proto__ survives", () => {
  // built as raw JSON on purpose: in an object LITERAL, __proto__ sets the
  // prototype rather than a key, so a literal fixture never has one. JSON.parse
  // makes it a real own property, which is what a hand-edited file would carry.
  const p = parseProject(`{"format":${JSON.stringify(FORMAT)},"version":${VERSION},"savedAt":"",
    "transcripts":{"P01":{"lines":[{"id":1,"ts":"0:01","speaker":"P","text":"hi"}]}},
    "segments":[],
    "codebook":{"__proto__":{"color":"#123456","def":"x","status":"candidate"}}}`);
  expect(Object.keys(p.codebook)).toContain("__proto__");
});

// A newer build may write fields this one does not know. Rebuilding the object
// from a whitelist deletes them on the next save — the rule cleanTranscripts
// states, and which cleanSegments/cleanCodebook were breaking.
test("fields a newer build wrote survive a round trip", () => {
  const p = hostile({
    segments: [{ sid: 1, pid: "P01", start: 1, end: 2, code: "c", futureField: "keep me" }],
    codebook: { c: { color: "#123456", def: "", status: "candidate", futureFlag: true } },
  });
  expect((p.segments[0] as unknown as Record<string, unknown>).futureField).toBe("keep me");
  expect((p.codebook.c as unknown as Record<string, unknown>).futureFlag).toBe(true);
});

test("tabs that are not a list of loaded transcripts cannot reach Tabs.map", () => {
  expect(hostile({ tabs: "nope" }).tabs).toEqual(["P01"]);
  expect(hostile({ tabs: [1, "P01", "P01", "gone"] }).tabs).toEqual(["P01"]);
  expect(hostile({ extSegRows: "nope" }).extSegRows).toEqual([]);
});

// nextSid is derived as max(sid)+1; a single non-numeric sid used to make it
// NaN, and then every new segment got sid NaN, deleteSegment matched nothing,
// and every grounding collided on one key.
test("no surviving segment can poison nextSid", () => {
  const p = hostile({ segments: [{ sid: "x", pid: "P01", start: 1, end: 1 }, { pid: "P01", start: 1, end: 1 }] });
  expect(p.segments).toEqual([]);
  expect(p.segments.every((s) => Number.isSafeInteger(s.sid))).toBe(true);
});

// The counts in the open dialog are of the CLEANED project, so a file that
// loses rows would otherwise be confirmed at a total that excludes them — and
// the researcher opens, works, and saves the loss over their only copy.
test("a file that loses rows says so before it is opened", () => {
  const p = hostile({ segments: [
    { sid: 1, pid: "P01", start: 1, end: 2 },
    { sid: "x", pid: "P01", start: 1, end: 2 },
    null,
  ] });
  expect(p.segments).toHaveLength(1);
  expect(p.warnings?.join(" ")).toContain("2 segment rows");
});

test("a well-formed file carries no warnings at all", () => {
  expect(hostile({ segments: [{ sid: 1, pid: "P01", start: 1, end: 2, code: "c" }] }).warnings)
    .toEqual([]);
});

// Two rows sharing a sid is the corruption class the NaN case belongs to:
// deleteSegment would remove both, setStatus flip both, groundings collide.
test("a duplicated sid is renumbered rather than dropped", () => {
  const p = hostile({ segments: [
    { sid: 7, pid: "P01", start: 1, end: 2, code: "a" },
    { sid: 7, pid: "P01", start: 3, end: 4, code: "b" },
  ] });
  expect(p.segments).toHaveLength(2);
  expect(new Set(p.segments.map((s) => s.sid)).size).toBe(2);
});

// Quoting a number is the commonest thing a hand-edit does to JSON, and losing
// a coding over a pair of quotes is exactly what this boundary exists to stop.
test("numeric fields written as strings are read, not discarded", () => {
  const p = hostile({ segments: [{ sid: "5", pid: "P01", start: "3", end: "4", code: "c" }] });
  expect(p.segments).toHaveLength(1);
  expect([p.segments[0].sid, p.segments[0].start, p.segments[0].end]).toEqual([5, 3, 4]);
});

// `active` is read as transcripts[active] during render, so an object there
// throws "Cannot convert object to primitive value" on every frame — and
// persist rehydrates it, so the white screen never lifts.
test("active can only be a view that exists", () => {
  expect(hostile({ active: { toString: null } }).active).toBe("browse");
  expect(hostile({ active: "gone" }).active).toBe("browse");
  expect(hostile({ active: "P01" }).active).toBe("P01");
  expect(hostile({ active: "summary" }).active).toBe("summary");
});

// Absent tabs means "open them all"; absent pinnedTabs means "none pinned".
// Sharing cleanTabs's fallback pinned every transcript in every older file.
test("a file with no pinnedTabs pins nothing", () => {
  expect(hostile({}).pinnedTabs).toEqual([]);
  expect(hostile({ pinnedTabs: ["P01", "gone"] }).pinnedTabs).toEqual(["P01"]);
});

// The same contract importSegments and remapSegment hold: a negative start
// exports a ref the importer cannot parse, and a span of billions makes
// remapSegment enumerate every integer in it and hang.
test("a span the rest of the app cannot handle does not load", () => {
  const p = hostile({ segments: [
    { sid: 1, pid: "P01", start: -1, end: 2 },
    { sid: 2, pid: "P01", start: 1, end: 500000 },
    { sid: 3, pid: "P01", start: 1, end: 2 },
  ] });
  expect(p.segments.map((s) => s.sid)).toEqual([3]);
  expect(p.warnings?.join(" ")).toContain("2 segment rows");
});

// One row carrying MAX_SAFE_INTEGER used to make every later id unsafe, after
// which consecutive additions collided on the same one.
test("a duplicate sid is given an id nothing else holds", () => {
  const big = Number.MAX_SAFE_INTEGER;
  const p = hostile({ segments: [
    { sid: big, pid: "P01", start: 1, end: 2, code: "a" },
    { sid: big, pid: "P01", start: 3, end: 4, code: "b" },
  ] });
  expect(p.segments).toHaveLength(2);
  expect(new Set(p.segments.map((s) => s.sid)).size).toBe(2);
  expect(p.segments.every((s) => Number.isSafeInteger(s.sid))).toBe(true);
});

// exportCSV unions parked-row keys into the header and trims proposed_by, so a
// non-string value there is a TypeError inside the export.
test("a parked row keeps only values the export can write", () => {
  const p = hostile({ extSegRows: [null, "nope", { segment_ref: "P09:1", proposed_by: {}, code: "c" }] });
  expect(p.extSegRows).toHaveLength(1);
  expect(p.extSegRows[0]).toEqual({ segment_ref: "P09:1", code: "c" });
});

// The full circle the researcher actually performs: export, parse, OPEN, and
// export again. The cleaners added at the boundary sit on this path, and a
// field they quietly drop is a field lost from the only copy on the second save
// rather than the first — which is the failure that never announces itself.
test("a project converges: what one open repairs, the next leaves alone", () => {
  const s = () => useStore.getState();
  // The first pass MAY repair — a tab whose transcript is no longer loaded is
  // dropped, because it cannot open. What must not happen is a file that keeps
  // changing every time it is opened and saved: that is a project drifting under
  // the researcher, and it is the failure a byte-equality check on pass one
  // would have hidden behind an expected repair.
  s().openProject(parseProject(s().exportProject()));
  const a = JSON.parse(s().exportProject());
  s().openProject(parseProject(s().exportProject()));
  const b = JSON.parse(s().exportProject());

  // savedAt is stamped per export, so it is expected to differ; nothing else is
  delete a.savedAt; delete b.savedAt;
  expect(b).toEqual(a);
  // and no coding was lost on the way through
  expect(b.segments.length).toBe(a.segments.length);
  expect(Object.keys(b.codebook).length).toBe(Object.keys(a.codebook).length);
});

// The three fields the boundary learned to validate this week are the three
// most likely to be dropped on the way back in.
test("tabs, pins and the active view come back as they went out", () => {
  const s = () => useStore.getState();
  const before = { tabs: s().tabs, pinned: s().pinnedTabs, active: s().active,
    parked: s().extSegRows.length, segs: s().segments.length };
  s().openProject(parseProject(s().exportProject()));
  expect({ tabs: s().tabs, pinned: s().pinnedTabs, active: s().active,
    parked: s().extSegRows.length, segs: s().segments.length }).toEqual(before);
});
