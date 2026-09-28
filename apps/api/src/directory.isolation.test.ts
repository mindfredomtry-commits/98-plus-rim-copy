import { describe, expect, it } from "vitest";
import { MemorySqlClient } from "@98plus/persistence";
import type { Ban, DurationMinutes, UserId } from "@98plus/product-model";
import { MemorySqlRegisteredUserDirectory } from "./directory.ts";
import { TestOnlyRegisteredUserDirectory } from "./seed-contact.ts";

const A = "user-a" as UserId;
const B = "user-b" as UserId;

function seedUsers(sql: MemorySqlClient): void {
  sql.tables.registerIdentityUser(A, "1001");
  sql.tables.registerIdentityUser(B, "1002");
}

describe("Stage 13B Contact directory isolation", () => {
  it("production MemorySqlRegisteredUserDirectory has no grant API and ignores grants", async () => {
    const sql = new MemorySqlClient();
    seedUsers(sql);
    const directory = new MemorySqlRegisteredUserDirectory(sql);

    expect("grantTestContactPair" in directory).toBe(false);
    expect(typeof (directory as { grantTestContactPair?: unknown }).grantTestContactPair).toBe(
      "undefined",
    );
    expect(await directory.listSelectableContacts(A)).toEqual([]);

    const testOnly = new TestOnlyRegisteredUserDirectory(sql);
    testOnly.grantTestContactPair(A, B);
    expect(await testOnly.listSelectableContacts(A)).toEqual([
      { userId: B, telegramUserId: "1002" },
    ]);
    // Separate production instance over the same SQL still Ban-only.
    expect(await directory.listSelectableContacts(A)).toEqual([]);
  });

  it("production directory exposes Contacts only from authoritative Ban facts", async () => {
    const sql = new MemorySqlClient();
    seedUsers(sql);
    const directory = new MemorySqlRegisteredUserDirectory(sql);
    const ban: Ban = {
      id: "ban-1" as Ban["id"],
      senderId: A,
      receiverId: B,
      banText: "x",
      durationMinutes: 10 as DurationMinutes,
      acceptance: "PENDING",
      status: null,
      boundViaTelegramShareLink: false,
      sourceProposalId: null,
    };
    sql.tables.upsertBan(ban);
    expect(await directory.listSelectableContacts(A)).toEqual([
      { userId: B, telegramUserId: "1002" },
    ]);
    expect(await directory.listSelectableContacts(B)).toEqual([
      { userId: A, telegramUserId: "1001" },
    ]);
  });
});
