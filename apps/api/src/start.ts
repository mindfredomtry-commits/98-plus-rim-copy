import { releaseTrackedRimOwnershipForShutdown } from "@98plus/application";
import {
  MemorySqlClient,
  openPostgresPersistence,
  redactConnectionString,
  type PostgresPersistence,
  type PersistenceSqlClient,
} from "@98plus/persistence";
import { listenCreateBanContactServer } from "./http.ts";
import { loadPersistenceConfig, type PersistenceConfig } from "./persistence-config.ts";
import {
  createCreateBanContactRuntime,
  DEFAULT_DEV_AUTH_SECRET,
  DEFAULT_TEST_TELEGRAM_USERS,
  type CreateBanContactRuntime,
} from "./runtime.ts";

export type StartApiOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  handleSignals?: boolean;
  port?: number;
  host?: string;
  log?: (line: string) => void;
  /** Test-only pool settings. Production leaves pool max to config or the driver. */
  postgres?: Readonly<{
    max?: number;
    options?: string;
    connectionTimeoutMillis?: number;
  }>;
}>;

export type RunningApi = Readonly<{
  mode: "memory" | "postgres";
  runtime: CreateBanContactRuntime;
  url: string;
  close: () => Promise<void>;
}>;

function isProductionRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" || env.APP_ENV === "production";
}

function runtimeEnvForStart(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (isProductionRuntime(env)) {
    return env;
  }
  return {
    ...env,
    NODE_ENV: env.NODE_ENV ?? "development",
    APP_ENV: env.APP_ENV ?? "development",
    IDENTITY_ALLOW_DEV_AUTH: env.IDENTITY_ALLOW_DEV_AUTH ?? "true",
    IDENTITY_DEV_AUTH_SECRET: env.IDENTITY_DEV_AUTH_SECRET ?? DEFAULT_DEV_AUTH_SECRET,
  };
}

function writeStartupLog(
  log: (line: string) => void,
  input: {
    readonly host: string;
    readonly port: number;
    readonly url: string;
    readonly runtime: CreateBanContactRuntime;
    readonly env: NodeJS.ProcessEnv;
    readonly config: PersistenceConfig;
  },
): void {
  const authMode = input.runtime.config.allowDevelopmentAuth
    ? "development-auth-enabled"
    : "telegram-initData-only";
  const tokenStatus = input.env.TELEGRAM_BOT_TOKEN?.trim() ? "configured" : "missing";
  const usernameStatus = input.env.TELEGRAM_BOT_USERNAME?.trim() ? "configured" : "missing";
  const rimProviderLine =
    input.runtime.rimProvider === "openai"
      ? `RIM provider: openai model=${input.runtime.rimModel ?? ""}`
      : "RIM provider: fake";
  const persistenceLine =
    input.config.mode === "memory"
      ? "persistence=memory (volatile; lost on restart)"
      : "persistence=postgres";
  const poolLine =
    input.config.mode === "postgres"
      ? input.config.max === undefined
        ? "poolMax=driver-default"
        : `poolMax=${input.config.max}`
      : null;
  log(
    [
      "98+ TEST UI — temporary Stage 11 Telegram verification host",
      `listening ${input.host}:${input.port} (local url ${input.url})`,
      `auth=${authMode}`,
      rimProviderLine,
      `TELEGRAM_BOT_TOKEN=${tokenStatus}`,
      `TELEGRAM_BOT_USERNAME=${usernameStatus}`,
      persistenceLine,
      ...(poolLine === null ? [] : [poolLine]),
      "topology=API replicas MUST equal 1 until MVP17-DC-02 is resolved",
      "surface=TEST UI (not production Mini App UI)",
      "",
    ].join("\n"),
  );
}

/**
 * Production startup.
 * Postgres mode verifies connectivity and applies migrations before listen.
 * A database failure closes the pool and does not start a memory runtime.
 * SIGTERM and SIGINT use the same close path as a normal server close.
 */
export async function startApiProcess(options: StartApiOptions = {}): Promise<RunningApi> {
  const env = options.env ?? process.env;
  const config = loadPersistenceConfig(env);
  const log = options.log ?? ((line: string) => process.stdout.write(line));
  const production = isProductionRuntime(env);
  const port = options.port ?? Number(env.PORT ?? "8787");
  const host = options.host ?? env.HOST ?? (production ? "0.0.0.0" : "127.0.0.1");
  let postgres: PostgresPersistence | null = null;
  try {
    let sql: PersistenceSqlClient;
    if (config.mode === "memory") {
      sql = new MemorySqlClient();
    } else {
      postgres = await openProductionSql(config, options.postgres);
      await postgres.sql.query("SELECT 1", []);
      await postgres.migrate();
      sql = postgres.sql;
    }
    const runtime = createCreateBanContactRuntime({
      sql,
      persistence: config.mode,
      env: runtimeEnvForStart(env),
      telegramSharePrepare: "live",
    });
    const listening = await listenCreateBanContactServer({
      runtime,
      port,
      host,
      seedTelegramUserIds: runtime.config.allowDevelopmentAuth
        ? [...DEFAULT_TEST_TELEGRAM_USERS]
        : [],
    });
    const bound = listening.server.address();
    const boundPort = bound !== null && typeof bound === "object" ? bound.port : port;
    writeStartupLog(log, { host, port: boundPort, url: listening.url, runtime, env, config });
    let closed = false;
    let onSignal: (signal: NodeJS.Signals) => void = () => undefined;
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
      await releaseTrackedRimOwnershipForShutdown(runtime.productStore);
      await listening.close();
      await postgres?.close();
    };
    onSignal = (signal: NodeJS.Signals): void => {
      log(`shutdown signal=${signal} persistence=${config.mode}\n`);
      void close().then(
        () => process.exit(0),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : "shutdown failed";
          process.stderr.write(`shutdown failed: ${message}\n`);
          process.exit(1);
        },
      );
    };
    if (options.handleSignals === true) {
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
    }
    return { mode: config.mode, runtime, url: listening.url, close };
  } catch (error) {
    await postgres?.close().catch(() => undefined);
    const connectionString = config.mode === "postgres" ? config.connectionString : "";
    throw redactConnectionString(error, connectionString);
  }
}

async function openProductionSql(
  config: Extract<PersistenceConfig, { mode: "postgres" }>,
  postgres: StartApiOptions["postgres"],
): Promise<PostgresPersistence> {
  const max = postgres?.max ?? config.max;
  return openPostgresPersistence({
    connectionString: config.connectionString,
    ...(config.ssl === undefined ? {} : { ssl: config.ssl }),
    ...(max === undefined ? {} : { max }),
    ...(postgres?.options === undefined ? {} : { options: postgres.options }),
    ...(postgres?.connectionTimeoutMillis === undefined
      ? { connectionTimeoutMillis: 10_000 }
      : { connectionTimeoutMillis: postgres.connectionTimeoutMillis }),
  });
}
