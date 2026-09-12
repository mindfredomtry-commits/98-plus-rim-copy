import { describe, expect, it } from "vitest";
import {
  ABSENT_CREATE_BAN_STATE_ID,
  ABSENT_EVENT_IDS,
  assertCanonicalEventId,
  CANONICAL_EVENT_COUNT,
  CANONICAL_EVENT_DEFINITIONS,
  IMPLEMENTATION_STAGE,
  isAbsentEventId,
  isCanonicalEventId,
  PRODUCT_CONTROL_STATE_COUNT,
  PRODUCT_CONTROL_STATE_DEFINITIONS,
  PRODUCT_CONTROL_STATE_IDS,
  STAGE_1_EXCLUDES,
  STAGE_2_EXCLUDES,
} from "./index.ts";

describe("Stage 1 closed registries", () => {
  it("contains exactly 30 Product Control States", () => {
    expect(PRODUCT_CONTROL_STATE_DEFINITIONS).toHaveLength(30);
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(
      new Set(PRODUCT_CONTROL_STATE_DEFINITIONS.map((definition) => definition.state)).size,
    ).toBe(30);
    expect(new Set(PRODUCT_CONTROL_STATE_IDS).size).toBe(30);
    expect(
      (PRODUCT_CONTROL_STATE_IDS as readonly string[]).includes(ABSENT_CREATE_BAN_STATE_ID),
    ).toBe(false);
  });

  it("contains exactly 55 canonical Product Events", () => {
    expect(CANONICAL_EVENT_DEFINITIONS).toHaveLength(55);
    expect(CANONICAL_EVENT_COUNT).toBe(55);
    expect(new Set(CANONICAL_EVENT_DEFINITIONS.map((definition) => definition.id)).size).toBe(55);
    expect(new Set(CANONICAL_EVENT_DEFINITIONS.map((definition) => definition.name)).size).toBe(55);
  });

  it("rejects E-36 through E-40", () => {
    expect(ABSENT_EVENT_IDS).toEqual(["E-36", "E-37", "E-38", "E-39", "E-40"]);
    for (const id of ABSENT_EVENT_IDS) {
      expect(isAbsentEventId(id)).toBe(true);
      expect(isCanonicalEventId(id)).toBe(false);
      expect(() => assertCanonicalEventId(id)).toThrow(/intentionally absent/);
    }
  });

  it("does not implement later stages", () => {
    expect(IMPLEMENTATION_STAGE).toBe(2);
    expect(STAGE_1_EXCLUDES).toContain("transition-resolver-behavior");
    expect(STAGE_1_EXCLUDES).toContain("database-persistence");
    expect(STAGE_1_EXCLUDES).toContain("ui-screens");
    expect(STAGE_2_EXCLUDES).not.toContain("transition-resolver-behavior");
    expect(STAGE_2_EXCLUDES).toContain("database-persistence");
    expect(STAGE_2_EXCLUDES).toContain("ui-screens");
  });
});
