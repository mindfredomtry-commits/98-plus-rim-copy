import { describe, expect, it } from "vitest";
import {
  APP_FULL_CLOSE_COMPOSITION,
  MATRIX_CONTRACT_ROWS,
  MATRIX_SPEC_GAP_COUNT,
  PRODUCT_CONTROL_STATES,
} from "./index.ts";

describe("Matrix contract fixtures", () => {
  it("contains zero unresolved SPEC GAP rows", () => {
    expect(MATRIX_SPEC_GAP_COUNT).toBe(0);
    expect(MATRIX_CONTRACT_ROWS.some((row) => (row.result as string) === "SPEC_GAP")).toBe(false);
  });

  it("records the global E-32 overlay and a local E-32 row for every state", () => {
    expect(APP_FULL_CLOSE_COMPOSITION.composition).toBe("GLOBAL_THEN_LOCAL");
    expect(APP_FULL_CLOSE_COMPOSITION.result).toBe("SESSION_END");
    const global = MATRIX_CONTRACT_ROWS.find(
      (row) => row.eventId === "E-32" && row.state === "GLOBAL",
    );
    expect(global?.result).toBe("SESSION_END");
    for (const state of PRODUCT_CONTROL_STATES) {
      const local = MATRIX_CONTRACT_ROWS.find(
        (row) => row.eventId === "E-32" && row.state === state,
      );
      expect(local, `missing local E-32 for ${state}`).toBeDefined();
      expect(local?.result).toBe("SESSION_END");
      expect(local?.source.document).toBe("MVP8_STATE_EVENT_MATRIX");
    }
  });

  it("keeps E-42 independent of Timer Notification Item processing", () => {
    const durationRows = MATRIX_CONTRACT_ROWS.filter((row) => row.eventId === "E-42");
    expect(durationRows.length).toBe(PRODUCT_CONTROL_STATES.length);
    expect(durationRows.every((row) => row.result === "STAY")).toBe(true);
    expect(
      durationRows.every((row) =>
        row.effects.some((effect) => effect.type === "UPSERT_DOMAIN_TIMER"),
      ),
    ).toBe(true);
  });
});
