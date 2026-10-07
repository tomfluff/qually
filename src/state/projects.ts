// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Several projects in one browser: the moves between them. A move first saves
// the project being left and waits to see it land; then, in ONE synchronous
// tick, points autosave at the next project and swaps the store's state — so
// no write can ever pair one project's state with the other's key. Moves run
// one at a time: a second click while the first is still reading waits its turn.
import { useStore } from "./store";
import type { Project } from "../project";
import { activeKey, dropRawState, enterProject, listProjects, newProjectKey, projectsAvailable,
  readProject, saveNow } from "./persistence";
import { dropScroll, positioned, scrollFor } from "../scrollMemory";
import { aiBusy } from "../ai/openai";

export { activeKey, listProjects, projectsAvailable, type ProjectEntry } from "./persistence";

let queue: Promise<unknown> = Promise.resolve();
const serial = <T,>(fn: () => Promise<T> | T): Promise<T> => {
  const run = queue.then(() => {
    if (!projectsAvailable())
      throw new Error("saving is off in this session, so projects can't be switched, created or deleted");
    return fn();
  });
  queue = run.catch(() => { /* the caller reports it; the next move still runs */ });
  return run;
};

// an AI answer lands in whichever project is open when it arrives
const notBusy = () => {
  if (aiBusy()) throw new Error("an AI request is still running — let it finish, or stop it, first");
};

async function leave() {
  notBusy();
  // save the project being left however long ago it was last edited — so it is
  // on disk, and listed with its name and size — and SEE it land: a move never
  // strands edits that only this tab's memory still holds
  useStore.setState({});
  try { await saveNow(); }
  catch (e) {
    throw new Error(`this project couldn't be saved, so it stays open (${e instanceof Error ? e.message : String(e)})`,
      { cause: e });
  }
  notBusy(); // ...and one started while it was saving
}

function enter(key: string, load: () => void) {
  const from = activeKey(), before = useStore.getState(), placed = [...positioned];
  enterProject(key);
  scrollFor(key);
  try { load(); }
  catch (e) {
    // Nothing of the next project landed (a corrupt envelope fails before any
    // set): point back, or the next edit would save this project's state over
    // that one's. The open transcript never re-mounted, so it never re-places
    // itself: hand back its "placed" mark too, or its scrolling stops saving.
    if (useStore.getState() === before) {
      enterProject(from);
      scrollFor(from);
      for (const pid of placed) positioned.add(pid);
    }
    throw e;
  }
}

// read FIRST: a project that can't be read is never entered, and the one you
// are on stays exactly as it was. `discard`: the one you are on is about to be
// deleted, so its edits needn't land first.
async function open(key: string, discard = false) {
  const saved = await readProject(key);
  // a record that isn't an envelope would load as a blank project — and the
  // first autosave would then write that blank over whatever it does hold
  const state = (saved as { state?: unknown } | undefined)?.state;
  if (saved !== undefined && (!state || typeof state !== "object" || Array.isArray(state)))
    throw new Error("its saved data isn't in a shape this version of QuAlly can open");
  if (discard) notBusy(); else await leave();
  enter(key, () => useStore.getState().loadProjectState(state));
}

/** resolves true when it moved (false: that project was already open) */
export const switchProject = (key: string) =>
  serial(async () => (key === activeKey() ? false : (await open(key), true)));

export const createProject = () => serial(async () => {
  await leave();
  enter(newProjectKey(), () => useStore.getState().newProject());
});

/** A project file opened beside the current work instead of over it. Resolves
    false when the file was cancelled while the current project was saving. */
export const openAsNewProject = (p: Project) => serial(async () => {
  await leave();
  if (useStore.getState().pendingProject !== p) return false;
  enter(newProjectKey(), () => useStore.getState().openProject(p));
  return true;
});

/** Delete a project from this browser. The open one is left first — for the
    most recently used other project, or a fresh one when it was the last —
    WITHOUT insisting that it save on the way out: a full disk is exactly when
    a project needs deleting, and its edits are going anyway. */
export const deleteProject = (key: string) => serial(async () => {
  if (key === activeKey()) {
    const next = (await listProjects()).filter((p) => p.key !== key)
      .sort((a, b) => (b.used ?? 0) - (a.used ?? 0))[0];
    if (next) await open(next.key, true);
    else {
      notBusy();
      enter(newProjectKey(), () => useStore.getState().newProject());
    }
  }
  await dropRawState(key);
  dropScroll(key);
});
