"use client";

/**
 * Inbound rules tab — "mail arrives at this address → tell me in this channel".
 *
 * Two behaviours of the machinery underneath are surfaced here on purpose, because both
 * would otherwise be silent:
 *
 *   - the channel picker lists only `enabled && verified` channels, and excludes `in_app`.
 *     The dispatcher drops anything unverified, and the in_app worker is a deliberate no-op
 *     with no dashboard surface reading the deliveries feed — so either would let an
 *     operator save a rule that can never deliver anything they can see.
 *   - a mailbox rule carries a caveat rather than hiding one. Postfix runs with
 *     `enable_original_recipient = no`, so a captured copy has no `X-Original-To` and can
 *     only be attributed via To/Cc: mail that arrived by Bcc or through an alias is
 *     invisible to a mailbox rule. Domain scope has no such gap.
 *
 * Same layout and primitives as the Mailboxes/Aliases tabs (DataTable + StatusPill +
 * FormModalContent), so this reads as one panel rather than a bolt-on.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Inbox, Pencil, Plus, Trash2, FlaskConical } from "lucide-react";
import {
  getApiErrorMessage,
  mailAdminApi,
  notificationsApi,
  type InboundRule,
  type InboundScope,
  type NotificationChannel,
} from "@/lib/api";
import { useModal } from "@/context/ModalContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { DataTable, RowIconButton, type DataTableColumn } from "./_shared/data-table";
import { StatusPill } from "./_shared/status-pill";
import { Field, FormModalContent, inputClassName } from "./_shared/form-modal-content";
import { useMailRailOwnsTabs } from "../../_lib/mail-section";

interface InboundTabProps {
  serverId: string;
  primaryDomain: string;
}

const SCOPES: InboundScope[] = ["mailbox", "domain", "all"];

export function InboundTab({ serverId, primaryDomain }: InboundTabProps) {
  const { showModal, hideModal } = useModal();
  const { t } = useI18n();
  const a = t.emailsAdmin.inbound;
  // Heading lives in the page header in mail view — see ../../_lib/mail-section.
  const hoisted = useMailRailOwnsTabs(serverId);

  const [rules, setRules] = useState<InboundRule[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, c] = await Promise.all([
        mailAdminApi.inbound.list(serverId),
        notificationsApi
          .listChannels()
          .then((x) => x.channels)
          .catch(() => [] as NotificationChannel[]),
      ]);
      setRules(r.rules);
      setChannels(c);
    } catch (err) {
      setError(getApiErrorMessage(err, a.loadFailed));
    } finally {
      setLoading(false);
    }
  }, [serverId, a.loadFailed]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Only channels the dispatcher will actually ship to — see the module header. */
  const usable = useMemo(
    () => channels.filter((c) => c.enabled && c.verified && c.kind !== "in_app"),
    [channels],
  );

  const openEditor = (rule?: InboundRule) => {
    const id = showModal({
      maxWidth: "600px",
      showCloseButton: false,
      customContent: (
        <RuleForm
          serverId={serverId}
          rule={rule}
          channels={usable}
          primaryDomain={primaryDomain}
          onCancel={() => hideModal(id)}
          onSaved={() => {
            hideModal(id);
            void reload();
          }}
        />
      ),
    });
  };

  const openDelete = (rule: InboundRule) => {
    const id = showModal({
      maxWidth: "520px",
      showCloseButton: false,
      customContent: (
        <FormModalContent
          title={a.deleteTitle}
          description={interpolate(a.confirmDelete, { name: rule.name })}
          submitLabel={a.deleteConfirm}
          submittingLabel={a.deleting}
          submitVariant="danger"
          onCancel={() => hideModal(id)}
          onSubmit={async () => {
            await mailAdminApi.inbound.remove(serverId, rule.id);
            hideModal(id);
            void reload();
          }}
        >
          <p className="text-sm text-muted-foreground">{a.deleteHint}</p>
        </FormModalContent>
      ),
    });
  };

  const runTest = async () => {
    setTesting(true);
    setError(null);
    setNotice(null);
    try {
      const r = await mailAdminApi.inbound.test(serverId);
      setNotice(
        interpolate(a.testResult, {
          read: String(r.read),
          matched: String(r.matched),
          dropped: String(r.dropped),
        }),
      );
    } catch (err) {
      setError(getApiErrorMessage(err, a.testFailed));
    } finally {
      setTesting(false);
    }
  };

  const columns: DataTableColumn<InboundRule>[] = [
    {
      key: "name",
      header: a.colRule,
      width: "minmax(220px, 1.4fr)",
      cell: (r) => (
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
            <Inbox className="size-4 text-muted-foreground" strokeWidth={2} />
          </div>
          <p className="text-sm font-medium text-foreground truncate">{r.name}</p>
        </div>
      ),
    },
    {
      key: "watch",
      header: a.colWatch,
      width: "minmax(200px, 1.2fr)",
      cell: (r) =>
        r.scope === "all" ? (
          <span className="text-sm text-foreground">{a.scopeAllSummary}</span>
        ) : (
          <span className="text-sm text-foreground font-mono truncate">{r.target ?? "—"}</span>
        ),
    },
    {
      key: "channels",
      header: a.colChannels,
      width: "140px",
      hideBelow: "md",
      cell: (r) => (
        <span className="text-sm text-muted-foreground">
          {interpolate(a.channelCount, { count: String(r.channelIds.length) })}
        </span>
      ),
    },
    {
      key: "status",
      header: a.colStatus,
      width: "150px",
      cell: (r) =>
        r.pausedReason ? (
          <StatusPill tone="warning" dot>
            {a.paused}
          </StatusPill>
        ) : r.enabled ? (
          <StatusPill tone="success" dot>
            {a.active}
          </StatusPill>
        ) : (
          <StatusPill tone="neutral" dot>
            {a.disabled}
          </StatusPill>
        ),
    },
  ];

  return (
    <div className="space-y-5">
      <div
        className={`flex items-center gap-3 flex-wrap ${hoisted ? "justify-end" : "justify-between"}`}
      >
        {!hoisted && (
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-foreground">{a.heading}</h2>
            <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">{a.description}</p>
          </div>
        )}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => void runTest()}
            disabled={testing || rules.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2.5 border border-border text-foreground text-sm font-medium rounded-xl hover:bg-muted/50 transition-colors disabled:opacity-50"
          >
            <FlaskConical className="size-4" />
            {testing ? a.testing : a.test}
          </button>
          <button
            onClick={() => openEditor()}
            disabled={usable.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 disabled:opacity-50 disabled:hover:shadow-none"
          >
            <Plus className="size-4" />
            {a.newRule}
          </button>
        </div>
      </div>

      {usable.length === 0 && !loading && (
        <p className="text-sm text-warning bg-warning/10 rounded-xl px-4 py-3">{a.noChannels}</p>
      )}
      {error && <p className="text-sm text-danger bg-danger/10 rounded-xl px-4 py-3">{error}</p>}
      {notice && <p className="text-sm text-muted-foreground bg-muted/40 rounded-xl px-4 py-3">{notice}</p>}

      <DataTable
        columns={columns}
        rows={rules}
        rowKey={(r) => r.id}
        loading={loading}
        empty={{ icon: Inbox, title: a.emptyTitle, description: a.emptyBody }}
        rowActions={(r) => (
          <>
            <RowIconButton icon={Pencil} label={a.edit} onClick={() => openEditor(r)} />
            <RowIconButton
              icon={Trash2}
              label={a.deleteConfirm}
              variant="danger"
              onClick={() => openDelete(r)}
            />
          </>
        )}
      />
    </div>
  );
}

function RuleForm({
  serverId,
  rule,
  channels,
  primaryDomain,
  onCancel,
  onSaved,
}: {
  serverId: string;
  rule?: InboundRule;
  channels: NotificationChannel[];
  primaryDomain: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const a = t.emailsAdmin.inbound;

  const [name, setName] = useState(rule?.name ?? "");
  const [scope, setScope] = useState<InboundScope>(rule?.scope ?? "mailbox");
  const [target, setTarget] = useState(rule?.target ?? "");
  const [fromPattern, setFromPattern] = useState(rule?.fromPattern ?? "");
  const [subjectPattern, setSubjectPattern] = useState(rule?.subjectPattern ?? "");
  const [selected, setSelected] = useState<string[]>(rule?.channelIds ?? []);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);

  const needsTarget = scope !== "all";
  const invalid =
    name.trim().length === 0 || selected.length === 0 || (needsTarget && target.trim().length === 0);

  const scopeLabel = (s: InboundScope) =>
    s === "mailbox" ? a.scopeMailbox : s === "domain" ? a.scopeDomain : a.scopeAll;

  return (
    <FormModalContent
      title={rule ? a.editTitle : a.newTitle}
      submitLabel={a.save}
      submittingLabel={a.saving}
      onCancel={onCancel}
      disabled={invalid}
      onSubmit={async () => {
        const payload = {
          name: name.trim(),
          scope,
          target: needsTarget ? target.trim() : null,
          fromPattern: fromPattern.trim() || null,
          subjectPattern: subjectPattern.trim() || null,
          channelIds: selected,
          enabled,
        };
        // FormModalContent surfaces a thrown error, and getApiErrorMessage is what
        // unwraps the server's real message — an ApiError's own `.message` is the
        // useless "API 409: Conflict", which is exactly the foreign-BCC refusal the
        // operator has to read to know what to do.
        try {
          if (rule) await mailAdminApi.inbound.update(serverId, rule.id, payload);
          else await mailAdminApi.inbound.create(serverId, payload);
        } catch (err) {
          throw new Error(getApiErrorMessage(err, a.saveFailed));
        }
        onSaved();
      }}
    >
      <Field label={a.fieldName}>
        <input
          className={inputClassName}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={a.namePlaceholder}
        />
      </Field>

      <Field label={a.fieldScope}>
        <select
          className={inputClassName}
          value={scope}
          onChange={(e) => setScope(e.target.value as InboundScope)}
        >
          {SCOPES.map((s) => (
            <option key={s} value={s}>
              {scopeLabel(s)}
            </option>
          ))}
        </select>
      </Field>

      {needsTarget && (
        <Field
          label={scope === "mailbox" ? a.fieldAddress : a.fieldDomain}
          hint={scope === "mailbox" ? a.mailboxCaveat : undefined}
        >
          <input
            className={inputClassName}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={scope === "mailbox" ? `support@${primaryDomain}` : primaryDomain}
          />
        </Field>
      )}

      <Field label={a.fieldFrom}>
        <input
          className={inputClassName}
          value={fromPattern}
          onChange={(e) => setFromPattern(e.target.value)}
          placeholder={a.patternPlaceholder}
        />
      </Field>

      <Field label={a.fieldSubject} hint={a.patternHint}>
        <input
          className={inputClassName}
          value={subjectPattern}
          onChange={(e) => setSubjectPattern(e.target.value)}
          placeholder={a.patternPlaceholder}
        />
      </Field>

      <Field label={a.fieldChannels}>
        <div className="space-y-2">
          {channels.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={selected.includes(c.id)}
                onChange={(e) =>
                  setSelected((prev) =>
                    e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id),
                  )
                }
              />
              <span className="truncate">
                {c.label} <span className="text-muted-foreground">({c.kind})</span>
              </span>
            </label>
          ))}
        </div>
      </Field>

      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>{a.fieldEnabled}</span>
      </label>
    </FormModalContent>
  );
}
