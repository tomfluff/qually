// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
//
// There was no ESLint config in this repo at all, which meant the fifteen-odd
// `// eslint-disable-next-line react-hooks/exhaustive-deps` comments were
// documentation rather than suppression — the rule had never run. That is what
// let a handful of dependency-array bugs through a codebase otherwise unusually
// careful about hooks (SearchBar's line-scope memo omitted `lang`, so a scoped
// find on a translated transcript returned nothing until an unrelated store
// write happened to re-run it).
//
// Deliberately NARROW. This is not a style pass: the formatting in this repo is
// consistent and hand-made, and turning on a general rule set now would bury the
// findings that matter under hundreds that do not. Only the rules that catch
// real defects are on, and they are ERRORS so the existing disable comments go
// back to meaning what they say.
import js from "@eslint/js";
import ts from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";

export default ts.config(
  { ignores: ["dist/**", "docs/**", "node_modules/**"] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks },
    rules: {
      // the reason this file exists
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",

      // TS already reports unused code, and its own config decides what counts;
      // two voices on the same question is noise.
      "@typescript-eslint/no-unused-vars": "off",
      // `unknown` is used properly at the trust boundaries; `any` is not banned
      // outright because a few test doubles need it.
      "@typescript-eslint/no-explicit-any": "off",
      // deliberate: the codebase uses `?? {}` and empty interfaces in places
      "@typescript-eslint/no-empty-object-type": "off",
      // `cond ? a() : b()` and `x && y()` as statements are this codebase's
      // house style, used consistently and readably. A rule that flags 25 of
      // them is a style opinion, and style is not what this config is for.
      "@typescript-eslint/no-unused-expressions": "off",
      // flag.ts matches control characters ON PURPOSE — a model-supplied "fix"
      // carrying a newline or a bidi override must never reach a line
      "no-control-regex": "off",
    },
  },
);
