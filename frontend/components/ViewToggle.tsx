"use client";

export type ViewMode = "grid" | "list";

interface ViewToggleProps {
  value: ViewMode;
  onChange: (value: ViewMode) => void;
}

function GridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="2.5" y="2.5" width="6" height="6" rx="1" />
      <rect x="11.5" y="2.5" width="6" height="6" rx="1" />
      <rect x="2.5" y="11.5" width="6" height="6" rx="1" />
      <rect x="11.5" y="11.5" width="6" height="6" rx="1" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 5h14M3 10h14M3 15h14" strokeLinecap="round" />
    </svg>
  );
}

// Drive-style segmented grid/list control. Presentation only — the caller owns
// the persisted value (e.g. localStorage) and swaps rendering, no refetch.
export default function ViewToggle({ value, onChange }: ViewToggleProps) {
  return (
    <div className="dam-glass inline-flex h-10 items-center rounded-[10px] p-1" role="group" aria-label="View">
      <button
        type="button"
        aria-label="Grid view"
        aria-pressed={value === "grid"}
        onClick={() => onChange("grid")}
        className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-[7px] transition-colors ${
          value === "grid"
            ? "bg-brand text-white shadow-[0_2px_8px_var(--shadow-color-brand)]"
            : "text-slate hover:bg-white/60 dark:hover:bg-white/10"
        }`}
      >
        <GridIcon />
      </button>
      <button
        type="button"
        aria-label="List view"
        aria-pressed={value === "list"}
        onClick={() => onChange("list")}
        className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-[7px] transition-colors ${
          value === "list"
            ? "bg-brand text-white shadow-[0_2px_8px_var(--shadow-color-brand)]"
            : "text-slate hover:bg-white/60 dark:hover:bg-white/10"
        }`}
      >
        <ListIcon />
      </button>
    </div>
  );
}
