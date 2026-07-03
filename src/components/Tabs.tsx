import { useStore } from "../state/store";

export function Tabs() {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.active);
  const setActive = useStore((s) => s.setActive);
  const closeTab = useStore((s) => s.closeTab);

  return (
    <div id="tabs">
      {tabs.map((pid) => (
        <div key={pid} className={"tab" + (active === pid ? " active" : "")}
          onClick={() => setActive(pid)}>
          {pid}
          <span className="x" onClick={(e) => { e.stopPropagation(); closeTab(pid); }}>×</span>
        </div>
      ))}
      <div className={"tab" + (active === "browse" ? " active" : "")}
        onClick={() => setActive("browse")}>Browse</div>
    </div>
  );
}
