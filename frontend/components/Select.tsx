"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

// A flat single-select dropdown replacing native <select> app-wide — the
// browser draws <option> text itself, in the OS font, which no CSS can
// reach; that's the only reason this exists (dark:bg-card already made every
// native select's own background correct — see the Stage 111 select audit).
// Mechanically this is CollectionTreePicker with the tree flattened to a
// plain option list: same portal-to-document.body + position:fixed-from-
// getBoundingClientRect() escape from the .dam-glass backdrop-filter
// stacking trap, same outside-click/Escape handling. Extended with real
// listbox keyboard parity (Home/End, typeahead) that a flat list needs but a
// tree never did.
export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  className?: string;
}

const TYPEAHEAD_RESET_MS = 600;

function TriggerChevronIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-slate" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M5.5 8l4.5 4.5L14.5 8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  id,
  ariaLabel,
  className,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>({
    buffer: "",
    timer: null,
  });

  // Falls back to a React-generated id (stable per instance, collision-free
  // across every Select on the page) whenever the caller doesn't pass one —
  // needed for aria-activedescendant's option ids, not just the listbox id.
  const generatedId = useId();
  const baseId = id ?? generatedId;
  const listboxId = `${baseId}-listbox`;

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  // Opens with the current value already highlighted, same as a native
  // select's popup — not always index 0.
  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value);
    setActiveIndex(idx >= 0 ? idx : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function openPanel() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.max(rect.width, 160);
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
      // Estimated from the real option row height (~34px) + panel padding,
      // capped at the same max-height the panel itself scrolls at — a short
      // list (e.g. 2 options) shouldn't trigger the "opens upward" branch
      // meant for tall ones.
      const panelHeight = Math.min(320, 12 + options.length * 34);
      const opensDown = rect.bottom + 6 + panelHeight <= window.innerHeight;
      setPos(
        opensDown
          ? { top: rect.bottom + 6, left, width }
          : { bottom: window.innerHeight - rect.top + 6, left, width },
      );
    }
    setOpen(true);
  }

  function toggle() {
    if (disabled) return;
    if (open) setOpen(false);
    else openPanel();
  }

  function commit(index: number) {
    const opt = options[index];
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
  }

  function handleTriggerKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (open) return; // the listbox itself owns keydown once open
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPanel();
    }
  }

  function runTypeahead(char: string) {
    const buf = (typeaheadRef.current.buffer + char).toLowerCase();
    typeaheadRef.current.buffer = buf;
    if (typeaheadRef.current.timer) clearTimeout(typeaheadRef.current.timer);
    typeaheadRef.current.timer = setTimeout(() => {
      typeaheadRef.current.buffer = "";
      typeaheadRef.current.timer = null;
    }, TYPEAHEAD_RESET_MS);

    if (options.length === 0) return;
    // Search forward from just after the active option, wrapping all the way
    // around back to it (repeated keystrokes of the same letter cycle
    // through every match, ending back where they started if there's only one).
    const n = options.length;
    for (let step = 1; step <= n; step++) {
      const idx = (activeIndex + step) % n;
      if (options[idx].label.toLowerCase().startsWith(buf)) {
        setActiveIndex(idx);
        return;
      }
    }
  }

  function handleListKeyDown(e: React.KeyboardEvent) {
    if (options.length === 0) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(options.length - 1, i + 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        return;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        return;
      case "End":
        e.preventDefault();
        setActiveIndex(options.length - 1);
        return;
      case "Enter":
        e.preventDefault();
        commit(activeIndex);
        return;
      case " ":
        e.preventDefault();
        commit(activeIndex);
        return;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        return;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          runTypeahead(e.key);
        }
    }
  }

  const selected = useMemo(() => options.find((o) => o.value === value), [options, value]);
  const triggerLabel = selected ? selected.label : value ? "…" : (placeholder ?? "");

  const defaultTriggerClass =
    "flex w-full items-center justify-between gap-2 rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-controls={listboxId}
        onClick={toggle}
        onKeyDown={handleTriggerKeyDown}
        className={className ?? `${defaultTriggerClass} cursor-pointer`}
      >
        <span className={`truncate ${!selected ? "text-slate" : ""}`}>{triggerLabel}</span>
        <TriggerChevronIcon />
      </button>

      {open &&
        pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div
              className="fixed z-50 rounded-[10px] border border-line bg-card shadow-lg"
              style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width }}
            >
              <div
                ref={listRef}
                id={listboxId}
                role="listbox"
                aria-label={ariaLabel}
                aria-activedescendant={options[activeIndex] ? `${baseId}-opt-${activeIndex}` : undefined}
                tabIndex={0}
                onKeyDown={handleListKeyDown}
                className="max-h-80 overflow-y-auto p-1.5 outline-none"
              >
                {options.length === 0 && (
                  <div className="px-2 py-3 text-sm text-slate">No options available.</div>
                )}
                {options.map((opt, i) => {
                  const isSelected = opt.value === value;
                  const isActive = i === activeIndex;
                  return (
                    <div
                      key={opt.value}
                      id={`${baseId}-opt-${i}`}
                      role="option"
                      aria-selected={isSelected}
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => commit(i)}
                      className={`flex select-none items-center rounded-[6px] px-2.5 py-1.5 text-sm cursor-pointer text-ink hover:bg-mist ${
                        isSelected ? "bg-surface-tint font-medium text-brand" : ""
                      } ${isActive ? "ring-1 ring-inset ring-brand/40" : ""}`}
                    >
                      <span className="truncate">{opt.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
