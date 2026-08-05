import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bakedEdgeNginxConf } from "./edge-baked-conf";
import {
  ACME_HTTP01_PORT,
  EDGE_CHALLENGE_ROOT,
  EDGE_CHALLENGE_URL_PREFIX,
  EDGE_SHARED_DICTS,
  OPENRESTY_DEFAULT_PATHS,
  OPENRESTY_MGMT_PORT,
} from "./openresty-lua";

/**
 * `apps/edge/nginx.conf` is COPYed into the edge image, so it can't read a TS
 * constant — yet most of what it contains is shared with the bare/remote edge,
 * which gets those same directives patched in from TypeScript. It used to be a
 * hand-maintained copy with three "keep in sync" comments, guarded by string
 * matches that would catch a rename but not a divergent VALUE.
 *
 * It is now generated. This file is the guard on that: the checked-in conf must
 * equal its generator, and the properties worth naming are asserted against the
 * generator, so breaking one gives you its name rather than a whole-file diff.
 */
describe("baked edge nginx.conf", () => {
  const conf = bakedEdgeNginxConf();
  const onDisk = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../../apps/edge/nginx.conf"),
    "utf-8",
  );

  test("the checked-in file is up to date", () => {
    // If this fails: `bun run edge:conf` in packages/adapters. Never hand-edit
    // apps/edge/nginx.conf — the next regeneration silently reverts it.
    expect(onDisk).toBe(conf);
  });

  test("owns the 443 default_server and rejects unknown SNI", () => {
    // Without a 443 default, nginx serves the first-loaded 443 vhost to any
    // unmatched SNI — a domain we do NOT route gets another app's cert + backend.
    expect(conf).toContain("listen 443 ssl default_server;");
    expect(conf).toContain("ssl_reject_handshake on;");
  });

  test("owns the 80 default_server catch-all (no HTTP fallthrough)", () => {
    expect(conf).toContain("listen 80 default_server;");
    expect(conf).toContain("server_name _;");
  });

  /**
   * Both probes that matter arrive addressed to a bare IP, so `Host:` matches no
   * server_name and only the catch-all is left to answer them.
   */
  test("answers ACME http-01 on the catch-all, proxied to certbot's loopback port", () => {
    expect(conf).toContain(`proxy_pass http://127.0.0.1:${ACME_HTTP01_PORT};`);
  });

  test("serves the Openship Cloud edge-target challenge on the catch-all", () => {
    expect(conf).toContain(`location ${EDGE_CHALLENGE_URL_PREFIX} {`);
    expect(conf).toContain(`root ${EDGE_CHALLENGE_ROOT};`);
  });

  test("serves challenge tokens as FILES, never echoing them back", () => {
    // An echo (`return 200 $1` off a regex match) would hand a token back to
    // whoever asked, letting a third party register this box as THEIR routing
    // target and prove control with our own reply. Only files we wrote may serve.
    expect(conf).toContain("try_files $uri =404;");
    expect(conf).not.toMatch(/oblien-proxy-challenge[\s\S]{0,200}return\s+200/);
  });

  test("declares every shared dict the Lua depends on, at the shared size", () => {
    // The drift this whole generator exists for: a zone sized here by hand and
    // patched elsewhere from EDGE_SHARED_DICTS evicts under load on one edge only.
    for (const dict of EDGE_SHARED_DICTS) {
      expect(conf).toContain(`lua_shared_dict ${dict.name} ${dict.size};`);
    }
  });

  test("includes the sites-enabled glob the api actually writes into", () => {
    // A mismatch here is a box where every managed vhost is written and none load.
    expect(conf).toContain(`include ${OPENRESTY_DEFAULT_PATHS.sitesDir}/*.conf;`);
  });

  test("binds the management API to loopback only", () => {
    // Analytics, raw request logs and the live-log pipe. A bare `listen 9145;`
    // would publish all three.
    expect(conf).toContain(`listen 127.0.0.1:${OPENRESTY_MGMT_PORT};`);
    expect(conf).not.toMatch(new RegExp(`listen\\s+${OPENRESTY_MGMT_PORT}\\b`));
  });
});
