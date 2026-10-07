import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresIdentityStore, asTelegramUserId } from "@98plus/identity";
import {
  MemorySqlClient,
  openPostgresPersistence,
  PostgresProductStore,
  type PostgresPersistence,
} from "@98plus/persistence";
import { startApiProcess, type RunningApi } from "./start.ts";

const databaseUrl = process.env.MVP17_TEST_DATABASE_URL;
const SECRET = "startup-secret-value";

function assertSchemaName(schema: string): void {
  if (!/^mvp17_[0-9a-f]+$/.test(schema)) {
    throw new Error("refusing to interpolate an unexpected schema name");
  }
}

function openAdmin(): PostgresPersistence {
  if (!databaseUrl) {
    throw new Error("MVP17_TEST_DATABASE_URL is required");
  }
  return openPostgresPersistence({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
}

describe.skipIf(!databaseUrl)("postgres production startup", () => {
  const schemas: string[] = [];
  const running: RunningApi[] = [];

  afterAll(async () => {
    for (const api of running) {
      await api.close();
    }
    const admin = openAdmin();
    try {
      for (const schema of schemas) {
        assertSchemaName(schema);
        await admin.sql.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
      }
    } finally {
      await admin.close();
    }
  });

  async function schema(): Promise<string> {
    const name = `mvp17_${randomUUID().replaceAll("-", "")}`;
    schemas.push(name);
    const admin = openAdmin();
    try {
      assertSchemaName(name);
      await admin.sql.query(`CREATE SCHEMA ${name}`, []);
    } finally {
      await admin.close();
    }
    return name;
  }

  function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      PERSISTENCE_MODE: "postgres",
      DATABASE_URL: databaseUrl ?? "",
      ...extra,
    };
  }

  it("migrates, listens, serves one postgres runtime, and closes the pool", async () => {
    const name = await schema();
    const lines: string[] = [];
    const api = await startApiProcess({
      env: env(),
      host: "127.0.0.1",
      port: 0,
      log: (line) => lines.push(line),
      postgres: { max: 2, options: `-c search_path=${name}`, connectionTimeoutMillis: 5_000 },
    });
    running.push(api);
    expect(api.mode).toBe("postgres");
    expect(api.runtime.persistenceMode).toBe("postgres");
    expect(api.runtime.sql).not.toBeInstanceOf(MemorySqlClient);
    expect(api.runtime.identityStore).toBeInstanceOf(PostgresIdentityStore);
    expect(api.runtime.productStore).toBeInstanceOf(PostgresProductStore);
    const meta = await (await fetch(`${api.url}/api/meta`)).json();
    expect(meta.PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(meta.CANONICAL_EVENT_COUNT).toBe(60);
    expect(meta.MATRIX_RULE_COUNT).toBe(360);
    const text = lines.join("\n");
    expect(text).toContain("persistence=postgres");
    expect(text).toContain("poolMax=driver-default");
    expect(text).toContain("topology=API replicas MUST equal 1 until MVP17-DC-02 is resolved");
    expect(text).not.toContain("mvp17test");
    expect(text).not.toContain(databaseUrl ?? "postgres://");
    const user = await api.runtime.identityStore.resolveByTelegramUserId(asTelegramUserId("5252"));
    const opened = await api.runtime.productStore.loadProductSnapshot(user.userId);
    expect(opened.snapshot.controlState).toBeNull();
    await api.close();
    await expect(api.runtime.productStore.loadProductSnapshot(user.userId)).rejects.toThrow();
    await expect(fetch(`${api.url}/api/meta`)).rejects.toThrow();
  }, 30_000);

  it("does not listen when migration history is impossible", async () => {
    const name = await schema();
    const admin = openPostgresPersistence({
      connectionString: databaseUrl ?? "",
      max: 1,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${name}`,
    });
    try {
      await admin.migrate();
      await admin.sql.query(
        "INSERT INTO schema_migrations (version) VALUES ('packages/persistence/schema/999_future.sql')",
        [],
      );
    } finally {
      await admin.close();
    }
    const lines: string[] = [];
    await expect(
      startApiProcess({
        env: env(),
        host: "127.0.0.1",
        port: 0,
        log: (line) => lines.push(line),
        postgres: { max: 1, options: `-c search_path=${name}`, connectionTimeoutMillis: 5_000 },
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_HISTORY" });
    expect(lines.join("\n")).not.toContain("listening");
  }, 30_000);

  it("rejects a bad password without logging it and does not start memory", async () => {
    const lines: string[] = [];
    const url = new URL(databaseUrl ?? "postgres://postgres:mvp17test@127.0.0.1:55432/mvp17");
    url.password = SECRET;
    await expect(
      startApiProcess({
        env: { PERSISTENCE_MODE: "postgres", DATABASE_URL: url.toString() },
        host: "127.0.0.1",
        port: 0,
        log: (line) => lines.push(line),
        postgres: { connectionTimeoutMillis: 5_000, max: 1 },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      return message.length > 0 && !message.includes(SECRET) && !message.includes("not a function");
    });
    const text = lines.join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("persistence=memory");
    expect(text).not.toContain("listening");
  }, 30_000);

  it("fails a later query when the schema disappears and stays on postgres", async () => {
    const name = await schema();
    const api = await startApiProcess({
      env: env(),
      host: "127.0.0.1",
      port: 0,
      log: () => undefined,
      postgres: { max: 2, options: `-c search_path=${name}`, connectionTimeoutMillis: 5_000 },
    });
    running.push(api);
    const admin = openAdmin();
    try {
      assertSchemaName(name);
      await admin.sql.query(`DROP SCHEMA ${name} CASCADE`, []);
    } finally {
      await admin.close();
    }
    await expect(
      api.runtime.identityStore.resolveByTelegramUserId(asTelegramUserId("6262")),
    ).rejects.toThrow();
    expect(api.runtime.persistenceMode).toBe("postgres");
    expect(api.runtime.sql).not.toBeInstanceOf(MemorySqlClient);
  }, 30_000);
});
