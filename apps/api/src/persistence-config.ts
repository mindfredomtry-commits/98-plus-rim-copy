export class PersistenceConfigError extends Error {
  readonly code = "PERSISTENCE_CONFIG" as const;

  constructor(message: string) {
    super(message);
    this.name = "PersistenceConfigError";
  }
}

export type PostgresSslConfig = false | Readonly<{ rejectUnauthorized: true }>;

export type PersistenceConfig =
  | Readonly<{ mode: "memory" }>
  | Readonly<{
      mode: "postgres";
      connectionString: string;
      ssl?: PostgresSslConfig;
      max?: number;
    }>;

function invalidModeMessage(value: string): string {
  if (value.length === 0) {
    return "PERSISTENCE_MODE must be memory or postgres";
  }
  if (value.includes("://") || value.length > 32) {
    return "PERSISTENCE_MODE is invalid";
  }
  return `PERSISTENCE_MODE must be memory or postgres (received ${value})`;
}

function poolMax(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.DATABASE_POOL_MAX?.trim() ?? "";
  if (raw.length === 0) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new PersistenceConfigError("DATABASE_POOL_MAX must be a positive integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new PersistenceConfigError("DATABASE_POOL_MAX must be a positive integer");
  }
  return value;
}

function sslConfig(env: NodeJS.ProcessEnv): PostgresSslConfig | undefined {
  const raw = env.DATABASE_SSL?.trim() ?? "";
  if (raw.length === 0) {
    return undefined;
  }
  if (raw === "disable") {
    return false;
  }
  if (raw === "require") {
    return { rejectUnauthorized: true };
  }
  throw new PersistenceConfigError("DATABASE_SSL must be disable or require");
}

/**
 * Explicit persistence selection.
 * Missing and unknown modes fail. Postgres mode requires DATABASE_URL.
 * There is no fallback from postgres to memory.
 */
export function loadPersistenceConfig(env: NodeJS.ProcessEnv = process.env): PersistenceConfig {
  const mode = env.PERSISTENCE_MODE?.trim() ?? "";
  if (mode === "memory") {
    return { mode: "memory" };
  }
  if (mode !== "postgres") {
    throw new PersistenceConfigError(invalidModeMessage(mode));
  }
  const connectionString = env.DATABASE_URL?.trim() ?? "";
  if (connectionString.length === 0) {
    throw new PersistenceConfigError("DATABASE_URL is required when PERSISTENCE_MODE=postgres");
  }
  const max = poolMax(env);
  const ssl = sslConfig(env);
  return {
    mode: "postgres",
    connectionString,
    ...(ssl === undefined ? {} : { ssl }),
    ...(max === undefined ? {} : { max }),
  };
}
