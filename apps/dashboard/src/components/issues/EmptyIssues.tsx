"use client";

import { CheckCircle2, ShieldAlert } from "lucide-react";

import { useI18n } from "@/components/i18n-provider";

/**
 * Three distinct nothings, because they mean different things: nothing is wrong,
 * nothing has recovered yet, and nothing matches the filter you typed.
 *
 * The distinction is the point — "no resolved incidents" must never read as "your
 * fleet is healthy", and a filtered-out list must never read as either. Lives beside
 * the other presentation pieces (no fetching) so the page, the fixture preview and the
 * render test all show the same nothing.
 */
export function EmptyIssues({ filtered, resolved }: { filtered: boolean; resolved: boolean }) {
  const { t } = useI18n();
  const c = t.issues.empty;
  const [Icon, title, body] = filtered
    ? [ShieldAlert, c.filteredTitle, c.filteredBody]
    : resolved
      ? [CheckCircle2, c.resolvedTitle, c.resolvedBody]
      : [CheckCircle2, c.openTitle, c.openBody];

  return (
    <div className="rounded-2xl border border-border/50 bg-card px-6 py-16 text-center">
      <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-2xl bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <h3 className="text-[15px] font-medium text-foreground">{title}</h3>
      <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-muted-foreground/80">
        {body}
      </p>
    </div>
  );
}
