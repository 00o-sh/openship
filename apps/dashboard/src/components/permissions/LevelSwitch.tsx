"use client";

/**
 * A segmented control for named, CUMULATIVE access levels — the legible face of
 * read / read+write / read+write+admin.
 *
 * Lossless as a display: the server's permission check is cumulative
 * (permission.ts — read ⇐ read|write|admin, write ⇐ write|admin), so ["write"]
 * and ["read","write"] authorize identically and normalizing to the cumulative
 * set when the user picks a level changes nothing about what the grant can do.
 *
 * Deliberately label-agnostic: the caller supplies the options, so this component
 * carries no copy and no notion of what a "level" means.
 */

export interface LevelOption {
  id: string;
  label: string;
  /** Shown on hover — useful when `label` is abbreviated to fit. */
  title?: string;
}

export function LevelSwitch({
  options,
  value,
  disabled,
  onChange,
  size = "md",
}: {
  options: readonly LevelOption[];
  value: string;
  disabled?: boolean;
  onChange: (id: string) => void;
  size?: "sm" | "md";
}) {
  const pad = size === "sm" ? "px-2 py-[3px] text-[10px]" : "px-2.5 py-1 text-[11px]";
  return (
    <div className="inline-flex shrink-0 rounded-lg bg-muted/50 p-0.5 ring-1 ring-inset ring-border/50">
      {options.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            disabled={disabled}
            aria-pressed={active}
            // Only when it actually adds something. A title identical to the
            // visible label just parks a native tooltip over the control.
            title={o.title && o.title !== o.label ? o.title : undefined}
            className={`whitespace-nowrap rounded-md font-medium transition-colors disabled:opacity-50 ${pad} ${
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground/70 hover:bg-card/40 hover:text-foreground"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
