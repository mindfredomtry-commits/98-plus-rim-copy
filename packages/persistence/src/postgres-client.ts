import { Pool, type PoolClient, type PoolConfig, type QueryResult } from "pg";
import type { SqlQueryResult } from "@98plus/identity";
import { allMigrationSql, canonicalMigrationScripts } from "./migrations.ts";
import {
  runProductionMigrations,
  type MigrationScript,
  type ProductionMigrationReport,
} from "./production-migrations.ts";
import type { PersistenceSqlClient } from "./types.ts";

const INT8_OID = 20;

/**
 * Explicit Postgres pool configuration.
 * Construction does not connect. `max` is optional. When it is omitted,
 * node-postgres uses its driver default. That default is not a capacity decision.
 */
export type PostgresPoolConfig = Readonly<{
  connectionString: string;
  max?: number;
  ssl?: PoolConfig["ssl"];
  options?: string;
  connectionTimeoutMillis?: number;
}>;

export type PostgresPoolStats = Readonly<{
  total: number;
  waiting: number;
  idle: number;
}>;

export type PostgresPersistence = Readonly<{
  sql: PersistenceSqlClient;
  /** Test harness. Replays every canonical script and does not record history. */
  applyMigrations(): Promise<void>;
  /**
   * Production runner. Applies canonical migrations 001–012 once, recording
   * schema_migrations. Does not fall back to any other store.
   */
  migrate(options?: {
    readonly migrations?: readonly MigrationScript[];
  }): Promise<ProductionMigrationReport>;
  close(): Promise<void>;
  stats(): PostgresPoolStats;
}>;

export function bindSqlParams(params: readonly unknown[]): unknown[] {
  return params.map((param) => (Array.isArray(param) && param.length === 0 ? "{}" : param));
}

export function normalizeDriverRows<T>(result: Pick<QueryResult, "fields" | "rows">): T[] {
  const int8Fields = result.fields.filter((field) => field.dataTypeID === INT8_OID);
  if (int8Fields.length === 0) {
    return result.rows as T[];
  }
  return result.rows.map((row: Record<string, unknown>) => {
    const copy: Record<string, unknown> = { ...row };
    for (const field of int8Fields) {
      const value = copy[field.name];
      if (typeof value !== "string") {
        continue;
      }
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) {
        copy[field.name] = parsed;
      }
    }
    return copy as T;
  });
}

function connectionPassword(connectionString: string): string | null {
  try {
    const password = new URL(connectionString).password;
    if (password.length < 4) {
      return null;
    }
    return decodeURIComponent(password);
  } catch {
    return null;
  }
}

export function redactConnectionString(error: unknown, connectionString: string): unknown {
  if (!(error instanceof Error) || connectionString.length === 0) {
    return error;
  }
  const password = connectionPassword(connectionString);
  const redact = (value: string): string => {
    let next = value;
    if (connectionString.length > 0 && next.includes(connectionString)) {
      next = next.replaceAll(connectionString, "[redacted]");
    }
    if (password !== null && password.length >= 4 && next.includes(password)) {
      next = next.replaceAll(password, "[redacted]");
    }
    return next;
  };
  error.message = redact(error.message);
  if (error.stack !== undefined) {
    error.stack = redact(error.stack);
  }
  return error;
}

function poolConfig(config: PostgresPoolConfig): PoolConfig {
  const next: PoolConfig = { connectionString: config.connectionString };
  if (config.max !== undefined) {
    next.max = config.max;
  }
  if (config.ssl !== undefined) {
    next.ssl = config.ssl;
  }
  if (config.options !== undefined) {
    next.options = config.options;
  }
  if (config.connectionTimeoutMillis !== undefined) {
    next.connectionTimeoutMillis = config.connectionTimeoutMillis;
  }
  return next;
}

class BoundPostgresSqlClient implements PersistenceSqlClient {
  private savepoint = 0;

  constructor(
    private readonly connection: PoolClient,
    private readonly connectionString: string,
  ) {}

  async query<T>(sql: string, params: readonly unknown[]): Promise<SqlQueryResult<T>> {
    try {
      const result = await this.connection.query(sql, bindSqlParams(params));
      return { rows: normalizeDriverRows<T>(result) };
    } catch (error) {
      throw redactConnectionString(error, this.connectionString);
    }
  }

  async transaction<T>(fn: (tx: PersistenceSqlClient) => Promise<T>): Promise<T> {
    const name = `sp_${++this.savepoint}`;
    await this.connection.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn(this);
      await this.connection.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await this.connection.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
      throw redactConnectionString(error, this.connectionString);
    }
  }
}

function createPoolSqlClient(pool: Pool, connectionString: string): PersistenceSqlClient {
  return {
    async query<T>(sql: string, params: readonly unknown[]): Promise<SqlQueryResult<T>> {
      try {
        const result = await pool.query(sql, bindSqlParams(params));
        return { rows: normalizeDriverRows<T>(result) };
      } catch (error) {
        throw redactConnectionString(error, connectionString);
      }
    },
    async transaction<T>(fn: (tx: PersistenceSqlClient) => Promise<T>): Promise<T> {
      const connection = await pool.connect();
      const bound = new BoundPostgresSqlClient(connection, connectionString);
      try {
        await connection.query("BEGIN");
        try {
          const result = await fn(bound);
          await connection.query("COMMIT");
          return result;
        } catch (error) {
          await connection.query("ROLLBACK").catch(() => undefined);
          throw redactConnectionString(error, connectionString);
        }
      } finally {
        connection.release();
      }
    },
  };
}

export function openPostgresPersistence(config: PostgresPoolConfig): PostgresPersistence {
  const pool = new Pool(poolConfig(config));
  const connectionString = config.connectionString;
  return {
    sql: createPoolSqlClient(pool, connectionString),
    async applyMigrations(): Promise<void> {
      const connection = await pool.connect();
      try {
        await connection.query("BEGIN");
        try {
          for (const script of allMigrationSql()) {
            await connection.query(script);
          }
          await connection.query("COMMIT");
        } catch (error) {
          await connection.query("ROLLBACK").catch(() => undefined);
          throw redactConnectionString(error, connectionString);
        }
      } finally {
        connection.release();
      }
    },
    async migrate(options?: {
      readonly migrations?: readonly MigrationScript[];
    }): Promise<ProductionMigrationReport> {
      const connection = await pool.connect();
      const session = {
        async query<T>(
          sql: string,
          params: readonly unknown[] = [],
        ): Promise<{ readonly rows: T[] }> {
          try {
            const result = await connection.query(sql, [...params]);
            return { rows: result.rows as T[] };
          } catch (error) {
            throw redactConnectionString(error, connectionString);
          }
        },
      };
      try {
        return await runProductionMigrations(
          session,
          options?.migrations ?? canonicalMigrationScripts(),
        );
      } finally {
        connection.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
    stats(): PostgresPoolStats {
      return {
        total: pool.totalCount,
        waiting: pool.waitingCount,
        idle: pool.idleCount,
      };
    },
  };
}
