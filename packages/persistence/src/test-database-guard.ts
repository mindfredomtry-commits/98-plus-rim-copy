/**
 * Fail-closed guard for disposable PostgreSQL integration tests.
 * Test harness only — not a production runtime dependency.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Explicit test database naming policy for MVP17 isolated suites. */
const TEST_DATABASE_NAME = /^(mvp17_[a-z0-9_]*test[a-z0-9_]*|mvp17_test_[a-z0-9_]+)$/i;

const FORBIDDEN_HOST_MARKERS = [
  "railway",
  "rlwy.net",
  "railway.app",
  "amazonaws.com",
  "neon.tech",
  "supabase.co",
  "azure.com",
  "gcp.",
];

export type SafeTestDatabaseUrl = Readonly<{
  connectionString: string;
  host: string;
  port: number;
  database: string;
  user: string;
}>;

function decodeHostCandidate(raw: string): string {
  let current = raw.trim().toLowerCase();
  for (let i = 0; i < 3; i += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) {
        break;
      }
      current = decoded.trim().toLowerCase();
    } catch {
      break;
    }
  }
  if (current.startsWith("[") && current.endsWith("]")) {
    current = current.slice(1, -1);
  }
  if (current.endsWith(".")) {
    current = current.slice(0, -1);
  }
  return current;
}

function isLoopbackHost(host: string): boolean {
  const normalized = decodeHostCandidate(host);
  if (LOOPBACK_HOSTS.has(normalized)) {
    return true;
  }
  // IPv4-mapped IPv6 loopback
  if (normalized === "::ffff:127.0.0.1") {
    return true;
  }
  return false;
}

function rejectForbiddenHost(host: string): void {
  const normalized = decodeHostCandidate(host);
  for (const marker of FORBIDDEN_HOST_MARKERS) {
    if (normalized.includes(marker)) {
      throw new Error(
        `MVP17_TEST_DATABASE_URL rejected: host looks production-like (${marker})`,
      );
    }
  }
  if (!isLoopbackHost(normalized)) {
    throw new Error(
      "MVP17_TEST_DATABASE_URL rejected: host must be loopback (127.0.0.1 / ::1 / localhost)",
    );
  }
}

function parsePort(raw: string | null, fallback: number): number {
  if (raw === null || raw.length === 0) {
    return fallback;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("MVP17_TEST_DATABASE_URL rejected: malformed port");
  }
  return port;
}

/**
 * Validates an isolated integration-test database URL.
 * Never falls back to application DATABASE_URL.
 */
export function assertSafeMvp17TestDatabaseUrl(
  url: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SafeTestDatabaseUrl {
  // G6: application DATABASE_URL must never override / substitute the test URL.
  void env.DATABASE_URL;

  if (url === undefined || url.trim().length === 0) {
    throw new Error(
      "MVP17_TEST_DATABASE_URL is required for PostgreSQL integration tests; refusing to connect elsewhere",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("MVP17_TEST_DATABASE_URL rejected: malformed URL");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("MVP17_TEST_DATABASE_URL rejected: protocol must be postgres(ql)");
  }

  const host = parsed.hostname;
  if (!host) {
    throw new Error("MVP17_TEST_DATABASE_URL rejected: missing host");
  }
  rejectForbiddenHost(host);

  // Socket / host overrides that bypass URL host validation.
  const hostOverride =
    parsed.searchParams.get("host") ??
    parsed.searchParams.get("hostname") ??
    parsed.searchParams.get("hostaddr");
  if (hostOverride !== null) {
    if (hostOverride.startsWith("/") || hostOverride.includes("\\")) {
      throw new Error(
        "MVP17_TEST_DATABASE_URL rejected: Unix socket / filesystem host overrides are not allowed",
      );
    }
    rejectForbiddenHost(hostOverride);
  }

  const portOverride = parsed.searchParams.get("port");
  const port = parsePort(portOverride ?? (parsed.port || null), 5432);

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database || database.includes("/")) {
    throw new Error("MVP17_TEST_DATABASE_URL rejected: missing or ambiguous database name");
  }
  if (!TEST_DATABASE_NAME.test(database)) {
    throw new Error(
      "MVP17_TEST_DATABASE_URL rejected: database name must match the explicit mvp17_*test* policy",
    );
  }

  const user = decodeURIComponent(parsed.username);
  if (!user) {
    throw new Error("MVP17_TEST_DATABASE_URL rejected: missing database user");
  }

  return {
    connectionString: url,
    host: decodeHostCandidate(host),
    port,
    database,
    user,
  };
}

/** Disposable schema names created by MVP17 integration harnesses. */
export function assertMvp17TestSchemaName(schema: string): void {
  if (!/^mvp17_[0-9a-f]+$/.test(schema)) {
    throw new Error("refusing to interpolate an unexpected schema name");
  }
}

/**
 * After connecting, confirm the live session still matches the validated target.
 * Call before CREATE SCHEMA / migrations / writes.
 */
export async function assertConnectedTestDatabase(
  query: (sql: string, params?: readonly unknown[]) => Promise<{
    rows: ReadonlyArray<Record<string, unknown>>;
  }>,
  expected: SafeTestDatabaseUrl,
): Promise<void> {
  const result = await query(
    `SELECT current_database() AS database,
            inet_server_addr() AS addr,
            inet_server_port() AS port,
            current_user AS db_user`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("MVP17 test database identity probe returned no rows");
  }
  if (String(row.database) !== expected.database) {
    throw new Error("MVP17 test database identity mismatch: database name");
  }
  if (String(row.db_user) !== expected.user) {
    throw new Error("MVP17 test database identity mismatch: user");
  }
  const addr = row.addr === null || row.addr === undefined ? null : String(row.addr);
  // Inside Docker, inet_server_addr may be the container bridge IP; host-side URL must still be loopback.
  if (addr !== null && !isLoopbackHost(addr) && addr !== "") {
    // Server-reported address inside the container network is acceptable when the
    // client URL was already validated as loopback-bound. Reject only if it looks hosted.
    for (const marker of FORBIDDEN_HOST_MARKERS) {
      if (addr.includes(marker)) {
        throw new Error("MVP17 test database identity mismatch: production-like server address");
      }
    }
  }
}
