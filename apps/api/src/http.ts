import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { APPLICATION_STAGE, ApplicationError, type ProductEventInput } from "@98plus/application";
import { AuthenticationError, IDENTITY_STAGE, type AuthenticationAttempt } from "@98plus/identity";
import { PERSISTENCE_STAGE } from "@98plus/persistence";
import {
  CANONICAL_EVENT_COUNT,
  IMPLEMENTATION_STAGE,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
} from "@98plus/product-model";
import {
  authenticateRuntime,
  createCreateBanContactRuntime,
  loadDiagnostics,
  openLobbyIfNeeded,
  seedRegisteredUsers,
  type CreateBanContactRuntime,
} from "./runtime.ts";
import {
  CREATE_BAN_CONTACT_STAGE,
  INCOMING_OVERBOARD_STAGE,
  REPLY_BAN_FROM_INCOMING_STAGE,
  REPLY_BAN_FROM_STATUS_STAGE,
  STAGE_6_EXCLUDES,
  STAGE_7_EXCLUDES,
  STAGE_8_EXCLUDES,
  STAGE_9_EXCLUDES,
  STAGE_10_EXCLUDES,
  STAGE_11_EXCLUDES,
  TIMER_CHECK_STATUS_STAGE,
  TEMPLATE_CREATE_BAN_STAGE,
} from "./stage.ts";
import { assertUiTransportEvent } from "./contact-send.ts";
import { executeIncomingOverboardVertical } from "./overboard.ts";
import { applyElapsedDomainTimers } from "./duration-expired.ts";
import { assertSelectableContactId } from "./select-contact.ts";
import { CreateBanContactTransportError } from "./transport-error.ts";
import { testUiHtmlSource, testUiModuleSource } from "./test-ui-assets.ts";
import { buildTelegramShareInvocation, shouldOpenTelegramShare } from "./template-share.ts";

const TEST_UI_HTML = testUiHtmlSource();

export type CreateBanContactHttpOptions = Readonly<{
  runtime?: CreateBanContactRuntime;
  seedTelegramUserIds?: readonly string[];
  /** Listen host. Defaults to HOST env, then 127.0.0.1 (tests/local). Railway sets HOST=0.0.0.0. */
  host?: string;
}>;

export async function createCreateBanContactHttp(
  options: CreateBanContactHttpOptions = {},
): Promise<{
  runtime: CreateBanContactRuntime;
  dispatch: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}> {
  const runtime = options.runtime ?? createCreateBanContactRuntime();
  if (runtime.config.allowDevelopmentAuth) {
    await seedRegisteredUsers(runtime, options.seedTelegramUserIds);
  }
  return {
    runtime,
    dispatch: (req, res) => handleCreateBanContactRequest(runtime, req, res),
  };
}

export async function listenCreateBanContactServer(
  options: CreateBanContactHttpOptions & { port?: number } = {},
): Promise<{
  runtime: CreateBanContactRuntime;
  server: Server;
  url: string;
  close: () => Promise<void>;
}> {
  const { runtime, dispatch } = await createCreateBanContactHttp(options);
  const server = createServer((req, res) => {
    void dispatch(req, res);
  });
  const port = options.port ?? 0;
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("TEST UI server did not bind a TCP port");
  }
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return {
    runtime,
    server,
    url: `http://${displayHost}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export async function handleCreateBanContactRequest(
  runtime: CreateBanContactRuntime,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "OPTIONS") {
      writeCors(res, 204);
      res.end();
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/test-ui")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(TEST_UI_HTML);
      return;
    }
    if (req.method === "GET") {
      const moduleSource = testUiModuleSource(url.pathname);
      if (moduleSource !== null) {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(moduleSource);
        return;
      }
    }
    if (req.method === "GET" && url.pathname === "/api/meta") {
      json(res, 200, {
        CREATE_BAN_CONTACT_STAGE,
        INCOMING_OVERBOARD_STAGE,
        REPLY_BAN_FROM_INCOMING_STAGE,
        TIMER_CHECK_STATUS_STAGE,
        REPLY_BAN_FROM_STATUS_STAGE,
        TEMPLATE_CREATE_BAN_STAGE,
        STAGE_7_EXCLUDES,
        STAGE_8_EXCLUDES,
        STAGE_9_EXCLUDES,
        STAGE_10_EXCLUDES,
        STAGE_11_EXCLUDES,
        IMPLEMENTATION_STAGE,
        IDENTITY_STAGE,
        PERSISTENCE_STAGE,
        APPLICATION_STAGE,
        PRODUCT_CONTROL_STATE_COUNT,
        CANONICAL_EVENT_COUNT,
        MATRIX_RULE_COUNT: MATRIX_CONTRACT_ROWS.length,
        STAGE_6_EXCLUDES,
        ui: "TEST",
      });
      return;
    }
    const attempt = parseAuthAttempt(req);
    if (!attempt) {
      json(res, 401, { error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
      return;
    }
    const context = await authenticateRuntime(runtime, attempt);
    const claimed = headerValue(req, "x-98-claimed-user-id");
    if (req.method === "GET" && url.pathname === "/api/snapshot") {
      await applyElapsedDomainTimers(runtime, context);
      const { diagnostics } = await loadDiagnostics(runtime, context);
      json(res, 200, { diagnostics });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/contacts") {
      const { diagnostics } = await loadDiagnostics(runtime, context);
      json(res, 200, { diagnostics, contacts: diagnostics.contacts });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session") {
      const body = await readJson(req);
      const openIfNeeded = body.openIfNeeded !== false;
      if (openIfNeeded) {
        await openLobbyIfNeeded(runtime, context);
      }
      await applyElapsedDomainTimers(runtime, context);
      const { diagnostics } = await loadDiagnostics(runtime, context);
      json(res, 200, { diagnostics });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/events") {
      const body = await readJson(req);
      if (typeof body.name !== "string") {
        json(res, 400, {
          error: { code: "INVALID_EVENT", message: "Product Event name is required" },
        });
        return;
      }
      assertUiTransportEvent(body.name);
      const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
      if (body.name === "CREATE_BAN.SELECT_CONTACT") {
        await assertSelectableContactId(runtime.directory, context.currentUserId, payload);
      }
      const event: ProductEventInput = {
        name: body.name,
        payload,
      };
      const claimedUserId =
        typeof body.clientClaimedUserId === "string" ? body.clientClaimedUserId : claimed;
      const executed = await executeIncomingOverboardVertical(
        runtime,
        context,
        event,
        claimedUserId ?? undefined,
      );
      const telegramShare = shouldOpenTelegramShare(executed.last)
        ? await buildTelegramShareInvocation(
            runtime,
            executed.last.snapshot,
            String(context.currentTelegramUser.telegramUserId),
          )
        : null;
      const { diagnostics } = await loadDiagnostics(
        runtime,
        context,
        executed.last,
        executed.orchestration ? executed.first : null,
        telegramShare,
      );
      json(res, 200, {
        diagnostics,
        executionStatus: executed.last.status,
        ...(executed.orchestration === null ? {} : { orchestration: executed.orchestration }),
      });
      return;
    }
    json(res, 404, { error: { code: "NOT_FOUND", message: "Unknown TEST UI route" } });
  } catch (error) {
    if (error instanceof CreateBanContactTransportError) {
      json(res, 400, {
        error: { code: error.code, reason: error.reason, message: error.message },
      });
      return;
    }
    if (error instanceof AuthenticationError) {
      json(res, 401, { error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof ApplicationError) {
      json(res, error.code === "INVALID_EVENT" ? 400 : 500, {
        error: { code: error.code, message: error.message },
      });
      return;
    }
    json(res, 500, {
      error: {
        code: "INFRASTRUCTURE_FAILURE",
        message: error instanceof Error ? error.message : "Create Ban CONTACT HTTP failure",
      },
    });
  }
}

function writeCors(res: ServerResponse, status: number): void {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "content-type, x-98-auth-method, x-98-dev-secret, x-98-dev-telegram-user-id, x-98-init-data, x-98-claimed-user-id",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim().length > 0) {
    return value[0].trim();
  }
  return null;
}

export function parseAuthAttempt(req: IncomingMessage): AuthenticationAttempt | null {
  const method = headerValue(req, "x-98-auth-method");
  if (method === "telegram") {
    const initData = headerValue(req, "x-98-init-data");
    if (!initData) {
      return null;
    }
    return { method: "telegram", initData };
  }
  if (method === "development" || method === null) {
    const secret = headerValue(req, "x-98-dev-secret");
    const telegramUserId = headerValue(req, "x-98-dev-telegram-user-id");
    if (!secret || !telegramUserId) {
      return null;
    }
    return { method: "development", secret, telegramUserId };
  }
  return null;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApplicationError("INVALID_EVENT", "JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}
