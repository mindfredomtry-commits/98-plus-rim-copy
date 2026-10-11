import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asTelegramUserId, PostgresIdentityStore } from "@98plus/identity";
import {
  openPostgresPersistence,
  PostgresProductStore,
  SQL,
  type PostgresPersistence,
} from "@98plus/persistence";
import { PersistenceTestKit } from "../../../persistence/src/test-kit.ts";
import {
  CANONICAL_EVENT_COUNT,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  asInstant,
  counterAllocator,
  emptySnapshot,
  reduce,
  type AiRequestId,
  type BanId,
  type CheckPair,
  type CheckPairId,
  type ContextRequestId,
  type DomainTimerId,
  type DurationMinutes,
  type NotificationItemId,
  type OperationId,
  type ProductSnapshot,
  type RimChat,
  type RimChatId,
  type ShareAttemptId,
  type ShareLinkId,
  type ShareOperation,
  type UserId,
} from "@98plus/product-model";
import {
  branded,
  checkItem,
  eventOf,
  kernelContext,
  makeBan,
  makeChat,
  makeTimer,
  pendingAi,
  pendingOp,
  readyContext,
  shareOp,
  validCreateDraft,
  withChat,
  withControlState,
  withEntities,
  withOperation,
} from "../../../product-model/src/kernel.fixtures.ts";
import { executeProductEvent, executeTemplateShareClaim } from "../execute.ts";
import { authContext } from "../test-harness.ts";
import { recoverPendingRimAi } from "./recover-pending-rim-ai.ts";
import { parseRimProviderRuntime } from "./rim-provider-runtime.ts";
import type {
  ProviderConversationId,
  ProviderResponseId,
  RimProviderAttempt,
  RimProviderAttemptId,
  RimProviderRuntime,
} from "./rim-provider-runtime.ts";
import type { WorkerJob, WorkerResult } from "./postgres-multiprocess.worker.ts";

const databaseUrl = process.env.MVP17_TEST_DATABASE_URL;

type Actor = Readonly<{ userId: UserId; telegram: string }>;

type Runtime = Readonly<{
  name: "a" | "b";
  db: PostgresPersistence;
  store: PostgresProductStore;
  kill(): Promise<void>;
}>;

function assertSchemaName(schema: string): void {
  if (!/^mvp17_[0-9a-f]+$/.test(schema)) {
    throw new Error("refusing to interpolate an unexpected schema name");
  }
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tokenOf(value: string): ShareOperation["token"] {
  return value as unknown as ShareOperation["token"];
}

function attempt(value: string): RimProviderAttemptId {
  return value as RimProviderAttemptId;
}

function conversation(value: string): ProviderConversationId {
  return value as ProviderConversationId;
}

function response(value: string): ProviderResponseId {
  return value as ProviderResponseId;
}

describe("multi-process boundary keeps the frozen Product engine", () => {
  it("keeps 30 states, 60 events, and 360 matrix rows", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(60);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(360);
  });
});

describe.skipIf(!databaseUrl)("two isolated API runtimes on one PostgreSQL database", () => {
  const schema = `mvp17_${randomUUID().replaceAll("-", "")}`;
  let admin: PostgresPersistence;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error("MVP17_TEST_DATABASE_URL is required");
    }
    assertSchemaName(schema);
    admin = openPostgresPersistence({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema} -c application_name=mvp17_pass6_admin`,
    });
    await admin.sql.query(`CREATE SCHEMA ${schema}`, []);
    await admin.sql.query(`SET search_path TO ${schema}`, []);
    await admin.applyMigrations();
  }, 30_000);

  afterAll(async () => {
    if (!admin) {
      return;
    }
    assertSchemaName(schema);
    await admin.sql.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
    await admin.close();
  });

  async function startRuntime(name: "a" | "b"): Promise<Runtime> {
    if (!databaseUrl) {
      throw new Error("MVP17_TEST_DATABASE_URL is required");
    }
    const db = openPostgresPersistence({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema} -c application_name=mvp17_pass6_${name}`,
    });
    return {
      name,
      db,
      store: new PostgresProductStore(db.sql),
      async kill() {
        await db.close();
      },
    };
  }

  async function actor(label: string): Promise<Actor> {
    const telegram = `${label}-${randomUUID()}`;
    const user = await new PostgresIdentityStore(admin.sql).resolveByTelegramUserId(
      asTelegramUserId(telegram),
    );
    return { userId: user.userId, telegram };
  }

  async function seed(userId: UserId, snapshot: ProductSnapshot, runtime?: RimProviderRuntime) {
    const saved = await PersistenceTestKit.postgres(admin.sql).installFixtureSnapshot(
      userId,
      snapshot,
    );
    if (runtime) {
      await new PostgresProductStore(admin.sql).saveRimProviderRuntime(
        userId,
        saved.revision,
        runtime,
      );
    }
    return saved;
  }

  async function contend<T>(
    lockSql: string,
    lockParams: readonly unknown[],
    run: () => Promise<T>,
  ): Promise<T> {
    const held = deferred();
    const release = deferred();
    const holder = admin.sql.transaction(async (tx) => {
      await tx.query(lockSql, lockParams);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const pending = run();
    release.resolve();
    try {
      return await pending;
    } finally {
      await holder;
    }
  }

  function checkWorld(receiverId: UserId, senderId: UserId) {
    const pairId = branded<CheckPairId>(`pair-${randomUUID()}`);
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const receiverItem = branded<NotificationItemId>(`${pairId}-receiver`);
    const senderItem = branded<NotificationItemId>(`${pairId}-sender`);
    const pair: CheckPair = {
      id: pairId,
      banId,
      receiverItemId: receiverItem,
      senderItemId: senderItem,
      receiverAnswer: null,
      senderAnswer: null,
      resultingStatus: null,
    };
    const receiver = checkItem("RECEIVER", {
      id: receiverItem,
      ownerId: receiverId,
      banId,
      checkPairId: pairId,
      lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
    });
    const sender = checkItem("SENDER", {
      id: senderItem,
      ownerId: senderId,
      banId,
      checkPairId: pairId,
    });
    let receiverWorld = withEntities(
      withControlState(emptySnapshot(), "NOTIFICATIONS.CHECK.RECEIVER"),
      {
        bans: {
          [banId]: makeBan({ id: banId, senderId, receiverId, acceptance: "ACCEPTED" }),
        },
        checkPairs: { [pairId]: pair },
        notificationItems: { [receiver.id]: receiver, [sender.id]: sender },
      },
    );
    receiverWorld = {
      ...receiverWorld,
      extended: { ...receiverWorld.extended, activeNotificationItemId: receiver.id },
    };
    receiverWorld = withOperation(
      receiverWorld,
      pendingOp({
        operationId: branded<OperationId>(`op-${pairId}-receiver`),
        kind: "CHECK_ANSWER",
        originatingState: "NOTIFICATIONS.CHECK.RECEIVER",
        originatingItemId: receiver.id,
      }),
    );
    const activeSender = {
      ...sender,
      lifecycle: { status: "UNPROCESSED" as const, display: "ACTIVE" as const },
    };
    let senderWorld = withEntities(
      withControlState(emptySnapshot(), "NOTIFICATIONS.CHECK.SENDER"),
      {
        bans: receiverWorld.extended.entities.bans,
        checkPairs: { [pairId]: pair },
        notificationItems: { [receiver.id]: receiver, [activeSender.id]: activeSender },
      },
    );
    senderWorld = {
      ...senderWorld,
      extended: { ...senderWorld.extended, activeNotificationItemId: activeSender.id },
    };
    senderWorld = withOperation(
      senderWorld,
      pendingOp({
        operationId: branded<OperationId>(`op-${pairId}-sender`),
        kind: "CHECK_ANSWER",
        originatingState: "NOTIFICATIONS.CHECK.SENDER",
        originatingItemId: activeSender.id,
      }),
    );
    return { pairId, banId, receiverWorld, senderWorld };
  }

  function child(job: Omit<WorkerJob, "databaseUrl" | "schema">): {
    child: ChildProcess;
    provider: Promise<void>;
    done: Promise<WorkerResult>;
    release(): void;
  } {
    if (!databaseUrl) {
      throw new Error("MVP17_TEST_DATABASE_URL is required");
    }
    const worker = fileURLToPath(new URL("./postgres-multiprocess.worker.ts", import.meta.url));
    const processChild = fork(worker, [], {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, MVP17_MULTIPROCESS_WORKER: "1" },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    let settled = false;
    const provider = new Promise<void>((resolve, reject) => {
      processChild.once("exit", (code) => {
        if (!settled && code !== 0) {
          reject(new Error(`worker exited ${code} before the provider call`));
        }
      });
      processChild.on("message", (message: { phase?: string }) => {
        if (message.phase === "provider") {
          resolve();
        }
      });
    });
    const done = new Promise<WorkerResult>((resolve, reject) => {
      processChild.on(
        "message",
        (message: { phase?: string; result?: WorkerResult; message?: string }) => {
          if (message.phase === "result" && message.result) {
            settled = true;
            resolve(message.result);
          }
          if (message.phase === "error") {
            settled = true;
            reject(new Error(message.message ?? "worker failed"));
          }
        },
      );
      processChild.once("exit", (code) => {
        if (!settled) {
          reject(new Error(`worker exited ${code}`));
        }
      });
    });
    processChild.send({
      cmd: "run",
      job: { ...job, databaseUrl, schema },
    });
    return {
      child: processChild,
      provider,
      done,
      release() {
        if (processChild.connected) {
          processChild.send({ cmd: "release" });
        }
      },
    };
  }

  it("uses separate pools and stores that share only PostgreSQL", async () => {
    const first = await startRuntime("a");
    const second = await startRuntime("b");
    expect(first.db).not.toBe(second.db);
    expect(first.store).not.toBe(second.store);
    await first.db.sql.query("SELECT 1", []);
    await second.db.sql.query("SELECT 1", []);
    expect(first.db.stats().total).toBeGreaterThan(0);
    expect(second.db.stats().total).toBeGreaterThan(0);
    await first.kill();
    await expect(first.db.sql.query("SELECT 1", [])).rejects.toThrow();
    await expect(second.db.sql.query("SELECT 1", [])).resolves.toBeTruthy();
    await second.kill();
  });

  it("lets one stale revision win across pools and drops the loser's rows", async () => {
    const user = await actor("cas-user");
    const receiver = await actor("cas-receiver");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const timerId = branded<DomainTimerId>(`timer-${randomUUID()}`);
    const seeded = await seed(
      user.userId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: {
          [banId]: makeBan({ id: banId, senderId: user.userId, receiverId: receiver.userId }),
        },
        domainTimers: {
          [timerId]: makeTimer({ id: timerId, banId, startedAt: asInstant(0) }),
        },
      }),
    );
    const expired = reduce(seeded.snapshot, eventOf("BAN.DURATION_EXPIRED", { banId }), {
      ...kernelContext(),
      currentUserId: user.userId,
      allocateId: counterAllocator(1),
    });
    const closed = reduce(seeded.snapshot, eventOf("APP.FULL_CLOSE", {}), {
      ...kernelContext(),
      currentUserId: user.userId,
      allocateId: counterAllocator(2),
    });
    expect(expired.outcome).toBe("APPLIED");
    expect(closed.outcome).toBe("APPLIED");
    const first = await startRuntime("a");
    const second = await startRuntime("b");
    const settled = await contend(SQL.selectSessionForUpdate, [user.userId], () =>
      Promise.allSettled([
        first.store.persistTransition({
          currentUserId: user.userId,
          expectedRevision: seeded.revision,
          result: expired,
        }),
        second.store.persistTransition({
          currentUserId: user.userId,
          expectedRevision: seeded.revision,
          result: closed,
        }),
      ]),
    );
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.find((item) => item.status === "rejected")).toMatchObject({
      reason: { code: "REVISION_CONFLICT" },
    });
    const loadedA = await first.store.loadProductSnapshot(user.userId);
    const loadedB = await second.store.loadProductSnapshot(user.userId);
    expect(loadedB.revision).toBe(loadedA.revision);
    expect(loadedB.snapshot.controlState).toBe(loadedA.snapshot.controlState);
    expect(loadedA.revision).toBe(seeded.revision + 1);
    const winner = settled.find((item) => item.status === "fulfilled");
    const winnerSnapshot = winner?.status === "fulfilled" ? winner.value.snapshot : null;
    const loser =
      expired.snapshot.controlState === loadedA.snapshot.controlState ? closed : expired;
    for (const pairId of Object.keys(loser.snapshot.extended.entities.checkPairs)) {
      if (!winnerSnapshot?.extended.entities.checkPairs[pairId as CheckPairId]) {
        expect(
          loadedA.snapshot.extended.entities.checkPairs[pairId as CheckPairId],
        ).toBeUndefined();
      }
    }
    expect(loadedA.snapshot.extended.entities.checkPairs).toEqual(
      winnerSnapshot?.extended.entities.checkPairs,
    );
    await first.kill();
    await second.kill();
  });

  it("persists one Create Ban when two runtimes confirm the same revision", async () => {
    const sender = await actor("create-sender");
    const receiver = await actor("create-receiver");
    const operationId = branded<OperationId>(`op-${randomUUID()}`);
    const firstBan = branded<BanId>(`ban-${randomUUID()}`);
    const secondBan = branded<BanId>(`ban-${randomUUID()}`);
    let world = withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.CONTACT");
    world = {
      ...world,
      extended: {
        ...world.extended,
        createBanDraft: {
          ...validCreateDraft("CONTACT"),
          selectedContactId: receiver.userId,
          durationMinutes: 3 as DurationMinutes,
        },
      },
    };
    const seeded = await seed(sender.userId, withOperation(world, pendingOp({ operationId })));
    const firstResult = reduce(
      seeded.snapshot,
      eventOf("CREATE_BAN.SEND_CONFIRMED", { operationId, createdBanId: firstBan }),
      { ...kernelContext(), currentUserId: sender.userId, allocateId: counterAllocator(11) },
    );
    const secondResult = reduce(
      seeded.snapshot,
      eventOf("CREATE_BAN.SEND_CONFIRMED", { operationId, createdBanId: secondBan }),
      { ...kernelContext(), currentUserId: sender.userId, allocateId: counterAllocator(12) },
    );
    expect(firstResult.outcome).toBe("APPLIED");
    expect(secondResult.outcome).toBe("APPLIED");
    const runtimeA = await startRuntime("a");
    const runtimeB = await startRuntime("b");
    const settled = await contend(SQL.selectSessionForUpdate, [sender.userId], () =>
      Promise.allSettled([
        runtimeA.store.persistTransition({
          currentUserId: sender.userId,
          expectedRevision: seeded.revision,
          result: firstResult,
        }),
        runtimeB.store.persistTransition({
          currentUserId: sender.userId,
          expectedRevision: seeded.revision,
          result: secondResult,
        }),
      ]),
    );
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.find((item) => item.status === "rejected")).toMatchObject({
      reason: { code: "REVISION_CONFLICT" },
    });
    const rows = await admin.sql.query<{ ban_id: string }>(
      "SELECT ban_id FROM bans WHERE sender_id = $1",
      [sender.userId],
    );
    expect(rows.rows).toHaveLength(1);
    const winner = rows.rows[0]?.ban_id;
    expect([firstBan, secondBan]).toContain(winner);
    const loser = winner === firstBan ? secondBan : firstBan;
    expect(rows.rows.map((row) => row.ban_id)).not.toContain(loser);
    const loadedA = await runtimeA.store.loadProductSnapshot(sender.userId);
    const loadedB = await runtimeB.store.loadProductSnapshot(sender.userId);
    expect(loadedA.revision).toBe(loadedB.revision);
    expect(loadedA.snapshot.extended.entities.bans[winner as BanId]?.id).toBe(winner);
    expect(loadedB.snapshot.extended.entities.bans[loser]).toBeUndefined();
    await runtimeA.kill();
    await runtimeB.kill();
  });

  it("lets one isolated runtime claim an active share", async () => {
    const sender = await actor("share-sender");
    const firstReceiver = await actor("share-first");
    const secondReceiver = await actor("share-second");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const attemptId = branded<ShareOperation["attemptId"]>(`attempt-${randomUUID()}`);
    const token = `token-${randomUUID()}`;
    await seed(
      sender.userId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: {
          [banId]: makeBan({
            id: banId,
            senderId: sender.userId,
            receiverId: null,
            acceptance: "PENDING",
            status: null,
            boundViaTelegramShareLink: false,
          }),
        },
        shareOperations: {
          [attemptId]: shareOp({ attemptId, token: tokenOf(token), createdBanId: banId }),
        },
      }),
    );
    await seed(firstReceiver.userId, withControlState(emptySnapshot(), "RIM.LOBBY"));
    await seed(secondReceiver.userId, withControlState(emptySnapshot(), "RIM.LOBBY"));
    const runtimeA = await startRuntime("a");
    const runtimeB = await startRuntime("b");
    const reduces = { a: 0, b: 0 };
    const claimFor = (runtime: Runtime, receiverId: UserId, bucket: "a" | "b") =>
      runtime.store.claimTemplateShare({
        receiverId,
        token,
        reduceClaim: (context) => {
          reduces[bucket] += 1;
          return reduce(
            withEntities(context.receiver.snapshot, {
              shareOperations: { [context.share.attemptId]: context.share },
            }),
            eventOf("TELEGRAM_SHARE_LINK.RESOLVED", {
              targetBanId: banId,
              receiverId,
              incomingBanItemId: branded<NotificationItemId>(`incoming-${bucket}-${randomUUID()}`),
              shareAttemptId: attemptId,
              shareOwnerId: sender.userId,
            }),
            {
              ...kernelContext(),
              currentUserId: receiverId,
              allocateId: counterAllocator(bucket === "a" ? 21 : 22),
            },
          );
        },
      });
    const settled = await contend(SQL.selectShareByTokenForUpdate, [token], () =>
      Promise.all([
        claimFor(runtimeA, firstReceiver.userId, "a"),
        claimFor(runtimeB, secondReceiver.userId, "b"),
      ]),
    );
    const claimed = settled.filter((item) => item.status === "CLAIMED");
    const lost = settled.filter((item) => item.status === "CONFLICT");
    expect(claimed).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(reduces.a + reduces.b).toBe(1);
    const share = await admin.sql.query<{ status: string; created_ban_id: string }>(
      "SELECT status, created_ban_id FROM share_operations WHERE token = $1",
      [token],
    );
    expect(share.rows).toEqual([{ status: "CONFIRMED", created_ban_id: banId }]);
    const ban = await runtimeA.store.getBanById(banId);
    const banOnB = await runtimeB.store.getBanById(banId);
    expect(ban?.receiverId).toBe(banOnB?.receiverId);
    expect([firstReceiver.userId, secondReceiver.userId]).toContain(ban?.receiverId);
    const incoming = await admin.sql.query(
      "SELECT item_id FROM notification_items WHERE ban_id = $1 AND kind = 'INCOMING_BAN'",
      [banId],
    );
    expect(incoming.rows).toHaveLength(1);
    await runtimeA.kill();
    await runtimeB.kill();
  });

  it("keeps CheckPair invariants across two pools", async () => {
    const receiver = await actor("check-receiver");
    const sender = await actor("check-sender");
    const world = checkWorld(receiver.userId, sender.userId);
    const receiverSeed = await seed(receiver.userId, world.receiverWorld);
    await seed(sender.userId, world.senderWorld);
    const runtimeA = await startRuntime("a");
    const runtimeB = await startRuntime("b");
    const fulfilled = reduce(
      receiverSeed.snapshot,
      eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
        checkItemId: branded<NotificationItemId>(`${world.pairId}-receiver`),
        answer: "FULFILLED",
        checkPairId: world.pairId,
      }),
      { ...kernelContext(), currentUserId: receiver.userId, allocateId: counterAllocator(31) },
    );
    const declined = reduce(
      receiverSeed.snapshot,
      eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
        checkItemId: branded<NotificationItemId>(`${world.pairId}-receiver`),
        answer: "NOT_FULFILLED",
        checkPairId: world.pairId,
      }),
      { ...kernelContext(), currentUserId: receiver.userId, allocateId: counterAllocator(32) },
    );
    expect(fulfilled.outcome).toBe("APPLIED");
    expect(declined.outcome).toBe("APPLIED");
    const same = await contend(SQL.selectSessionForUpdate, [receiver.userId], () =>
      Promise.allSettled([
        runtimeA.store.persistTransition({
          currentUserId: receiver.userId,
          expectedRevision: receiverSeed.revision,
          result: fulfilled,
        }),
        runtimeB.store.persistTransition({
          currentUserId: receiver.userId,
          expectedRevision: receiverSeed.revision,
          result: fulfilled,
        }),
      ]),
    );
    expect(same.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(same.find((item) => item.status === "rejected")).toMatchObject({
      reason: { code: "REVISION_CONFLICT" },
    });
    const current = await runtimeA.store.loadProductSnapshot(receiver.userId);
    await expect(
      runtimeB.store.persistTransition({
        currentUserId: receiver.userId,
        expectedRevision: current.revision,
        result: declined,
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    const pair = (await runtimeB.store.loadProductSnapshot(receiver.userId)).snapshot.extended
      .entities.checkPairs[world.pairId];
    expect(pair).toMatchObject({
      receiverAnswer: "FULFILLED",
      senderAnswer: null,
      resultingStatus: null,
    });

    const both = checkWorld(
      (await actor("both-receiver")).userId,
      (await actor("both-sender")).userId,
    );
    await seed(
      both.receiverWorld.extended.entities.bans[both.banId]!.receiverId!,
      both.receiverWorld,
    );
    const bothSender = both.senderWorld.extended.entities.bans[both.banId]!.senderId;
    await seed(bothSender, both.senderWorld);
    const names = await contend(SQL.selectPairForUpdate, [both.pairId], () =>
      Promise.all([
        runtimeA.store.withCheckPairLock(
          both.pairId,
          both.banId,
          both.receiverWorld.extended.entities.bans[both.banId]!.receiverId!,
          async (ctx) => {
            const currentUserId =
              both.receiverWorld.extended.entities.bans[both.banId]!.receiverId!;
            const loaded = await ctx.loadProductSnapshot(currentUserId);
            const seen = ctx.pair ?? loaded.snapshot.extended.entities.checkPairs[both.pairId]!;
            const event =
              seen.senderAnswer === null
                ? eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
                    checkItemId: branded<NotificationItemId>(`${both.pairId}-receiver`),
                    answer: "FULFILLED",
                    checkPairId: both.pairId,
                  })
                : eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND", {
                    checkItemId: branded<NotificationItemId>(`${both.pairId}-receiver`),
                    answer: "FULFILLED",
                    checkPairId: both.pairId,
                    resultingStatus: seen.senderAnswer === "FULFILLED" ? "BANTASTIC" : "BANFLICT",
                  });
            const result = reduce(loaded.snapshot, event, {
              ...kernelContext(),
              currentUserId,
              allocateId: counterAllocator(41),
            });
            expect(result.outcome).toBe("APPLIED");
            await ctx.persistTransition({
              currentUserId,
              expectedRevision: loaded.revision,
              result,
            });
            return event.name;
          },
        ),
        runtimeB.store.withCheckPairLock(both.pairId, both.banId, bothSender, async (ctx) => {
          const loaded = await ctx.loadProductSnapshot(bothSender);
          const seen = ctx.pair ?? loaded.snapshot.extended.entities.checkPairs[both.pairId]!;
          const event =
            seen.receiverAnswer === null
              ? eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
                  checkItemId: branded<NotificationItemId>(`${both.pairId}-sender`),
                  answer: "NOT_FULFILLED",
                  checkPairId: both.pairId,
                })
              : eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND", {
                  checkItemId: branded<NotificationItemId>(`${both.pairId}-sender`),
                  answer: "NOT_FULFILLED",
                  checkPairId: both.pairId,
                  resultingStatus:
                    seen.receiverAnswer === "NOT_FULFILLED" ? "FAIR_ENOUGH" : "BANFLICT",
                });
          const result = reduce(loaded.snapshot, event, {
            ...kernelContext(),
            currentUserId: bothSender,
            allocateId: counterAllocator(42),
          });
          expect(result.outcome).toBe("APPLIED");
          await ctx.persistTransition({
            currentUserId: bothSender,
            expectedRevision: loaded.revision,
            result,
          });
          return event.name;
        }),
      ]),
    );
    expect(new Set(names)).toEqual(
      new Set([
        "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST",
        "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND",
      ]),
    );
    const receiverLoaded = await runtimeA.store.loadProductSnapshot(
      both.receiverWorld.extended.entities.bans[both.banId]!.receiverId!,
    );
    const senderLoaded = await runtimeB.store.loadProductSnapshot(bothSender);
    expect(receiverLoaded.snapshot.extended.entities.checkPairs[both.pairId]).toMatchObject({
      receiverAnswer: "FULFILLED",
      senderAnswer: "NOT_FULFILLED",
      resultingStatus: "BANFLICT",
    });
    expect(senderLoaded.snapshot.extended.entities.checkPairs[both.pairId]).toEqual(
      receiverLoaded.snapshot.extended.entities.checkPairs[both.pairId],
    );

    const boundaryReceiver = await actor("boundary-receiver");
    const boundarySender = await actor("boundary-sender");
    const boundary = checkWorld(boundaryReceiver.userId, boundarySender.userId);
    const boundaryReceiverSeed = await seed(boundaryReceiver.userId, boundary.receiverWorld);
    const boundarySenderSeed = await seed(boundarySender.userId, boundary.senderWorld);
    const receiverFirst = reduce(
      boundaryReceiverSeed.snapshot,
      eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
        checkItemId: branded<NotificationItemId>(`${boundary.pairId}-receiver`),
        answer: "FULFILLED",
        checkPairId: boundary.pairId,
      }),
      {
        ...kernelContext(),
        currentUserId: boundaryReceiver.userId,
        allocateId: counterAllocator(51),
      },
    );
    const senderFirst = reduce(
      boundarySenderSeed.snapshot,
      eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
        checkItemId: branded<NotificationItemId>(`${boundary.pairId}-sender`),
        answer: "FULFILLED",
        checkPairId: boundary.pairId,
      }),
      {
        ...kernelContext(),
        currentUserId: boundarySender.userId,
        allocateId: counterAllocator(52),
      },
    );
    const raced = await contend(SQL.selectPairForUpdate, [boundary.pairId], () =>
      Promise.allSettled([
        runtimeA.store.withCheckPairLock(
          boundary.pairId,
          boundary.banId,
          boundaryReceiver.userId,
          (ctx) =>
            ctx.persistTransition({
              currentUserId: boundaryReceiver.userId,
              expectedRevision: boundaryReceiverSeed.revision,
              result: receiverFirst,
            }),
        ),
        runtimeB.store.withCheckPairLock(
          boundary.pairId,
          boundary.banId,
          boundarySender.userId,
          (ctx) =>
            ctx.persistTransition({
              currentUserId: boundarySender.userId,
              expectedRevision: boundarySenderSeed.revision,
              result: senderFirst,
            }),
        ),
      ]),
    );
    expect(raced.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(raced.find((item) => item.status === "rejected")).toMatchObject({
      reason: { code: "CHECK_PAIR_CONFLICT" },
    });
    const boundaryPair = (await runtimeA.store.loadProductSnapshot(boundaryReceiver.userId))
      .snapshot.extended.entities.checkPairs[boundary.pairId];
    expect(
      [boundaryPair?.receiverAnswer, boundaryPair?.senderAnswer].filter((value) => value !== null),
    ).toHaveLength(1);
    expect(boundaryPair?.resultingStatus).toBeNull();
    expect(
      (await runtimeB.store.loadProductSnapshot(boundarySender.userId)).snapshot.extended.entities
        .checkPairs[boundary.pairId],
    ).toEqual(boundaryPair);
    await runtimeA.kill();
    await runtimeB.kill();
  });

  it("expires one timer when two runtimes observe it", async () => {
    const sender = await actor("timer-sender");
    const receiver = await actor("timer-receiver");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const timerId = branded<DomainTimerId>(`timer-${randomUUID()}`);
    const world = withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      bans: {
        [banId]: makeBan({
          id: banId,
          senderId: sender.userId,
          receiverId: receiver.userId,
          acceptance: "ACCEPTED",
        }),
      },
      domainTimers: { [timerId]: makeTimer({ id: timerId, banId, startedAt: asInstant(0) }) },
    });
    const seeded = await seed(sender.userId, world);
    await seed(receiver.userId, world);
    const first = reduce(seeded.snapshot, eventOf("BAN.DURATION_EXPIRED", { banId }), {
      ...kernelContext(),
      currentUserId: sender.userId,
      allocateId: counterAllocator(61),
    });
    const second = reduce(seeded.snapshot, eventOf("BAN.DURATION_EXPIRED", { banId }), {
      ...kernelContext(),
      currentUserId: sender.userId,
      allocateId: counterAllocator(62),
    });
    const runtimeA = await startRuntime("a");
    const runtimeB = await startRuntime("b");
    const settled = await contend(SQL.selectSessionForUpdate, [sender.userId], () =>
      Promise.allSettled([
        runtimeA.store.persistTransition({
          currentUserId: sender.userId,
          expectedRevision: seeded.revision,
          result: first,
        }),
        runtimeB.store.persistTransition({
          currentUserId: sender.userId,
          expectedRevision: seeded.revision,
          result: second,
        }),
      ]),
    );
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.find((item) => item.status === "rejected")).toMatchObject({
      reason: { code: "REVISION_CONFLICT" },
    });
    const pairs = await admin.sql.query<{ pair_id: string }>(
      "SELECT pair_id FROM check_pairs WHERE ban_id = $1",
      [banId],
    );
    expect(pairs.rows).toHaveLength(1);
    const items = await admin.sql.query(
      "SELECT item_id FROM notification_items WHERE ban_id = $1 AND kind = 'CHECK'",
      [banId],
    );
    expect(items.rows).toHaveLength(2);
    const timer = await admin.sql.query<{ state: string; check_pair_created: boolean }>(
      "SELECT state, check_pair_created FROM domain_timers WHERE timer_id = $1",
      [timerId],
    );
    expect(timer.rows[0]).toEqual({ state: "EXPIRED", check_pair_created: true });
    const loadedA = await runtimeA.store.loadProductSnapshot(sender.userId);
    const loadedB = await runtimeB.store.loadProductSnapshot(sender.userId);
    expect(loadedA.revision).toBe(seeded.revision + 1);
    expect(loadedB.snapshot.extended.entities.checkPairs).toEqual(
      loadedA.snapshot.extended.entities.checkPairs,
    );
    await runtimeA.kill();
    await runtimeB.kill();
  });

  it("fences bootstrap delivery across two pools", async () => {
    const user = await actor("bootstrap");
    await seed(user.userId, {
      ...withControlState(emptySnapshot(), "RIM.LOBBY"),
      extended: {
        ...withControlState(emptySnapshot(), "RIM.LOBBY").extended,
        telegramPersistentReentryEstablished: true,
      },
    });
    const runtimeA = await startRuntime("a");
    const runtimeB = await startRuntime("b");
    const settled = await contend(SQL.selectSessionForUpdate, [user.userId], () =>
      Promise.all([
        runtimeA.store.claimTelegramPersistentReentryBootstrapDelivery(user.userId, 1_000, 60_000),
        runtimeB.store.claimTelegramPersistentReentryBootstrapDelivery(user.userId, 1_000, 60_000),
      ]),
    );
    const claimed = settled.filter((item) => item.status === "CLAIMED");
    const busy = settled.filter((item) => item.status === "ALREADY_CLAIMED");
    expect(claimed).toHaveLength(1);
    expect(busy).toHaveLength(1);
    const token = claimed[0]?.status === "CLAIMED" ? claimed[0].claimToken : "";
    expect(
      (await runtimeB.store.markTelegramPersistentReentryBootstrapSent(user.userId, "other-token"))
        .status,
    ).toBe("STALE_CLAIM");
    expect(
      (
        await runtimeA.store.releaseTelegramPersistentReentryBootstrapClaim(
          user.userId,
          "other-token",
        )
      ).status,
    ).toBe("STALE_CLAIM");
    expect(
      (await runtimeB.store.markTelegramPersistentReentryBootstrapSent(user.userId, token)).status,
    ).toBe("MARKED");
    expect(
      (
        await runtimeA.store.claimTelegramPersistentReentryBootstrapDelivery(
          user.userId,
          2_000,
          60_000,
        )
      ).status,
    ).toBe("ALREADY_SENT");
    await runtimeA.kill();
    await runtimeB.kill();
  });

  it("keeps one receiver when share open and claim overlap", async () => {
    const sender = await actor("entry-sender");
    const receiver = await actor("entry-receiver");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const attemptId = branded<ShareAttemptId>(`attempt-${randomUUID()}`);
    const token = `token-${randomUUID()}`;
    await seed(
      sender.userId,
      withEntities(withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING"), {
        bans: {
          [banId]: makeBan({
            id: banId,
            senderId: sender.userId,
            receiverId: null,
            acceptance: "PENDING",
            status: null,
            boundViaTelegramShareLink: false,
          }),
        },
        shareOperations: {
          [attemptId]: shareOp({
            attemptId,
            token: tokenOf(token),
            createdBanId: banId,
            draft: validCreateDraft("TEMPLATE"),
          }),
        },
      }),
    );
    await seed(receiver.userId, withControlState(emptySnapshot(), "RIM.LOBBY"));
    const runtimeA = await startRuntime("a");
    const runtimeB = await startRuntime("b");
    const depsA = {
      store: runtimeA.store,
      clock: { nowMs: () => 2_000_000 },
      allocateId: counterAllocator(71),
    };
    const depsB = {
      store: runtimeB.store,
      clock: { nowMs: () => 2_000_000 },
      allocateId: counterAllocator(72),
    };
    await contend(SQL.selectSessionForUpdate, [receiver.userId], () =>
      Promise.allSettled([
        executeProductEvent(
          {
            context: authContext(receiver.userId, receiver.telegram),
            event: eventOf("TELEGRAM_SHARE_LINK.OPENED", {
              shareLinkId: branded<ShareLinkId>(attemptId),
              shareTargetBanId: banId,
              currentTelegramUserId: receiver.userId,
            }),
          },
          depsA,
        ),
        executeTemplateShareClaim(
          {
            context: authContext(receiver.userId, receiver.telegram),
            receiverId: receiver.userId,
            token,
            shareAttemptId: attemptId,
            shareOwnerId: sender.userId,
          },
          depsB,
        ),
      ]),
    );
    const banA = await runtimeA.store.getBanById(banId);
    const banB = await runtimeB.store.getBanById(banId);
    expect(banA?.receiverId).toBe(receiver.userId);
    expect(banB?.receiverId).toBe(receiver.userId);
    const share = await admin.sql.query<{ status: string; created_ban_id: string }>(
      "SELECT status, created_ban_id FROM share_operations WHERE attempt_id = $1",
      [attemptId],
    );
    expect(share.rows).toEqual([{ status: "CONFIRMED", created_ban_id: banId }]);
    const incoming = await admin.sql.query(
      "SELECT item_id FROM notification_items WHERE ban_id = $1 AND kind = 'INCOMING_BAN'",
      [banId],
    );
    expect(incoming.rows).toHaveLength(1);
    const recipientA = await runtimeA.store.loadProductSnapshot(receiver.userId);
    const recipientB = await runtimeB.store.loadProductSnapshot(receiver.userId);
    expect(recipientA.revision).toBe(recipientB.revision);
    expect(Object.keys(recipientA.snapshot.extended.entities.notificationItems)).toEqual(
      Object.keys(recipientB.snapshot.extended.entities.notificationItems),
    );
    await runtimeA.kill();
    await runtimeB.kill();
  });

  it("does not dispatch E-64 from a second process while initialization ownership is held", async () => {
    const user = await actor("init-user");
    const contact = await actor("init-contact");
    const chat = makeChat({
      id: branded<RimChatId>(`init-${randomUUID()}`),
      selectedContactId: contact.userId,
      relationshipContext: readyContext(
        contact.userId,
        branded<ContextRequestId>(`init-ctx-${randomUUID()}`),
      ),
      messages: [{ kind: "USER", text: "еще жив" }],
    });
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      runtimeFor(
        chat,
        {
          submissionState: "not-submitted",
          attemptId: attempt("init-live"),
          clientRequestId: "client-init",
        },
        null,
      ),
    );
    const alive = child({
      action: "init-hold",
      userId: user.userId,
      telegram: user.telegram,
      text: "unused",
    });
    try {
      await alive.provider;
      const during = parseRimProviderRuntime(
        (await new PostgresProductStore(admin.sql).loadProductSnapshot(user.userId))
          .rimProviderRuntime,
      );
      expect(during.status).toBe("PRESENT");
      if (during.status === "PRESENT") {
        expect(during.runtime.initialization.submissionState).toBe("acceptance-unknown");
      }
      const other = child({
        action: "init-recover",
        userId: user.userId,
        telegram: user.telegram,
        text: "unused",
      });
      const recovered = await other.done;
      expect(recovered.eventName).toBeNull();
      expect(recovered.log).toEqual([]);
      expect(recovered.initializes).toBe(0);
      expect(recovered.controlState).toBe("RIM.CHAT");
      alive.release();
      const finished = await alive.done;
      expect(finished.initializes).toBe(1);
      expect(finished.log).toContain("initialization-stored");
      expect(finished.log).not.toContain("e64-dispatched");
      expect(finished.eventName).toBeNull();
      const loaded = await new PostgresProductStore(admin.sql).loadProductSnapshot(user.userId);
      expect(loaded.snapshot.controlState).toBe("RIM.CHAT");
      expect(loaded.snapshot.extended.rimChat?.id).toBe(chat.id);
      const runtime = parseRimProviderRuntime(loaded.rimProviderRuntime);
      expect(runtime.status).toBe("PRESENT");
      if (runtime.status === "PRESENT") {
        expect(runtime.runtime.initialization.submissionState).toBe("stored");
        if (runtime.runtime.initialization.submissionState === "stored") {
          expect(runtime.runtime.initialization.conversationId).toBe(conversation("conv-child"));
        }
      }
    } finally {
      alive.release();
      alive.child.kill();
    }
  }, 20_000);

  it("does not install a local successor while a USER attempt ownership lease is held", async () => {
    const user = await actor("attempt-user");
    const contact = await actor("attempt-contact");
    const chat = pendingChat(contact, "живой вызов");
    const original = "attempt-live";
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      runtimeFor(
        chat,
        {
          submissionState: "stored",
          attemptId: attempt("init-stored"),
          conversationId: conversation("conv-live"),
          clientRequestId: "client-init",
        },
        {
          requestId: requestOf(chat),
          attemptId: attempt(original),
          submissionState: "not-submitted",
          clientRequestId: "client-1",
        },
      ),
    );
    const alive = child({
      action: "user-hold",
      userId: user.userId,
      telegram: user.telegram,
      text: "from-a",
    });
    try {
      await alive.provider;
      const during = parseRimProviderRuntime(
        (await new PostgresProductStore(admin.sql).loadProductSnapshot(user.userId))
          .rimProviderRuntime,
      );
      expect(during.status).toBe("PRESENT");
      if (during.status === "PRESENT") {
        expect(during.runtime.continuityMode).toBe("provider-conversation");
        expect(during.runtime.attempt?.submissionState).toBe("acceptance-unknown");
        expect(during.runtime.attempt?.attemptId).toBe(original);
      }
      const other = child({
        action: "user-recover",
        userId: user.userId,
        telegram: user.telegram,
        text: "from-b",
      });
      const recovered = await other.done;
      expect(recovered.continuity).toBe("provider-conversation");
      expect(recovered.retiredAttemptId).toBeNull();
      expect(recovered.attemptId).toBe(original);
      expect(recovered.responds).toBe(0);
      expect(recovered.rimTexts).toEqual([]);
      expect(recovered.eventName).toBeNull();
      alive.release();
      const finished = await alive.done;
      expect(finished.responds).toBe(1);
      expect(finished.rimTexts).toEqual(["from-a"]);
      expect(finished.eventName).toBe("RIM.AI_RESULT_RECEIVED");
      const loaded = await new PostgresProductStore(admin.sql).loadProductSnapshot(user.userId);
      const runtime = parseRimProviderRuntime(loaded.rimProviderRuntime);
      expect(runtime.status).toBe("PRESENT");
      if (runtime.status === "PRESENT") {
        expect(runtime.runtime.continuityMode).toBe("provider-conversation");
        expect(runtime.runtime.retiredAttemptId).toBeNull();
        expect(runtime.runtime.attempt?.attemptId).toBe(original);
      }
      expect(
        (loaded.snapshot.extended.rimChat?.messages ?? []).flatMap((message) =>
          message.kind === "RIM" ? [message.text] : [],
        ),
      ).toEqual(["from-a"]);
    } finally {
      alive.release();
      alive.child.kill();
    }
  }, 20_000);

  it("retrieves one known response from two runtimes without a second Product result", async () => {
    const user = await actor("known-user");
    const contact = await actor("known-contact");
    const chat = pendingChat(contact, "общий ответ");
    const responseId = response(`resp-${randomUUID()}`);
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      runtimeFor(chat, storedInit("conv-known"), {
        requestId: requestOf(chat),
        attemptId: attempt("attempt-known"),
        submissionState: "response-id-known",
        responseId,
        clientRequestId: "client-1",
      }),
    );
    const runtimeA = await startRuntime("a");
    const runtimeB = await startRuntime("b");
    let entered = 0;
    const both = deferred();
    const release = deferred();
    const retrievals = { a: 0, b: 0 };
    const port = (bucket: "a" | "b") => ({
      async retrieve(id: ProviderResponseId) {
        retrievals[bucket] += 1;
        entered += 1;
        if (entered === 2) {
          both.resolve();
        }
        await release.promise;
        return {
          responseId: id,
          providerStatus: "completed" as const,
          output: { kind: "MESSAGE" as const, text: "общий" },
        };
      },
    });
    const deps = (runtime: Runtime) => ({
      store: runtime.store,
      clock: { nowMs: () => 2_000_000 },
      allocateId: counterAllocator(runtime.name === "a" ? 81 : 82),
    });
    const pending = Promise.all([
      recoverPendingRimAi({
        context: authContext(user.userId, user.telegram),
        deps: deps(runtimeA),
        rimAi: {
          async respond() {
            return { kind: "MESSAGE", text: "unused" };
          },
        },
        retrieval: port("a"),
      }),
      recoverPendingRimAi({
        context: authContext(user.userId, user.telegram),
        deps: deps(runtimeB),
        rimAi: {
          async respond() {
            return { kind: "MESSAGE", text: "unused" };
          },
        },
        retrieval: port("b"),
      }),
    ]);
    await both.promise;
    release.resolve();
    const results = await pending;
    expect(retrievals.a).toBe(1);
    expect(retrievals.b).toBe(1);
    expect(results.filter((item) => item?.status === "APPLIED")).toHaveLength(1);
    expect(results.filter((item) => item === null)).toHaveLength(1);
    const loadedA = await runtimeA.store.loadProductSnapshot(user.userId);
    const loadedB = await runtimeB.store.loadProductSnapshot(user.userId);
    const texts = (loadedA.snapshot.extended.rimChat?.messages ?? []).flatMap((message) =>
      message.kind === "RIM" ? [message.text] : [],
    );
    expect(texts).toEqual(["общий"]);
    expect(loadedB.snapshot.extended.rimChat).toEqual(loadedA.snapshot.extended.rimChat);
    expect(parseRimProviderRuntime(loadedA.rimProviderRuntime)).toMatchObject({
      status: "PRESENT",
      runtime: { attempt: { submissionState: "completed-retrieved", responseId } },
    });
    await runtimeA.kill();
    await runtimeB.kill();
  });

  it("leaves a returned body without a response id pending on every runtime", async () => {
    const user = await actor("nobody-user");
    const contact = await actor("nobody-contact");
    const chat = pendingChat(contact, "без идентификатора");
    const runtime = runtimeFor(chat, storedInit("conv-dead"), {
      requestId: requestOf(chat),
      attemptId: attempt("attempt-dead"),
      submissionState: "returned-body-observed",
      clientRequestId: "client-1",
    });
    const seeded = await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      runtime,
    );
    const runtimeA = await startRuntime("a");
    const runtimeB = await startRuntime("b");
    const retrieves = { count: 0 };
    const deps = (runtimeProcess: Runtime) => ({
      store: runtimeProcess.store,
      clock: { nowMs: () => 2_000_000 },
      allocateId: counterAllocator(91),
    });
    const retrieval = {
      async retrieve(id: ProviderResponseId) {
        retrieves.count += 1;
        return {
          responseId: id,
          providerStatus: "completed" as const,
          output: { kind: "MESSAGE" as const, text: "нет" },
        };
      },
    };
    expect(
      await recoverPendingRimAi({
        context: authContext(user.userId, user.telegram),
        deps: deps(runtimeA),
        rimAi: {
          async respond() {
            return { kind: "MESSAGE", text: "unused" };
          },
        },
        retrieval,
      }),
    ).toBeNull();
    expect(
      await recoverPendingRimAi({
        context: authContext(user.userId, user.telegram),
        deps: deps(runtimeB),
        rimAi: {
          async respond() {
            return { kind: "MESSAGE", text: "unused" };
          },
        },
        retrieval,
      }),
    ).toBeNull();
    expect(retrieves.count).toBe(0);
    const loaded = await runtimeB.store.loadProductSnapshot(user.userId);
    expect(loaded.revision).toBe(seeded.revision + 1);
    expect(loaded.snapshot.extended.rimChat).toEqual(chat);
    expect(parseRimProviderRuntime(loaded.rimProviderRuntime)).toMatchObject({
      status: "PRESENT",
      runtime,
    });
    await runtimeA.kill();
    await runtimeB.kill();
  });

  it("lets exactly one of two processes initialize one chat", async () => {
    const user = await actor("race-init-user");
    const contact = await actor("race-init-contact");
    const chat = makeChat({
      id: branded<RimChatId>(`race-init-${randomUUID()}`),
      selectedContactId: contact.userId,
      relationshipContext: readyContext(
        contact.userId,
        branded<ContextRequestId>(`race-init-ctx-${randomUUID()}`),
      ),
      messages: [{ kind: "USER", text: "один старт" }],
    });
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      runtimeFor(
        chat,
        {
          submissionState: "not-submitted",
          attemptId: attempt("init-race"),
          clientRequestId: "client-race",
        },
        null,
      ),
    );
    const left = child({
      action: "init-recover",
      userId: user.userId,
      telegram: user.telegram,
      text: "unused",
    });
    const right = child({
      action: "init-recover",
      userId: user.userId,
      telegram: user.telegram,
      text: "unused",
    });
    const [a, b] = await Promise.all([left.done, right.done]);
    expect(a.initializes + b.initializes).toBe(1);
    expect(a.eventName).toBeNull();
    expect(b.eventName).toBeNull();
    const loaded = await new PostgresProductStore(admin.sql).loadProductSnapshot(user.userId);
    expect(loaded.snapshot.extended.rimChat?.id).toBe(chat.id);
    const runtime = parseRimProviderRuntime(loaded.rimProviderRuntime);
    expect(runtime.status).toBe("PRESENT");
    if (runtime.status === "PRESENT") {
      expect(runtime.runtime.initialization.submissionState).toBe("stored");
    }
    expect(
      (loaded.snapshot.extended.rimChat?.messages ?? []).filter((message) => message.kind === "RIM"),
    ).toEqual([]);
  }, 20_000);

  it("dispatches Class U E-64 from a second process and fences the late conversation id", async () => {
    const user = await actor("class-u-init-user");
    const contact = await actor("class-u-init-contact");
    const chat = makeChat({
      id: branded<RimChatId>(`class-u-init-${randomUUID()}`),
      selectedContactId: contact.userId,
      relationshipContext: readyContext(
        contact.userId,
        branded<ContextRequestId>(`class-u-init-ctx-${randomUUID()}`),
      ),
      messages: [{ kind: "USER", text: "истек" }],
    });
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      runtimeFor(
        chat,
        {
          submissionState: "not-submitted",
          attemptId: attempt("init-u"),
          clientRequestId: "client-u",
        },
        null,
      ),
    );
    const alive = child({
      action: "init-hold",
      userId: user.userId,
      telegram: user.telegram,
      text: "unused",
    });
    try {
      await alive.provider;
      await admin.sql.query(
        `UPDATE rim_provider_ownership
         SET leased_until = clock_timestamp() - INTERVAL '1 second'
         WHERE user_id = $1 AND operation_kind = 'initialization' AND released_at IS NULL`,
        [user.userId],
      );
      const other = child({
        action: "init-recover",
        userId: user.userId,
        telegram: user.telegram,
        text: "unused",
      });
      const recovered = await other.done;
      expect(recovered.eventName).toBe("RIM.INITIALIZATION_UNRECOVERABLE");
      expect(recovered.initializes).toBe(0);
      expect(recovered.controlState).toBe("RIM.SELECT_CONTACT");
      alive.release();
      const finished = await alive.done;
      expect(finished.initializes).toBe(1);
      expect(finished.log).toContain("stale-initialization-success-discarded");
      expect(finished.eventName).toBeNull();
      const loaded = await new PostgresProductStore(admin.sql).loadProductSnapshot(user.userId);
      expect(loaded.snapshot.controlState).toBe("RIM.SELECT_CONTACT");
      expect(loaded.snapshot.extended.rimChat).toBeNull();
    } finally {
      alive.release();
      alive.child.kill();
    }
  }, 20_000);

  it("installs one Class U local successor from a second process and fences the late provider result", async () => {
    const user = await actor("class-u-user");
    const contact = await actor("class-u-contact");
    const chat = pendingChat(contact, "поздний ответ");
    const original = "attempt-u";
    await seed(
      user.userId,
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      runtimeFor(
        chat,
        storedInit("conv-u"),
        {
          requestId: requestOf(chat),
          attemptId: attempt(original),
          submissionState: "not-submitted",
          clientRequestId: "client-u",
        },
      ),
    );
    const alive = child({
      action: "user-hold",
      userId: user.userId,
      telegram: user.telegram,
      text: "from-old",
    });
    try {
      await alive.provider;
      await admin.sql.query(
        `UPDATE rim_provider_ownership
         SET leased_until = clock_timestamp() - INTERVAL '1 second'
         WHERE user_id = $1 AND operation_kind = 'user-attempt' AND released_at IS NULL`,
        [user.userId],
      );
      const other = child({
        action: "user-recover",
        userId: user.userId,
        telegram: user.telegram,
        text: "from-local",
      });
      const recovered = await other.done;
      expect(recovered.continuity).toBe("local-canonical-history");
      expect(recovered.retiredAttemptId).toBe(original);
      expect(recovered.attemptId).not.toBe(original);
      expect(recovered.responds).toBe(1);
      expect(recovered.initializes).toBe(0);
      expect(recovered.rimTexts).toEqual(["from-local"]);
      alive.release();
      const finished = await alive.done;
      expect(finished.responds).toBe(1);
      expect(recovered.responds + finished.responds).toBe(2);
      expect(finished.eventName).toBeNull();
      const loaded = await new PostgresProductStore(admin.sql).loadProductSnapshot(user.userId);
      const texts = (loaded.snapshot.extended.rimChat?.messages ?? []).flatMap((message) =>
        message.kind === "RIM" ? [message.text] : [],
      );
      const userTexts = (loaded.snapshot.extended.rimChat?.messages ?? []).flatMap((message) =>
        message.kind === "USER" ? [message.text] : [],
      );
      expect(texts).toEqual(["from-local"]);
      expect(userTexts).toEqual(["поздний ответ"]);
      const runtime = parseRimProviderRuntime(loaded.rimProviderRuntime);
      expect(runtime.status).toBe("PRESENT");
      if (runtime.status === "PRESENT") {
        expect(runtime.runtime.continuityMode).toBe("local-canonical-history");
        expect(runtime.runtime.retiredAttemptId).toBe(original);
        expect(runtime.runtime.initialization.submissionState).toBe("stored");
      }
    } finally {
      alive.release();
      alive.child.kill();
    }
  }, 20_000);
});

function storedInit(conv: string): RimProviderRuntime["initialization"] {
  return {
    submissionState: "stored",
    attemptId: attempt("init-stored"),
    conversationId: conversation(conv),
    clientRequestId: "client-init",
  };
}

function runtimeFor(
  chat: RimChat,
  initialization: RimProviderRuntime["initialization"],
  providerAttempt: RimProviderAttempt | null,
): RimProviderRuntime {
  if (!chat.selectedContactId || !chat.relationshipContext) {
    throw new Error("chat is missing contact or context");
  }
  return {
    rimChatId: chat.id,
    selectedContactId: chat.selectedContactId,
    contextRequestId: chat.relationshipContext.requestId,
    initialization,
    attempt: providerAttempt,
    continuityMode: "provider-conversation",
    retiredAttemptId: null,
  };
}

function pendingChat(contact: Actor, text: string): RimChat {
  const chatId = branded<RimChatId>(`pending-${randomUUID()}`);
  const contextId = branded<ContextRequestId>(`pending-ctx-${randomUUID()}`);
  const requestId = branded<AiRequestId>(`ai-${randomUUID()}`);
  return makeChat({
    id: chatId,
    selectedContactId: contact.userId,
    relationshipContext: readyContext(contact.userId, contextId),
    messages: [{ kind: "USER", text }],
    aiOperation: pendingAi({
      userMessage: text,
      rimChatId: chatId,
      requestId,
      contextRequestId: contextId,
    }),
  });
}

function requestOf(chat: RimChat): AiRequestId {
  if (chat.aiOperation.status !== "PENDING" && chat.aiOperation.status !== "FAILED") {
    throw new Error("request id missing");
  }
  return chat.aiOperation.requestId;
}
