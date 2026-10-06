import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPLICATION_STAGE } from "@98plus/application";
import {
  CANONICAL_EVENT_COUNT,
  IMPLEMENTATION_STAGE,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  ABSENT_EVENT_IDS,
} from "@98plus/product-model";
import { IDENTITY_STAGE } from "@98plus/identity";
import {
  PERSISTENCE_STAGE,
  PersistenceError,
  productPersistenceSql,
  type ProductStore,
} from "@98plus/persistence";
import {
  API_IDENTITY_STAGE,
  API_KERNEL_STAGE,
  API_PERSISTENCE_STAGE,
  API_STAGE,
  CREATE_BAN_CONTACT_STAGE,
  STAGE_6_EXCLUDES,
} from "./index.ts";
import { listenCreateBanContactServer } from "./http.ts";
import {
  authenticateRuntime,
  createCreateBanContactRuntime,
  executeAuthenticatedEvent,
  seedRegisteredUsers,
  userIdOf,
  type CreateBanContactRuntime,
} from "./runtime.ts";
import type { TestUiDiagnostics } from "./diagnostics.ts";
import { listSelectableRegisteredUsers } from "./directory.ts";
import { grantContactBetweenTelegramUsers } from "./seed-contact.ts";
import type { ContactSendOrchestration } from "./contact-send.ts";

const USER_A_TG = "1001";
const USER_B_TG = "1002";
const BAN_TEXT = "не пропускай зал";
const DEV_SECRET = "test-secret";

type Started = Awaited<ReturnType<typeof listenCreateBanContactServer>>;

const started: Started[] = [];

afterEach(async () => {
  while (started.length > 0) {
    const app = started.pop();
    if (app) {
      await app.close();
    }
  }
});

async function start(runtime?: CreateBanContactRuntime): Promise<Started> {
  const app = await listenCreateBanContactServer(
    runtime === undefined ? {} : { runtime, seedTelegramUserIds: [] },
  );
  started.push(app);
  return app;
}

function authHeaders(telegramUserId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-98-auth-method": "development",
    "x-98-dev-secret": DEV_SECRET,
    "x-98-dev-telegram-user-id": telegramUserId,
  };
}

async function session(url: string, telegramUserId: string): Promise<TestUiDiagnostics> {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify({ openIfNeeded: true }),
  });
  const body = (await response.json()) as { diagnostics?: TestUiDiagnostics; error?: unknown };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.diagnostics!;
}

async function dispatch(
  url: string,
  telegramUserId: string,
  name: string,
  payload: Record<string, unknown> = {},
  extras: { clientClaimedUserId?: string } = {},
): Promise<{
  httpStatus: number;
  diagnostics: TestUiDiagnostics | null;
  executionStatus?: string;
  orchestration: ContactSendOrchestration | null;
  error: { code?: string; reason?: string; message?: string } | null;
}> {
  const response = await fetch(`${url}/api/events`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify({
      name,
      payload,
      ...(extras.clientClaimedUserId === undefined
        ? {}
        : { clientClaimedUserId: extras.clientClaimedUserId }),
    }),
  });
  const body = (await response.json()) as {
    diagnostics?: TestUiDiagnostics;
    executionStatus?: string;
    orchestration?: ContactSendOrchestration;
    error?: { code?: string; reason?: string; message?: string };
  };
  return {
    httpStatus: response.status,
    diagnostics: body.diagnostics ?? null,
    orchestration: body.orchestration ?? null,
    error: body.error ?? null,
    ...(body.executionStatus === undefined ? {} : { executionStatus: body.executionStatus }),
  };
}

function requireDiagnostics(result: Awaited<ReturnType<typeof dispatch>>): TestUiDiagnostics {
  expect(result.httpStatus, JSON.stringify(result.error)).toBe(200);
  expect(result.diagnostics).not.toBeNull();
  return result.diagnostics!;
}

async function snapshot(url: string, telegramUserId: string): Promise<TestUiDiagnostics> {
  const response = await fetch(`${url}/api/snapshot`, { headers: authHeaders(telegramUserId) });
  const body = (await response.json()) as { diagnostics: TestUiDiagnostics };
  expect(response.status).toBe(200);
  return body.diagnostics;
}

type BanJson = {
  id: string;
  senderId: string;
  receiverId: string | null;
  banText: string;
  durationMinutes: number;
  acceptance: string;
  status: string | null;
};

type IncomingJson = {
  ownerId: string;
  banId: string;
  kind: string;
};

function bansOf(diagnostics: TestUiDiagnostics): BanJson[] {
  return diagnostics.bans as BanJson[];
}

function incomingOf(diagnostics: TestUiDiagnostics): IncomingJson[] {
  return diagnostics.incomingItems as IncomingJson[];
}

async function userBId(app: Started, diagnostics: TestUiDiagnostics): Promise<string> {
  const listed = diagnostics.contacts.find((contact) => contact.telegramUserId === USER_B_TG);
  if (listed) {
    return listed.userId;
  }
  const fromSql = userIdOf(app.runtime, USER_B_TG);
  expect(fromSql).not.toBeNull();
  return fromSql!;
}

async function reachWhatContact(
  url: string,
  app: Started,
): Promise<{ a: TestUiDiagnostics; bId: string }> {
  await session(url, USER_A_TG);
  await session(url, USER_B_TG);
  grantContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_B_TG);
  const opened = await session(url, USER_A_TG);
  expect(opened.controlState).toBe("RIM.LOBBY");
  const who = requireDiagnostics(await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_START"));
  expect(who.controlState).toBe("CREATE_BAN.WHO");
  const bId = await userBId(app, who);
  expect(who.contacts.some((contact) => contact.userId === bId)).toBe(true);
  const what = requireDiagnostics(
    await dispatch(url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", { contactId: bId }),
  );
  expect(what.controlState).toBe("CREATE_BAN.WHAT.CONTACT");
  return { a: what, bId };
}

async function reachConfirm(
  url: string,
  app: Started,
  text: string = BAN_TEXT,
  durationMinutes: number = 10,
): Promise<{ diagnostics: TestUiDiagnostics; bId: string }> {
  const { bId } = await reachWhatContact(url, app);
  await dispatch(url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: text });
  await dispatch(url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes });
  const next = requireDiagnostics(await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_NEXT"));
  return { diagnostics: next, bId };
}

async function confirmOnce(url: string): Promise<{
  diagnostics: TestUiDiagnostics;
  orchestration: ContactSendOrchestration;
}> {
  const forbid = await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_FORBID");
  const diagnostics = requireDiagnostics(forbid);
  expect(forbid.orchestration).not.toBeNull();
  return { diagnostics, orchestration: forbid.orchestration! };
}

describe("Stage 6 Create Ban CONTACT vertical", () => {
  it("keeps frozen 30 / 59 / 358 and stage markers 2 / 3 / 4 / 5 with CREATE_BAN_CONTACT_STAGE = 6", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(59);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(358);
    expect(IMPLEMENTATION_STAGE).toBe(2);
    expect(IDENTITY_STAGE).toBe(3);
    expect(PERSISTENCE_STAGE).toBe(4);
    expect(APPLICATION_STAGE).toBe(5);
    expect(API_KERNEL_STAGE).toBe(2);
    expect(API_IDENTITY_STAGE).toBe(3);
    expect(API_PERSISTENCE_STAGE).toBe(4);
    expect(API_STAGE).toBe(5);
    expect(CREATE_BAN_CONTACT_STAGE).toBe(6);
    expect(STAGE_6_EXCLUDES).toContain("full-notifications-ui");
    expect(STAGE_6_EXCLUDES).toContain("production-ui");
    expect(ABSENT_EVENT_IDS).toEqual(["E-36", "E-37", "E-38", "E-39", "E-40"]);
  });

  it("A. Lobby → Create Ban Who through canonical E-01", async () => {
    const app = await start();
    const opened = await session(app.url, USER_A_TG);
    expect(opened.controlState).toBe("RIM.LOBBY");
    const startedBan = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START"),
    );
    expect(startedBan.lastEvent).toEqual({
      id: "E-01",
      name: "CREATE_BAN.PRESS_START",
    });
    expect(startedBan.controlState).toBe("CREATE_BAN.WHO");
    expect(startedBan.kernelOutcome).toBe("APPLIED");
    expect(startedBan.persisted).toBe(true);
    expect(startedBan.createBanDraft).toEqual({
      origin: "CONTACT",
      selectedContactId: null,
      banText: "",
      durationMinutes: null,
      proposalId: null,
    });
  });

  it("B / N. Select registered User B → WHAT.CONTACT through E-02 UserId", async () => {
    const app = await start();
    const { a, bId } = await reachWhatContact(app.url, app);
    expect(a.lastEvent).toEqual({ id: "E-02", name: "CREATE_BAN.SELECT_CONTACT" });
    expect(a.selectedContactId).toBe(bId);
    expect(a.selectedContactId).not.toBe(USER_B_TG);
    expect(a.createBanDraft?.origin).toBe("CONTACT");
    const self = a.contacts.find((contact) => contact.userId === a.currentUserId);
    expect(self).toBeUndefined();
  });

  it("C. Ban text update through canonical E-04", async () => {
    const app = await start();
    await reachWhatContact(app.url, app);
    const updated = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT }),
    );
    expect(updated.lastEvent).toEqual({
      id: "E-04",
      name: "CREATE_BAN.CHANGE_BAN_TEXT",
    });
    expect(updated.createBanDraft?.banText).toBe(BAN_TEXT);
    expect(updated.controlState).toBe("CREATE_BAN.WHAT.CONTACT");
  });

  it("D. valid 3-minute boundary reaches CONFIRM.CONTACT", async () => {
    const app = await start();
    const { diagnostics } = await reachConfirm(app.url, app, BAN_TEXT, 3);
    expect(diagnostics.controlState).toBe("CREATE_BAN.CONFIRM.CONTACT");
    expect(diagnostics.createBanDraft?.durationMinutes).toBe(3);
    expect(diagnostics.lastEvent).toEqual({ id: "E-06", name: "CREATE_BAN.PRESS_NEXT" });
  });

  it("E. valid 60-minute boundary reaches CONFIRM.CONTACT", async () => {
    const app = await start();
    const { diagnostics } = await reachConfirm(app.url, app, BAN_TEXT, 60);
    expect(diagnostics.controlState).toBe("CREATE_BAN.CONFIRM.CONTACT");
    expect(diagnostics.createBanDraft?.durationMinutes).toBe(60);
  });

  it("F. invalid 2 / 61 / non-integer duration cannot open Confirm", async () => {
    const app = await start();
    await reachWhatContact(app.url, app);
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT });
    for (const durationMinutes of [2, 61, 3.5]) {
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes });
      const next = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT"));
      expect(next.controlState).toBe("CREATE_BAN.WHAT.CONTACT");
      expect(next.matrixResult).toBe("IGNORE_NOT_ALLOWED");
    }
  });

  it("G. whitespace Ban text cannot complete send", async () => {
    const app = await start();
    await reachWhatContact(app.url, app);
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: "   " });
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 });
    const next = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT"));
    expect(next.controlState).toBe("CREATE_BAN.WHAT.CONTACT");
    expect(next.matrixResult).toBe("IGNORE_NOT_ALLOWED");
    const forbid = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID"),
    );
    expect(forbid.controlState).toBe("CREATE_BAN.WHAT.CONTACT");
    expect(bansOf(forbid)).toEqual([]);
  });

  it("H. Confirm renders authoritative draft", async () => {
    const app = await start();
    const { diagnostics, bId } = await reachConfirm(app.url, app, BAN_TEXT, 10);
    expect(diagnostics.controlState).toBe("CREATE_BAN.CONFIRM.CONTACT");
    expect(diagnostics.createBanDraft).toEqual({
      origin: "CONTACT",
      selectedContactId: bId,
      banText: BAN_TEXT,
      durationMinutes: 10,
      proposalId: null,
    });
    expect(diagnostics.currentUserId).toBe(userIdOf(app.runtime, USER_A_TG));
  });

  it("A–I, R. one Confirm click runs E-08 then backend E-10 to SUCCESS", async () => {
    const app = await start();
    const { bId } = await reachConfirm(app.url, app, BAN_TEXT, 10);
    const { diagnostics, orchestration } = await confirmOnce(app.url);
    expect(orchestration.userEvent.eventName).toBe("CREATE_BAN.PRESS_FORBID");
    expect(orchestration.userEvent.controlState).toBe("CREATE_BAN.CONFIRM.CONTACT");
    expect(orchestration.userEvent.applicationStatus).toBe("APPLIED");
    expect(orchestration.userEvent.banCount).toBe(0);
    expect(orchestration.userEvent.pendingOperationId).toBeTruthy();
    expect(orchestration.serverEvent.eventName).toBe("CREATE_BAN.SEND_CONFIRMED");
    expect(orchestration.serverEvent.correlatedOperationId).toBe(
      orchestration.userEvent.pendingOperationId,
    );
    expect(orchestration.serverEvent.pendingOperationId).toBeNull();
    expect(diagnostics.previousEvent).toEqual({ id: "E-08", name: "CREATE_BAN.PRESS_FORBID" });
    expect(diagnostics.lastEvent).toEqual({ id: "E-10", name: "CREATE_BAN.SEND_CONFIRMED" });
    expect(diagnostics.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(diagnostics.kernelOutcome).toBe("APPLIED");
    expect(orchestration.serverEvent.applicationStatus).toBe("APPLIED");
    expect(orchestration.serverEvent.persisted).toBe(true);
    expect(diagnostics.effects).toEqual(
      expect.arrayContaining([
        "UPSERT_BAN",
        "UPSERT_NOTIFICATION_ITEM",
        "CLEAR_OPERATION",
        "MARK_OPERATION_RESULT_APPLIED",
        "SET_CONTROL_STATE",
      ]),
    );
    const created = bansOf(diagnostics);
    expect(created).toHaveLength(1);
    expect(created[0]?.senderId).toBe(diagnostics.currentUserId);
    expect(created[0]?.receiverId).toBe(bId);
    expect(created[0]?.banText).toBe(BAN_TEXT);
    expect(created[0]?.durationMinutes).toBe(10);
    expect(created[0]?.acceptance).toBe("PENDING");
    expect(created[0]?.status).toBeNull();
    expect(diagnostics.domainTimers).toEqual([]);
    expect(diagnostics.checkPairs).toEqual([]);
    const asB = await session(app.url, USER_B_TG);
    expect(incomingOf(asB)).toHaveLength(1);
    expect(incomingOf(asB)[0]?.ownerId).toBe(bId);
    expect(incomingOf(asB)[0]?.banId).toBe(created[0]?.id);
    const reloadedB = await snapshot(app.url, USER_B_TG);
    expect(incomingOf(reloadedB)).toHaveLength(1);
  });

  it("A–G. SUCCESS FORBID AGAIN dispatches frozen E-09 to Matrix queue-empty RIM.LOBBY", async () => {
    const e09 = MATRIX_CONTRACT_ROWS.filter(
      (row) =>
        row.state === "CREATE_BAN.SUCCESS" && row.eventName === "CREATE_BAN.PRESS_FORBID_MORE",
    );
    expect(e09).toHaveLength(2);
    expect(e09.find((row) => row.branch === "queue-empty")).toMatchObject({
      eventId: "E-09",
      nextState: "RIM.LOBBY",
      effects: [{ type: "SET_CONTROL_STATE" }],
    });
    expect(e09.find((row) => row.branch === "unprocessed-items-exist")).toMatchObject({
      eventId: "E-09",
      nextState: "RESULT_OF_NOTIFICATIONS_SELECT_NEXT",
    });
    const app = await start();
    await reachConfirm(app.url, app);
    const { diagnostics: success } = await confirmOnce(app.url);
    expect(success.controlState).toBe("CREATE_BAN.SUCCESS");
    const leftoverDraft = success.createBanDraft;
    const created = bansOf(success);
    expect(created).toHaveLength(1);
    const again = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID_MORE"),
    );
    expect(again.lastEvent).toEqual({ id: "E-09", name: "CREATE_BAN.PRESS_FORBID_MORE" });
    expect(again.controlState).toBe("RIM.LOBBY");
    expect(again.kernelOutcome).toBe("APPLIED");
    expect(again.effects).toEqual(["SET_CONTROL_STATE"]);
    expect(again.createBanDraft).toEqual(leftoverDraft);
    expect(bansOf(again)).toHaveLength(1);
    expect(bansOf(again)[0]?.id).toBe(created[0]?.id);
    expect(again.domainTimers).toEqual([]);
    expect(again.checkPairs).toEqual([]);
    const asB = await snapshot(app.url, USER_B_TG);
    expect(incomingOf(asB)).toHaveLength(1);
  });

  it("Q. duplicate / late E-10 does not duplicate Ban or Incoming", async () => {
    const app = await start();
    await reachConfirm(app.url, app);
    const { diagnostics, orchestration } = await confirmOnce(app.url);
    expect(diagnostics.controlState).toBe("CREATE_BAN.SUCCESS");
    const operationId = orchestration.userEvent.pendingOperationId;
    expect(operationId).toBeTruthy();
    const createdBanId = bansOf(diagnostics)[0]!.id;
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_A_TG,
    });
    const second = await executeAuthenticatedEvent(app.runtime, context, {
      name: "CREATE_BAN.SEND_CONFIRMED",
      payload: { operationId, createdBanId },
    });
    expect(Object.keys(second.snapshot.extended.entities.bans)).toHaveLength(1);
    const asB = await session(app.url, USER_B_TG);
    expect(incomingOf(asB)).toHaveLength(1);
  });

  it("S. client-spoofed UserId cannot become sender", async () => {
    const app = await start();
    const opened = await session(app.url, USER_A_TG);
    const spoofed = userIdOf(app.runtime, USER_B_TG);
    const startedBan = requireDiagnostics(
      await dispatch(
        app.url,
        USER_A_TG,
        "CREATE_BAN.PRESS_START",
        {},
        {
          clientClaimedUserId: spoofed ?? "spoofed-user",
        },
      ),
    );
    expect(startedBan.currentUserId).toBe(opened.currentUserId);
    expect(startedBan.currentUserId).not.toBe(spoofed);
  });

  it("L. unregistered E-02 contactId is rejected before Stage 5", async () => {
    const app = await start();
    await session(app.url, USER_A_TG);
    requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START"));
    const rejected = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", {
      contactId: "not-a-registered-user",
    });
    expect(rejected.httpStatus).toBe(400);
    expect(rejected.error?.code).toBe("INVALID_CONTACT");
    expect(rejected.error?.reason).toBe("UNREGISTERED");
    expect(rejected.diagnostics).toBeNull();
    const durable = await snapshot(app.url, USER_A_TG);
    expect(durable.controlState).toBe("CREATE_BAN.WHO");
    expect(durable.selectedContactId).toBeNull();
    expect(durable.lastEvent).toBeNull();
  });

  it("M. E-02 with the current user's own UserId is rejected", async () => {
    const app = await start();
    const opened = await session(app.url, USER_A_TG);
    requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START"));
    const rejected = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", {
      contactId: opened.currentUserId,
    });
    expect(rejected.httpStatus).toBe(400);
    expect(rejected.error?.code).toBe("INVALID_CONTACT");
    expect(rejected.error?.reason).toBe("SELF");
    const durable = await snapshot(app.url, USER_A_TG);
    expect(durable.controlState).toBe("CREATE_BAN.WHO");
    expect(durable.selectedContactId).toBeNull();
  });

  it("O. Telegram user id cannot be substituted for internal UserId", async () => {
    const app = await start();
    await session(app.url, USER_A_TG);
    requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START"));
    const rejected = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", {
      contactId: USER_B_TG,
    });
    expect(rejected.httpStatus).toBe(400);
    expect(rejected.error?.code).toBe("INVALID_CONTACT");
    expect(rejected.error?.reason).toBe("UNREGISTERED");
    const durable = await snapshot(app.url, USER_A_TG);
    expect(durable.controlState).toBe("CREATE_BAN.WHO");
    expect(durable.selectedContactId).toBeNull();
  });

  it("U. revision conflict is not silently overwritten", async () => {
    const base = createCreateBanContactRuntime();
    await seedRegisteredUsers(base);
    const inner = base.productStore;
    const racing: ProductStore = {
      loadProductSnapshot: (userId) => inner.loadProductSnapshot(userId),
      listRelationshipBans: (left, right) => inner.listRelationshipBans(left, right),
      listRelationshipContextSources: (left, right) =>
        inner.listRelationshipContextSources(left, right),
      withCheckPairLock: (pairId, run) => inner.withCheckPairLock(pairId, run),
      findShareByToken: (token) => inner.findShareByToken(token),
      getBanById: (banId) => inner.getBanById(banId),
      bindBanReceiver: (banId, receiverId) => inner.bindBanReceiver(banId, receiverId),
      saveRimProviderRuntime: (userId, expectedRevision, runtime) =>
        inner.saveRimProviderRuntime(userId, expectedRevision, runtime),
      persistShareLinkResolved: (input) => inner.persistShareLinkResolved(input),
      getShareByAttemptId: (attemptId) => inner.getShareByAttemptId(attemptId),
      claimTemplateShare: (input) => inner.claimTemplateShare(input),
      markTelegramPersistentReentryBootstrapSent: (userId, claimToken) =>
        inner.markTelegramPersistentReentryBootstrapSent(userId, claimToken),
      claimTelegramPersistentReentryBootstrapDelivery: (userId, nowMs, leaseMs) =>
        inner.claimTelegramPersistentReentryBootstrapDelivery(userId, nowMs, leaseMs),
      releaseTelegramPersistentReentryBootstrapClaim: (userId, claimToken) =>
        inner.releaseTelegramPersistentReentryBootstrapClaim(userId, claimToken),
      commitOwnedTransition: (input) => inner.commitOwnedTransition(input),
      persistTransition: async (input) => {
        if (input.result.snapshot.controlState === "CREATE_BAN.WHO") {
          throw new PersistenceError("REVISION_CONFLICT", "conflicting writes");
        }
        return inner.persistTransition(input);
      },
    };
    const runtime = createCreateBanContactRuntime({
      sql: base.sql,
      identityStore: base.identityStore,
      productStore: racing,
      directory: base.directory,
      config: base.config,
    });
    const app = await start(runtime);
    await session(app.url, USER_A_TG);
    const conflict = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START"),
    );
    expect(conflict.applicationStatus).toBe("REVISION_CONFLICT");
    expect(conflict.persisted).toBe(false);
    expect(conflict.controlState).toBe("RIM.LOBBY");
    const durable = await snapshot(app.url, USER_A_TG);
    expect(durable.controlState).toBe("RIM.LOBBY");
  });

  it("V. Back restores frozen CONTACT semantics", async () => {
    const app = await start();
    const { diagnostics: confirm } = await reachConfirm(app.url, app, BAN_TEXT, 10);
    expect(confirm.controlState).toBe("CREATE_BAN.CONFIRM.CONTACT");
    const backWhat = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_BACK"),
    );
    expect(backWhat.controlState).toBe("CREATE_BAN.WHAT.CONTACT");
    expect(backWhat.createBanDraft?.banText).toBe(BAN_TEXT);
    expect(backWhat.createBanDraft?.durationMinutes).toBe(10);
    const backWho = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_BACK"));
    expect(backWho.controlState).toBe("CREATE_BAN.WHO");
    expect(backWho.createBanDraft).toEqual({
      origin: "CONTACT",
      selectedContactId: null,
      banText: "",
      durationMinutes: null,
      proposalId: null,
    });
    const backLobby = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_BACK"),
    );
    expect(backLobby.controlState).toBe("RIM.LOBBY");
    expect(backLobby.createBanDraft).toBeNull();
  });

  it("W. CONTACT from RIM.LOBBY does not freeze or destroy RIM chat incorrectly", async () => {
    const app = await start();
    await session(app.url, USER_A_TG);
    const chat = requireDiagnostics(await dispatch(app.url, USER_A_TG, "RIM.PRESS_START_CHAT"));
    expect(chat.controlState).toBe("RIM.CHAT");
    const lobby = requireDiagnostics(await dispatch(app.url, USER_A_TG, "RIM.PRESS_BACK"));
    expect(lobby.controlState).toBe("RIM.LOBBY");
    const who = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START"));
    expect(who.controlState).toBe("CREATE_BAN.WHO");
    expect(who.savedFrozenRimChatPresent).toBe(false);
    const back = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_BACK"));
    expect(back.controlState).toBe("RIM.LOBBY");
    expect(back.savedFrozenRimChatPresent).toBe(false);
  });

  it("K. server failure produces E-11 and no successful Ban", async () => {
    const runtime = createCreateBanContactRuntime({ contactSendCompletion: "failure" });
    await seedRegisteredUsers(runtime);
    const app = await start(runtime);
    await reachConfirm(app.url, app);
    const failed = await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID");
    const diagnostics = requireDiagnostics(failed);
    expect(failed.orchestration?.userEvent.eventName).toBe("CREATE_BAN.PRESS_FORBID");
    expect(failed.orchestration?.userEvent.banCount).toBe(0);
    expect(failed.orchestration?.serverEvent.eventName).toBe("CREATE_BAN.SEND_FAILED");
    expect(diagnostics.lastEvent).toEqual({ id: "E-11", name: "CREATE_BAN.SEND_FAILED" });
    expect(diagnostics.previousEvent).toEqual({ id: "E-08", name: "CREATE_BAN.PRESS_FORBID" });
    expect(diagnostics.controlState).toBe("CREATE_BAN.CONFIRM.CONTACT");
    expect(bansOf(diagnostics)).toEqual([]);
    expect(Object.keys(diagnostics.pendingOperations)).toEqual([]);
  });

  it("rejects client-sent E-10 / E-11 on the public TEST UI transport", async () => {
    const app = await start();
    const blocked10 = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SEND_CONFIRMED", {
      operationId: "operation-1",
      createdBanId: "ban-1",
    });
    expect(blocked10.httpStatus).toBe(400);
    expect(blocked10.error?.code).toBe("SERVER_RESULT_NOT_ACCEPTED");
    const blocked11 = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SEND_FAILED", {
      operationId: "operation-1",
      failure: { code: "SEND_FAILED" },
    });
    expect(blocked11.httpStatus).toBe(400);
    expect(blocked11.error?.code).toBe("SERVER_RESULT_NOT_ACCEPTED");
  });

  it("unauthenticated request is rejected", async () => {
    const app = await start();
    const response = await fetch(`${app.url}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "CREATE_BAN.PRESS_START", payload: {} }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  it("Confirm without a complete valid draft does not create a Ban", async () => {
    const app = await start();
    await session(app.url, USER_A_TG);
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START");
    const forbid = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID"),
    );
    expect(forbid.controlState).toBe("CREATE_BAN.WHO");
    expect(forbid.applicationStatus).toBe("NOT_APPLIED");
    expect(bansOf(forbid)).toEqual([]);
  });

  it("J. TEST UI does not expose E-10/E-11 as user buttons and serves distinct Product Screens", async () => {
    const app = await start();
    const html = await fetch(app.url);
    expect(html.status).toBe(200);
    const page = await html.text();
    expect(page).toContain("98+ TEST UI — implemented through Stage 13A");
    expect(page).toContain("PRODUCT SCREEN");
    expect(page).toContain("MACHINE DIAGNOSTICS");
    expect(page).toContain("DEV / AUTH CONTROLS");
    expect(page).toContain("/test-ui/product-screens.js");
    expect(page).toContain("CREATE_BAN.PRESS_FORBID");
    expect(page).not.toContain("E-10 CREATE_BAN.SEND_CONFIRMED (server result)");
    expect(page).not.toContain("E-11 CREATE_BAN.SEND_FAILED (server result)");
    expect(page).not.toContain('sendEvent("CREATE_BAN.SEND_CONFIRMED"');
    expect(page).not.toContain('sendEvent("CREATE_BAN.SEND_FAILED"');
    const screensJs = await fetch(`${app.url}/test-ui/product-screens.js`);
    expect(screensJs.status).toBe(200);
    const screens = await screensJs.text();
    expect(screens).toContain("LobbyTestScreen");
    expect(screens).toContain("CreateBanWhoTestScreen");
    expect(screens).toContain("CREATE_BAN.PRESS_START");
    expect(screens).toContain("CREATE BAN");
    expect(screens).toContain("TEST_UI_SERVER_RESULT_EVENT_NAMES");
    expect(screens).not.toContain('data-event="CREATE_BAN.SEND_CONFIRMED"');
    expect(screens).not.toContain('data-event="CREATE_BAN.SEND_FAILED"');
    expect(screens).not.toContain('sendEvent("CREATE_BAN.SEND_CONFIRMED"');
    expect(screens).not.toContain('sendEvent("CREATE_BAN.SEND_FAILED"');
    const disk = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../miniapp/src/test-ui.html"),
      "utf8",
    );
    expect(disk).not.toContain("SEND_CONFIRMED (server result)");
    expect(disk).not.toContain("SEND_FAILED (server result)");
  });

  it("P. Ban.receiver_id FK to identity_users remains unchanged", () => {
    expect(productPersistenceSql()).toContain(
      "receiver_id TEXT REFERENCES identity_users (user_id)",
    );
  });

  it("serves frozen meta counts", async () => {
    const app = await start();
    const meta = await fetch(`${app.url}/api/meta`);
    const body = (await meta.json()) as {
      PRODUCT_CONTROL_STATE_COUNT: number;
      CANONICAL_EVENT_COUNT: number;
      MATRIX_RULE_COUNT: number;
      IMPLEMENTATION_STAGE: number;
      IDENTITY_STAGE: number;
      PERSISTENCE_STAGE: number;
      APPLICATION_STAGE: number;
      CREATE_BAN_CONTACT_STAGE: number;
    };
    expect(body).toMatchObject({
      PRODUCT_CONTROL_STATE_COUNT: 30,
      CANONICAL_EVENT_COUNT: 59,
      MATRIX_RULE_COUNT: 358,
      IMPLEMENTATION_STAGE: 2,
      IDENTITY_STAGE: 3,
      PERSISTENCE_STAGE: 4,
      APPLICATION_STAGE: 5,
      CREATE_BAN_CONTACT_STAGE: 6,
    });
  });

  it("Select Contact source is existing identity_users UserId, not Telegram id", () => {
    const listed = listSelectableRegisteredUsers(
      [
        { userId: "user-a" as never, telegramUserId: "1001" },
        { userId: "user-b" as never, telegramUserId: "1002" },
      ],
      "user-a" as never,
    );
    expect(listed).toEqual([{ userId: "user-b", telegramUserId: "1002" }]);
  });
});
