import { describe, expect, it } from "vitest";
import { MATRIX_CONTRACT_ROWS, isProductControlState, reduce } from "./index.ts";
import { fixtureForRow, kernelContext } from "./kernel.fixtures.ts";

/**
 * Reachability / selection audit only.
 * This suite proves every authoritative Matrix row can be selected and resolved.
 * It does NOT prove that applied snapshots implement Matrix product semantics.
 * Semantic correctness is covered by kernel.semantics.test.ts.
 */
describe("Stage 2 Matrix row selection (359-row reachability, not semantic proof)", () => {
  it("can select and resolve every authoritative Matrix branch under a valid fixture", () => {
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(359);
    const failures: string[] = [];
    for (const row of MATRIX_CONTRACT_ROWS) {
      const { snapshot, event } = fixtureForRow(row);
      const before = structuredClone(snapshot);
      const result = reduce(snapshot, event, kernelContext());
      if (JSON.stringify(snapshot) !== JSON.stringify(before)) {
        failures.push(`${row.id}: mutated input snapshot`);
        continue;
      }
      if (result.outcome !== "APPLIED") {
        failures.push(
          `${row.id}: expected APPLIED, got ${result.outcome} ${result.error?.code ?? ""} ${result.error?.message ?? ""}`,
        );
        continue;
      }
      if (!result.traces.some((trace) => trace.identity === row.id)) {
        failures.push(
          `${row.id}: traces were ${result.traces.map((trace) => trace.identity).join(" | ")}`,
        );
        continue;
      }
      if (result.controlState && !isProductControlState(result.controlState)) {
        failures.push(`${row.id}: non-canonical control state ${String(result.controlState)}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
