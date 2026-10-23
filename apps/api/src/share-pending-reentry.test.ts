import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySqlClient } from "@98plus/persistence";
import { PersistenceTestKit } from "../../../packages/persistence/src/test-kit.ts";
import {
  emptySnapshot,
  type BanId,
  type ProductSnapshot,
  type ShareAttemptId,
  type UserId,
} from "@98plus/product-model";
import { authContext } from "../../../packages/application/src/test-harness.ts";
import {
  BAN_ID,
  CONTACT_A,
  SHARE_ATTEMPT_ID,
  USER_ID,
  makeBan,
  shareOp,
  withControlState,
  withEntities,
} from "../../../packages/product-model/src/kernel.fixtures.ts";
import { listenCreateBanContactServer } from "./http.ts";
import {
  recoverSharePendingOnReentry,
  resolveSharePendingReentry,
} from "./share-pending-reentry.ts";
import { createCreateBanContactRuntime, userIdOf } from "./runtime.ts";

const SENDER_TG = "share-reentry-sender";
const REPLY_BAN_ID = "ban-reply" as BanId;
const HIST_BAN_ID = "ban-hist" as BanId;
const HIST_SHARE_ID = "share-hist" as ShareAttemptId;
const NEWER_BAN_ID = "ban-newer" as BanId;
const NEWER_SHARE_ID = "share-newer" as ShareAttemptId;

function pendingSnapshot(
  patch?: Partial<{
    controlState: ProductSnapshot["controlState"];
    acceptance: "PENDING" | "ACCEPTED";
    shareStatus: "ACTIVE" | "CONFIRMED";
    senderId: UserId;
    receiverId: UserId;
    successfulBanId: BanId | null;
    shareBanId: BanId | null;
    includeShare: boolean;
    includeBan: boolean;
    replyBan: boolean;
  }>,
): ProductSnapshot {
  const options = {
    controlState: "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING" as ProductSnapshot["controlState"],
    acceptance: "PENDING" as const,
    shareStatus: "ACTIVE" as const,
    senderId: USER_ID,
    receiverId: CONTACT_A,
    successfulBanId: BAN_ID as BanId | null,
    shareBanId: BAN_ID as BanId | null,
    includeShare: true,
    includeBan: true,
    replyBan: false,
    ...patch,
  };
  let snapshot = withControlState(emptySnapshot(), options.controlState);
  const ban = makeBan({
    id: BAN_ID,
    senderId: options.senderId,
    receiverId: options.receiverId,
    acceptance: options.acceptance,
    boundViaTelegramShareLink: options.shareStatus === "CONFIRMED",
  });
  const reply = makeBan({
    id: REPLY_BAN_ID,
    senderId: CONTACT_A,
    receiverId: USER_ID,
    acceptance: "PENDING",
    banText: "reply",
  });
  snapshot = withEntities(snapshot, {
    ...(options.includeBan
      ? { bans: { [BAN_ID]: ban, ...(options.replyBan ? { [REPLY_BAN_ID]: reply } : {}) } }
      : {}),
    ...(options.includeShare
      ? {
          shareOperations: {
            [SHARE_ATTEMPT_ID]: shareOp({
              status: options.shareStatus,
              createdBanId: options.shareBanId,
            }),
          },
        }
      : {}),
  });
  return {
    ...snapshot,
    extended: { ...snapshot.extended, successfulBanId: options.successfulBanId },
  };
}

function withExtraShare(
  snapshot: ProductSnapshot,
  input: {
    banId: BanId;
    attemptId: ShareAttemptId;
    token: string;
    status: "ACTIVE" | "CONFIRMED";
    banText: string;
  },
): ProductSnapshot {
  const ban = makeBan({
    id: input.banId,
    senderId: USER_ID,
    receiverId: CONTACT_A,
    acceptance: "ACCEPTED",
    banText: input.banText,
    boundViaTelegramShareLink: input.status === "CONFIRMED",
  });
  const share = shareOp({
    attemptId: input.attemptId,
    status: input.status,
    createdBanId: input.banId,
    token: input.token as never,
  });
  return {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      entities: {
        ...snapshot.extended.entities,
        bans: { ...snapshot.extended.entities.bans, [input.banId]: ban },
        shareOperations: {
          ...snapshot.extended.entities.shareOperations,
          [input.attemptId]: share,
        },
      },
    },
  };
}

async function expectUnchangedPending(
  runtime: Awaited<ReturnType<typeof installed>>["runtime"],
  beforeRevision: number,
) {
  const after = await runtime.productStore.loadProductSnapshot(USER_ID);
  expect(after.revision).toBe(beforeRevision);
  expect(after.snapshot.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
  return after;
}

async function installed(snapshot: ProductSnapshot) {
  const sql = new MemorySqlClient();
  const runtime = createCreateBanContactRuntime({ sql, telegramSharePrepare: "mock" });
  const kit = PersistenceTestKit.postgres(sql);
  kit.establishIdentity(USER_ID, SENDER_TG);
  kit.establishIdentity(CONTACT_A, "share-reentry-receiver");
  await kit.installFixtureSnapshot(USER_ID, snapshot);
  const context = authContext(USER_ID, SENDER_TG);
  return { runtime, context };
}

describe("share pending re-entry recovery", () => {
  it("ACTIVE share and a persisted Ban recover to Success without another Ban or share", async () => {
    const { runtime, context } = await installed(pendingSnapshot());
    const before = await runtime.productStore.loadProductSnapshot(USER_ID);
    const recovered = await recoverSharePendingOnReentry(runtime, context);
    const after = await runtime.productStore.loadProductSnapshot(USER_ID);
    expect(recovered.status).toBe("RECOVERED");
    expect(after.snapshot.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(Object.keys(after.snapshot.extended.entities.bans)).toEqual([BAN_ID]);
    expect(Object.keys(after.snapshot.extended.entities.shareOperations)).toEqual([
      SHARE_ATTEMPT_ID,
    ]);
    expect(after.snapshot.extended.entities.shareOperations[SHARE_ATTEMPT_ID]?.status).toBe(
      "ACTIVE",
    );
    expect(after.snapshot.extended.entities.bans[BAN_ID]).toEqual(
      before.snapshot.extended.entities.bans[BAN_ID],
    );
    expect(after.revision).toBe(before.revision + 1);
  });

  it("CONFIRMED share recovers to Success and leaves the share confirmed", async () => {
    const { runtime, context } = await installed(
      pendingSnapshot({ shareStatus: "CONFIRMED", acceptance: "PENDING" }),
    );
    expect((await recoverSharePendingOnReentry(runtime, context)).status).toBe("RECOVERED");
    const loaded = await runtime.productStore.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(loaded.snapshot.extended.entities.shareOperations[SHARE_ATTEMPT_ID]?.status).toBe(
      "CONFIRMED",
    );
  });

  it("an accepted Ban recovers to Success", async () => {
    const { runtime, context } = await installed(
      pendingSnapshot({ shareStatus: "CONFIRMED", acceptance: "ACCEPTED" }),
    );
    expect((await recoverSharePendingOnReentry(runtime, context)).status).toBe("RECOVERED");
    const loaded = await runtime.productStore.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(loaded.snapshot.extended.entities.bans[BAN_ID]?.acceptance).toBe("ACCEPTED");
  });

  it("a Reply Ban already on the snapshot recovers to Success without a third Ban", async () => {
    const { runtime, context } = await installed(
      pendingSnapshot({ shareStatus: "CONFIRMED", acceptance: "ACCEPTED", replyBan: true }),
    );
    expect((await recoverSharePendingOnReentry(runtime, context)).status).toBe("RECOVERED");
    const loaded = await runtime.productStore.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(Object.keys(loaded.snapshot.extended.entities.bans).sort()).toEqual(
      [BAN_ID, REPLY_BAN_ID].sort(),
    );
    expect(Object.keys(loaded.snapshot.extended.entities.shareOperations)).toEqual([
      SHARE_ATTEMPT_ID,
    ]);
  });

  it("a repeated re-entry does not dispatch a second E-66", async () => {
    const { runtime, context } = await installed(pendingSnapshot());
    expect((await recoverSharePendingOnReentry(runtime, context)).status).toBe("RECOVERED");
    const once = await runtime.productStore.loadProductSnapshot(USER_ID);
    expect((await recoverSharePendingOnReentry(runtime, context)).status).toBe("NOT_PENDING");
    const twice = await runtime.productStore.loadProductSnapshot(USER_ID);
    expect(twice.revision).toBe(once.revision);
    expect(twice.snapshot.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(Object.keys(twice.snapshot.extended.entities.bans)).toEqual([BAN_ID]);
  });

  it("concurrent re-entry keeps one Ban, one share, and a persisted Success", async () => {
    const { runtime, context } = await installed(pendingSnapshot());
    const results = await Promise.all([
      recoverSharePendingOnReentry(runtime, context),
      recoverSharePendingOnReentry(runtime, context),
    ]);
    const loaded = await runtime.productStore.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(Object.keys(loaded.snapshot.extended.entities.bans)).toEqual([BAN_ID]);
    expect(Object.keys(loaded.snapshot.extended.entities.shareOperations)).toEqual([
      SHARE_ATTEMPT_ID,
    ]);
    expect(results.filter((result) => result.status === "RECOVERED")).toHaveLength(1);
    expect(loaded.revision).toBeGreaterThan(0);
  });

  it("does not recover when the Ban is missing, the share is missing, the sender does not own the Ban, or the share names another Ban", async () => {
    const missingBanSnapshot = pendingSnapshot({ includeBan: false, includeShare: false });
    expect(resolveSharePendingReentry(missingBanSnapshot, USER_ID)).toEqual({
      ok: false,
      code: "BAN_MISSING",
    });
    const missingBan = await installed(missingBanSnapshot);
    const missingBanResult = await recoverSharePendingOnReentry(
      missingBan.runtime,
      missingBan.context,
    );
    expect(missingBanResult).toMatchObject({ status: "NOT_RECOVERABLE", code: "BAN_MISSING" });
    expect(
      (await missingBan.runtime.productStore.loadProductSnapshot(USER_ID)).snapshot.controlState,
    ).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");

    const missingShare = await installed(pendingSnapshot({ includeShare: false }));
    const missingShareResult = await recoverSharePendingOnReentry(
      missingShare.runtime,
      missingShare.context,
    );
    expect(missingShareResult).toMatchObject({ status: "NOT_RECOVERABLE", code: "SHARE_MISSING" });

    const foreign = await installed(pendingSnapshot({ senderId: CONTACT_A, receiverId: USER_ID }));
    const foreignResult = await recoverSharePendingOnReentry(foreign.runtime, foreign.context);
    expect(foreignResult).toMatchObject({
      status: "NOT_RECOVERABLE",
      code: "BAN_SENDER_MISMATCH",
    });

    const otherBan = await installed(
      pendingSnapshot({ shareBanId: REPLY_BAN_ID, includeBan: true, replyBan: true }),
    );
    const mismatch = await recoverSharePendingOnReentry(otherBan.runtime, otherBan.context);
    expect(mismatch).toMatchObject({ status: "NOT_RECOVERABLE", code: "SHARE_BAN_MISMATCH" });
    expect(
      (await otherBan.runtime.productStore.loadProductSnapshot(USER_ID)).snapshot.controlState,
    ).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
  });

  it("does not recover a null successfulBanId from one historical CONFIRMED share", async () => {
    const { runtime, context } = await installed(
      pendingSnapshot({ successfulBanId: null, shareStatus: "CONFIRMED" }),
    );
    const before = await runtime.productStore.loadProductSnapshot(USER_ID);
    const result = await recoverSharePendingOnReentry(runtime, context);
    expect(result).toMatchObject({
      status: "NOT_RECOVERABLE",
      code: "SUCCESSFUL_BAN_ID_MISSING",
    });
    const after = await expectUnchangedPending(runtime, before.revision);
    expect(after.snapshot.extended.entities.shareOperations[SHARE_ATTEMPT_ID]?.status).toBe(
      "CONFIRMED",
    );
  });

  it("does not recover a null successfulBanId from one historical ACTIVE share", async () => {
    const { runtime, context } = await installed(
      pendingSnapshot({ successfulBanId: null, shareStatus: "ACTIVE" }),
    );
    const before = await runtime.productStore.loadProductSnapshot(USER_ID);
    const result = await recoverSharePendingOnReentry(runtime, context);
    expect(result).toMatchObject({
      status: "NOT_RECOVERABLE",
      code: "SUCCESSFUL_BAN_ID_MISSING",
    });
    const after = await expectUnchangedPending(runtime, before.revision);
    expect(after.snapshot.extended.entities.shareOperations[SHARE_ATTEMPT_ID]?.status).toBe(
      "ACTIVE",
    );
  });

  it("does not recover a null successfulBanId when a newer unrelated share is also present", async () => {
    const snapshot = withExtraShare(
      pendingSnapshot({ successfulBanId: null, shareStatus: "CONFIRMED" }),
      {
        banId: NEWER_BAN_ID,
        attemptId: NEWER_SHARE_ID,
        token: "share-token-newer",
        status: "ACTIVE",
        banText: "newer",
      },
    );
    const { runtime, context } = await installed(snapshot);
    const before = await runtime.productStore.loadProductSnapshot(USER_ID);
    const result = await recoverSharePendingOnReentry(runtime, context);
    expect(result).toMatchObject({
      status: "NOT_RECOVERABLE",
      code: "SUCCESSFUL_BAN_ID_MISSING",
    });
    const after = await expectUnchangedPending(runtime, before.revision);
    expect(Object.keys(after.snapshot.extended.entities.shareOperations).sort()).toEqual(
      [NEWER_SHARE_ID, SHARE_ATTEMPT_ID].sort(),
    );
    expect(after.snapshot.extended.entities.shareOperations[NEWER_SHARE_ID]?.status).toBe("ACTIVE");
    expect(after.snapshot.extended.entities.shareOperations[SHARE_ATTEMPT_ID]?.status).toBe(
      "CONFIRMED",
    );
  });

  it("recovers only the Ban named by successfulBanId when unrelated historical shares exist", async () => {
    const snapshot = withExtraShare(pendingSnapshot(), {
      banId: HIST_BAN_ID,
      attemptId: HIST_SHARE_ID,
      token: "share-token-hist",
      status: "CONFIRMED",
      banText: "historical",
    });
    const { runtime, context } = await installed(snapshot);
    const recovered = await recoverSharePendingOnReentry(runtime, context);
    expect(recovered.status).toBe("RECOVERED");
    if (recovered.status === "RECOVERED") {
      expect(recovered.execution.effects).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "SET_CONTROL_STATE" })]),
      );
    }
    const loaded = await runtime.productStore.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(loaded.snapshot.extended.successfulBanId).toBe(BAN_ID);
    expect(Object.keys(loaded.snapshot.extended.entities.bans).sort()).toEqual(
      [BAN_ID, HIST_BAN_ID].sort(),
    );
    expect(loaded.snapshot.extended.entities.shareOperations[SHARE_ATTEMPT_ID]?.status).toBe(
      "ACTIVE",
    );
    expect(loaded.snapshot.extended.entities.shareOperations[SHARE_ATTEMPT_ID]?.createdBanId).toBe(
      BAN_ID,
    );
    expect(loaded.snapshot.extended.entities.shareOperations[HIST_SHARE_ID]?.status).toBe(
      "CONFIRMED",
    );
    expect(loaded.snapshot.extended.entities.shareOperations[HIST_SHARE_ID]?.createdBanId).toBe(
      HIST_BAN_ID,
    );
  });

  it("does not recover when successfulBanId has no matching share, even if a historical share exists", async () => {
    const snapshot = withExtraShare(pendingSnapshot({ includeShare: false }), {
      banId: HIST_BAN_ID,
      attemptId: HIST_SHARE_ID,
      token: "share-token-hist",
      status: "CONFIRMED",
      banText: "historical",
    });
    const { runtime, context } = await installed(snapshot);
    const before = await runtime.productStore.loadProductSnapshot(USER_ID);
    const result = await recoverSharePendingOnReentry(runtime, context);
    expect(result).toMatchObject({ status: "NOT_RECOVERABLE", code: "SHARE_BAN_MISMATCH" });
    const after = await expectUnchangedPending(runtime, before.revision);
    expect(after.snapshot.extended.successfulBanId).toBe(BAN_ID);
    expect(after.snapshot.extended.entities.shareOperations[HIST_SHARE_ID]?.createdBanId).toBe(
      HIST_BAN_ID,
    );
    expect(Object.keys(after.snapshot.extended.entities.shareOperations)).toEqual([HIST_SHARE_ID]);
  });

  it("does not dispatch when the sender is already in Success", async () => {
    const { runtime, context } = await installed(
      pendingSnapshot({ controlState: "CREATE_BAN.SUCCESS" }),
    );
    const before = await runtime.productStore.loadProductSnapshot(USER_ID);
    expect(resolveSharePendingReentry(before.snapshot, USER_ID)).toEqual({
      ok: false,
      code: "NOT_PENDING",
    });
    expect((await recoverSharePendingOnReentry(runtime, context)).status).toBe("NOT_PENDING");
    const after = await runtime.productStore.loadProductSnapshot(USER_ID);
    expect(after.revision).toBe(before.revision);
    expect(after.snapshot.controlState).toBe("CREATE_BAN.SUCCESS");
  });

  it("does not call Telegram Share and does not report a missing prepared message id", () => {
    const source = readFileSync(new URL("./share-pending-reentry.ts", import.meta.url), "utf8");
    expect(source).not.toContain("shareMessage");
    expect(source).not.toContain("savePreparedInlineMessage");
    expect(source).not.toContain("TELEGRAM_SHARE_PREPARE_MISSING");
    expect(source).not.toContain("buildTelegramShareInvocation");
  });
});

describe("session re-entry HTTP", () => {
  const started: Array<Awaited<ReturnType<typeof listenCreateBanContactServer>>> = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    while (started.length > 0) {
      const app = started.pop();
      if (app) {
        await app.close();
      }
    }
  });

  it("a new HTTP session recovers an interrupted SHARE_PENDING sender without the Mini App", async () => {
    const telegramCalls: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        url.includes("api.telegram.org") ||
        url.includes("savePreparedInlineMessage") ||
        url.includes("shareMessage")
      ) {
        telegramCalls.push(url);
      }
      return realFetch(input, init);
    });
    const app = await listenCreateBanContactServer({
      runtime: createCreateBanContactRuntime({ telegramSharePrepare: "mock" }),
      seedTelegramUserIds: ["1001"],
    });
    started.push(app);
    const headers = {
      "content-type": "application/json",
      "x-98-auth-method": "development",
      "x-98-dev-secret": "test-secret",
      "x-98-dev-telegram-user-id": "1001",
    };
    await fetch(`${app.url}/api/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ openIfNeeded: true }),
    });
    type ForbidBody = {
      executionStatus: string;
      diagnostics: {
        controlState: string;
        successfulBanId: string | null;
        lastEvent: { name: string } | null;
        bans: Array<{ id: string }>;
        shareOperations: Array<{ attemptId: string; status: string; createdBanId: string | null }>;
      };
    };
    let forbid: ForbidBody | null = null;
    for (const name of [
      "CREATE_BAN.PRESS_START",
      "CREATE_BAN.SELECT_TEMPLATE",
      "CREATE_BAN.CHANGE_BAN_TEXT",
      "CREATE_BAN.CHANGE_DURATION",
      "CREATE_BAN.PRESS_NEXT",
      "CREATE_BAN.PRESS_FORBID",
    ]) {
      const payload =
        name === "CREATE_BAN.SELECT_TEMPLATE"
          ? { templateContext: {} }
          : name === "CREATE_BAN.CHANGE_BAN_TEXT"
            ? { banText: "reentry ban" }
            : name === "CREATE_BAN.CHANGE_DURATION"
              ? { durationMinutes: 10 }
              : {};
      const response = await fetch(`${app.url}/api/events`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, payload }),
      });
      expect(response.status).toBe(200);
      if (name === "CREATE_BAN.PRESS_FORBID") {
        forbid = (await response.json()) as ForbidBody;
      }
    }
    expect(forbid?.executionStatus).toBe("APPLIED");
    expect(forbid?.diagnostics.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(forbid?.diagnostics.lastEvent?.name).toBe("CREATE_BAN.PRESS_FORBID");
    const banId = forbid?.diagnostics.bans[0]?.id;
    const shareAttemptId = forbid?.diagnostics.shareOperations[0]?.attemptId;
    expect(forbid?.diagnostics.bans).toHaveLength(1);
    expect(forbid?.diagnostics.successfulBanId).toBe(banId);
    expect(forbid?.diagnostics.shareOperations).toEqual([
      expect.objectContaining({
        attemptId: shareAttemptId,
        status: "ACTIVE",
        createdBanId: banId,
      }),
    ]);

    const snapshotResponse = await fetch(`${app.url}/api/snapshot`, { headers });
    const snapshot = (await snapshotResponse.json()) as {
      diagnostics: {
        controlState: string;
        successfulBanId: string | null;
        revision: number;
        lastEvent: { name: string } | null;
        bans: Array<{ id: string }>;
        shareOperations: Array<{ attemptId: string; status: string; createdBanId: string | null }>;
      };
    };
    expect(snapshot.diagnostics.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(snapshot.diagnostics.successfulBanId).toBe(banId);
    expect(snapshot.diagnostics.lastEvent).toBeNull();
    expect(snapshot.diagnostics.bans.map((ban) => ban.id)).toEqual([banId]);
    expect(snapshot.diagnostics.shareOperations).toEqual([
      expect.objectContaining({ attemptId: shareAttemptId, status: "ACTIVE", createdBanId: banId }),
    ]);

    const reentered = await fetch(`${app.url}/api/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ openIfNeeded: true }),
    });
    const body = (await reentered.json()) as {
      diagnostics: {
        controlState: string;
        successfulBanId: string | null;
        lastEvent: { name: string } | null;
        applicationStatus: string;
        persisted: boolean;
        revision: number;
        error: { code?: string } | null;
        telegramShare: unknown;
        bans: Array<{ id: string }>;
        shareOperations: Array<{ attemptId: string; status: string; createdBanId: string | null }>;
      };
    };
    expect(reentered.status).toBe(200);
    expect(body.diagnostics.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(body.diagnostics.lastEvent?.name).toBe("CREATE_BAN.SHARE_RETURNED");
    expect(body.diagnostics.applicationStatus).toBe("APPLIED");
    expect(body.diagnostics.persisted).toBe(true);
    expect(body.diagnostics.revision).toBe(snapshot.diagnostics.revision + 1);
    expect(body.diagnostics.successfulBanId).toBe(banId);
    expect(body.diagnostics.bans.map((ban) => ban.id)).toEqual([banId]);
    expect(body.diagnostics.shareOperations).toEqual([
      expect.objectContaining({ attemptId: shareAttemptId, status: "ACTIVE", createdBanId: banId }),
    ]);
    expect(body.diagnostics.error?.code ?? null).not.toBe("TELEGRAM_SHARE_PREPARE_MISSING");
    expect(body.diagnostics.telegramShare ?? null).toBeNull();
    expect(telegramCalls).toEqual([]);

    const again = await fetch(`${app.url}/api/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ openIfNeeded: true }),
    });
    const second = (await again.json()) as {
      diagnostics: {
        controlState: string;
        lastEvent: { name: string } | null;
        applicationStatus: string;
        persisted: boolean;
        revision: number;
        bans: Array<{ id: string }>;
        shareOperations: Array<{ attemptId: string }>;
      };
    };
    expect(second.diagnostics.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(second.diagnostics.lastEvent?.name ?? null).not.toBe("CREATE_BAN.SHARE_RETURNED");
    expect(second.diagnostics.persisted).toBe(false);
    expect(second.diagnostics.revision).toBe(body.diagnostics.revision);
    expect(second.diagnostics.bans.map((ban) => ban.id)).toEqual([banId]);
    expect(second.diagnostics.shareOperations.map((share) => share.attemptId)).toEqual([
      shareAttemptId,
    ]);
    const senderId = await userIdOf(app.runtime, "1001");
    const stored = await app.runtime.productStore.loadProductSnapshot(senderId!);
    expect(stored.snapshot.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(stored.revision).toBe(body.diagnostics.revision);
    expect(telegramCalls).toEqual([]);
  });
});
