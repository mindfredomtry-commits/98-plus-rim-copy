import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IDENTITY_STAGE } from "@98plus/identity";
import { PERSISTENCE_STAGE } from "@98plus/persistence";
import {
  CANONICAL_EVENT_COUNT,
  IMPLEMENTATION_STAGE,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
} from "@98plus/product-model";
import { APPLICATION_STAGE, STAGE_5_EXCLUDES } from "./stage.ts";

describe("Stage 5 boundary", () => {
  it("marks application orchestration as Stage 5 without relabeling frozen layers", () => {
    expect(APPLICATION_STAGE).toBe(5);
    expect(IMPLEMENTATION_STAGE).toBe(2);
    expect(IDENTITY_STAGE).toBe(3);
    expect(PERSISTENCE_STAGE).toBe(4);
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(57);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(342);
    expect(STAGE_5_EXCLUDES).toContain("openai");
    expect(STAGE_5_EXCLUDES).toContain("telegram-adapters");
    expect(STAGE_5_EXCLUDES).toContain("external-entry");
    expect(STAGE_5_EXCLUDES).toContain("ui-screens");
  });
});

function walkTs(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTs(path));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test-d.ts")
    ) {
      files.push(path);
    }
  }
  return files;
}

describe("Stage 5 does not duplicate product behavior", () => {
  it("does not create Ban/Timer/Check/Notification facts itself", () => {
    for (const file of walkTs(join(dirname(fileURLToPath(import.meta.url))))) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("UPSERT_BAN");
      expect(source).not.toContain("UPSERT_DOMAIN_TIMER");
      expect(source).not.toContain("UPSERT_CHECK_PAIR");
      expect(source).not.toContain("UPSERT_NOTIFICATION_ITEM");
      expect(source).not.toMatch(/from ["']@98plus\/persistence["'].*PersistenceTestKit/);
      expect(source).not.toContain("PersistenceTestKit");
    }
  });

  it("does not import Matrix rows or implement reduce", () => {
    const execute = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "execute.ts"),
      "utf8",
    );
    expect(execute).toContain("reduce(");
    expect(execute).not.toContain("MATRIX_CONTRACT_ROWS");
    expect(execute).not.toContain("evaluateRowGuard");
    expect(execute).not.toContain("registerIdentityUser");
    expect(execute).not.toContain("ensureIdentityUser");
    expect(execute).not.toContain("resolveByTelegramUserId");
  });
});
