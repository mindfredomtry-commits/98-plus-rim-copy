import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_EVENT_COUNT,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
} from "./index.ts";
import type { BanAcceptance } from "./entities.ts";
import type { UserId } from "./ids.ts";
import { CONTACT_A } from "./kernel.fixtures.ts";

const ACCEPTANCE_VALUES = ["PENDING", "ACCEPTED"] as const satisfies readonly BanAcceptance[];
const SRC = dirname(fileURLToPath(import.meta.url));

function readSrc(relative: string): string {
  return readFileSync(join(SRC, relative), "utf8");
}

describe("pre-Stage 4 persistence-boundary contracts", () => {
  it("canonical BanAcceptance is only PENDING and ACCEPTED", () => {
    expect(ACCEPTANCE_VALUES).toEqual(["PENDING", "ACCEPTED"]);
    const acceptance: BanAcceptance = "PENDING";
    expect(ACCEPTANCE_VALUES).toContain(acceptance);
  });

  it("treats selectedContact as a registered UserId", () => {
    const selected: UserId = CONTACT_A;
    expect(selected).toBe(CONTACT_A);
  });

  it("kernel instantiate never writes Ban.acceptance OVERBOARD", () => {
    const instantiate = readSrc("kernel/instantiate.ts");
    expect(instantiate).toContain('acceptance: "PENDING", status: "OVERBOARD"');
    expect(instantiate).not.toMatch(/acceptance:\s*"OVERBOARD"/);
  });

  it("does not cast ContactId to UserId on the CONTACT identity path", () => {
    expect(readSrc("kernel/instantiate.ts")).not.toMatch(/contactAsUser/);
    expect(readSrc("kernel/effects.ts")).not.toMatch(/contactAsUser|function asUserId/);
    expect(readSrc("ids.ts")).not.toMatch(/type ContactId/);
    expect(readSrc("kernel/instantiate.ts")).toContain("receiverId: draft.selectedContactId");
  });

  it("keeps 30 states, 57 events, and 342 Matrix rules", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(57);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(342);
  });
});
