"use client";

import { BadgeCheck } from "lucide-react";

/**
 * Data-driven "Verified" trust mark (from `AppTemplate.verified`). Shown on
 * catalog cards + the install wizard. Hover reveals why the app is trusted —
 * official open-source image, version-pinned, reviewed pipeline. CSS-only
 * tooltip (no dependency); the icon is non-interactive so it's safe inside the
 * card <button>. Use `text-info` per the semantic status tokens.
 */
export function VerifiedBadge({
  className = "",
  iconClassName = "size-4",
}: {
  className?: string;
  /** Literal tailwind size class for the icon (must be a full class name). */
  iconClassName?: string;
}) {
  return (
    <span className={`group/vb relative inline-flex items-center ${className}`}>
      <BadgeCheck className={`${iconClassName} text-info`} aria-label="Verified app" />
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-30 mt-2 w-60 -translate-x-1/2 rounded-xl border border-border/60 bg-card px-3 py-2.5 text-start text-[11px] normal-case leading-relaxed tracking-normal text-muted-foreground opacity-0 shadow-xl transition-opacity duration-150 group-hover/vb:opacity-100"
      >
        <span className="mb-1 flex items-center gap-1.5 font-semibold text-foreground">
          <BadgeCheck className="size-3.5 text-info" /> Verified app
        </span>
        Uses the project&apos;s official, open-source image pinned to a version, deployed through a
        reviewed pipeline. The full definition is public and auditable.
      </span>
    </span>
  );
}
