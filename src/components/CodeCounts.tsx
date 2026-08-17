// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The icon count pair beside a code name — one vocabulary wherever codes are
// listed (transcript sidebar, Codebook). aria-hidden: every row that renders
// this already carries both numbers in its own aria-label.
import type { CodeStat } from "../codeStats";
import { Icon } from "./Icon";

export function CodeCounts({ stat, size }: { stat: CodeStat | undefined; size: number }) {
  return (
    <span className="cnt" aria-hidden="true" data-tip="">
      <span className="cntpair" title="Excerpts coded">
        <Icon name="message-2" size={size} />{stat?.segs ?? 0}
      </span>
      <span className="cntpair" title="Transcripts it appears in">
        <Icon name="notes" size={size} />{stat?.pids ?? 0}
      </span>
    </span>
  );
}
