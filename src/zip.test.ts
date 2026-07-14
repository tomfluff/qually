// A hand-rolled ZIP is only worth anything if a REAL unzipper opens it, so this
// writes one to disk and extracts it with independent tooling. A structural
// self-check would happily pass on an archive nobody else can read.
import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipTextFiles } from "./zip";

// first extractor this machine actually has (Info-ZIP, then bsdtar, then PowerShell)
function extract(zipPath: string, outDir: string): string {
  const tries: [string, string[]][] = [
    ["unzip", ["-q", zipPath, "-d", outDir]],
    ["tar", ["-xf", zipPath, "-C", outDir]], // bsdtar reads zip; GNU tar doesn't
    ["powershell", ["-NoProfile", "-Command",
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`]],
  ];
  for (const [cmd, args] of tries) {
    try { execFileSync(cmd, args, { stdio: "pipe" }); return cmd; }
    catch { /* try the next one */ }
  }
  throw new Error("no unzip tool available (tried unzip, tar, powershell)");
}

const FILES = [
  { name: "README.txt", text: "QuAlly CSV bundle\n" },
  { name: "coded-segments.csv", text: 'segment_ref,code\r\nP01:2,"quoted, comma"\r\n' },
  { name: "transcripts/P01.csv", text: "line_id,text\r\n1,héllo ünicode\r\n" }, // nested dir + UTF-8
];

// no @types/node in this project, so stay off Buffer
const sigAt = (b: Uint8Array, at: number) => [...b.subarray(at, at + 4)];
const hasSig = (b: Uint8Array, sig: number[]) => {
  for (let i = 0; i + 4 <= b.length; i++) if (sig.every((v, k) => b[i + k] === v)) return true;
  return false;
};

test("writes an archive the operating system can actually open", async () => {
  const blob = zipTextFiles(FILES, new Date("2026-07-14T12:00:00Z"));
  const bytes = new Uint8Array(await blob.arrayBuffer());

  // signatures: local header, central directory, end of central directory
  expect(sigAt(bytes, 0)).toEqual([0x50, 0x4b, 0x03, 0x04]);
  expect(hasSig(bytes, [0x50, 0x4b, 0x01, 0x02])).toBe(true);
  expect(hasSig(bytes, [0x50, 0x4b, 0x05, 0x06])).toBe(true);

  const dir = mkdtempSync(join(tmpdir(), "qually-zip-"));
  const zipPath = join(dir, "bundle.zip");
  writeFileSync(zipPath, bytes);
  const out = join(dir, "out");

  try {
    const tool = extract(zipPath, out);
    expect(tool).toBeTruthy();

    // every file came back, byte for byte — including the nested path and the UTF-8
    for (const f of FILES) {
      const p = join(out, ...f.name.split("/"));
      expect(existsSync(p), `${f.name} missing from the archive extracted by ${tool}`).toBe(true);
      expect(readFileSync(p, "utf8")).toBe(f.text);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty archive is still a valid one", async () => {
  const bytes = new Uint8Array(await zipTextFiles([], new Date("2026-07-14T12:00:00Z")).arrayBuffer());
  expect(bytes).toHaveLength(22);                        // just the end-of-central-directory record
  expect(sigAt(bytes, 0)).toEqual([0x50, 0x4b, 0x05, 0x06]);
});
