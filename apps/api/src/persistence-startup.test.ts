import { afterEach, describe, expect, it } from "vitest";
import { MemorySqlClient, openPostgresPersistence } from "@98plus/persistence";
import { loadPersistenceConfig, PersistenceConfigError } from "./persistence-config.ts";
import { createCreateBanContactRuntime } from "./runtime.ts";
import { startApiProcess } from "./start.ts";

const SECRET = "supersecretpassword";

describe("persistence mode selection", () => {
  const running: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    while (running.length > 0) {
      await running.pop()?.close();
    }
  });

  it("accepts memory and postgres config without echoing secrets", () => {
    expect(loadPersistenceConfig({ PERSISTENCE_MODE: "memory", DATABASE_URL: SECRET }).mode).toBe(
      "memory",
    );
    const postgres = loadPersistenceConfig({
      PERSISTENCE_MODE: "postgres",
      DATABASE_URL: `postgres://mvp17:${SECRET}@127.0.0.1:5432/app`,
      DATABASE_SSL: "require",
      DATABASE_POOL_MAX: "4",
    });
    expect(postgres).toEqual({
      mode: "postgres",
      connectionString: `postgres://mvp17:${SECRET}@127.0.0.1:5432/app`,
      ssl: { rejectUnauthorized: true },
      max: 4,
    });
    expect(
      loadPersistenceConfig({ PERSISTENCE_MODE: "postgres", DATABASE_URL: "postgres://db" }),
    ).toEqual({ mode: "postgres", connectionString: "postgres://db" });
    expect(
      loadPersistenceConfig({
        PERSISTENCE_MODE: "postgres",
        DATABASE_URL: "postgres://db",
        DATABASE_SSL: "disable",
      }),
    ).toEqual({
      mode: "postgres",
      connectionString: "postgres://db",
      ssl: false,
    });
  });

  it("rejects a missing mode, an invalid mode, and postgres without DATABASE_URL", () => {
    expect(() => loadPersistenceConfig({})).toThrow(PersistenceConfigError);
    expect(() => loadPersistenceConfig({ PERSISTENCE_MODE: "sqlite" })).toThrow(/received sqlite/);
    expect(() =>
      loadPersistenceConfig({ PERSISTENCE_MODE: `postgres://mvp17:${SECRET}@db` }),
    ).toThrow(/^PERSISTENCE_MODE is invalid$/);
    try {
      loadPersistenceConfig({ PERSISTENCE_MODE: `postgres://mvp17:${SECRET}@db` });
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain(SECRET);
    }
    expect(() => loadPersistenceConfig({ PERSISTENCE_MODE: "postgres" })).toThrow(
      /DATABASE_URL is required/,
    );
    expect(() =>
      loadPersistenceConfig({
        PERSISTENCE_MODE: "postgres",
        DATABASE_URL: "postgres://db",
        DATABASE_SSL: "prefer",
      }),
    ).toThrow(/DATABASE_SSL must be disable or require/);
    expect(() =>
      loadPersistenceConfig({
        PERSISTENCE_MODE: "postgres",
        DATABASE_URL: "postgres://db",
        DATABASE_POOL_MAX: "0",
      }),
    ).toThrow(/DATABASE_POOL_MAX must be a positive integer/);
  });

  it("refuses to mix memory and postgres clients", async () => {
    expect(() =>
      createCreateBanContactRuntime({
        persistence: "postgres",
        sql: new MemorySqlClient(),
      }),
    ).toThrow(/cannot use MemorySqlClient/);
    const db = openPostgresPersistence({
      connectionString: `postgres://mvp17:${SECRET}@127.0.0.1:1/none`,
    });
    try {
      expect(() => createCreateBanContactRuntime({ persistence: "memory", sql: db.sql })).toThrow(
        /cannot use a PostgreSQL client/,
      );
    } finally {
      await db.close();
    }
  });

  it("starts memory mode on purpose and does not read DATABASE_URL", async () => {
    const lines: string[] = [];
    const api = await startApiProcess({
      env: {
        PERSISTENCE_MODE: "memory",
        DATABASE_URL: `postgres://mvp17:${SECRET}@127.0.0.1:1/none`,
      },
      host: "127.0.0.1",
      port: 0,
      log: (line) => lines.push(line),
    });
    running.push(api);
    expect(api.mode).toBe("memory");
    expect(api.runtime.persistenceMode).toBe("memory");
    expect(api.runtime.sql).toBeInstanceOf(MemorySqlClient);
    const body = await (await fetch(`${api.url}/api/meta`)).json();
    expect(body.PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    const text = lines.join("\n");
    expect(text).toContain("persistence=memory (volatile; lost on restart)");
    expect(text).toContain("topology=API replicas MUST equal 1 until MVP17-DC-02 is resolved");
    expect(text).not.toContain(SECRET);
    await api.close();
    await expect(fetch(`${api.url}/api/meta`)).rejects.toThrow();
  });

  it("does not fall back to memory when postgres is selected and the server is unreachable", async () => {
    const lines: string[] = [];
    await expect(
      startApiProcess({
        env: {
          PERSISTENCE_MODE: "postgres",
          DATABASE_URL: `postgres://mvp17:${SECRET}@127.0.0.1:1/none`,
        },
        host: "127.0.0.1",
        port: 0,
        log: (line) => lines.push(line),
        postgres: { connectionTimeoutMillis: 400, max: 1 },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      return message.length > 0 && !message.includes(SECRET) && !message.includes("not a function");
    });
    const text = lines.join("\n");
    expect(text).not.toContain("persistence=memory");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("listening");
  });
});
