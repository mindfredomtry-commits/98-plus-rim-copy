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
  CONTACT_RELATIONSHIP_STAGE,
  CREATE_BAN_CONTACT_STAGE,
  EXTERNAL_ENTRY_STAGE,
  INCOMING_OVERBOARD_STAGE,
  REPLY_BAN_FROM_INCOMING_STAGE,
  REPLY_BAN_FROM_STATUS_STAGE,
  STAGE_6_EXCLUDES,
  STAGE_7_EXCLUDES,
  STAGE_8_EXCLUDES,
  STAGE_9_EXCLUDES,
  STAGE_10_EXCLUDES,
  STAGE_11_EXCLUDES,
  STAGE_12_EXCLUDES,
  STAGE_13B_EXCLUDES,
  TELEGRAM_PERSISTENT_REENTRY_STAGE,
  TIMER_CHECK_STATUS_STAGE,
  TEMPLATE_CREATE_BAN_STAGE,
} from "./stage.ts";
import { assertUiTransportEvent } from "./contact-send.ts";
import { executeIncomingOverboardVertical } from "./overboard.ts";
import { applyElapsedDomainTimers } from "./duration-expired.ts";
import { assertSelectableContactId } from "./select-contact.ts";
import { CreateBanContactTransportError } from "./transport-error.ts";
import { testUiHtmlSource, testUiModuleSource } from "./test-ui-assets.ts";
import { recoverSharePendingOnReentry } from "./share-pending-reentry.ts";
import { buildTelegramShareInvocation, shouldOpenTelegramShare } from "./template-share.ts";
import {
  beginTelegramPersistentReentryRequest,
  deliverPendingTelegramPersistentReentryBootstrap,
  TelegramPersistentReentryError,
} from "./telegram-persistent-reentry.ts";
import {
  applyPendingExternalEntryExpiry,
  buildStartParamIntakeProbe,
  resolvePendingExternalEntryIfOnline,
  resolveTelegramShareExternalEntry,
  type ExternalEntryExecution,
  type ExternalEntryOrchestration,
} from "./external-entry.ts";
import {
  handleTelegramInlineProbeRequest,
  isTelegramInlineProbePath,
} from "./telegram-inline-probe.ts";
import {
  handleTelegramBanWebhookRequest,
  isTelegramBanWebhookPath,
} from "./telegram-ban-callback.ts";
import {
  handleTelegramPc02ProbeRequest,
  isPc02ProbeHttpPath,
  isPc02ProbeStartParam,
} from "./telegram-pc02-probe.ts";
import {
  mergeTelegramShareReplyEntry,
  orchestrateTelegramShareReplyEntry,
  shortCircuitShareReentryWhileInReplyBan,
} from "./telegram-reply-entry.ts";
import { jsonWithDiagnostics, withHttpDiagnostics } from "./http-diagnostics.ts";

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
  await withHttpDiagnostics(req, res, async (_diagCtx, startedAtMs) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const respond = (status: number, body: unknown): void => {
      jsonWithDiagnostics(res, status, body, {
        httpMethod: req.method ?? "GET",
        httpPath: url.pathname,
        startedAtMs,
      });
    };
  try {
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
      respond(200, {
        CREATE_BAN_CONTACT_STAGE,
        INCOMING_OVERBOARD_STAGE,
        REPLY_BAN_FROM_INCOMING_STAGE,
        TIMER_CHECK_STATUS_STAGE,
        REPLY_BAN_FROM_STATUS_STAGE,
        TEMPLATE_CREATE_BAN_STAGE,
        EXTERNAL_ENTRY_STAGE,
        CONTACT_RELATIONSHIP_STAGE,
        TELEGRAM_PERSISTENT_REENTRY_STAGE,
        STAGE_7_EXCLUDES,
        STAGE_8_EXCLUDES,
        STAGE_9_EXCLUDES,
        STAGE_10_EXCLUDES,
        STAGE_11_EXCLUDES,
        STAGE_12_EXCLUDES,
        STAGE_13B_EXCLUDES,
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
    if (req.method === "POST" && isTelegramBanWebhookPath(url.pathname)) {
      await handleTelegramBanWebhookRequest(runtime, req, res);
      return;
    }
    if (req.method === "POST" && isTelegramInlineProbePath(url.pathname)) {
      await handleTelegramInlineProbeRequest(req, res);
      return;
    }
    if (req.method === "POST" && isPc02ProbeHttpPath(url.pathname)) {
      await handleTelegramPc02ProbeRequest(req, res);
      return;
    }
    const attempt = parseAuthAttempt(req);
    if (!attempt) {
      respond(401, { error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
      return;
    }
    const context = await authenticateRuntime(runtime, attempt);
    const claimed = headerValue(req, "x-98-claimed-user-id");
    if (req.method === "GET" && url.pathname === "/api/snapshot") {
      await applyElapsedDomainTimers(runtime, context);
      await applyPendingExternalEntryExpiry(runtime, context, claimed ?? undefined);
      const { diagnostics } = await loadDiagnostics(runtime, context);
      respond(200, { diagnostics });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/contacts") {
      const { diagnostics } = await loadDiagnostics(runtime, context);
      respond(200, { diagnostics, contacts: diagnostics.contacts });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session") {
      const body = await readJson(req);
      const openIfNeeded = body.openIfNeeded !== false;
      const startParam = typeof body.startParam === "string" ? body.startParam : null;
      const clientLaunch =
        body.launchProbe && typeof body.launchProbe === "object"
          ? (body.launchProbe as {
              unsafeStartParamPresent?: boolean;
              initDataStartParamPresent?: boolean;
              tgWebAppStartParamPresent?: boolean;
              queryStartParamPresent?: boolean;
              sentStartParamToSession?: boolean;
            })
          : null;
      const claimedUserId = claimed ?? undefined;
      await applyElapsedDomainTimers(runtime, context);
      let externalEntry: ExternalEntryOrchestration | null = null;
      let entryExecution: ExternalEntryExecution | null = null;
      let lastExecution = null as Awaited<
        ReturnType<typeof resolveTelegramShareExternalEntry>
      >["last"];
      let firstExecution = null as Awaited<
        ReturnType<typeof resolveTelegramShareExternalEntry>
      >["first"];

      const expired = await applyPendingExternalEntryExpiry(runtime, context, claimedUserId);
      if (expired) {
        lastExecution = expired;
        firstExecution = expired;
      }

      if (startParam) {
        const shortCircuit = await shortCircuitShareReentryWhileInReplyBan(
          runtime,
          context,
          startParam,
        );
        if (shortCircuit) {
          entryExecution = shortCircuit;
          externalEntry = shortCircuit.orchestration;
        } else {
          const resolved = await resolveTelegramShareExternalEntry(
            runtime,
            context,
            startParam,
            claimedUserId,
          );
          entryExecution = resolved;
          externalEntry = resolved.orchestration;
          if (resolved.last) {
            lastExecution = resolved.last;
            firstExecution = resolved.first ?? resolved.last;
          }
          const replyEntry = await orchestrateTelegramShareReplyEntry(
            runtime,
            context,
            resolved,
            startParam,
            claimedUserId,
          );
          if (replyEntry.kind === "applied") {
            entryExecution = mergeTelegramShareReplyEntry(resolved, replyEntry);
            externalEntry = entryExecution.orchestration;
            lastExecution = replyEntry.execution;
          }
        }
      } else {
        const pending = await resolvePendingExternalEntryIfOnline(runtime, context, claimedUserId);
        if (pending) {
          entryExecution = pending;
          externalEntry = pending.orchestration;
          if (pending.last) {
            lastExecution = pending.last;
            firstExecution = pending.first ?? pending.last;
          }
        }
      }

      const sharePendingRecovery = await recoverSharePendingOnReentry(runtime, context);
      let openExecution: Awaited<ReturnType<typeof openLobbyIfNeeded>>["execution"] = null;
      if (openIfNeeded) {
        const opened = await openLobbyIfNeeded(runtime, context);
        openExecution = opened.execution;
      }
      await applyElapsedDomainTimers(runtime, context);
      const bootstrapDelivery = await deliverPendingTelegramPersistentReentryBootstrap(
        runtime,
        context,
      );
      const pc02Matched = isPc02ProbeStartParam(startParam);
      const startParamIntake = {
        ...buildStartParamIntakeProbe(startParam, entryExecution),
        pc02Probe: {
          matched: pc02Matched,
          productEventsSkipped: pc02Matched,
        },
        ...(clientLaunch
          ? {
              client: {
                unsafeStartParamPresent: clientLaunch.unsafeStartParamPresent === true,
                initDataStartParamPresent: clientLaunch.initDataStartParamPresent === true,
                tgWebAppStartParamPresent: clientLaunch.tgWebAppStartParamPresent === true,
                queryStartParamPresent: clientLaunch.queryStartParamPresent === true,
                sentStartParamToSession: clientLaunch.sentStartParamToSession === true,
              },
            }
          : {}),
      };
      // Prefer APP.NORMAL_OPEN over a prior pending-entry re-dispatch so CTA /
      // controlState reflect the post-open Product Snapshot (MVP10 whitelist).
      const primaryExecution =
        sharePendingRecovery.status === "RECOVERED"
          ? sharePendingRecovery.execution
          : (openExecution ?? lastExecution);
      const secondaryExecution =
        openExecution && lastExecution && openExecution !== lastExecution
          ? lastExecution
          : firstExecution && firstExecution !== primaryExecution
            ? firstExecution
            : null;
      const { diagnostics: baseDiagnostics } = await loadDiagnostics(
        runtime,
        context,
        primaryExecution,
        secondaryExecution,
        undefined,
        externalEntry,
        startParamIntake,
      );
      const recoveryDiagnostic =
        sharePendingRecovery.status === "NOT_RECOVERABLE" ||
        sharePendingRecovery.status === "NOT_PERSISTED"
          ? { code: sharePendingRecovery.code, message: sharePendingRecovery.message }
          : null;
      const diagnostics = bootstrapDelivery.error
        ? { ...baseDiagnostics, error: bootstrapDelivery.error }
        : recoveryDiagnostic
          ? { ...baseDiagnostics, error: recoveryDiagnostic }
          : baseDiagnostics;
      respond(200, {
        diagnostics,
        ...(externalEntry === null ? {} : { externalEntry }),
        ...(recoveryDiagnostic === null
          ? {}
          : {
              sharePendingRecovery: {
                status: sharePendingRecovery.status,
                code: recoveryDiagnostic.code,
              },
            }),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/external-entry") {
      const body = await readJson(req);
      const startParam = typeof body.startParam === "string" ? body.startParam : null;
      const claimedUserId =
        typeof body.clientClaimedUserId === "string"
          ? body.clientClaimedUserId
          : (claimed ?? undefined);
      await applyElapsedDomainTimers(runtime, context);
      await applyPendingExternalEntryExpiry(runtime, context, claimedUserId);
      const shortCircuit = await shortCircuitShareReentryWhileInReplyBan(
        runtime,
        context,
        startParam,
      );
      let resolved =
        shortCircuit ??
        (await resolveTelegramShareExternalEntry(runtime, context, startParam, claimedUserId));
      if (!shortCircuit) {
        const replyEntry = await orchestrateTelegramShareReplyEntry(
          runtime,
          context,
          resolved,
          startParam,
          claimedUserId,
        );
        if (replyEntry.kind === "applied") {
          resolved = mergeTelegramShareReplyEntry(resolved, replyEntry);
        }
      }
      if (
        resolved.orchestration.outcome === "NOOP" ||
        resolved.orchestration.outcome === "PENDING"
      ) {
        await openLobbyIfNeeded(runtime, context);
      }
      const pc02Matched = isPc02ProbeStartParam(startParam);
      const startParamIntake = {
        ...buildStartParamIntakeProbe(startParam, resolved),
        pc02Probe: {
          matched: pc02Matched,
          productEventsSkipped: pc02Matched,
        },
      };
      const { diagnostics } = await loadDiagnostics(
        runtime,
        context,
        resolved.last,
        resolved.first && resolved.first !== resolved.last ? resolved.first : null,
        undefined,
        resolved.orchestration,
        startParamIntake,
      );
      respond(200, {
        diagnostics,
        externalEntry: resolved.orchestration,
        executionStatus: resolved.last?.status ?? "LOADED",
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/telegram-persistent-reentry/begin") {
      const began = await beginTelegramPersistentReentryRequest(runtime, context);
      respond(200, {
        requestId: began.requestId,
        diagnostics: began.diagnostics,
        telegramPersistentReentryEligible: began.eligible,
        telegramPersistentReentryEstablished: began.established,
        telegramPersistentReentryActiveRequestId: began.activeRequestId,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/events") {
      const body = await readJson(req);
      if (typeof body.name !== "string") {
        respond(400, {
          error: { code: "INVALID_EVENT", message: "Product Event name is required" },
        });
        return;
      }
      assertUiTransportEvent(body.name);
      const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
      if (body.name === "CREATE_BAN.SELECT_CONTACT" || body.name === "RIM.SELECT_CONTACT") {
        await assertSelectableContactId(
          runtime.directory,
          context.currentUserId,
          payload,
          body.name,
        );
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
      let externalEntry = null as ExternalEntryOrchestration | null;
      let last = executed.last;
      let first = executed.orchestration ? executed.first : null;
      if (event.name === "CONNECTION.RESTORED" && last.status === "APPLIED") {
        const pending = await resolvePendingExternalEntryIfOnline(
          runtime,
          context,
          claimedUserId ?? undefined,
        );
        if (pending?.last) {
          externalEntry = pending.orchestration;
          first = last;
          last = pending.last;
        }
      }
      let bootstrapDeliveryError: Readonly<{ code: string; message: string }> | null = null;
      if (event.name === "TELEGRAM_PERSISTENT_REENTRY.GRANTED") {
        const delivery = await deliverPendingTelegramPersistentReentryBootstrap(runtime, context);
        if (delivery.error) {
          bootstrapDeliveryError = delivery.error;
        }
      }
      const telegramShare = shouldOpenTelegramShare(last)
        ? await buildTelegramShareInvocation(
            runtime,
            last.snapshot,
            String(context.currentTelegramUser.telegramUserId),
          )
        : null;
      const { diagnostics: baseDiagnostics } = await loadDiagnostics(
        runtime,
        context,
        last,
        first,
        telegramShare,
        externalEntry,
      );
      const diagnostics = bootstrapDeliveryError
        ? { ...baseDiagnostics, error: bootstrapDeliveryError }
        : baseDiagnostics;
      respond(200, {
        diagnostics,
        executionStatus: last.status,
        ...(executed.orchestration === null ? {} : { orchestration: executed.orchestration }),
        ...(externalEntry === null ? {} : { externalEntry }),
      });
      return;
    }
    respond(404, { error: { code: "NOT_FOUND", message: "Unknown TEST UI route" } });
  } catch (error) {
    if (error instanceof TelegramPersistentReentryError) {
      respond(400, {
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error instanceof CreateBanContactTransportError) {
      respond(400, {
        error: { code: error.code, reason: error.reason, message: error.message },
      });
      return;
    }
    if (error instanceof AuthenticationError) {
      respond(401, { error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof ApplicationError) {
      respond(error.code === "INVALID_EVENT" ? 400 : 500, {
        error: { code: error.code, message: error.message },
      });
      return;
    }
    respond(500, {
      error: {
        code: "INFRASTRUCTURE_FAILURE",
        message: error instanceof Error ? error.message : "Create Ban CONTACT HTTP failure",
      },
    });
  }
  });
}

function writeCors(res: ServerResponse, status: number): void {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "content-type, x-98-auth-method, x-98-dev-secret, x-98-dev-telegram-user-id, x-98-init-data, x-98-claimed-user-id",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
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
