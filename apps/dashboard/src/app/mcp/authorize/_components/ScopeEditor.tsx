"use client";

/**
 * Left column: the editor. Always visible for a scoped template — the brief was
 * "left column = the resource list he can edit", so it is not hidden behind a
 * disclosure.
 *
 * Two halves, because the grant model has two shapes:
 *   1. CAPABILITIES — {project,"*",["create"]}. Not a resource you tick; the
 *      generic picker only speaks read/write/admin and a project wildcard with
 *      anything else is a 400 at mint. So it gets its own switch, and is kept out
 *      of the picker's `value` entirely (a {project,"*"} grant reaching the picker
 *      would trip its wildcardActive branch and disable every project row).
 *   2. RESOURCES — the shared ResourcePicker, with the project wildcard row
 *      suppressed for the same reason.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, PlusCircle } from "lucide-react";
import { ResourcePicker } from "@/components/permissions/ResourcePicker";
import { Switch } from "@/components/ui/Switch";
import {
  ACCESS_LEVELS,
  ADVANCED_TYPES,
  LEVEL_PERMISSIONS,
  hasCreateCapability,
  levelOf,
  pickerGrants,
  type AccessLevel,
  type AccessSelection,
} from "@/components/permissions/mcp-access-templates";
import type { LevelsConfig } from "@/components/permissions/ResourcePicker";
import type { PickerGrant, ResourceType } from "@/lib/api";
import { useI18n } from "@/components/i18n-provider";

export function ScopeEditor({
  selection,
  availableTypes,
  orgKey,
  disabled,
  onPickerChange,
  onCreateChange,
}: {
  selection: AccessSelection;
  availableTypes: ResourceType[];
  /** Remounts the picker on an org switch so no catalog row outlives its org. */
  orgKey: string;
  disabled?: boolean;
  onPickerChange: (grants: PickerGrant[]) => void;
  onCreateChange: (on: boolean) => void;
}) {
  const { t } = useI18n();
  const m = t.misc.mcpAuthorize;
  const [showAdvanced, setShowAdvanced] = useState(false);

  // read/write/admin shown as the three named levels. This is the ONLY place a
  // level is set — the summary rail states it, it doesn't edit it.
  const levelLabel: Record<AccessLevel, string> = {
    view: m.levelView,
    manage: m.levelManage,
    full: m.levelFull,
  };
  const levels: LevelsConfig = {
    options: ACCESS_LEVELS.map((id) => ({ id, label: levelLabel[id] })),
    resolve: (permissions) => levelOf(permissions),
    toPermissions: (id) => [...LEVEL_PERMISSIONS[id as AccessLevel]],
  };

  const primary = availableTypes.filter((tp) => !ADVANCED_TYPES.has(tp));
  const advanced = availableTypes.filter((tp) => ADVANCED_TYPES.has(tp));
  const types = showAdvanced ? [...primary, ...advanced] : primary;

  return (
    <div className="rounded-2xl bg-card p-5">
      <div className="mb-4">
        <h2 className="text-[14px] font-medium text-foreground">{m.editorHeading}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{m.editorNote}</p>
      </div>

      {/* ── Capabilities ── */}
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {m.capabilitiesHeading}
      </p>
      <div className="mb-5 flex items-start gap-3 rounded-xl border border-border/50 p-3.5">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/40 text-muted-foreground">
          <PlusCircle className="size-4" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{m.createProjectsTitle}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{m.createProjectsDesc}</p>
        </div>
        <div className="mt-0.5 shrink-0">
          <Switch
            checked={hasCreateCapability(selection.grants)}
            onChange={onCreateChange}
            disabled={disabled}
            ariaLabel={m.createProjectsTitle}
          />
        </div>
      </div>

      {/* ── Resources ── */}
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {m.resourcesHeading}
      </p>
      <ResourcePicker
        // Keyed on the org only. Toggling Advanced just widens `availableTypes`;
        // the picker keeps its own tab valid, so remounting there would throw
        // away the user's tab + search for nothing.
        key={orgKey}
        value={pickerGrants(selection.grants)}
        onChange={onPickerChange}
        availableTypes={types}
        // Read+write is the level that actually lets a client deploy the thing it
        // was granted; read-only is one click away in the summary.
        defaultPermissions={["read", "write"]}
        // "All projects" would emit {project,"*",[read,write]} → 400
        // INVALID_GRANT_SCOPE. The create capability above is the only legitimate
        // project wildcard.
        suppressWildcardTypes={["project"]}
        levels={levels}
        disabled={disabled}
      />

      {advanced.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            {showAdvanced ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5 rtl:rotate-180" />
            )}
            {showAdvanced ? m.advancedHide : m.advancedShow}
          </button>
          {showAdvanced && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{m.advancedNote}</p>
          )}
        </div>
      )}
    </div>
  );
}
