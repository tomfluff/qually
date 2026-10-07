// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { activeKey, createProject, deleteProject, listProjects, projectsAvailable,
  switchProject, type ProjectEntry } from "../state/projects";
import { ProjectError } from "../project";
import { announce } from "../announce";
import { useToggleMenu } from "../usePopover";
import { onProjectSwap } from "../sessionReset";
import { saveText } from "./ExportMenu";
import { Icon } from "./Icon";

const displayName = (name: string) => name.trim() || "Untitled project";
const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);

export function ProjectMenu() {
  const { open, setOpen, btnRef, menuRef, arrows } = useToggleMenu();
  const projectName = useStore((s) => s.projectName);
  const transcripts = useStore((s) => s.transcripts);
  const fs = useStore((s) => s.ui.sidebarFontSize);
  const key = activeKey();
  const name = displayName(projectName);
  const available = projectsAvailable();
  const [entries, setEntries] = useState<ProjectEntry[]>([]);
  const [listError, setListError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const openRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const trashRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const actionRef = useRef<HTMLButtonElement>(null);
  const focusAfterDelete = useRef<string | null>(null);
  const noteId = useId();
  const current: ProjectEntry = { key, name: projectName, transcripts: Object.keys(transcripts).length, used: null };
  const projects = available
    ? entries.some((p) => p.key === key) ? entries.map((p) => p.key === key ? current : p) : [...entries, current]
    : [current];

  useEffect(() => {
    if (!open) return;
    let live = true;
    void listProjects().then(
      (list) => { if (live) setEntries(list); },
      (e) => {
        if (!live) return;
        const msg = `Couldn't list projects: ${messageOf(e)}.`;
        setListError(msg); announce(msg, { assertive: true });
      },
    );
    return () => { live = false; };
  }, [open]);

  // The confirmation disappears after deletion; restore only once the new rows exist.
  // A rename draft or a delete confirmation names the project it was opened
  // on: once another project is open, neither may stand (Rename would write
  // the old name onto this one).
  useEffect(() => onProjectSwap(() => { setOpen(false); setRenaming(false); setConfirmKey(null); }),
    [setOpen]);

  useLayoutEffect(() => {
    if (!open || focusAfterDelete.current === null) return;
    (openRefs.current[focusAfterDelete.current] ?? actionRef.current)?.focus();
    focusAfterDelete.current = null;
  });

  // shown in the menu AND said: the line alone is silent, the announcement alone invisible
  const showError = (msg: string) => { setListError(msg); announce(msg, { assertive: true }); };
  const listFailed = (e: unknown) => showError(`Couldn't list projects: ${messageOf(e)}.`);
  const toggle = () => {
    if (!open) {
      setEntries([]); setListError(""); setRenaming(false); setConfirmKey(null);
    }
    setOpen(!open);
  };
  // a refused move reopens the menu with the reason in it — sighted readers
  // get the line, screen-reader users the announcement
  const refused = (msg: string) => { setOpen(true); showError(msg); };
  const openProject = async (p: ProjectEntry) => {
    setOpen(false);
    const nm = displayName(p.name);
    // no "already open" shortcut here: a switch still in flight means the open
    // project is about to change, and this choice must queue behind it
    try { if (await switchProject(p.key)) announce(`Opened project ${nm}.`); }
    catch (e) { refused(`Couldn't open ${nm}: ${messageOf(e)}.`); }
  };
  const startProject = async () => {
    setOpen(false);
    try {
      await createProject();
      announce("New project started. Your other projects are in the Projects menu.");
    } catch (e) { refused(`Couldn't start a new project: ${messageOf(e)}.`); }
  };
  const remove = async (p: ProjectEntry) => {
    if (deleting) return;
    const nm = displayName(p.name);
    // One project is all this session can keep: deleting it is the old "start
    // fresh", clearing the workspace in place.
    if (!available) {
      useStore.getState().newProject();
      setOpen(false);
      announce(`Cleared ${nm}. A new, empty project takes its place.`);
      return;
    }
    setDeleting(true);
    const wasActive = p.key === key;
    const at = projects.findIndex((row) => row.key === p.key);
    const neighbour = projects[at + 1]?.key ?? projects[at - 1]?.key ?? "";
    try {
      await deleteProject(p.key);
      if (wasActive) {
        setOpen(false);
        announce(`Deleted project ${nm}. Opened ${displayName(useStore.getState().projectName)}.`);
      } else {
        try { setEntries(await listProjects()); setListError(""); }
        catch (e) {
          setEntries((list) => list.filter((row) => row.key !== p.key));
          listFailed(e);
        }
        focusAfterDelete.current = neighbour;
        setConfirmKey(null);
        announce(`Deleted project ${nm}.`);
      }
    } catch (e) {
      // leaving it may have worked before the delete itself failed: say where you are
      const moved = wasActive && activeKey() !== p.key
        ? ` ${displayName(useStore.getState().projectName)} is open now.` : "";
      refused(`Couldn't delete ${nm}: ${messageOf(e)}.${moved}`);
    }
    finally { setDeleting(false); }
  };
  const rename = () => {
    const nm = draft.trim();
    useStore.getState().setProjectName(nm);
    announce(`Project renamed to ${displayName(nm)}.`);
    setOpen(false);
  };
  const saveFirst = () => {
    const s = useStore.getState();
    const slug = s.projectName.replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "") || "qually";
    saveText(s.exportProject(), `${slug}.qually.json`, "application/json");
  };
  const importFile = async (files: FileList | null) => {
    if (!files?.length) return;
    const picked = Array.from(files);
    setOpen(false); // the open-project dialog takes over from here
    try { await useStore.getState().importFiles(picked); }
    catch (e) {
      // back in the menu, where the reader was, with the reason on screen too
      refused(e instanceof ProjectError ? e.message : `Couldn't open that file: ${messageOf(e)}`);
    }
  };

  return (
    <>
      <button className="btn iconlabel project-trigger" ref={btnRef} onClick={toggle}
        aria-label={`Projects — open: ${name}`} title={`Projects — open: ${name}`}
        aria-haspopup="dialog" aria-expanded={open}>
        <Icon name="folder" size={16} /> <span className="blabel">{name}</span>
        <Icon name={open ? "chevron-up" : "chevron-down"} size={12} />
      </button>
      {open && (
        <div className="ctxmenu project-menu" ref={menuRef} role="dialog"
          aria-label="Projects in this browser" onKeyDown={arrows} style={{ fontSize: fs }}>
          <div className="ctxhead">Projects in this browser</div>
          {listError && <div className="ctxerr">{listError}</div>}
          <ul className="project-list">
            {projects.map((p) => {
              const nm = displayName(p.name);
              const isActive = p.key === key;
              const count = p.transcripts;
              const meta = [
                count === null ? null : `${count} transcript${count === 1 ? "" : "s"}`,
                isActive ? "open now" : p.used === null ? null
                  : `last used ${new Date(p.used).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`,
              ].filter(Boolean).join(" · ");
              return (
                <li key={p.key}>
                  <div className="project-row">
                    <button className="project-open" aria-current={isActive ? "true" : undefined}
                      ref={(el) => { openRefs.current[p.key] = el; }} disabled={deleting}
                      onClick={() => { void openProject(p); }}>
                      <span className="project-name">{isActive && <Icon name="check" size={fs + 2} />}{nm}</span>
                      {meta && <span className="project-meta">{meta}</span>}
                    </button>
                    <button className="danger" aria-label={`Delete project ${nm}`} title={`Delete project ${nm}`}
                      ref={(el) => { trashRefs.current[p.key] = el; }} disabled={deleting}
                      onClick={() => { setConfirmKey(p.key); setRenaming(false); }}>
                      <Icon name="trash" size={fs + 2} />
                    </button>
                  </div>
                  {confirmKey === p.key && (
                    <div className="ctxform">
                      <div className="ctxnote" id={noteId}>
                        Delete <b>{nm}</b> from this browser — {count === null ? "all its transcripts" : `${count} transcript${count === 1 ? "" : "s"}`} and all {count === 1 ? "its" : "their"} coding? This can't be undone.
                        {isActive && <> {projects.length > 1
                          ? "You'll be moved to your most recently used other project."
                          : "A new, empty project takes its place."}</>}
                      </div>
                      {isActive && <button className="btn" onClick={saveFirst}>Save a project file first</button>}
                      <div className="ctxrow">
                        {/* focus lands here, so it carries the warning above with it */}
                        <button className="btn danger" autoFocus aria-disabled={deleting} aria-describedby={noteId}
                          onClick={() => { void remove(p); }}>Delete</button>
                        <button className="btn" disabled={deleting} onClick={() => {
                          setConfirmKey(null); trashRefs.current[p.key]?.focus();
                        }}>Cancel</button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {!available && <div className="ctxnote">This session can keep only one project — saving is off, or this browser has no IndexedDB.</div>}
          <div className="ctxdiv" />
          {renaming ? (
            <div className="ctxform">
              <input autoFocus aria-label="Project name" placeholder="e.g. Voice-UI field study"
                value={draft} onChange={(e) => setDraft(e.target.value)}
                // preventDefault: closing hands focus back to the trigger mid-keystroke,
                // and the Enter's keypress would then click it and reopen the menu
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); rename(); } }} />
              <div className="ctxrow">
                <button className="btn primary" onClick={rename}>Rename</button>
                <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              {available && <button ref={actionRef} disabled={deleting} onClick={() => { void startProject(); }}>
                <Icon name="file-plus" size={fs + 2} /> New project
              </button>}
              <button ref={available ? undefined : actionRef} disabled={deleting}
                onClick={() => { setDraft(projectName); setRenaming(true); setConfirmKey(null); }}>
                <Icon name="pencil" size={fs + 2} /> Rename this project…
              </button>
              <button disabled={deleting} onClick={() => fileRef.current?.click()}>
                <Icon name="upload" size={fs + 2} /> Open a project file…
              </button>
            </>
          )}
        </div>
      )}
      <input ref={fileRef} type="file" accept=".json,application/json" hidden aria-hidden="true" tabIndex={-1}
        onChange={(e) => { void importFile(e.target.files); e.target.value = ""; }} />
    </>
  );
}
