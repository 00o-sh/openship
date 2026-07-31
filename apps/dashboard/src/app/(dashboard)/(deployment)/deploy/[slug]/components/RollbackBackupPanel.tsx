"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Archive, ExternalLink } from "lucide-react";
import { MAX_ROLLBACK_WINDOW } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { projectsApi, backupsApi, getApiErrorMessage } from "@/lib/api";
import type { RollbackCapacityUI } from "@/lib/api/projects";
import type { BackupPolicy } from "@/lib/api/backups";
import { RollbackRetentionCards } from "@/components/rollback/RollbackRetentionCards";
import { PolicyEditor } from "@/components/backup/PolicyEditor";

/**
 * Rollback & backups, inside the deploy wizard's target panel.
 *
 * The target step is where an operator decides WHERE this project runs, so it's
 * also where "how much of its history stays restorable on that machine" belongs.
 * The retention controls are the SAME component the project's Git settings
 * render — not a second copy — and backups are shown read-only with a button
 * that opens the existing PolicyEditor modal, so backup configuration keeps
 * living in exactly one place.
 *
 * Before a project row exists (a first deploy), everything renders read-only:
 * there's nothing to PATCH yet, and the numbers shown are what will apply.
 */
export function RollbackBackupPanel({
  projectId,
  enabled,
}: {
  /** Null until the project exists (first deploy through the wizard). */
  projectId?: string | null;
  /** The Advanced disclosure is open — don't fetch while collapsed. */
  enabled: boolean;
}) {
  const { t } = useI18n();
  const ts = t.deploy.targetStep;
  const { showToast } = useToast();

  const [capacity, setCapacity] = useState<RollbackCapacityUI | null>(null);
  const [policies, setPolicies] = useState<BackupPolicy[] | null>(null);
  const [togglingStrategy, setTogglingStrategy] = useState(false);
  const [savingWindow, setSavingWindow] = useState(false);
  const [editingBackup, setEditingBackup] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    const [cap, pol] = await Promise.all([
      projectsApi.getRollbackCapacity(projectId).then((r) => r.data).catch(() => null),
      backupsApi.listPolicies(projectId).then((r) => r.data ?? []).catch(() => []),
    ]);
    setCapacity(cap ?? null);
    setPolicies(pol);
  }, [projectId]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  const strategy: "git" | "snapshot" = capacity?.strategy === "snapshot" ? "snapshot" : "git";

  const toggleStrategy = async () => {
    if (!projectId) return;
    setTogglingStrategy(true);
    try {
      await projectsApi.update(projectId, {
        defaultRollbackStrategy: strategy === "git" ? "snapshot" : "git",
      });
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, t.projectSettings.git.toast.rollbackStrategyFailed), "error");
    } finally {
      setTogglingStrategy(false);
    }
  };

  const changeWindow = async (next: number) => {
    if (!projectId) return;
    const clamped = Math.max(0, Math.min(capacity?.maxWindow ?? MAX_ROLLBACK_WINDOW, next));
    if (clamped === (capacity?.window ?? 5)) return;
    setSavingWindow(true);
    try {
      await projectsApi.update(projectId, { rollbackWindow: clamped });
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, t.projectSettings.git.toast.rollbackHistoryFailed), "error");
    } finally {
      setSavingWindow(false);
    }
  };

  const preDeployOn = (policies ?? []).some((p) => p.enabled && p.triggerOnPreDeploy);
  const backupSummary =
    policies === null || policies.length === 0
      ? ts.backupSummaryNone
      : interpolate(ts.backupSummaryConfigured, {
          count: String(policies.length),
          preDeploy: preDeployOn ? ts.on : ts.off,
        });

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{ts.rollbackTitle}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{ts.rollbackHint}</p>
      </div>

      <RollbackRetentionCards
        strategy={strategy}
        capacity={capacity}
        onToggleStrategy={projectId ? toggleStrategy : undefined}
        onChangeWindow={projectId ? changeWindow : undefined}
        togglingStrategy={togglingStrategy}
        savingWindow={savingWindow}
        readOnly={!projectId}
      />

      {projectId ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Archive className="size-4" />
            </div>
            <p className="truncate text-[12px] text-muted-foreground">{backupSummary}</p>
          </div>
          <button
            type="button"
            onClick={() => setEditingBackup(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
          >
            {ts.backupManage}
            <ExternalLink className="size-3.5" />
          </button>
        </div>
      ) : (
        <p className="text-[12px] text-muted-foreground">{ts.rollbackFirstDeploy}</p>
      )}

      {editingBackup && projectId ? (
        <PolicyEditor
          projectId={projectId}
          existing={(policies ?? []).find((p) => p.serviceId === null) ?? null}
          onClose={() => setEditingBackup(false)}
          onSaved={() => {
            setEditingBackup(false);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

export default RollbackBackupPanel;
