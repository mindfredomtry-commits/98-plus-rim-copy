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
  it("uses the frozen MVP10 documents as product authority", () => {
    expect(AUTHORITY_DOCUMENTS.productSpecification).toBe("MVP10_PRODUCT_SPECIFICATION");
    expect(AUTHORITY_DOCUMENTS.stateRegistry).toBe("MVP10_PRODUCT_CONTROL_STATE_REGISTRY");
    expect(AUTHORITY_DOCUMENTS.eventRegistry).toBe("MVP10_EVENT_REGISTRY");
    expect(AUTHORITY_DOCUMENTS.matrix).toBe("MVP10_STATE_EVENT_MATRIX");
    expect(PRODUCT_SPECIFICATION_SOURCE.document).toBe("MVP10_PRODUCT_SPECIFICATION");
    expect(PRODUCT_SPECIFICATION_SOURCE.file).toBe("1. MVP10_PRODUCT SPECIFICATION");
    expect(PRODUCT_SPECIFICATION_SOURCE.revision).toBe("10");
  });

  it("does not declare MVP5–MVP9 as current product authority", () => {
    const authorityValues = Object.values(AUTHORITY_DOCUMENTS);
    expect(authorityValues.some((value) => value.includes("MVP5"))).toBe(false);
    expect(authorityValues.some((value) => value.includes("MVP6"))).toBe(false);
    expect(authorityValues.some((value) => value.includes("MVP7"))).toBe(false);
    expect(authorityValues.some((value) => value.includes("MVP8"))).toBe(false);
    expect(authorityValues.some((value) => value.includes("MVP9"))).toBe(false);
    expect(PRODUCT_SPECIFICATION_SOURCE.revision).not.toBe("5");
    expect(PRODUCT_SPECIFICATION_SOURCE.revision).not.toBe("6");
    expect(PRODUCT_SPECIFICATION_SOURCE.revision).not.toBe("7");
    expect(PRODUCT_SPECIFICATION_SOURCE.revision).not.toBe("8");
    expect(PRODUCT_SPECIFICATION_SOURCE.revision).not.toBe("9");
    expect(PRODUCT_SPECIFICATION_SOURCE.file).not.toMatch(/MVP5|MVP6|MVP7|MVP8|MVP9/);
  });

  it("keeps frozen registry counts and intentionally absent events", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(58);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(358);
    expect(ABSENT_EVENT_IDS).toEqual(["E-36", "E-37", "E-38", "E-39", "E-40"]);
  });

  it("attaches document references to every Product Control State", () => {
    for (const definition of PRODUCT_CONTROL_STATE_DEFINITIONS) {
      expect(definition.references.length).toBeGreaterThan(0);
      expect(definition.references[0]?.document).toBe("MVP10_PRODUCT_CONTROL_STATE_REGISTRY");
      expect(definition.references[0]?.locator.length).toBeGreaterThan(0);
    }
  });

  it("attaches document references to every canonical Event", () => {
    for (const definition of CANONICAL_EVENT_DEFINITIONS) {
      expect(definition.references.length).toBeGreaterThan(0);
      expect(definition.references[0]?.document).toBe("MVP10_EVENT_REGISTRY");
      expect(definition.references[0]?.locator.length).toBeGreaterThan(0);
    }
  });

  it("labels every Matrix row with the MVP10 Matrix authority document", () => {
    for (const row of MATRIX_CONTRACT_ROWS) {
      expect(row.source.document).toBe("MVP10_STATE_EVENT_MATRIX");
    }
  });
});
