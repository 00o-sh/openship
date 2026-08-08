/**
 * Selective stale-heartbeat sweep for in-flight backup runs (#516).
 */

import { describe, expect, it } from "vitest";
import { createBackupRunRepo } from "../../../../../packages/db/src/repos/backup.repo";

interface PgFake {
  db: unknown;
  rows: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
}

function makePgFake(rows: Array<Record<string, unknown>>): PgFake {
  const now = Date.now();
  const state: PgFake = { db: null, rows: rows.map((r) => ({ ...r })), updates: [] };
  state.db = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          state.updates.push(values);
          const queuedCutoff = now - 30 * 60 * 1000;
          const idleCutoff = now - 10 * 60 * 1000;
          const ceilingCutoff = now - 6 * 60 * 60 * 1000;
          const swept: Array<Record<string, unknown>> = [];

          for (const row of state.rows) {
            const status = row.status as string;
            const last = (row.lastEventAt as Date).getTime();
            const bytes = row.bytesTransferred as number | null | undefined;
            const terminal = ["succeeded", "failed", "cancelled", "server_error"];
            if (terminal.includes(status) || row.finishedAt) continue;

            const stale =
              (status === "queued" && last < queuedCutoff) ||
              (["preparing", "snapshotting", "verifying"].includes(status) && last < idleCutoff) ||
              (status === "uploading" && (bytes == null || bytes === 0) && last < idleCutoff) ||
              last < ceilingCutoff;

            if (stale) {
              Object.assign(row, values);
              swept.push(row);
            }
          }
          return {
            returning: async () => swept,
          };
        },
      }),
    }),
  };
  return state;
}

describe("backupRun.sweepRunsWithStaleHeartbeat", () => {
  const now = Date.now();

  it("fails a queued run nobody picked up", async () => {
    const pg = makePgFake([
      {
        id: "bkr_q",
        status: "queued",
        lastEventAt: new Date(now - 31 * 60 * 1000),
        finishedAt: null,
      },
    ]);
    const repo = createBackupRunRepo(pg.db as never);
    const swept = await repo.sweepRunsWithStaleHeartbeat({
      queuedCutoff: new Date(now - 30 * 60 * 1000),
      idleCutoff: new Date(now - 10 * 60 * 1000),
      ceilingCutoff: new Date(now - 6 * 60 * 60 * 1000),
      reason: "stale",
    });
    expect(swept).toBe(1);
    expect(pg.rows[0].status).toBe("server_error");
  });

  it("fails uploading with null bytes and a stale heartbeat (#516 shape)", async () => {
    const pg = makePgFake([
      {
        id: "bkr_u",
        status: "uploading",
        bytesTransferred: null,
        lastEventAt: new Date(now - 11 * 60 * 1000),
        finishedAt: null,
      },
    ]);
    const repo = createBackupRunRepo(pg.db as never);
    const swept = await repo.sweepRunsWithStaleHeartbeat({
      queuedCutoff: new Date(now - 30 * 60 * 1000),
      idleCutoff: new Date(now - 10 * 60 * 1000),
      ceilingCutoff: new Date(now - 6 * 60 * 60 * 1000),
      reason: "stale",
    });
    expect(swept).toBe(1);
    expect(pg.rows[0].status).toBe("server_error");
  });

  it("does not fail uploading when bytes are moving and under the ceiling", async () => {
    const pg = makePgFake([
      {
        id: "bkr_ok",
        status: "uploading",
        bytesTransferred: 1_048_576,
        lastEventAt: new Date(now - 20 * 60 * 1000),
        finishedAt: null,
      },
    ]);
    const repo = createBackupRunRepo(pg.db as never);
    const swept = await repo.sweepRunsWithStaleHeartbeat({
      queuedCutoff: new Date(now - 30 * 60 * 1000),
      idleCutoff: new Date(now - 10 * 60 * 1000),
      ceilingCutoff: new Date(now - 6 * 60 * 60 * 1000),
      reason: "stale",
    });
    expect(swept).toBe(0);
    expect(pg.rows[0].status).toBe("uploading");
  });
});
