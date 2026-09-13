import { describe, expect, it } from "vitest";
import {
  ABSENT_EVENT_IDS,
  APP_FULL_CLOSE_COMPOSITION,
  CANONICAL_EVENT_DEFINITIONS,
  IMPLEMENTATION_STAGE,
  isCanonicalEventId,
  isProductControlState,
  MATRIX_BOOTSTRAP_RULE_COUNT,
  MATRIX_CONTRACT_ROWS,
  MATRIX_E43_RULE_COUNT,
  MATRIX_GLOBAL_RULE_COUNT,
  MATRIX_SPEC_GAP_COUNT,
  PRODUCT_CONTROL_STATES,
  STAGE_1_EXCLUDES,
  STAGE_2_EXCLUDES,
  countMatrixRowsByProductControlState,
  isAuthoritativeEventReference,
  isValidMatrixNextState,
  matrixRowIdentity,
} from "./index.ts";
import {
  DOCUMENT_INCONSISTENCIES,
  EXPECTED_AUTHORITATIVE_ROW_IDS,
  EXPECTED_LOCAL_ROW_COUNTS,
  NONDETERMINISTIC_MATRIX_LINES,
} from "./matrix/expected-coverage.ts";

const CARTESIAN_30_BY_55 = 30 * 55;
const EXPECTED_LOCAL_TOTAL = (Object.values(EXPECTED_LOCAL_ROW_COUNTS) as number[]).reduce(
  (sum, count) => sum + count,
  0,
);

describe("Stage 1.5 Matrix coverage audit", () => {
  it("transcribes every expected authoritative row exactly once", () => {
    const actual = MATRIX_CONTRACT_ROWS.map(matrixRowIdentity).sort();
    const expected = [...EXPECTED_AUTHORITATIVE_ROW_IDS].sort();
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
    expect(actual).toHaveLength(EXPECTED_AUTHORITATIVE_ROW_IDS.length);
  });

  it("does not silently omit or duplicate a state/event/guard branch", () => {
    const keys = MATRIX_CONTRACT_ROWS.map(
      (row) => `${row.kind}:${row.state}:${row.eventId}:${row.branch}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    const missing = EXPECTED_AUTHORITATIVE_ROW_IDS.filter((id) => !keys.includes(id));
    const extra = keys.filter((id) => !EXPECTED_AUTHORITATIVE_ROW_IDS.includes(id));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it("keeps local row counts aligned with every Product Control State section", () => {
    const counts = countMatrixRowsByProductControlState();
    expect(Object.keys(counts)).toHaveLength(30);
    for (const state of PRODUCT_CONTROL_STATES) {
      expect(counts[state], state).toBe(EXPECTED_LOCAL_ROW_COUNTS[state]);
    }
  });

  it("references only registry State IDs and canonical or LATE_RESULT Event IDs", () => {
    for (const row of MATRIX_CONTRACT_ROWS) {
      if (row.kind === "LOCAL") {
        expect(isProductControlState(row.state), row.id).toBe(true);
      } else {
        expect(["GLOBAL", "BOOTSTRAP", "E43"]).toContain(row.state);
      }
      expect(isAuthoritativeEventReference(row.eventId), row.id).toBe(true);
      if (row.eventId !== "LATE_RESULT") {
        expect(isCanonicalEventId(row.eventId), row.id).toBe(true);
      }
      for (const eventId of row.appliesToEventIds ?? []) {
        expect(isCanonicalEventId(eventId), `${row.id} appliesTo ${eventId}`).toBe(true);
      }
    }
  });

  it("uses only valid Next State IDs where a Next State exists", () => {
    for (const row of MATRIX_CONTRACT_ROWS) {
      expect(isValidMatrixNextState(row.nextState), row.id).toBe(true);
      if (row.result === "SESSION_END") {
        expect(row.nextState, row.id).toBeNull();
      }
    }
  });

  it("contains zero SPEC_GAP rows", () => {
    expect(MATRIX_SPEC_GAP_COUNT).toBe(0);
    expect(MATRIX_CONTRACT_ROWS.some((row) => (row.result as string) === "SPEC_GAP")).toBe(false);
  });

  it("does not introduce E-36 through E-40", () => {
    const absent = ABSENT_EVENT_IDS as readonly string[];
    const present = MATRIX_CONTRACT_ROWS.filter((row) => absent.includes(row.eventId));
    expect(present).toEqual([]);
    expect(CANONICAL_EVENT_DEFINITIONS.some((event) => absent.includes(event.id))).toBe(false);
  });

  it("keeps global, bootstrap, E-43, and local rows distinguishable", () => {
    expect(MATRIX_GLOBAL_RULE_COUNT).toBe(7);
    expect(MATRIX_BOOTSTRAP_RULE_COUNT).toBe(5);
    expect(MATRIX_E43_RULE_COUNT).toBe(8);
    expect(MATRIX_CONTRACT_ROWS.filter((row) => row.kind === "GLOBAL")).toHaveLength(7);
    expect(MATRIX_CONTRACT_ROWS.filter((row) => row.kind === "BOOTSTRAP")).toHaveLength(5);
    expect(MATRIX_CONTRACT_ROWS.filter((row) => row.kind === "E43")).toHaveLength(8);
    expect(MATRIX_CONTRACT_ROWS.filter((row) => row.kind === "LOCAL")).toHaveLength(
      EXPECTED_LOCAL_TOTAL,
    );
    for (const row of MATRIX_CONTRACT_ROWS) {
      expect(row.source.document).toBe("MVP8_STATE_EVENT_MATRIX");
      expect(row.source.section.length).toBeGreaterThan(0);
      expect(row.source.locator.length).toBeGreaterThan(0);
      if (row.kind === "GLOBAL") {
        expect(row.state).toBe("GLOBAL");
      }
      if (row.kind === "BOOTSTRAP") {
        expect(row.state).toBe("BOOTSTRAP");
      }
      if (row.kind === "E43") {
        expect(row.state).toBe("E43");
        expect(row.eventId).toBe("E-43");
      }
    }
  });

  it("keeps TimerNotificationItem processing separate from DomainTimer on E-32 and E-42", () => {
    expect(APP_FULL_CLOSE_COMPOSITION.composition).toBe("GLOBAL_THEN_LOCAL");
    const globalClose = MATRIX_CONTRACT_ROWS.find(
      (row) => row.kind === "GLOBAL" && row.eventId === "E-32",
    );
    expect(
      globalClose?.effects.some((effect) => effect.type === "PROCESS_TIMER_NOTIFICATION_ITEM"),
    ).toBe(true);
    expect(globalClose?.effects.some((effect) => effect.type === "UPSERT_DOMAIN_TIMER")).toBe(
      false,
    );

    const localClose = MATRIX_CONTRACT_ROWS.filter(
      (row) => row.kind === "LOCAL" && row.eventId === "E-32",
    );
    expect(localClose).toHaveLength(30);
    expect(localClose.every((row) => row.result === "SESSION_END")).toBe(true);
    expect(
      localClose.every(
        (row) => !row.effects.some((effect) => effect.type === "UPSERT_DOMAIN_TIMER"),
      ),
    ).toBe(true);

    const durationRows = MATRIX_CONTRACT_ROWS.filter((row) => row.eventId === "E-42");
    expect(durationRows.length).toBe(30);
    expect(durationRows.every((row) => row.kind === "LOCAL")).toBe(true);
    expect(durationRows.every((row) => row.result === "STAY")).toBe(true);
    expect(
      durationRows.every((row) =>
        row.effects.some((effect) => effect.type === "UPSERT_DOMAIN_TIMER"),
      ),
    ).toBe(true);
    expect(
      durationRows.every(
        (row) => !row.effects.some((effect) => effect.type === "PROCESS_TIMER_NOTIFICATION_ITEM"),
      ),
    ).toBe(true);
  });

  it("represents frozen E-49 and E-56 RIM behavior exactly", () => {
    const chatE49 = MATRIX_CONTRACT_ROWS.filter(
      (row) => row.kind === "LOCAL" && row.state === "RIM.CHAT" && row.eventId === "E-49",
    );
    expect(chatE49).toEqual([]);

    const selectE49 = MATRIX_CONTRACT_ROWS.filter(
      (row) => row.kind === "LOCAL" && row.state === "RIM.SELECT_CONTACT" && row.eventId === "E-49",
    );
    expect(selectE49.map((row) => row.branch)).toEqual([
      "initial-selected-contact",
      "change-selected-contact",
      "same-current-selected-contact",
    ]);
    expect(selectE49.every((row) => row.nextState === "RIM.CHAT")).toBe(true);
    expect(selectE49.every((row) => row.result === "TRANSITION")).toBe(true);
    expect(
      selectE49
        .filter((row) => row.branch !== "same-current-selected-contact")
        .every((row) =>
          row.effects.some((effect) => effect.type === "REQUEST_RELATIONSHIP_CONTEXT"),
        ),
    ).toBe(true);
    expect(
      selectE49
        .find((row) => row.branch === "same-current-selected-contact")
        ?.effects.some((effect) => effect.type === "REQUEST_RELATIONSHIP_CONTEXT"),
    ).toBe(false);

    const chatE56Current = MATRIX_CONTRACT_ROWS.find(
      (row) =>
        row.state === "RIM.CHAT" && row.eventId === "E-56" && row.branch === "current-contact",
    );
    expect(chatE56Current?.result).toBe("STAY");
    expect(chatE56Current?.nextState).toBe("RIM.CHAT");
    expect(chatE56Current?.effectsText.includes("relationshipContext.status")).toBe(true);

    const selectE56Transition = MATRIX_CONTRACT_ROWS.filter(
      (row) =>
        row.state === "RIM.SELECT_CONTACT" && row.eventId === "E-56" && row.result === "TRANSITION",
    );
    expect(selectE56Transition).toEqual([]);

    const selectE56Background = MATRIX_CONTRACT_ROWS.find(
      (row) =>
        row.state === "RIM.SELECT_CONTACT" &&
        row.eventId === "E-56" &&
        row.branch === "no-new-selection-prior-contact",
    );
    expect(selectE56Background?.result).toBe("STAY");
    expect(selectE56Background?.nextState).toBe("RIM.SELECT_CONTACT");
  });

  it("has no remaining Product Specification contradiction after corrected 1.6.3.1", () => {
    expect(DOCUMENT_INCONSISTENCIES).toEqual([]);
    expect(MATRIX_SPEC_GAP_COUNT).toBe(0);
  });

  it("does not invent a 30 × 55 Cartesian product", () => {
    expect(MATRIX_CONTRACT_ROWS.length).toBeLessThan(CARTESIAN_30_BY_55);
    expect(MATRIX_CONTRACT_ROWS.length).toBe(333);
    expect(MATRIX_CONTRACT_ROWS.length).toBe(EXPECTED_AUTHORITATIVE_ROW_IDS.length);
    expect(NONDETERMINISTIC_MATRIX_LINES.length).toBeGreaterThan(0);
  });

  it("implements the Stage 2 transition resolver without Stage 3 infrastructure", () => {
    expect(IMPLEMENTATION_STAGE).toBe(2);
    expect(STAGE_1_EXCLUDES).toContain("transition-resolver-behavior");
    expect(STAGE_2_EXCLUDES).not.toContain("transition-resolver-behavior");
    expect(STAGE_2_EXCLUDES).toContain("database-persistence");
    expect(STAGE_2_EXCLUDES).toContain("telegram-adapters");
    expect(STAGE_2_EXCLUDES).toContain("ui-screens");
    expect(STAGE_2_EXCLUDES).toContain("rim-ai");
  });
});
