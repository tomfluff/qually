// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { fuzzy } from "./CodeCombobox";

export interface CreatableComboboxOption {
  name: string;
  count: number;
  color?: string;
}

export function creatableEntries(value: string, options: CreatableComboboxOption[]) {
  const query = value.trim();
  const matches = options.filter((option) => fuzzy(query, option.name));
  const exact = options.some((option) => option.name.toLowerCase() === query.toLowerCase());
  return [
    ...matches.map((option) => ({ kind: "pick" as const, ...option })),
    ...(query && !exact
      ? [{ kind: "create" as const, name: query, count: 0, color: undefined }]
      : []),
  ];
}

export type CreatableComboboxKeyIntent =
  | { kind: "none" }
  | { kind: "open"; preventDefault: true }
  | { kind: "highlight"; direction: -1 | 1; preventDefault: true }
  | { kind: "pick"; index: number; preventDefault: true; stopPropagation: boolean }
  | { kind: "close"; stopPropagation: true }
  | { kind: "commit"; preventDefault: true };

export function creatableComboboxKeyIntent({
  key,
  isComposing,
  showList,
  entryCount,
  highlighted,
  openOnArrowDown,
  canCommit,
  stopPickEnterPropagation,
}: {
  key: string;
  isComposing: boolean;
  showList: boolean;
  entryCount: number;
  highlighted: number;
  openOnArrowDown: boolean;
  canCommit: boolean;
  stopPickEnterPropagation: boolean;
}): CreatableComboboxKeyIntent {
  // Confirming an IME candidate is still text entry, never a pick or commit.
  if (isComposing) return { kind: "none" };
  if (!showList) {
    if (key === "ArrowDown" && openOnArrowDown && entryCount)
      return { kind: "open", preventDefault: true };
    if (key === "Enter" && canCommit) return { kind: "commit", preventDefault: true };
    return { kind: "none" };
  }
  if (key === "ArrowDown") return { kind: "highlight", direction: 1, preventDefault: true };
  if (key === "ArrowUp") return { kind: "highlight", direction: -1, preventDefault: true };
  if (key === "Enter")
    return {
      kind: "pick",
      index: Math.min(highlighted, entryCount - 1),
      preventDefault: true,
      stopPropagation: stopPickEnterPropagation,
    };
  if (key === "Escape") return { kind: "close", stopPropagation: true };
  return { kind: "none" };
}

export function CreatableCombobox({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  autoFocus,
  onCommit,
  listId,
  className,
  openOn,
  openOnArrowDown = false,
  stopPickEnterPropagation = false,
  createLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: CreatableComboboxOption[];
  placeholder: string;
  ariaLabel: string;
  autoFocus?: boolean;
  /** Enter with the list closed belongs to the containing form. */
  onCommit?: () => void;
  listId: string;
  className: string;
  openOn: "focus" | "click";
  openOnArrowDown?: boolean;
  /** The event card also saves on Enter, so a pick must not reach that handler. */
  stopPickEnterPropagation?: boolean;
  createLabel: (name: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const lastPointer = useRef({ x: -1, y: -1 });
  const entries = creatableEntries(value, options);
  const showList = open && entries.length > 0;

  const choose = (name: string) => {
    onChange(name);
    setOpen(false);
    setHighlighted(0);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const intent = creatableComboboxKeyIntent({
      key: event.key,
      isComposing: event.nativeEvent.isComposing,
      showList,
      entryCount: entries.length,
      highlighted,
      openOnArrowDown,
      canCommit: !!onCommit,
      stopPickEnterPropagation,
    });
    if ("preventDefault" in intent) event.preventDefault();
    if ("stopPropagation" in intent && intent.stopPropagation) event.stopPropagation();
    if (intent.kind === "open") {
      setOpen(true);
      setHighlighted(0);
    } else if (intent.kind === "highlight") {
      setHighlighted((index) => intent.direction === 1
        ? Math.min(index + 1, entries.length - 1)
        : Math.max(index - 1, 0));
    } else if (intent.kind === "pick") {
      const entry = entries[intent.index];
      if (entry) choose(entry.name);
    } else if (intent.kind === "close") {
      setOpen(false);
    } else if (intent.kind === "commit") {
      onCommit?.();
    }
  };

  return (
    <div className={`newCodeWrap ${className}`}>
      <input
        className="signinput"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        aria-activedescendant={showList ? `${listId}-${highlighted}` : undefined}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setHighlighted(0);
        }}
        onFocus={openOn === "focus" ? () => setOpen(true) : undefined}
        onClick={openOn === "click" ? () => setOpen(true) : undefined}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <div className="acList nicescroll" role="listbox" id={listId}>
          {entries.map((entry, index) => (
            <div
              key={entry.kind + entry.name}
              className={`acItem${index === highlighted ? " hl" : ""}`}
              role="option"
              id={`${listId}-${index}`}
              aria-selected={index === highlighted}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(entry.name);
              }}
              onMouseMove={(event) => {
                // Scrolling can dispatch mousemove at unchanged coordinates.
                if (event.clientX === lastPointer.current.x && event.clientY === lastPointer.current.y) return;
                lastPointer.current = { x: event.clientX, y: event.clientY };
                setHighlighted(index);
              }}
            >
              {entry.kind === "pick" ? (
                <>
                  {entry.color && <span className="swatch" style={{ background: entry.color }} />}
                  <span className="acName">{entry.name}</span>
                  <span className="cnt">{entry.count}</span>
                </>
              ) : (
                <span className="acCreate">{createLabel(entry.name)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
