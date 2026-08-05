# syntax=docker/dockerfile:1
# ─── openship-edge ──────────────────────────────────────────────────────────
# The routing/TLS edge, run as a CONTAINER on :80/:443 (network_mode: host)
# instead of bare OpenResty on the host. Cleaner than apt-installing OpenResty +
# certbot on the box: the edge ships as an image.
#
# The api container drives this edge via the Docker socket (see
# DockerEdgeExecutor): it drops vhost `<slug>.conf` files into the shared
# sites-enabled volume and runs `openresty -s reload` / `certbot` via
# `docker exec`. Three dirs are SHARED VOLUMES (api writes, edge reads):
#   • /usr/local/openresty/nginx/conf/sites-enabled  — managed vhosts
#   • /etc/letsencrypt                                — issued certs
# nginx.conf + the openship Lua are BAKED here (complete, no runtime edits), so
# the api never installs OpenResty or Lua in docker mode.
# ─────────────────────────────────────────────────────────────────────────────
FROM openresty/openresty:1.27.1.1-alpine

# certbot → managed TLS via http-01 STANDALONE: certbot binds a loopback alt-port
# (49180) transiently and the edge proxies /.well-known/acme-challenge/ to it
# (see nginx.conf) — zero downtime, no webroot, no port-80 fight.
# procps → `pkill` for the reload command's restart fallback.
# curl   → the mgmt-API exec transport (project-analytics.ts execMgmt) reaches
#          127.0.0.1:9145 from INSIDE this container, since network_mode: host
#          puts that loopback out of the api container's reach.
# openssl → the CLI (the base image ships only the libraries) for the temporary
#           self-signed certs a domain serves until its real one is issued, so a
#           routed host never refuses a TLS handshake. See ensureBootstrapCert in
#           packages/adapters/src/infra/nginx.ts; without it that falls back to an
#           HTTP-only vhost, which is what Cloudflare reports as error 525.
# libmaxminddb → the C library geo_country.lua's FFI binding loads. WITHOUT IT
#           every country lookup returns nil: no per-country analytics is ever
#           recorded, and rules_guard.lua's country rules fail CLOSED (a country
#           ban blocks all traffic). It was never installed here, and the only
#           installer (installGeoDeps) probed apt/dnf/yum but never apk — so geo
#           has been silently dark on every containerized edge.
RUN apk add --no-cache certbot procps curl openssl libmaxminddb

# Openship Lua (rules engine + analytics + logging + webhook) plus the vendored
# maxminddb FFI binding. Baked in at the path lua_package_path resolves
# (`require "openship.rules_lib"`, `require "openship.maxminddb"` etc.).
COPY packages/adapters/src/infra/lua/ /usr/local/openresty/site/lualib/openship/

# GeoLite2-Country, from the copy we already vendor and already treat as the
# source of truth for the API's own lookups (apps/api/assets/geoip/README.md:
# "production reads this shipped copy — the running server never depends on a
# third-party mirror"). Baking it holds that line for the edge too: no runtime
# download, and nothing to lose when the container is recreated on upgrade.
# Refresh both copies together with `bun run update:geoip`.
COPY apps/api/assets/geoip/GeoLite2-Country.mmdb /usr/share/GeoIP/GeoLite2-Country.mmdb

# Complete config: shared dicts, lua path, ACME/default catch-all, the loopback
# management API, and the dynamic sites-enabled include. No runtime sed.
COPY apps/edge/nginx.conf /usr/local/openresty/nginx/conf/nginx.conf

# Create the shared-volume mount points so a first boot (before the api writes
# anything) still validates + starts.
RUN mkdir -p /usr/local/openresty/nginx/conf/sites-enabled /var/www/acme /etc/letsencrypt

EXPOSE 80 443
# Graceful OpenResty stop.
STOPSIGNAL SIGQUIT
CMD ["openresty", "-g", "daemon off;"]
