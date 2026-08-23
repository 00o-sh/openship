import { describe, expect, it } from "vitest";
import { pickHostPort } from "@repo/adapters";
import { pinnedHostPortsToAvoid, type PinnedHostPort } from "./pinned-host-ports";

const claims: PinnedHostPort[] = [
  { projectId: "single", serviceId: null, port: 20001 },
  { projectId: "compose", serviceId: "api", port: 20002 },
  { projectId: "compose", serviceId: "worker", port: 20003 },
];

describe("pinnedHostPortsToAvoid", () => {
  it("reserves every offline-capable database claim by default", () => {
    expect([...pinnedHostPortsToAvoid(claims)].sort()).toEqual([20001, 20002, 20003]);
  });

  it("releases only the carried claim owned by the service being redeployed", () => {
    const avoid = pinnedHostPortsToAvoid(claims, {
      projectId: "compose",
      serviceId: "api",
      port: 20002,
    });

    expect(avoid.has(20002)).toBe(false);
    expect(avoid.has(20001)).toBe(true);
    expect(avoid.has(20003)).toBe(true);
  });

  it("does not release a port that another owner also claims", () => {
    const duplicate = [
      ...claims,
      { projectId: "other", serviceId: "web", port: 20002 },
    ] satisfies PinnedHostPort[];

    expect(
      pinnedHostPortsToAvoid(duplicate, {
        projectId: "compose",
        serviceId: "api",
        port: 20002,
      }).has(20002),
    ).toBe(true);
  });

  it("does not release an unowned preferred port", () => {
    expect(
      pinnedHostPortsToAvoid(claims, {
        projectId: "compose",
        serviceId: "missing",
        port: 20001,
      }).has(20001),
    ).toBe(true);
  });

  it("makes the allocator skip a pinned port even when no container is listening", () => {
    expect(pickHostPort(new Set(), { avoid: pinnedHostPortsToAvoid(claims) })).toBe(20000);

    const firstRangePortClaimed: PinnedHostPort[] = [
      { projectId: "offline", serviceId: "api", port: 20000 },
    ];
    expect(
      pickHostPort(new Set(), { avoid: pinnedHostPortsToAvoid(firstRangePortClaimed) }),
    ).toBe(20001);
  });

  it("lets a service keep its own carried port when nobody else claims it", () => {
    const avoid = pinnedHostPortsToAvoid(claims, {
      projectId: "compose",
      serviceId: "api",
      port: 20002,
    });

    expect(pickHostPort(new Set(), { preferred: 20002, avoid })).toBe(20002);
  });
});
