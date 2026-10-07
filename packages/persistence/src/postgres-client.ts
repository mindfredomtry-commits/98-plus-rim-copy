import { Pool, type PoolClient, type PoolConfig, type QueryResult } from "pg";
import { allMigrationSql } from "./migrations.ts";
import type { PersistenceSqlClient } from "./types.ts";
import type { SqlQueryResult } from "@98plus/identity";

const INT8_OID = 20;

/**
 * Explicit Postgres pool configuration.
 * Construction does not connect. Production main does not call this.
 * `max` is optional so MVP18 can size the pool; node-postgres supplies its own
 * default when max is omitted.
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
  applyMigrations(): Promise<void>;
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

export function redactConnectionString(error: unknown, connectionString: string): unknown {
  if (!(error instanceof Error) || connectionString.length === 0) {
    return error;
  }
  if (error.message.includes(connectionString)) {
    error.message = error.message.replaceAll(connectionString, "[redacted]");
  }
  if (error.stack?.includes(connectionString)) {
    error.stack = error.stack.replaceAll(connectionString, "[redacted]");
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
