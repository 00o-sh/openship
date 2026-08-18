import { describe, expect, it } from "vitest";
import { ENV_MASK } from "@repo/core";
import { serviceEnvPatch } from "./service-env-payload";

/**
 * The API merges this map (#619), so the client half decides whether a deletion
 * happens at all: a payload built from the current rows alone leaves every removed
 * variable in place, and the operator gets a success toast for a delete that never
 * happened. Every case here is about a key that must come out as `null`.
 */

const rows = (...pairs: [string, string][]) => pairs.map(([key, value]) => ({ key, value }));

describe("serviceEnvPatch", () => {
  it("nulls a key that was loaded but is no longer in the rows", () => {
    expect(serviceEnvPatch(rows(["KEEP", "1"]), { KEEP: ENV_MASK, GONE: ENV_MASK })).toEqual({
      KEEP: "1",
      GONE: null,
    });
  });

  it("treats a rename as add-plus-remove", () => {
    expect(serviceEnvPatch(rows(["NEW_NAME", "v"]), { OLD_NAME: ENV_MASK })).toEqual({
      NEW_NAME: "v",
      OLD_NAME: null,
    });
  });

  it("nulls a key whose row was blanked, and never emits an empty key", () => {
    expect(serviceEnvPatch(rows(["  ", "v"]), { WAS_HERE: ENV_MASK })).toEqual({
      WAS_HERE: null,
    });
  });

  it("passes the mask sentinel through untouched so the API restores the stored value", () => {
    expect(serviceEnvPatch(rows(["SECRET", ENV_MASK]), { SECRET: ENV_MASK })).toEqual({
      SECRET: ENV_MASK,
    });
  });

  it("keeps an empty value as empty rather than dropping the key", () => {
    expect(serviceEnvPatch(rows(["BLANK", ""]), { BLANK: "" })).toEqual({ BLANK: "" });
  });

  it("trims keys and emits nothing to delete when there was no stored map", () => {
    expect(serviceEnvPatch(rows([" PADDED ", "v"]))).toEqual({ PADDED: "v" });
    expect(serviceEnvPatch([], null)).toEqual({});
  });

  // A row that re-adds a key under its original name must not be nulled by the
  // deletion pass — `in` is checked against the emitted patch, not the row list.
  it("does not null a key that is still present", () => {
    expect(serviceEnvPatch(rows(["A", "1"], ["B", "2"]), { A: ENV_MASK, B: ENV_MASK })).toEqual({
      A: "1",
      B: "2",
    });
  });
});
