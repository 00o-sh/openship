"use client";

/**
 * Live resource usage: one overall card plus a dot per container/service.
 *
 * Both come from a single SSE frame (see useProjectUsageStream), so the totals and
 * the dots always describe the same instant — and a compose project shows its whole
 * stack rather than whichever service happens to own `deployment.containerId`.
 *
 * Status colours use the theme's semantic tokens (text-success / -warning /
 * -danger / -muted-foreground), never hardcoded hues, so they stay legible in every
 * theme.
 */

import React, { useState } from "react";
import { Cpu, MemoryStick, Network, HardDrive, Info, RefreshCw } from "lucide-react";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type {
  ProjectUsage,
  ResourceUsage,
  ServiceStatus,
  ServiceUsage,
} from "@/hooks/useProjectUsageStream";
import { formatBytes, formatMb } from "./format";

/** A zeroed reading, for a focused service with no live usage to report. */
const ZERO_USAGE: ResourceUsage = {
  cpuPercent: 0,
  memoryMb: 0,
  diskMb: 0,
  networkRxBytes: 0,
  networkTxBytes: 0,
};

interface Props {
  usage: ProjectUsage | null;
  isConnected: boolean;
  error: string | null;
  onReconnect: () => void;
  /**
   * Scope the headline numbers to one service. null = All (the summed stack).
   *
   * The per-service dots stay visible either way — narrowing them to the selected
   * service would hide the very comparison they exist to make — but the selected one
   * is highlighted so the card and the dots agree about what is being shown.
   */
  focusServiceKey?: string | null;
}

/** Semantic token per live container state. Mirrors the status vocabulary the
 *  rest of the app uses for services. */
const STATUS_DOT: Record<ServiceStatus, string> = {
  running: "bg-success",
  starting: "bg-warning",
  restarting: "bg-warning",
  failed: "bg-danger",
  stopped: "bg-muted-foreground/40",
};

/**
 * How many service chips show before the rest fold behind a count.
 *
 * Eight fits two rows at most usable widths. Past that the block was growing taller than
 * the metrics it annotates, which inverts the hierarchy — the totals are the subject and
 * the per-service breakdown is the footnote.
 */
const SERVICE_CHIP_LIMIT = 8;

/**
 * Whether the usage stream is currently delivering.
 *
 * The dot only pulses meaning when it can also be absent: a static green dot beside the
 * word "Live" looks identical whether the stream is working or died four minutes ago, so
 * the disconnected state changes both the colour AND offers the retry.
 */
const LiveBadge: React.FC<{ isConnected: boolean; onReconnect: () => void }> = ({
  isConnected,
  onReconnect,
}) => {
  const { t } = useI18n();
  const m = t.projects.monitoring;
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span
        aria-hidden
        className={`size-2 rounded-full ${isConnected ? "bg-success" : "bg-muted-foreground/40"}`}
      />
      <span className="text-xs text-muted-foreground">{isConnected ? m.live : m.offline}</span>
      {!isConnected && (
        <button
          type="button"
          onClick={onReconnect}
          className="ml-1 flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <RefreshCw className="size-3" />
          {m.reconnect}
        </button>
      )}
    </div>
  );
};

const Metric: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  subtext?: string;
  /** 0–1; omitted when there's no meaningful denominator. */
  fill?: number;
}> = ({ icon, label, value, subtext, fill }) => (
  /*
   * A TILE, not a bare grid cell.
   *
   * `bg-muted/30`, deliberately not `bg-card`: this sits inside a card already, and a card
   * on a card reads as a rendering bug in every theme (no theme draws a resting card
   * border, so the two surfaces would simply merge into an odd double-padded block). The
   * muted surface is a step away from the card in both light and dark, so each metric gets
   * a visible container without inventing a second card level.
   */
  <div className="flex flex-col rounded-xl bg-muted/30 p-4">
    <div className="mb-3 flex items-center gap-2">
      <div className="text-primary">{icon}</div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
    </div>
    <p className="mb-1 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
    {fill !== undefined && (
      <span className="mb-1 block h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${Math.min(100, Math.max(1, fill * 100))}%` }}
        />
      </span>
    )}
    {subtext && <p className="text-xs font-normal text-muted-foreground/70">{subtext}</p>}
  </div>
);

/**
 * One service as a compact CHIP.
 *
 * Was a full-width row in a two-column grid: ~56px tall each, so a five-service stack
 * cost ~170px of vertical space before the map — to carry three short values. Chips wrap,
 * so the same information takes one or two lines and everything below moves up.
 *
 * Trimmed to what identifies and grades a service: status dot, name, CPU, memory. The
 * status WORD is gone — the dot already carries it, and spelling it out was most of the
 * width. It stays reachable in the `title`.
 */
const ServiceChip: React.FC<{
  service: ServiceUsage;
  statusLabel: string;
  focused: boolean;
}> = ({ service, statusLabel, focused }) => (
  <div
    title={`${service.name} — ${statusLabel}`}
    // No border. A ring around a pill that already has its own fill is a second boundary
    // for one edge, and at this size it read as noise — five outlined pills in a row drew
    // more attention than the numbers inside them. The fill alone separates them.
    className={`flex min-w-0 items-center gap-2 rounded-full py-1 pl-3 pr-2 text-xs transition-colors ${
      focused ? "bg-primary/15" : "bg-muted/60"
    }`}
  >
    <span className="max-w-[10rem] truncate font-medium text-foreground">{service.name}</span>
    {/* A stopped or unmeasurable container shows a dash, not 0% — zero CPU is a real
        reading and must not be confused with "no reading". */}
    <span className="shrink-0 tabular-nums text-muted-foreground">
      {service.usage ? `${service.usage.cpuPercent.toFixed(1)}%` : "—"}
    </span>
    <span className="shrink-0 tabular-nums text-muted-foreground/60">
      {service.usage ? formatMb(service.usage.memoryMb) : "—"}
    </span>
    {/* Trailing, not leading. Both edges then carry a small round element, which is what
        makes a row of pills of differing widths look deliberate rather than ragged. */}
    <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[service.status]}`} />
  </div>
);

export const ResourceCards: React.FC<Props> = ({
  usage,
  isConnected,
  error,
  onReconnect,
  focusServiceKey = null,
}) => {
  const { t } = useI18n();
  const m = t.projects.monitoring;
  const statusLabels: Partial<Record<ServiceStatus, string>> =
    t.projectDetail.services.detail.status;
  const [showAllServices, setShowAllServices] = useState(false);

  // `supported: false` is a real answer, not an error: BareRuntime's old stub
  // returned zeros and the dashboard drew them as data, so an unmeasurable
  // deployment looked exactly like an idle one.
  if (usage && !usage.supported) {
    return (
      <>
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">{m.unsupportedTitle}</p>
            {usage.reason && (
              <p className="mt-0.5 text-xs text-muted-foreground">{usage.reason}</p>
            )}
          </div>
        </div>
      </>
    );
  }

  if (!usage) {
    return (
      <>
        <div className="mb-4 flex items-center justify-between">
          {error && (
            <button
              type="button"
              onClick={onReconnect}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <RefreshCw className="size-3" />
              {m.reconnect}
            </button>
          )}
        </div>
        {error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="space-y-2">
                <div className="h-3 w-16 rounded bg-muted" />
                <div className="h-7 w-20 rounded bg-muted" />
                <div className="h-1.5 w-full rounded bg-muted" />
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  // Scoped to one service when asked, else the whole stack. A selected service whose
  // container isn't running has no usage — fall back to zeros rather than silently
  // showing the stack total under that service's name, which would be a lie.
  const focused =
    focusServiceKey != null
      ? usage.services.find((s) => s.serviceId === focusServiceKey)
      : undefined;
  const o: ResourceUsage = focused ? (focused.usage ?? { ...ZERO_USAGE }) : usage.overall;
  const shownServices = showAllServices
    ? usage.services
    : usage.services.slice(0, SERVICE_CHIP_LIMIT);
  const hiddenCount = usage.services.length - shownServices.length;
  // A single-app deploy's one "service" IS the app, so chips would just repeat the totals
  // above them.
  const hasServiceChips = usage.services.length > 1;
  const cores = usage.capacity.cpuCores;
  const memTotal = usage.capacity.memoryMb;

  return (
    <>
      <div className="space-y-4">
        {/* No header row here any more. It carried nothing but the liveness pill — the title
            belongs to the parent card — so it spent a whole row of height on one dot. The
            pill now sits on the services row, which had empty space to the right of it. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric
            icon={<Cpu className="size-4" />}
            label={m.cpu}
            value={`${o.cpuPercent.toFixed(1)}%`}
            // Percent is per-core, so a 4-core box tops out at 400% — divide by the
            // core count to make the bar mean "share of this host".
            fill={cores ? o.cpuPercent / (cores * 100) : undefined}
            subtext={cores ? interpolate(m.ofCores, { cores: String(cores) }) : undefined}
          />
          <Metric
            icon={<MemoryStick className="size-4" />}
            label={m.memory}
            value={formatMb(o.memoryMb)}
            fill={memTotal ? o.memoryMb / memTotal : undefined}
            subtext={memTotal ? interpolate(m.ofMemory, { total: formatMb(memTotal) }) : undefined}
          />
          <Metric
            icon={<Network className="size-4" />}
            label={m.network}
            value={formatBytes(o.networkRxBytes + o.networkTxBytes)}
            subtext={`↓ ${formatBytes(o.networkRxBytes)} · ↑ ${formatBytes(o.networkTxBytes)}`}
          />
          <Metric
            icon={<HardDrive className="size-4" />}
            label={m.diskIo}
            value={formatMb(o.diskMb)}
            // Labelled I/O, not "disk", on purpose: the runtimes report CUMULATIVE
            // block I/O here, not space used. Calling it disk usage would be wrong.
            subtext={m.diskIo}
          />
        </div>

      {/* Only for multi-service projects: a single-app deploy's one "service" is
          the app itself, and repeating the numbers just read as duplication. A section of
          the parent card rather than a card of its own — the chips belong WITH the totals
          they break down. */}
      {/* This row exists whether or not there are services, because it also carries the
          liveness badge — and a single-container app needs that just as much. Only the
          label and the chips are conditional, so there is one layout rather than two. */}
      <div>
        <div className="mb-2 flex items-center gap-3">
          {hasServiceChips && (
            <h3 className="text-xs font-medium text-muted-foreground">{m.servicesTitle}</h3>
          )}
          <span className="min-w-0 flex-1" />
          {/* Liveness rides THIS row rather than one of its own. It describes the whole
              stream, so it belongs beside the list of what is being streamed, and the row
              had empty space across the middle anyway. */}
          <LiveBadge isConnected={isConnected} onReconnect={onReconnect} />
        </div>
        {hasServiceChips && (
          <div className="flex flex-wrap gap-1.5">
            {shownServices.map((s) => (
              <ServiceChip
                key={s.serviceId ?? s.name}
                service={s}
                focused={focusServiceKey != null && s.serviceId === focusServiceKey}
                // The service-detail labels, not a second vocabulary: these chips
                // report the SAME live container states resolveLiveServiceState
                // produces, so they must read identically to the Services tab.
                statusLabel={statusLabels[s.status] ?? s.status}
              />
            ))}
            {/* Bounded, with the remainder COUNTED rather than dropped.
                Chips wrap, so 15 services silently became four rows — the block quietly
                grew past the metrics it annotates. A cap plus a count keeps the height
                predictable and never lets a truncated list look complete. Deliberately not
                a horizontal scroller: a strip that runs off the edge hides the fact that
                there is more at all, whereas "+7" states it. */}
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setShowAllServices(true)}
                className="rounded-full bg-muted/60 px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {interpolate(m.servicesMore, { count: String(hiddenCount) })}
              </button>
            )}
            {showAllServices && usage.services.length > SERVICE_CHIP_LIMIT && (
              <button
                type="button"
                onClick={() => setShowAllServices(false)}
                className="rounded-full bg-muted/60 px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {m.servicesLess}
              </button>
            )}
          </div>
        )}
      </div>
      </div>
    </>
  );
};
