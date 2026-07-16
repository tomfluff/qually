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
      {/* label and × are real <button>s so the keyboard can switch and close tabs;
          the label's click bubbles to the wrapper's onClick (whole tab stays clickable) */}
      {tabs.map((pid) => (
        <div key={pid} className={"tab" + (active === pid ? " active" : "")}
          onClick={() => setActive(pid)}>
          <button className="tabname">{pid}</button>
          <button className="x" aria-label={`Close ${pid}`}
            onClick={(e) => { e.stopPropagation(); closeTab(pid); }}>×</button>
        </div>
      ))}
      <button className={"tab browsetab" + (active === "browse" ? " active" : "")}
        onClick={() => setActive("browse")}>
        <Icon name="list" size={14} /> Browse
      </button>
    </div>
  );
}
