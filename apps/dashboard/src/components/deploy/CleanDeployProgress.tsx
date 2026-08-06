"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Check,
  ArrowRight,
  ArrowLeft,
  ExternalLink,
  AlertTriangle,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { INSTALL_PHASES, type InstallPhaseId, type InstallPhaseStatus } from "@repo/core";
import { AppLogo } from "@/components/AppLogo";
import { PageContainer } from "@/components/ui/PageContainer";
import { useI18n } from "@/components/i18n-provider";
import { InstallStepper, type StepItem, type StepStatus } from "@/components/deploy/InstallStepper";
import { ConnectionCard } from "@/app/(dashboard)/projects/[id]/components/ConnectionCard";
import type { ServiceStatusEvent } from "@/lib/sseMessageProcessors";

export type CleanDeployPhase = "installing" | "done" | "error";

/** Map a raw deployment status to the two clean progress labels. */
export function labelForStatus(
  status: string,
  labels: { progressPreparing: string; progressDeploying: string },
): string {
  if (status === "building" || status === "deploying") return labels.progressDeploying;
  return labels.progressPreparing;
}

/**
 * Derive a public host from the deploy's publicEndpoints (custom domain wins,
 * else the free subdomain label + base domain).
 */
export function firstPublicHost(
  endpoints: Array<{ domain?: string; customDomain?: string; domainType?: string }> | undefined,
  baseDomain: string,
): string | null {
  const ep = endpoints?.[0];
  if (!ep) return null;
  if (ep.customDomain) return ep.customDomain;
  if (ep.domain) return ep.domain.includes(".") ? ep.domain : `${ep.domain}.${baseDomain}`;
  return null;
}

/** A running compose service reads as `done` on the stepper; a failed one as
 *  `failed`; anything mid-flight (building/built/deploying) as `active`. */
function serviceStatusToStep(status: ServiceStatusEvent["status"]): StepStatus {
  if (status === "running") return "done";
  if (status === "failed") return "failed";
  if (status === "pending") return "pending";
  return "active";
}

/**
 * Live log panel — a clean, theme-aware monospace console (an elevated surface
 * that adapts to light/dark, not a hardcoded black box) with a titlebar, a
 * "live" pulse while streaming, and auto-scroll to the newest line. Renders a
 * waiting placeholder until the build emits output so early phases read as
 * "working". All colors are semantic tokens.
 */
function TerminalLogs({
  logs,
  live,
  label,
  noTopMargin,
}: {
  logs: string;
  live: boolean;
  label: string;
  /** Drop the default top margin — the two-column install layout spaces it. */
  noTopMargin?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(
    () =>
      logs
        .split("\n")
        .map((l) => l.replace(/\s+$/, ""))
        .filter((l) => l.length > 0)
        .slice(-400),
    [logs],
  );

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines.length]);

  return (
    <div
      className={`${noTopMargin ? "" : "mt-5 "}overflow-hidden rounded-xl border border-border/60 bg-muted/40`}
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-3.5 py-2">
        <span className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-danger/60" />
          <span className="size-2.5 rounded-full bg-warning/60" />
          <span className="size-2.5 rounded-full bg-success/60" />
        </span>
        <span className="ms-1.5 font-mono text-[11px] tracking-wide text-muted-foreground">{label}</span>
        {live && (
          <span className="ms-auto inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-success">
            <span className="size-1.5 animate-pulse rounded-full bg-success-solid" />
            live
          </span>
        )}
      </div>
      <div
        ref={boxRef}
        className="max-h-72 overflow-auto p-3.5 font-mono text-[11.5px] leading-relaxed"
      >
        {lines.length === 0 ? (
          <span className="text-muted-foreground/70">Waiting for output…</span>
        ) : (
          lines.map((l, i) => (
            <div key={i} className="flex gap-3">
              <span className="select-none text-muted-foreground/40 tabular-nums">
                {String(i + 1).padStart(3, " ")}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-foreground/80">{l}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Logs demoted to an on-demand detail: a Show/Hide toggle over the terminal
 *  panel, open by default so there's live feedback but foldable to keep the
 *  stepper the star. */
function CollapsibleLogs({
  logs,
  live,
  label,
  showLabel,
  hideLabel,
}: {
  logs: string;
  live: boolean;
  label: string;
  showLabel: string;
  hideLabel: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {open ? hideLabel : showLabel}
        </button>
      </div>
      {open && <TerminalLogs logs={logs} live={live} label={label} noTopMargin />}
    </div>
  );
}

/** A static credentials block for an app whose first login is a known default
 *  (e.g. Grafana admin/admin). Not a resolved connection value — authored copy
 *  from the app JSON, so it sits beside the ConnectionCard, not inside it. */
function FirstLoginCard({
  title,
  userLabel,
  passLabel,
  firstLogin,
}: {
  title: string;
  userLabel: string;
  passLabel: string;
  firstLogin: { username?: string; password?: string; note?: string };
}) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
        {firstLogin.username != null && firstLogin.username !== "" && (
          <div className="min-w-0">
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {userLabel}
            </label>
            <div className="mt-2 flex min-h-11 items-center rounded-xl bg-muted px-3.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
                {firstLogin.username}
              </code>
            </div>
          </div>
        )}
        {firstLogin.password != null && firstLogin.password !== "" && (
          <div className="min-w-0">
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {passLabel}
            </label>
            <div className="mt-2 flex min-h-11 items-center rounded-xl bg-muted px-3.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
                {firstLogin.password}
              </code>
            </div>
          </div>
        )}
      </div>
      {firstLogin.note && (
        <p className="mt-3 text-xs leading-relaxed text-warning">{firstLogin.note}</p>
      )}
    </div>
  );
}

/**
 * The install progress view shared by the app wizards. Keeps the install form's
 * frame + header (logo · name · status) so the flow reads as one continuous
 * wizard.
 *
 * Two shapes, chosen by whether `phases` is passed:
 *  - JSON-mapped install (app wizard): a left phase stepper (images → services →
 *    app-setup → ready, with a per-service sub-list and authored app-setup steps)
 *    and logs demoted to a foldable panel; the done screen adds a connect +
 *    first-login surface.
 *  - Legacy (mail wizard, no `phases`): the original progress bar + terminal.
 */
export function CleanDeployProgressCard({
  appId,
  title,
  description,
  phase,
  progress,
  phaseLabel,
  liveUrl,
  logs,
  errorMsg,
  deploymentId,
  onGoToProject,
  onViewBuild,
  onRetry,
  phases,
  services,
  appSetupSteps,
  firstLogin,
  connect,
}: {
  appId: string;
  title: string;
  /** App description — shown under the title while installing (header parity). */
  description?: string;
  phase: CleanDeployPhase;
  progress: number;
  phaseLabel: string;
  liveUrl: string | null;
  /** Plain build-log text (SSE-accumulated or status-poll) — powers the terminal. */
  logs?: string;
  errorMsg: string;
  deploymentId: string | null;
  onGoToProject: () => void;
  onViewBuild: () => void;
  onRetry: () => void;
  /** Live install-phase status map. Presence switches on the JSON-mapped stepper
   *  layout; absent → the legacy progress-bar layout (mail wizard). */
  phases?: Partial<Record<InstallPhaseId, InstallPhaseStatus>>;
  /** Per-service statuses, rendered as the sub-list under the `services` phase. */
  services?: ServiceStatusEvent[];
  /** Authored app-setup steps (prepare-step titles), shown under `app-setup`. */
  appSetupSteps?: Array<{ id: string; label: string }>;
  /** Static default credentials (e.g. admin/admin) for the done screen. */
  firstLogin?: { username?: string; password?: string; note?: string };
  /** Resolved-connection card target for the done screen. */
  connect?: {
    projectId: string;
    appTemplateId?: string | null;
    serverId?: string | null;
    deployTarget?: string | null;
  };
}) {
  const { t } = useI18n();
  const w = t.projectSettings.appInstall;
  const liveHost = liveUrl ? liveUrl.replace(/^https?:\/\//, "") : null;
  // `phases` is the switch: the app wizard always passes its state object (even
  // empty → all-pending preview); the mail wizard passes nothing.
  const hasStepper = phases !== undefined;

  const statusLine =
    phase === "installing" ? phaseLabel : phase === "done" ? w.progressLive : w.installFailed;

  const phaseLabelFor: Record<InstallPhaseId, string> = {
    images: w.phaseImages,
    services: w.phaseServices,
    "app-setup": w.phaseAppSetup,
    ready: w.phaseReady,
  };

  const serviceItems: StepItem[] = (services ?? []).map((s) => ({
    id: s.serviceId || s.serviceName,
    label: s.serviceName,
    status: serviceStatusToStep(s.status),
  }));
  const appSetupStatus: StepStatus = phases?.["app-setup"] ?? "pending";
  const appSetupItems: StepItem[] = (appSetupSteps ?? []).map((a) => ({
    id: a.id,
    label: a.label,
    status: appSetupStatus,
  }));
  // The app-setup phase only exists when the app has prepare steps — otherwise
  // it would hang "pending" forever after the deploy went live.
  const hasAppSetup = (appSetupSteps?.length ?? 0) > 0 || phases?.["app-setup"] != null;
  const stepItems: StepItem[] = INSTALL_PHASES.filter(
    (p) => p.id !== "app-setup" || hasAppSetup,
  ).map((p) => ({
    id: p.id,
    label: phaseLabelFor[p.id],
    status: phases?.[p.id] ?? "pending",
    children:
      p.id === "services" && serviceItems.length > 0 ? (
        <InstallStepper steps={serviceItems} />
      ) : p.id === "app-setup" && appSetupItems.length > 0 ? (
        <InstallStepper steps={appSetupItems} />
      ) : undefined,
  }));

  return (
    <PageContainer outerClassName="pb-20">
      <div className={`mx-auto ${hasStepper ? "max-w-4xl" : "max-w-2xl"} pt-6`}>
        {/* Header — same logo · title layout as the install form, so the wizard
            reads as one continuous flow rather than jumping to a modal card. */}
        <div className="flex items-center gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-muted/60">
            <AppLogo appId={appId} className="size-7 object-contain" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold text-foreground">{title}</h1>
            <p className="mt-0.5 flex items-center gap-2 text-sm text-muted-foreground">
              {phase === "installing" && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
              {phase === "done" && <Check className="size-3.5 shrink-0 text-success" />}
              {phase === "error" && <AlertTriangle className="size-3.5 shrink-0 text-danger" />}
              <span className="truncate">{statusLine}</span>
            </p>
          </div>
        </div>

        {phase === "installing" &&
          (hasStepper ? (
            <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
              <div className="rounded-2xl border border-border/50 bg-card p-5">
                <h2 className="text-sm font-semibold text-foreground">{w.stepperTitle}</h2>
                <div className="mt-4">
                  <InstallStepper steps={stepItems} />
                </div>
              </div>
              <CollapsibleLogs
                logs={logs ?? ""}
                live
                label={w.deployLogs}
                showLabel={w.showLogs}
                hideLabel={w.hideLogs}
              />
            </div>
          ) : (
            <>
              <div className="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500"
                  style={{ width: `${Math.max(5, progress)}%` }}
                />
              </div>
              {logs != null && <TerminalLogs logs={logs} live label={w.deployLogs} />}
            </>
          ))}

        {phase === "done" && (
          <div className="mt-6 space-y-4">
            <div className="rounded-2xl border border-border/50 bg-card p-6">
              <div className="flex size-10 items-center justify-center rounded-full bg-success-bg ring-4 ring-success/10">
                <Check className="size-5 text-success" />
              </div>
              <h2 className="mt-4 text-base font-semibold text-foreground">{w.progressLive}</h2>
              {liveHost && (
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground/70">
                  {liveHost}
                </p>
              )}
              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                {liveUrl && (
                  <a
                    href={liveUrl.startsWith("http") ? liveUrl : `https://${liveUrl}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    <ExternalLink className="size-4" /> {w.openApp}
                  </a>
                )}
                <button
                  type="button"
                  onClick={onGoToProject}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
                >
                  {w.goToApp} <ArrowRight className="size-4 rtl:rotate-180" />
                </button>
              </div>
            </div>

            {firstLogin && (firstLogin.username || firstLogin.password) && (
              <FirstLoginCard
                title={w.firstLoginTitle}
                userLabel={w.firstLoginUser}
                passLabel={w.firstLoginPassword}
                firstLogin={firstLogin}
              />
            )}

            {connect?.projectId && (
              <ConnectionCard
                projectId={connect.projectId}
                appTemplateId={connect.appTemplateId}
                serverId={connect.serverId}
                deployTarget={connect.deployTarget}
              />
            )}
          </div>
        )}

        {phase === "error" && (
          <div className="mt-6 rounded-2xl border border-border/50 bg-card p-6">
            <div className="flex size-10 items-center justify-center rounded-full bg-danger-bg ring-4 ring-danger/10">
              <AlertTriangle className="size-5 text-danger" />
            </div>
            <h2 className="mt-4 text-base font-semibold text-foreground">{w.installFailed}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{errorMsg}</p>
            {logs != null && <TerminalLogs logs={logs} live={false} label={w.deployLogs} />}
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              {deploymentId && (
                <button
                  type="button"
                  onClick={onViewBuild}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
                >
                  <SlidersHorizontal className="size-4" /> {w.viewDetails}
                </button>
              )}
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-4 rtl:rotate-180" /> {w.back}
              </button>
            </div>
          </div>
        )}

        {description && phase === "installing" && !hasStepper && (
          <p className="mt-4 text-center text-xs text-muted-foreground/50">{description}</p>
        )}
      </div>
    </PageContainer>
  );
}
