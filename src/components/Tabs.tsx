// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useStore } from "../state/store";
import { Icon } from "./Icon";

export function Tabs() {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.active);
  const fontSize = useStore((s) => s.ui.sidebarFontSize);
  const setActive = useStore((s) => s.setActive);
  const closeTab = useStore((s) => s.closeTab);

  return (
    <div id="tabs" style={{ fontSize }}>
      {tabs.map((pid) => (
        <div key={pid} className={"tab" + (active === pid ? " active" : "")}
          onClick={() => setActive(pid)}>
          {pid}
          <span className="x" onClick={(e) => { e.stopPropagation(); closeTab(pid); }}>×</span>
        </div>
      ))}
      <div className={"tab browsetab" + (active === "browse" ? " active" : "")}
        onClick={() => setActive("browse")}>
        <Icon name="list" size={14} /> Browse
      </div>
    </div>
  );
}
