import { describe, expect, it } from "vitest";
import { MemorySqlClient } from "./memory-sql.ts";
import {
  bindSqlParams,
  normalizeDriverRows,
  openPostgresPersistence,
  redactConnectionString,
} from "./postgres-client.ts";
import { SQL } from "./sql.ts";

describe("PostgreSQL client contract helpers", () => {
  it("does not connect when the module is imported or a pool is constructed", async () => {
    const connectionString = "postgres://mvp17:unit-test-secret@127.0.0.1:1/none";
    const db = openPostgresPersistence({ connectionString });
    expect(db.stats()).toEqual({ total: 0, idle: 0, waiting: 0 });
    await db.close();
  });

  it("binds an empty JavaScript array as a text array literal", () => {
    expect(bindSqlParams([[], ["user-1"], null, "ok"])).toEqual(["{}", ["user-1"], null, "ok"]);
  });

  it("normalizes int8 strings that fit a safe integer and leaves other values alone", () => {
    const normalized = normalizeDriverRows<{ created_seq: number | string; label: string }>({
      fields: [
        { name: "created_seq", dataTypeID: 20 },
        { name: "label", dataTypeID: 25 },
      ] as never,
      rows: [
        { created_seq: "42", label: "42" },
        { created_seq: "9007199254740993", label: "big" },
      ],
    });
    expect(normalized[0]).toEqual({ created_seq: 42, label: "42" });
    expect(normalized[1]?.created_seq).toBe("9007199254740993");
  });

  it("removes a connection string and its password from a thrown error", () => {
    const connectionString = "postgres://mvp17:unit-test-secret@127.0.0.1:1/none";
    const error = new Error(`failed ${connectionString} password unit-test-secret`);
    error.stack = `stack ${connectionString}`;
    redactConnectionString(error, connectionString);
    expect(error.message).toBe("failed [redacted] password [redacted]");
    expect(error.stack).not.toContain("unit-test-secret");
    expect(error.stack).toContain("[redacted]");
  });

  it("serves identity lookup SQL from MemorySqlClient without inserting", async () => {
    const sql = new MemorySqlClient();
    await sql.query(SQL.insertIdentity, ["user-1", "tg-1"]);
    const byTelegram = await sql.query(SQL.selectIdentityByTelegramUserId, ["tg-1"]);
    expect(byTelegram.rows).toEqual([{ user_id: "user-1", telegram_user_id: "tg-1" }]);
    const missing = await sql.query(SQL.selectIdentityByTelegramUserId, ["missing"]);
    expect(missing.rows).toEqual([]);
    const selected = await sql.query(SQL.selectIdentitiesByUserIds, [["user-1", "absent"]]);
    expect(selected.rows).toEqual([{ user_id: "user-1", telegram_user_id: "tg-1" }]);
    const none = await sql.query(SQL.selectIdentitiesByUserIds, [[]]);
    expect(none.rows).toEqual([]);
    const all = await sql.query(SQL.selectAllIdentities, []);
    expect(all.rows).toEqual([{ user_id: "user-1", telegram_user_id: "tg-1" }]);
  });
});
