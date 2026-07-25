"use client";

import { useState } from "react";
import { Loader2, Github, ChevronDown, Globe } from "lucide-react";
import { projectsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { useToast } from "@/context/ToastContext";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n, interpolate } from "@/components/i18n-provider";

/**
 * The managed GitHub push→auto-deploy hook, surfaced INSIDE the generic Webhooks
 * tab (its route/status used to live in the Source tab). Enable/disable is the
 * same `setAutoDeploy` op (which creates/removes the GitHub hook via the API for
 * self-hosted repo/domain strategy, or just flips the flag for the GitHub App).
 * The delivery-route picker (verified domain) is the `setWebhookDomain` op. This
 * is the "generic control over the GitHub hook"; Source keeps only git identity.
 */
export function ManagedGithubWebhook() {
  const { t } = useI18n();
  const g = t.projectSettings.git;
  const { showToast } = useToast();
  const { gitData, projectData, refreshGit } = useProjectSettings();
  const id = projectData.id;

  const [toggling, setToggling] = useState(false);
  const [settingDomain, setSettingDomain] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Only git-linked projects have a managed GitHub hook.
  if (gitData.isLoading || !gitData.repository?.full_name) return null;

  const strategy = gitData.webhookStrategy;
  const isCloud = projectData.deployTarget === "cloud";
  const canPickDomain = !isCloud && (gitData.verifiedDomains?.length ?? 0) > 0;

  // Plain-language strategy label — how (and whether) pushes reach this instance.
  const strategyLabel =
    strategy === "app"
      ? "Delivered via GitHub App"
      : strategy === "domain"
        ? interpolate(g.webhookCard.descDirect, { domain: String(gitData.webhookDomain ?? "") })
        : strategy === "repo"
          ? "Direct via the Openship webhook URL"
          : "Needs a public endpoint to receive pushes";
  const statusText = !gitData.autoDeployEnabled
    ? "Off"
    : strategy === "app"
      ? "On · GitHub App"
      : gitData.webhookActive
        ? strategy === "domain"
          ? "On · Direct"
          : "On · Active"
        : "On · Pending";

  const toggle = async () => {
    setToggling(true);
    try {
      const res = await projectsApi.setAutoDeploy(id, !gitData.autoDeployEnabled);
      if (res.success) await refreshGit();
      else showToast(res.error || g.toast.autoDeployFailed, "error");
    } catch (err) {
      showToast(getApiErrorMessage(err, g.toast.autoDeployFailed), "error");
    } finally {
      setToggling(false);
    }
  };

  const setDomain = async (domain: string | null) => {
    setSettingDomain(true);
    setMenuOpen(false);
    try {
      const res = await projectsApi.setWebhookDomain(id, domain);
      if (res.success) await refreshGit();
      else showToast(res.error || g.toast.webhookDomainFailed, "error");
    } catch (err) {
      showToast(getApiErrorMessage(err, g.toast.webhookDomainFailed), "error");
    } finally {
      setSettingDomain(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-foreground">
            <Github className="size-[18px]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold text-foreground">GitHub push → deploy</h2>
              <span
                className={`rounded-md border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide ${
                  gitData.autoDeployEnabled && (strategy === "app" || gitData.webhookActive)
                    ? "border-success/40 text-success"
                    : "border-border/60 text-muted-foreground"
                }`}
              >
                {statusText}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Auto-deploys {gitData.repository.full_name} on push. {strategyLabel}.
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={gitData.autoDeployEnabled}
          aria-label="Toggle auto-deploy"
          onClick={toggle}
          disabled={toggling || (strategy === "none" && !gitData.autoDeployEnabled)}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
            gitData.autoDeployEnabled ? "bg-primary" : "bg-muted"
          } ${toggling || (strategy === "none" && !gitData.autoDeployEnabled) ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
        >
          {toggling ? (
            <Loader2 className="mx-auto size-3.5 animate-spin text-background" />
          ) : (
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${
                gitData.autoDeployEnabled ? "translate-x-6 rtl:-translate-x-6" : "translate-x-1 rtl:-translate-x-1"
              }`}
            />
          )}
        </button>
      </div>

      {/* "none" strategy: no public endpoint — tell the user how to get one. */}
      {strategy === "none" && (
        <p className="mt-3 rounded-xl border border-info-border bg-info-bg px-3 py-2 text-[12px] text-muted-foreground">
          {g.webhookBanner.description}
        </p>
      )}

      {/* Delivery route picker — choose which verified domain receives pushes. */}
      {canPickDomain && (
        <div className="relative mt-4">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            {g.webhookEndpoint.title}
          </span>
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            disabled={settingDomain}
            className="mt-1 flex w-full items-center justify-between gap-2 rounded-lg border border-border/60 bg-background px-3 py-2 text-start text-[13px] transition-colors hover:border-border disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className={gitData.webhookDomain ? "text-foreground" : "text-muted-foreground"}>
              {settingDomain ? g.webhookEndpoint.updating : gitData.webhookDomain || g.webhookEndpoint.select}
            </span>
            {settingDomain ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            ) : (
              <ChevronDown className="size-3.5 text-muted-foreground" />
            )}
          </button>
          {menuOpen && (
            <div className="absolute start-0 end-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-border/60 bg-popover shadow-lg">
              {gitData.verifiedDomains!.map((d) => (
                <button
                  key={d.hostname}
                  type="button"
                  onClick={() => setDomain(d.hostname)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-start text-[13px] transition-colors hover:bg-muted/50 ${
                    gitData.webhookDomain === d.hostname ? "bg-primary/5 text-primary" : "text-foreground"
                  }`}
                >
                  <Globe className="size-3.5 shrink-0" />
                  {d.hostname}
                  {d.ssl && <span className="ms-auto text-[11px] text-success">SSL</span>}
                </button>
              ))}
              {gitData.webhookDomain && (
                <button
                  type="button"
                  onClick={() => setDomain(null)}
                  className="flex w-full items-center gap-2 border-t border-border/30 px-3 py-2 text-start text-[13px] text-muted-foreground transition-colors hover:bg-muted/50"
                >
                  {g.webhookEndpoint.clear}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
