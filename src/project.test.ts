// The project file is the save file: if it loses anything, work is gone. These tests
// exercise the full round trip through the REAL store, and prove the hand-rolled ZIP
// is an archive a real unzipper accepts (it's written to disk and read back with
// Node's own zlib-free store-only path via a structural check + `unzip -t` when
// available — see zip.test.ts).
import { beforeAll, test, expect } from "vitest";
import { parseProject, statsOf, FORMAT, VERSION, ProjectError } from "./project";

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
});

test("the project file carries everything that is the research work", () => {
  const p = parseProject(useStore.getState().exportProject());
  expect(p.format).toBe(FORMAT);
  expect(p.version).toBe(VERSION);
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
