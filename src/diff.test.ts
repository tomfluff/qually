import { describe, it, expect } from "vitest";
import { tinyDiff } from "./diff";

describe("tinyDiff", () => {
  it("isolates a changed middle", () => {
    expect(tinyDiff("the quikc fox", "the quick fox")).toEqual({ del: "kc", ins: "ck", pre: true, suf: true });
  });
  it("pure insertion keeps only the added span", () => {
    expect(tinyDiff("the fox", "the red fox")).toEqual({ del: "", ins: "red ", pre: true, suf: true });
  });
  it("pure deletion keeps only the removed span", () => {
    expect(tinyDiff("the red fox", "the fox")).toEqual({ del: "red ", ins: "", pre: true, suf: true });
  });
  it("no shared ends → whole strings", () => {
    expect(tinyDiff("cat", "dog")).toEqual({ del: "cat", ins: "dog", pre: false, suf: false });
  });
});
