import { readFileSync } from "node:fs";

export class PersistenceConfigError extends Error {
  readonly code = "PERSISTENCE_CONFIG" as const;

  constructor(message: string) {
    super(message);
    this.name = "PersistenceConfigError";
  }
}

export type PostgresSslConfig = false | Readonly<{ rejectUnauthorized: true; ca?: string }>;

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

const TLS_QUERY_KEYS = ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey"] as const;

function assertConnectionStringLeavesTlsToApp(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new PersistenceConfigError("DATABASE_URL is invalid");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new PersistenceConfigError("DATABASE_URL is invalid");
  }
  if (TLS_QUERY_KEYS.some((key) => url.searchParams.has(key))) {
    throw new PersistenceConfigError(
      "DATABASE_URL must not set sslmode, ssl, sslrootcert, sslcert, or sslkey",
    );
  }
}

function certificatePem(value: string): string {
  const inline = value.includes("-----BEGIN CERTIFICATE-----");
  let pem = value;
  if (!inline) {
    try {
      pem = readFileSync(value, "utf8");
    } catch {
      throw new PersistenceConfigError("DATABASE_SSL_CA could not be read");
    }
  }
  if (pem.includes("PRIVATE KEY")) {
    throw new PersistenceConfigError("DATABASE_SSL_CA must be a certificate, not a private key");
  }
  if (!/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(pem)) {
    throw new PersistenceConfigError("DATABASE_SSL_CA must be a PEM certificate");
  }
  return pem;
}

function sslConfig(
  env: NodeJS.ProcessEnv,
  connectionString: string,
): PostgresSslConfig | undefined {
  const raw = env.DATABASE_SSL?.trim() ?? "";
  const caValue = env.DATABASE_SSL_CA?.trim() ?? "";
  if (caValue.length > 0 && raw !== "require") {
    throw new PersistenceConfigError("DATABASE_SSL_CA requires DATABASE_SSL=require");
  }
  if (raw.length === 0) {
    return undefined;
  }
  assertConnectionStringLeavesTlsToApp(connectionString);
  if (raw === "disable") {
    return false;
  }
  if (raw === "require") {
    if (caValue.length === 0) {
      return { rejectUnauthorized: true };
    }
    return { rejectUnauthorized: true, ca: certificatePem(caValue) };
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
  const ssl = sslConfig(env, connectionString);
  return {
    mode: "postgres",
    connectionString,
    ...(ssl === undefined ? {} : { ssl }),
    ...(max === undefined ? {} : { max }),
  };
}
