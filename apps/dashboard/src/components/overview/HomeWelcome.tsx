"use client";

import React from "react";
import Link from "next/link";
import { Plus, Github } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

/**
 * First-run welcome shown on the home page when the user has no projects.
 *
 * The motif is what Openship actually IS: a hub wired to the things it runs —
 * repo, services, database, public domain — rather than a generic empty card.
 * Neutral --th-* vars only (works in light/dark/dim); the primary accent stays on
 * the CTA, and the one green dot marks the live edge, matching the traffic-light
 * precedent elsewhere in the illustration family.
 *
 * Kept deliberately compact: this renders INSIDE the home page's Projects card,
 * directly above the 4 shortcut cards — every extra 40px here pushes those below
 * the fold on a laptop.
 */

/** One satellite node: rounded tile + hand-drawn glyph (no icon fonts in SVG). */
function Node({
  x,
  y,
  children,
}: {
  x: number;
  y: number;
  children: React.ReactNode;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect
        x="-17"
        y="-15"
        width="34"
        height="30"
        rx="9"
        fill="var(--th-card-bg)"
        stroke="var(--th-bd-default)"
        strokeWidth="1.5"
      />
      {children}
    </g>
  );
}

const HomeWelcome: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="px-6 pt-5 pb-7 sm:pt-7 sm:pb-8">
      {/* Illustration — the graph: hub ↔ repo / services / data / domain */}
      <div className="relative mx-auto mb-3 h-32 w-72">
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 288 128" fill="none">
          {/* Orbit the whole graph sits in. Kept inside the node tiles' bounds so
              it never clips at the canvas edge. */}
          <ellipse
            cx="144"
            cy="64"
            rx="118"
            ry="49"
            stroke="var(--th-bd-subtle)"
            strokeWidth="1.5"
            strokeDasharray="4 8"
          />

          {/* Links, drawn first so the nodes sit on top. Dashed = wiring. */}
          <g stroke="var(--th-on-15)" strokeWidth="1.5" strokeDasharray="4 4" fill="none">
            <path d="M76 34 Q 104 44 124 56" />
            <path d="M76 94 Q 104 84 124 72" />
            <path d="M164 56 Q 184 44 212 34" />
            <path d="M164 72 Q 184 84 212 94" />
          </g>

          {/* Packets in flight — one per link, at each curve's midpoint, with
              stepped opacity so the graph reads as active rather than static. */}
          <circle cx="101" cy="45" r="2.5" fill="var(--th-on-30)" />
          <circle cx="101" cy="83" r="2" fill="var(--th-on-20)" />
          <circle cx="187" cy="45" r="2.5" fill="var(--th-on-25)" />
          <circle cx="187" cy="83" r="2" fill="var(--th-on-20)" />

          {/* ── Hub: Openship. The ring is the brand mark. ── */}
          <rect x="120" y="42" width="48" height="44" rx="14" fill="var(--th-sf-05)" />
          <rect
            x="118"
            y="40"
            width="48"
            height="44"
            rx="14"
            fill="var(--th-card-bg)"
            stroke="var(--th-bd-strong)"
            strokeWidth="2"
          />
          <circle cx="142" cy="62" r="10" stroke="var(--th-on-40)" strokeWidth="3" fill="none" />
          {/* live indicator */}
          <circle cx="160" cy="48" r="3.5" fill="#22c55e" fillOpacity="0.75" />

          {/* ── Repo (top-left) — two commits on a branch ── */}
          <Node x={52} y={30}>
            <circle cx="-6" cy="4" r="3.5" stroke="var(--th-on-35)" strokeWidth="1.8" fill="none" />
            <circle cx="7" cy="-5" r="3.5" stroke="var(--th-on-35)" strokeWidth="1.8" fill="none" />
            <path d="M-6 0v-4a4 4 0 0 1 4-4h5" stroke="var(--th-on-25)" strokeWidth="1.6" fill="none" />
          </Node>

          {/* ── Data (bottom-left) — stacked disks ── */}
          <Node x={52} y={98}>
            <ellipse cx="0" cy="-6" rx="9" ry="3.4" stroke="var(--th-on-35)" strokeWidth="1.6" fill="none" />
            <path d="M-9-6v8c0 1.9 4 3.4 9 3.4s9-1.5 9-3.4v-8" stroke="var(--th-on-35)" strokeWidth="1.6" fill="none" />
            <path d="M-9-1c0 1.9 4 3.4 9 3.4s9-1.5 9-3.4" stroke="var(--th-on-20)" strokeWidth="1.4" fill="none" />
          </Node>

          {/* ── Domain (top-right) — globe ── */}
          <Node x={236} y={30}>
            <circle cx="0" cy="0" r="9" stroke="var(--th-on-35)" strokeWidth="1.6" fill="none" />
            <path d="M-9 0h18M0-9c4.5 4 4.5 14 0 18M0-9c-4.5 4-4.5 14 0 18" stroke="var(--th-on-22)" strokeWidth="1.4" fill="none" />
          </Node>

          {/* ── Services (bottom-right) — container ── */}
          <Node x={236} y={98}>
            <rect x="-9" y="-6" width="18" height="13" rx="2.5" stroke="var(--th-on-35)" strokeWidth="1.6" fill="none" />
            <path d="M-3-6v13M3-6v13" stroke="var(--th-on-20)" strokeWidth="1.4" />
          </Node>

          {/* Decorative accents — same vocabulary as the other illustrations.
              Kept clear of the orbit path so nothing reads as a stray dash. */}
          <path d="M12 40l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
          <path d="M272 90l1.6-3.2 1.6 3.2-3.2-1.6 3.2 0-3.2 1.6z" fill="var(--th-on-12)" />
          <circle cx="20" cy="86" r="4" fill="var(--th-on-08)" />
          <circle cx="266" cy="42" r="3" fill="var(--th-on-10)" />
        </svg>
      </div>

      {/* Copy */}
      <div className="text-center">
        <h3 className="mb-1.5 text-xl font-medium text-foreground/85" style={{ letterSpacing: "-0.2px" }}>
          {t.overview.welcome.title}
        </h3>
        <p className="mx-auto mb-5 max-w-sm text-sm leading-relaxed text-muted-foreground/80">
          {t.overview.welcome.subtitle}
        </p>

        {/* CTAs */}
        <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/library"
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25"
          >
            <Plus className="size-4" />
            {t.overview.welcome.createProject}
          </Link>
          <Link
            href="/library"
            className="inline-flex items-center gap-2 rounded-xl bg-muted/50 px-6 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Github className="size-4" />
            {t.overview.welcome.importGithub}
          </Link>
        </div>
      </div>

      <p className="mt-5 text-center text-xs text-muted-foreground/60">
        {t.overview.welcome.tipPrefix}{" "}
        <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘ K</kbd>{" "}
        {t.overview.welcome.tipSuffix}
      </p>
    </div>
  );
};

export default HomeWelcome;
