import { describe, expect, it } from "vitest";
import {
  AUTHORITY_DOCUMENTS,
  ABSENT_EVENT_IDS,
  CANONICAL_EVENT_COUNT,
  CANONICAL_EVENT_DEFINITIONS,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  PRODUCT_CONTROL_STATE_DEFINITIONS,
  PRODUCT_SPECIFICATION_SOURCE,
} from "./index.ts";

describe("authority metadata", () => {
  it("uses the frozen MVP7 documents as product authority", () => {
    expect(AUTHORITY_DOCUMENTS.productSpecification).toBe("MVP7_PRODUCT_SPECIFICATION");
    expect(AUTHORITY_DOCUMENTS.stateRegistry).toBe("MVP7_PRODUCT_CONTROL_STATE_REGISTRY");
    expect(AUTHORITY_DOCUMENTS.eventRegistry).toBe("MVP7_EVENT_REGISTRY");
    expect(AUTHORITY_DOCUMENTS.matrix).toBe("MVP7_STATE_EVENT_MATRIX");
    expect(PRODUCT_SPECIFICATION_SOURCE.document).toBe("MVP7_PRODUCT_SPECIFICATION");
    expect(PRODUCT_SPECIFICATION_SOURCE.file).toBe("1. MVP7_PRODUCT SPECIFICATION");
    expect(PRODUCT_SPECIFICATION_SOURCE.revision).toBe("7");
  });

  it("does not declare MVP5 or MVP6 as current product authority", () => {
    const authorityValues = Object.values(AUTHORITY_DOCUMENTS);
    expect(authorityValues.some((value) => value.includes("MVP5"))).toBe(false);
    expect(authorityValues.some((value) => value.includes("MVP6"))).toBe(false);
    expect(PRODUCT_SPECIFICATION_SOURCE.revision).not.toBe("5");
    expect(PRODUCT_SPECIFICATION_SOURCE.revision).not.toBe("6");
    expect(PRODUCT_SPECIFICATION_SOURCE.file).not.toMatch(/MVP5|MVP6/);
  });

  it("keeps frozen registry counts and intentionally absent events", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(55);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(333);
    expect(ABSENT_EVENT_IDS).toEqual(["E-36", "E-37", "E-38", "E-39", "E-40"]);
  });

  it("attaches document references to every Product Control State", () => {
    for (const definition of PRODUCT_CONTROL_STATE_DEFINITIONS) {
      expect(definition.references.length).toBeGreaterThan(0);
      expect(definition.references[0]?.document).toBe("MVP7_PRODUCT_CONTROL_STATE_REGISTRY");
      expect(definition.references[0]?.locator.length).toBeGreaterThan(0);
    }
  });

  it("attaches document references to every canonical Event", () => {
    for (const definition of CANONICAL_EVENT_DEFINITIONS) {
      expect(definition.references.length).toBeGreaterThan(0);
      expect(definition.references[0]?.document).toBe("MVP7_EVENT_REGISTRY");
      expect(definition.references[0]?.locator.length).toBeGreaterThan(0);
    }
  });

  it("labels every Matrix row with the MVP7 Matrix authority document", () => {
    for (const row of MATRIX_CONTRACT_ROWS) {
      expect(row.source.document).toBe("MVP7_STATE_EVENT_MATRIX");
    }
  });
});
