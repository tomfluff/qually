// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import type { ReactNode } from "react";
import { findMatches } from "../search";
import { withSubs, SubText, subSpans } from "../markup";

export function searchHighlight(text: string, query: string, activeIndex?: number): ReactNode {
  const matches = findMatches(text, query);
  const subs = subSpans(text);
  if (!matches.length) return withSubs(text, 0, subs);
  const nodes: ReactNode[] = [];
  let last = 0;
  matches.forEach(([start, end], index) => {
    if (start > last) nodes.push(
      <SubText key={"p" + index} text={text.slice(last, start)} from={last} spans={subs} />,
    );
    nodes.push(
      <mark key={index} className={activeIndex === undefined ? undefined : index === activeIndex ? "cur" : ""}>
        <SubText text={text.slice(start, end)} from={start} spans={subs} />
      </mark>,
    );
    last = end;
  });
  if (last < text.length) nodes.push(
    <SubText key="tail" text={text.slice(last)} from={last} spans={subs} />,
  );
  return nodes;
}
