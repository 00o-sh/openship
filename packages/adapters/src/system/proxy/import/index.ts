/**
 * Proxy config import — read an existing reverse proxy's configuration and
 * normalize its sites so a migrate/takeover can re-register them as Openship
 * routes. All parsing is read-only and best-effort (warnings, never throws).
 */

import type { CommandExecutor } from "../../../types";
import type { ProxyKind, ProxyScanResult } from "../../types";
import { scanNginx, scanOpenshipEdge } from "./nginx";
import { scanCaddy } from "./caddy";
import { scanApache } from "./apache";
import { scanTraefik } from "./traefik";

/**
 * Config markers that prove a proxy is INSTALLED on this host, checked in
 * priority order.
 *
 * OpenResty ON THE HOST is included, and that is the point: our edge is a
 * CONTAINER now, so a host OpenResty is a proxy to migrate FROM like any other —
 * including one an older Openship installed itself. This list used to exclude
 * `/usr/local/openresty/...` as "ours", which was true only while the bare edge WAS
 * us; the container edge's own config lives inside the image, and its host-side
 * state is the `/var/lib/openship/edge` bind mount, so a file at these paths means
 * a host install, never the container.
 *
 * Checked last so a box running both (host OpenResty + a distro nginx) reports the
 * more likely intentional one first.
 */
const INSTALLED_MARKERS: Array<{ proxy: ProxyKind; paths: string[] }> = [
  { proxy: "nginx", paths: ["/etc/nginx/nginx.conf"] },
  { proxy: "caddy", paths: ["/etc/caddy/Caddyfile"] },
  { proxy: "apache", paths: ["/etc/apache2/apache2.conf", "/etc/httpd/conf/httpd.conf"] },
  {
    proxy: "openresty",
    paths: ["/usr/local/openresty/nginx/conf/nginx.conf", "/etc/openresty/nginx.conf"],
  },
];

/**
 * Find a proxy that is installed on this host but is NOT currently serving
 * :80/:443 — i.e. one we already stopped.
 *
 * Why this exists: `probeEdge` can only see a proxy that HOLDS the ports, so once
 * a takeover stops the operator's nginx, its sites become invisible to the
 * migrate flow — even though every vhost is still sitting in /etc/nginx. A run
 * that stopped the proxy but failed to register its sites (or a re-run after
 * that) had no way to recover them, which is exactly how a box ends up serving
 * nothing for domains the operator was told would be migrated. The parsers read
 * config off disk and never touch the process, so a stopped proxy scans fine.
 *
 * Returns null when nothing importable is installed.
 */
export async function detectInstalledProxy(
  executor: CommandExecutor,
): Promise<ProxyKind | null> {
  const probe = INSTALLED_MARKERS.map(({ proxy, paths }) => {
    const test = paths.map((p) => `[ -f '${p}' ]`).join(" || ");
    return `{ ${test}; } && echo ${proxy}`;
  }).join("; ");
  let out = "";
  try {
    out = await executor.exec(`{ ${probe}; } 2>/dev/null; true`, { timeout: 10_000 });
  } catch {
    return null;
  }
  const found = new Set(
    out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  return INSTALLED_MARKERS.find((m) => found.has(m.proxy))?.proxy ?? null;
}

/**
 * Scan a specific proxy's config into normalized sites. Returns an empty result
 * (with a warning) for proxies we can't import (e.g. haproxy — takeover-only).
 * traefik IS importable (via container labels) — see `scanTraefik`.
 */
export async function scanImportableSites(
  executor: CommandExecutor,
  proxy: ProxyKind,
): Promise<ProxyScanResult> {
  switch (proxy) {
    case "nginx":
      return scanNginx(executor);
    case "caddy":
      return scanCaddy(executor);
    case "apache":
      return scanApache(executor);
    case "traefik":
      return scanTraefik(executor);
    case "openresty":
      // Same parser: OpenResty vhosts ARE nginx syntax. scanOpenshipEdge already
      // reads the two bare-host sites-enabled layouts, which is exactly where a
      // host OpenResty (ours or hand-rolled) keeps them.
      return scanOpenshipEdge(executor);
    default:
      return {
        proxy,
        sites: [],
        warnings: [`${proxy}: config import not supported — takeover only`],
      };
  }
}

/**
 * Which recognized proxies can we import config from?
 *
 * `openresty` is importable for the same reason the marker list includes it: with a
 * containerized edge, a host OpenResty is a migration SOURCE. Leaving it out meant
 * the one proxy whose config we can parse most reliably — our own former bare edge —
 * was offered "takeover only", i.e. drop every vhost it serves.
 */
export function canImportProxy(proxy: ProxyKind | undefined): boolean {
  return (
    proxy === "nginx" ||
    proxy === "caddy" ||
    proxy === "apache" ||
    proxy === "traefik" ||
    proxy === "openresty"
  );
}

export { scanNginx, scanOpenshipEdge, scanCaddy, scanApache, scanTraefik };
