// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  CreatableCombobox,
  creatableComboboxKeyIntent,
  creatableEntries,
  type CreatableComboboxOption,
} from "./components/CreatableCombobox";

const options: CreatableComboboxOption[] = [
  { name: "Visual strain", count: 4, color: "#123456" },
  { name: "Baseline", count: 2 },
];

describe("creatableEntries", () => {
  test("keeps fuzzy matches before a trimmed create entry", () => {
    expect(creatableEntries("  vs  ", options)).toEqual([
      { kind: "pick", name: "Visual strain", count: 4, color: "#123456" },
      { kind: "create", name: "vs", count: 0, color: undefined },
    ]);
  });

  test("does not offer a case-insensitive exact duplicate", () => {
    expect(creatableEntries(" baseline ", options)).toEqual([
      { kind: "pick", name: "Baseline", count: 2 },
    ]);
  });

  test("an empty query offers every option and no create entry", () => {
    expect(creatableEntries("", options)).toEqual([
      { kind: "pick", name: "Visual strain", count: 4, color: "#123456" },
      { kind: "pick", name: "Baseline", count: 2 },
    ]);
  });
});

describe("creatableComboboxKeyIntent", () => {
  const intent = (overrides: Partial<Parameters<typeof creatableComboboxKeyIntent>[0]> = {}) =>
    creatableComboboxKeyIntent({
      key: "Tab",
      isComposing: false,
      showList: true,
      entryCount: 3,
      highlighted: 1,
      openOnArrowDown: true,
      canCommit: true,
      stopPickEnterPropagation: false,
      ...overrides,
    });

  test("IME composition makes every key inert", () => {
    expect(intent({ key: "Enter", isComposing: true })).toEqual({ kind: "none" });
    expect(intent({ key: "Escape", isComposing: true })).toEqual({ kind: "none" });
  });

  test("open-list arrows move the highlight in their respective direction", () => {
    expect(intent({ key: "ArrowDown", highlighted: 2 })).toEqual({
      kind: "highlight", direction: 1, preventDefault: true,
    });
    expect(intent({ key: "ArrowUp", highlighted: 0 })).toEqual({
      kind: "highlight", direction: -1, preventDefault: true,
    });
  });

  test("open-list Enter picks and preserves the host's propagation choice", () => {
    expect(intent({ key: "Enter" })).toEqual({
      kind: "pick", index: 1, preventDefault: true, stopPropagation: false,
    });
    expect(intent({ key: "Enter", stopPickEnterPropagation: true })).toEqual({
      kind: "pick", index: 1, preventDefault: true, stopPropagation: true,
    });
  });

  test("open-list Escape closes only the list", () => {
    expect(intent({ key: "Escape" })).toEqual({ kind: "close", stopPropagation: true });
  });

  test("closed-list Down opens only for hosts that opt in", () => {
    expect(intent({ key: "ArrowDown", showList: false })).toEqual({ kind: "open", preventDefault: true });
    expect(intent({ key: "ArrowDown", showList: false, openOnArrowDown: false })).toEqual({ kind: "none" });
    expect(intent({ key: "ArrowDown", showList: false, entryCount: 0 })).toEqual({ kind: "none" });
  });

  test("closed-list Enter commits only when the host supplies a commit", () => {
    expect(intent({ key: "Enter", showList: false })).toEqual({ kind: "commit", preventDefault: true });
    expect(intent({ key: "Enter", showList: false, canCommit: false })).toEqual({ kind: "none" });
  });

  test("unhandled keys remain native", () => {
    expect(intent()).toEqual({ kind: "none" });
    expect(intent({ key: "Escape", showList: false })).toEqual({ kind: "none" });
  });
});

test("two closed instances retain distinct ARIA control relationships", () => {
  const combo = (listId: string, ariaLabel: string) => createElement(CreatableCombobox, {
    value: "",
    onChange: () => undefined,
    options,
    placeholder: "condition",
    ariaLabel,
    listId,
    className: "stComboWrap",
    openOn: "click",
    createLabel: (name: string) => `New “${name}”`,
  });
  const html = renderToStaticMarkup(createElement(Fragment, null,
    combo("stretch-dims", "Dimension"), combo("stretch-values", "Value")));

  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-autocomplete="list"');
  expect(html).toContain('aria-controls="stretch-dims"');
  expect(html).toContain('aria-controls="stretch-values"');
  expect(html).not.toContain("aria-activedescendant");
});
