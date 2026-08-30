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
