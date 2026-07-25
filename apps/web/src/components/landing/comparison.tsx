/**
 * Comparison - clean table, Openship column visually highlighted with
 * tinted background. Each cell carries a refined status mark (win / loss
 * / neutral) so the comparison reads at a glance, without bright colors.
 */

type Status = "win" | "loss" | "neutral";
type Cell = { text: string; status: Status };
type Row = { feature: string; openship: Cell; managed: Cell; selfhost: Cell };

// Only the REAL exclusives — capabilities Openship has that managed clouds and
// other self-hosted platforms (Coolify / Dokploy / Dokku) don't. The shared
// essentials (git deploys, TLS, databases, backups, multi-server) are left out
// on purpose: claiming a win on things everyone has is the fastest way to lose
// trust. Every row here is verified against those tools.
const ROWS: Row[] = [
  {
    feature: "Adopt a running server",
    openship: { text: "Scan and take over existing containers in place", status: "win" },
    managed:  { text: "No - redeploy from source",          status: "loss" },
    selfhost: { text: "No - redeploy each app by hand",     status: "loss" },
  },
  {
    feature: "Move between servers",
    openship: { text: "Shift a running stack and its data host-to-host", status: "win" },
    managed:  { text: "Not applicable",                     status: "neutral" },
    selfhost: { text: "Redeploy, migrate volumes by hand",  status: "loss" },
  },
  {
    feature: "Take over your proxy",
    openship: { text: "Adopt Traefik / nginx / Caddy on :80/:443, rollback-safe", status: "win" },
    managed:  { text: "Not applicable",                     status: "neutral" },
    selfhost: { text: "They own the proxy from install",    status: "loss" },
  },
  {
    feature: "Edge access rules",
    openship: { text: "Rate-limit, IP + country + user-agent bans, hotlink - no reload, from a UI", status: "win" },
    managed:  { text: "Basic, plan-gated",                  status: "neutral" },
    selfhost: { text: "Hand-write Traefik / nginx; no geo", status: "neutral" },
  },
  {
    feature: "Traffic analytics & logs",
    openship: { text: "Per-route traffic, geo, live request logs - built in", status: "win" },
    managed:  { text: "Dashboards, capped by plan",         status: "neutral" },
    selfhost: { text: "Bolt on Grafana or Plausible",       status: "loss" },
  },
  {
    feature: "Desktop app",
    openship: { text: "Whole control plane on your laptop, loopback-only, nothing always-on", status: "win" },
    managed:  { text: "Cloud account, always remote",       status: "neutral" },
    selfhost: { text: "Browser-only; needs an always-on server", status: "loss" },
  },
  {
    feature: "Built-in mail server",
    openship: { text: "Postfix + Dovecot + webmail, trusted-relay sending", status: "win" },
    managed:  { text: "Not included - bring Sendgrid",      status: "loss" },
    selfhost: { text: "DIY Postfix, or not offered",        status: "loss" },
  },
  {
    feature: "Cloud + self-host, one plane",
    openship: { text: "Deploy to your servers or managed cloud, switch anytime", status: "win" },
    managed:  { text: "Their runtime only",                 status: "loss" },
    selfhost: { text: "Your boxes only",                    status: "loss" },
  },
  {
    feature: "Audit log",
    openship: { text: "Every change tracked, free",         status: "win" },
    managed:  { text: "Higher plans only",                  status: "neutral" },
    selfhost: { text: "Paid add-on or absent",              status: "loss" },
  },
];

function StatusMark({ status }: { status: Status }) {
  return (
    <span className={`cmp-mark cmp-mark--${status}`} aria-hidden="true">
      {status === "win" && (
        <svg viewBox="0 0 14 14" fill="none">
          <path d="M3 7.2 L6 10 L11 4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {status === "loss" && (
        <svg viewBox="0 0 14 14" fill="none">
          <path d="M4 4 L10 10 M10 4 L4 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
      {status === "neutral" && (
        <svg viewBox="0 0 14 14" fill="none">
          <path d="M3.5 7 L10.5 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}

export function Comparison() {
  return (
    <section className="cmp-section">
      <div className="cmp-container">
        <header className="cmp-head">
          <p className="cmp-eyebrow">Beyond the basics</p>
          <h2 className="cmp-title">
            What the others<br />can&rsquo;t do.
          </h2>
          <p className="cmp-sub">
            Git deploys, TLS, databases, backups &mdash; everyone has those. This is the short list
            of what you get with Openship that managed clouds and other self-hosted platforms don&rsquo;t.
          </p>
        </header>

        <div className="cmp">
          <div className="cmp-highlight" aria-hidden="true" />

          {/* Header */}
          <div className="cmp-row cmp-row--head">
            <div className="cmp-cell cmp-cell--feature">Feature</div>
            <div className="cmp-cell cmp-cell--win">Openship</div>
            <div className="cmp-cell">Managed (Vercel, Netlify)</div>
            <div className="cmp-cell">Self-host (Coolify, Dokploy, Dokku)</div>
          </div>

          {/* Body */}
          {ROWS.map((r) => (
            <div key={r.feature} className="cmp-row">
              <div className="cmp-cell cmp-cell--feature">{r.feature}</div>
              <div className="cmp-cell cmp-cell--win">
                <StatusMark status={r.openship.status} />
                <span>{r.openship.text}</span>
              </div>
              <div className="cmp-cell">
                <StatusMark status={r.managed.status} />
                <span>{r.managed.text}</span>
              </div>
              <div className="cmp-cell">
                <StatusMark status={r.selfhost.status} />
                <span>{r.selfhost.text}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
