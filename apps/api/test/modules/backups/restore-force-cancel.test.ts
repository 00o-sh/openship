/**
 * `cancel(..., { force: true })` — the door project teardown needs.
 *
 * A cooperative cancel on an `applying` restore deliberately leaves the row in
 * `applying`: it sets the durable flag, aborts the in-process extract, and lets the
 * running phase carry the row terminal at its next checkpoint. That is right for an
 * operator clicking cancel, and wrong for a force-delete — the teardown destroys the
 * volumes seconds later, so a row still claiming to write outlives its own target.
 *
 * Forcing must not read as the reassuring outcome. It knows strictly LESS about the
 * target's state than a cooperative cancel, so it carries the same partial-write
 * wording and the `partialWrite` / `serviceLeftStopped` flags.
 */

import { db, repos, schema } from "@repo/db";
import { beforeEach, describe, expect, it } from "vitest";

import { RestoreOrchestrator } from "../../../src/modules/backups/restore.orchestrator";
import { seedBackupDestination, seedBackupRun, seedOrg, seedProject } from "../../helpers/seed";

let organizationId: string;
let orchestrator: RestoreOrchestrator;
const ctx = () => ({ organizationId, userId: "usr_1" }) as never;

async function seedRestore(status: string, meta: Record<string, unknown> = {}) {
  const projectId = (await seedProject(organizationId)).id;
  const destinationId = (await seedBackupDestination(organizationId)).id;
  const run = await seedBackupRun(organizationId, { destinationId, projectId, artifacts: [] });
  const id = `bks_${status}_${projectId}`;
  await db.insert(schema.backupRestore).values({
    id,
    runId: run.id,
    destinationId,
    projectId,
    organizationId,
    status: status as never,
    confirmationToken: "t".repeat(16),
    meta,
  });
  return id;
}

/**
 * Register an abort handle the way a running apply does. `inFlight` is private to the
 * class, and reaching it is the only way to prove the thing that was actually missing:
 * that the extract is INTERRUPTED, not merely re-labelled.
 */
function registerInFlight(restoreId: string): AbortController {
  const controller = new AbortController();
  (orchestrator as never as { inFlight: Map<string, AbortController> }).inFlight.set(
    restoreId,
    controller,
  );
  return controller;
}

beforeEach(async () => {
  organizationId = (await seedOrg()).organizationId;
  orchestrator = new RestoreOrchestrator();
});

describe("a forced cancel of an applying restore", () => {
  it("takes the row terminal instead of leaving it in applying", async () => {
    const id = await seedRestore("applying");

    // The cooperative call first, so this asserts the DIFFERENCE and not just that
    // some cancel works: a fresh cancel request is nowhere near FORCE_CANCEL_AFTER_MS.
    const cooperative = await orchestrator.cancel(ctx(), id);
    expect(cooperative).toMatchObject({ accepted: true, status: "applying", forced: false });

    const forced = await orchestrator.cancel(ctx(), id, { force: true });
    expect(forced).toMatchObject({ accepted: true, status: "cancelled", forced: true });
    expect((await repos.backupRestore.findById(id))!.status).toBe("cancelled");
  });

  it("aborts the in-flight extract rather than only writing the row", async () => {
    const id = await seedRestore("applying");
    const controller = registerInFlight(id);
    await orchestrator.cancel(ctx(), id, { force: true });
    expect(controller.signal.aborted).toBe(true);
  });

  it("says the write may have continued, and flags the volume, when it had begun writing", async () => {
    const id = await seedRestore("applying", {
      destructive: true,
      destructiveSource: "the volume pgdata",
    });
    const forced = await orchestrator.cancel(ctx(), id, { force: true });
    expect(forced.destructive).toBe(true);

    const row = (await repos.backupRestore.findById(id))!;
    expect(row.errorMessage).toContain("holds partial data");
    expect(row.errorMessage).toContain("the volume pgdata");
    expect(row.meta).toMatchObject({
      forced: true,
      destructive: true,
      partialWrite: true,
      serviceLeftStopped: true,
    });
  });

  it("does not claim partial data when nothing had been written yet", async () => {
    const id = await seedRestore("applying");
    await orchestrator.cancel(ctx(), id, { force: true });
    const row = (await repos.backupRestore.findById(id))!;
    expect(row.errorMessage).toContain("Cancelled before any data was written");
    expect(row.meta).toMatchObject({ forced: true });
    expect((row.meta as { partialWrite?: boolean }).partialWrite).toBeUndefined();
  });

  it("is a no-op on a row that already finished", async () => {
    const id = await seedRestore("succeeded");
    const out = await orchestrator.cancel(ctx(), id, { force: true });
    expect(out).toMatchObject({ accepted: false, status: "succeeded" });
    expect((await repos.backupRestore.findById(id))!.status).toBe("succeeded");
  });

  it("still refuses a restore from another org", async () => {
    const id = await seedRestore("applying");
    const other = (await seedOrg()).organizationId;
    await expect(
      orchestrator.cancel({ organizationId: other, userId: "usr_2" } as never, id, {
        force: true,
      }),
    ).rejects.toThrow(/not found/i);
    expect((await repos.backupRestore.findById(id))!.status).toBe("applying");
  });

  it("takes a non-applying restore terminal without needing force at all", async () => {
    const id = await seedRestore("preparing");
    const out = await orchestrator.cancel(ctx(), id);
    expect(out).toMatchObject({ status: "cancelled", forced: false, destructive: false });
  });
});
