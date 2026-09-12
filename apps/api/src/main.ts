import { listenCreateBanContactServer } from "./http.ts";
import {
  createCreateBanContactRuntime,
  DEFAULT_DEV_AUTH_SECRET,
  DEFAULT_TEST_TELEGRAM_USERS,
} from "./runtime.ts";

function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" || env.APP_ENV === "production";
}

function runtimeEnvForStart(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
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

const production = isProductionRuntime();
const port = Number(process.env.PORT ?? "8787");
const host = process.env.HOST ?? (production ? "0.0.0.0" : "127.0.0.1");
const runtime = createCreateBanContactRuntime({
  env: runtimeEnvForStart(),
  telegramSharePrepare: "live",
});

const listening = await listenCreateBanContactServer({
  runtime,
  port,
  host,
  seedTelegramUserIds: runtime.config.allowDevelopmentAuth ? [...DEFAULT_TEST_TELEGRAM_USERS] : [],
});

const authMode = runtime.config.allowDevelopmentAuth
  ? "development-auth-enabled"
  : "telegram-initData-only";
const tokenStatus = process.env.TELEGRAM_BOT_TOKEN?.trim() ? "configured" : "missing";
const usernameStatus = process.env.TELEGRAM_BOT_USERNAME?.trim() ? "configured" : "missing";

process.stdout.write(
  [
    "98+ TEST UI — temporary Stage 11 Telegram verification host",
    `listening ${host}:${port} (local url ${listening.url})`,
    `auth=${authMode}`,
    `TELEGRAM_BOT_TOKEN=${tokenStatus}`,
    `TELEGRAM_BOT_USERNAME=${usernameStatus}`,
    "persistence=MemorySqlClient (volatile; lost on restart)",
    "surface=TEST UI (not production Mini App UI)",
    "",
  ].join("\n"),
);
