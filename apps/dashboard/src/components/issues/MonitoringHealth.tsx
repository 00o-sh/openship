"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bell, CheckCircle2, CircleHelp, HeartPulse, ServerOff } from "lucide-react";
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { issuesApi, type WorkloadHealthRow } from "@/lib/api";
import { timeAgo } from "@/lib/time";
import { useI18n } from "@/components/i18n-provider";
import { CHART_TOOLTIP_STYLE } from "@/lib/chart-theme";

const tone = {
  healthy: { Icon: CheckCircle2, className: "text-success bg-success-bg", label: "Healthy" },
  unhealthy: { Icon: AlertTriangle, className: "text-warning bg-warning-bg", label: "Unhealthy" },
  crash_loop: { Icon: AlertTriangle, className: "text-danger bg-danger-bg", label: "Crash loop" },
  down: { Icon: ServerOff, className: "text-danger bg-danger-bg", label: "Down" },
  unknown: { Icon: CircleHelp, className: "text-muted-foreground bg-muted", label: "Unknown" },
} as const;

/** Fleet health reads a cached snapshot produced by the server-grouped watcher.
 * Polling this view is therefore O(rows returned), never O(Docker connections). */
export function MonitoringHealth() {
  const { t } = useI18n();
  const [rows, setRows] = useState<WorkloadHealthRow[]>([]);
  const [watching, setWatching] = useState(true);
  const [watcher, setWatcher] = useState<{ key: string; schedule: string | null; eventsEnabled: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "problems">("all");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await issuesApi.health();
      setRows(result.data ?? []);
      setWatching(result.watching);
      setWatcher(result.watcher);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === "problems" && row.state === "healthy") return false;
      return !q || `${row.projectName} ${row.serviceName} ${row.serverName}`.toLowerCase().includes(q);
    });
  }, [rows, filter, query]);
  const problems = rows.filter((row) => row.state !== "healthy").length;
  const metrics = useMemo(() => {
    const counts = { healthy: 0, unhealthy: 0, crash_loop: 0, down: 0, unknown: 0 };
    for (const row of rows) counts[row.state]++;
    const score = rows.length ? Math.round((counts.healthy / rows.length) * 100) : 0;
    const servers = new Map<string, typeof counts>();
    for (const row of rows) {
      const current = servers.get(row.serverName) ?? { healthy: 0, unhealthy: 0, crash_loop: 0, down: 0, unknown: 0 };
      current[row.state]++;
      servers.set(row.serverName, current);
    }
    return {
      counts,
      score,
      serverRows: [...servers].map(([name, values]) => ({ name, ...values })),
    };
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-border/50 bg-card p-5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><HeartPulse className="size-[18px]" /></div>
          <div><h2 className="text-[15px] font-semibold">Container health</h2><p className="text-xs text-muted-foreground">{rows.length} services watched · {problems} need attention</p></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/jobs/services%3Ahealth-watch" className="inline-flex items-center justify-center rounded-xl border border-border/60 px-3 py-2 text-[13px] font-medium hover:bg-muted/50">Manage watcher</Link>
          <Link href="/settings?tab=notifications" className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border/60 px-3 py-2 text-[13px] font-medium hover:bg-muted/50"><Bell className="size-4" /> Configure alerts</Link>
        </div>
      </div>

      {watcher && (
        <div className="grid gap-3 sm:grid-cols-3">
          <StatusFact label="Trigger source" value={watcher.eventsEnabled ? "Docker events + reconciliation" : "Reconciliation only"} />
          <StatusFact label="Reconciliation schedule" value={watcher.schedule ?? "Not registered"} />
          <StatusFact label="Watch scope" value="Deployed services unless opted out" />
        </div>
      )}

      {!watching && <div className="rounded-xl border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning">Health watching is disabled. Enable the services:health-watch job to track outages.</div>}

      {!loading && rows.length > 0 && (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.35fr)]">
            <div className="rounded-2xl border border-border/50 bg-card p-5">
              <div className="mb-2">
                <h3 className="text-[14px] font-semibold text-foreground">Fleet health</h3>
                <p className="text-xs text-muted-foreground">Current state of every watched service</p>
              </div>
              <div className="grid grid-cols-[180px_1fr] items-center gap-3">
                <div className="relative h-[180px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={statusSlices(metrics.counts)} dataKey="value" nameKey="label" innerRadius="67%" outerRadius="88%" paddingAngle={2} stroke="var(--color-card)" strokeWidth={3} isAnimationActive={false}>
                        {statusSlices(metrics.counts).map((slice) => <Cell key={slice.key} fill={slice.color} />)}
                      </Pie>
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(value: unknown, name: unknown) => [Number(value), String(name)]} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className={`text-3xl font-semibold tabular-nums ${metrics.score === 100 ? "text-success" : metrics.score >= 90 ? "text-warning" : "text-danger"}`}>{metrics.score}%</span><span className="text-[11px] text-muted-foreground">healthy</span></div>
                </div>
                <div className="space-y-2.5">{statusSlices(metrics.counts).map((slice) => <div key={slice.key} className="flex items-center gap-2 text-xs"><span className="size-2 rounded-full" style={{ backgroundColor: slice.color }} /><span className="flex-1 text-muted-foreground">{slice.label}</span><span className="font-medium tabular-nums text-foreground">{slice.value}</span></div>)}</div>
              </div>
            </div>

            <div className="rounded-2xl border border-border/50 bg-card p-5">
              <div className="mb-3 flex items-end justify-between gap-3"><div><h3 className="text-[14px] font-semibold text-foreground">Health by server</h3><p className="text-xs text-muted-foreground">Distribution of service states on each host</p></div><span className="text-xs tabular-nums text-muted-foreground">{metrics.serverRows.length} servers</span></div>
              <div style={{ height: Math.max(190, metrics.serverRows.length * 42) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={metrics.serverRows} layout="vertical" margin={{ top: 4, right: 8, bottom: 4, left: 8 }} barCategoryGap="28%">
                    <XAxis type="number" hide allowDecimals={false} />
                    <YAxis type="category" dataKey="name" width={105} tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: "var(--color-muted)" }} />
                    <Bar dataKey="healthy" name="Healthy" stackId="health" fill="var(--color-success-solid)" radius={[4, 0, 0, 4]} isAnimationActive={false} />
                    <Bar dataKey="unhealthy" name="Unhealthy" stackId="health" fill="var(--color-warning-solid)" isAnimationActive={false} />
                    <Bar dataKey="crash_loop" name="Crash loop" stackId="health" fill="var(--color-danger-solid)" isAnimationActive={false} />
                    <Bar dataKey="down" name="Down" stackId="health" fill="var(--color-danger)" isAnimationActive={false} />
                    <Bar dataKey="unknown" name="Unknown" stackId="health" fill="var(--color-muted-foreground)" radius={[0, 4, 4, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {statusSlices(metrics.counts).map((slice) => <button key={slice.key} type="button" onClick={() => setFilter(slice.key === "healthy" ? "all" : "problems")} className="rounded-xl border border-border/50 bg-card px-4 py-3 text-start transition-colors hover:bg-muted/30"><div className="mb-2 size-2 rounded-full" style={{ backgroundColor: slice.color }} /><p className="text-2xl font-semibold tabular-nums text-foreground">{slice.value}</p><p className="text-xs text-muted-foreground">{slice.label}</p></button>)}
          </div>
        </>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search services, projects or servers" className="h-10 flex-1 rounded-xl border border-border/50 bg-card px-4 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
        <div className="inline-flex rounded-xl bg-muted/35 p-1">
          {(["all", "problems"] as const).map((value) => <button key={value} onClick={() => setFilter(value)} className={`h-8 rounded-lg px-3 text-xs font-medium ${filter === value ? "border border-border/60 bg-card" : "text-muted-foreground"}`}>{value === "all" ? "All services" : "Issues only"}</button>)}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
        {loading ? <p className="p-8 text-center text-sm text-muted-foreground">Loading health snapshot…</p> : visible.length === 0 ? <p className="p-8 text-center text-sm text-muted-foreground">{rows.length === 0 ? "Waiting for the first health-watch sweep." : "No services match this filter."}</p> : (
          <ul className="divide-y divide-border/50">{visible.map((row) => {
            const status = tone[row.state]; const Icon = status.Icon;
            return <li key={`${row.projectId}:${row.serviceKey}`} className="flex items-center gap-3 px-4 py-3">
              <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${status.className}`}><Icon className="size-4" /></span>
              <div className="min-w-0 flex-1"><Link href={`/projects/${row.projectId}/health`} className="text-sm font-medium hover:underline">{row.serviceName}</Link><p className="truncate text-xs text-muted-foreground">{row.projectName} · {row.serverName}</p></div>
              <div className="text-end"><p className={`text-xs font-medium ${status.className.split(" ")[0]}`}>{status.label}</p><p className="text-[11px] text-muted-foreground">{timeAgo(row.observedAt, t)}</p></div>
            </li>;
          })}</ul>
        )}
      </div>
    </div>
  );
}

function StatusFact({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-border/50 bg-card px-4 py-3"><p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 text-sm font-medium text-foreground">{value}</p></div>;
}

function statusSlices(counts: Record<WorkloadHealthRow["state"], number>) {
  return [
    { key: "healthy" as const, label: "Healthy", value: counts.healthy, color: "var(--color-success-solid)" },
    { key: "unhealthy" as const, label: "Unhealthy", value: counts.unhealthy, color: "var(--color-warning-solid)" },
    { key: "crash_loop" as const, label: "Crash loop", value: counts.crash_loop, color: "var(--color-danger-solid)" },
    { key: "down" as const, label: "Down", value: counts.down, color: "var(--color-danger)" },
    { key: "unknown" as const, label: "Unknown", value: counts.unknown, color: "var(--color-muted-foreground)" },
  ];
}
