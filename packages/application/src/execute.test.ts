import { describe, expect, it } from "vitest";
import {
  asTelegramUserId,
  authenticate,
  loadIdentityConfig,
  PostgresIdentityStore,
  type AuthenticatedContext,
} from "@98plus/identity";
import {
  InMemoryProductStore,
  MemorySqlClient,
  PersistenceError,
  PostgresProductStore,
  type PersistTransitionInput,
  type ProductStore,
} from "@98plus/persistence";
import {
  counterAllocator,
  type BanId,
  type CanonicalEvent,
  type OperationId,
  type UserId,
} from "@98plus/product-model";
import { executeProductEvent, type ProductExecutorDependencies } from "./execute.ts";
import { ApplicationError } from "./errors.ts";

const USER_ID = "user-from-auth" as UserId;
const CONTACT_ID = "contact-a" as UserId;
const SPOOFED_ID = "spoofed-user" as UserId;

function authContext(userId: UserId, telegramUserId: string): AuthenticatedContext {
  return {
    currentUserId: userId,
    currentTelegramUser: { telegramUserId: asTelegramUserId(telegramUserId) },
    authenticationMethod: "telegram",
  };
}

function eventOf(name: CanonicalEvent["name"], payload: object = {}): CanonicalEvent {
  return { name, payload } as CanonicalEvent;
}

async function harness(userId: UserId = USER_ID) {
  const store = new InMemoryProductStore();
  store.inspect().registerIdentityUser(userId, "tg-user");
  store.inspect().registerIdentityUser(CONTACT_ID, "tg-contact");
  store.inspect().registerIdentityUser(SPOOFED_ID, "tg-spoof");
  const context = authContext(userId, "tg-user");
  const deps: ProductExecutorDependencies = {
    store,
    clock: { nowMs: () => 1_000_000 },
    allocateId: counterAllocator(),
  };
  async function exec(
    event: CanonicalEvent | { name: unknown; payload?: unknown },
    claimed?: string,
  ) {
    return executeProductEvent(
      {
        context,
        event,
        ...(claimed === undefined ? {} : { clientClaimedUserId: claimed }),
      },
      deps,
    );
  }
  return { store, context, deps, exec, userId };
}

describe("Stage 5 executeProductEvent", () => {
  it("A. uses authenticated currentUserId as the Kernel caller", async () => {
    const { exec, userId } = await harness();
    const opened = await exec(eventOf("APP.NORMAL_OPEN", { serverState: {} }));
    expect(opened.status).toBe("APPLIED");
    expect(opened.currentUserId).toBe(userId);
    const started = await exec(eventOf("CREATE_BAN.PRESS_START"));
    expect(started.status).toBe("APPLIED");
    expect(started.snapshot.controlState).toBe("CREATE_BAN.WHO");
    expect(started.currentUserId).toBe(USER_ID);
  });

  it("B. client-claimed userId cannot replace authenticated currentUserId", async () => {
    const { exec, store } = await harness();
    await exec(eventOf("APP.NORMAL_OPEN", { serverState: {} }));
    const started = await exec(eventOf("CREATE_BAN.PRESS_START"), SPOOFED_ID);
    expect(started.currentUserId).toBe(USER_ID);
    expect(started.snapshot.controlState).toBe("CREATE_BAN.WHO");
    const spoofed = await store.loadProductSnapshot(SPOOFED_ID);
    expect(spoofed.snapshot.controlState).toBeNull();
    const authed = await store.loadProductSnapshot(USER_ID);
    expect(authed.snapshot.controlState).toBe("CREATE_BAN.WHO");
  });

  it("C. APPLIED events persist and reload as the Kernel result", async () => {
    const { exec, store } = await harness();
    const opened = await exec(eventOf("APP.NORMAL_OPEN", { serverState: {} }));
    expect(opened.persisted).toBe(true);
    expect(opened.snapshot.controlState).toBe("RIM.LOBBY");
    const reloaded = await store.loadProductSnapshot(USER_ID);
    expect(reloaded.revision).toBe(opened.revision);
    expect(reloaded.snapshot.controlState).toBe("RIM.LOBBY");
    expect(reloaded.snapshot.runtime.session).toBe("ACTIVE");
  });

  it("D. non-APPLIED Kernel results do not persist", async () => {
    const { exec, store } = await harness();
    const opened = await exec(eventOf("APP.NORMAL_OPEN", { serverState: {} }));
    const undefinedResult = await exec(eventOf("REPLY_BAN.CHANGE_BAN_TEXT", { banText: "nope" }));
    expect(undefinedResult.status).toBe("NOT_APPLIED");
    expect(undefinedResult.outcome).toBe("UNDEFINED");
    expect(undefinedResult.persisted).toBe(false);
    const reloaded = await store.loadProductSnapshot(USER_ID);
    expect(reloaded.revision).toBe(opened.revision);
    expect(reloaded.snapshot.controlState).toBe("RIM.LOBBY");
    expect(reloaded.snapshot.extended.replyBanDraft).toBeNull();
  });

  it("E. REVISION_CONFLICT is not silently overwritten", async () => {
    const inner = new InMemoryProductStore();
    inner.inspect().registerIdentityUser(USER_ID, "tg-user");
    const context = authContext(USER_ID, "tg-user");
    const racing: ProductStore = {
      loadProductSnapshot: (userId) => inner.loadProductSnapshot(userId),
      listRelationshipBans: (left, right) => inner.listRelationshipBans(left, right),
      withCheckPairLock: (pairId, run) => inner.withCheckPairLock(pairId, run),
      findShareByToken: (token) => inner.findShareByToken(token),
      getBanById: (banId) => inner.getBanById(banId),
      bindBanReceiver: (banId, receiverId) => inner.bindBanReceiver(banId, receiverId),
      persistShareLinkResolved: (input) => inner.persistShareLinkResolved(input),
      markTelegramPersistentReentryBootstrapSent: (userId, claimToken) =>
        inner.markTelegramPersistentReentryBootstrapSent(userId, claimToken),
      claimTelegramPersistentReentryBootstrapDelivery: (userId, nowMs, leaseMs) =>
        inner.claimTelegramPersistentReentryBootstrapDelivery(userId, nowMs, leaseMs),
      releaseTelegramPersistentReentryBootstrapClaim: (userId, claimToken) =>
        inner.releaseTelegramPersistentReentryBootstrapClaim(userId, claimToken),
      persistTransition: async () => {
        throw new PersistenceError("REVISION_CONFLICT", "conflicting writes");
      },
    };
    const first = await executeProductEvent(
      { context, event: eventOf("APP.NORMAL_OPEN", { serverState: {} }) },
      { store: inner, clock: { nowMs: () => 1_000_000 }, allocateId: counterAllocator() },
    );
    expect(first.status).toBe("APPLIED");
    const conflict = await executeProductEvent(
      { context, event: eventOf("CREATE_BAN.PRESS_START") },
      { store: racing, clock: { nowMs: () => 1_000_000 }, allocateId: counterAllocator() },
    );
    expect(conflict.status).toBe("REVISION_CONFLICT");
    expect(conflict.persisted).toBe(false);
    expect(conflict.error?.code).toBe("REVISION_CONFLICT");
    const durable = await inner.loadProductSnapshot(USER_ID);
    expect(durable.snapshot.controlState).toBe("RIM.LOBBY");
    expect(durable.revision).toBe(first.revision);
  });

  it("F. Kernel invariant remains visible to Stage 5", async () => {
    const { exec } = await harness();
    await exec(eventOf("APP.NORMAL_OPEN", { serverState: {} }));
    await exec(eventOf("CREATE_BAN.PRESS_START"));
    const invariant = await exec(eventOf("CREATE_BAN.SELECT_CONTACT", {}));
    expect(invariant.status).toBe("KERNEL_INVARIANT");
    expect(invariant.persisted).toBe(false);
    expect(invariant.kernelError).not.toBeNull();
    expect(invariant.error?.code).toBe("KERNEL_INVARIANT");
  });

  it("G. persistence invariant remains visible to Stage 5", async () => {
    const inner = new InMemoryProductStore();
    inner.inspect().registerIdentityUser(USER_ID, "tg-user");
    const context = authContext(USER_ID, "tg-user");
    const failing: ProductStore = {
      loadProductSnapshot: (userId) => inner.loadProductSnapshot(userId),
      listRelationshipBans: (left, right) => inner.listRelationshipBans(left, right),
      withCheckPairLock: (pairId, run) => inner.withCheckPairLock(pairId, run),
      findShareByToken: (token) => inner.findShareByToken(token),
      getBanById: (banId) => inner.getBanById(banId),
      bindBanReceiver: (banId, receiverId) => inner.bindBanReceiver(banId, receiverId),
      persistShareLinkResolved: (input) => inner.persistShareLinkResolved(input),
      markTelegramPersistentReentryBootstrapSent: (userId, claimToken) =>
        inner.markTelegramPersistentReentryBootstrapSent(userId, claimToken),
      claimTelegramPersistentReentryBootstrapDelivery: (userId, nowMs, leaseMs) =>
        inner.claimTelegramPersistentReentryBootstrapDelivery(userId, nowMs, leaseMs),
      releaseTelegramPersistentReentryBootstrapClaim: (userId, claimToken) =>
        inner.releaseTelegramPersistentReentryBootstrapClaim(userId, claimToken),
      persistTransition: async (_input: PersistTransitionInput) => {
        throw new PersistenceError("INVARIANT", "persistence refused the write");
      },
    };
    const result = await executeProductEvent(
      { context, event: eventOf("APP.NORMAL_OPEN", { serverState: {} }) },
      { store: failing, clock: { nowMs: () => 1_000_000 }, allocateId: counterAllocator() },
    );
    expect(result.status).toBe("PERSISTENCE_ERROR");
    expect(result.persisted).toBe(false);
    expect(result.error?.code).toBe("PERSISTENCE_INVARIANT");
    expect(result.outcome).toBe("APPLIED");
  });

  it("H. external effects are returned but not marked completed", async () => {
    const { exec } = await harness();
    await exec(eventOf("APP.NORMAL_OPEN", { serverState: {} }));
    await exec(eventOf("RIM.PRESS_START_CHAT"));
    await exec(eventOf("RIM.PRESS_SELECT_CONTACT"));
    const selected = await exec(eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_ID }));
    expect(selected.status).toBe("APPLIED");
    expect(selected.pendingExternalEffects).toHaveLength(1);
    expect(selected.pendingExternalEffects[0]?.effect.type).toBe("REQUEST_RELATIONSHIP_CONTEXT");
    expect(selected.pendingExternalEffects[0]?.completed).toBe(false);
    expect(selected.snapshot.extended.rimChat?.relationshipContext?.status).toBe("loading");
  });

  it("I. repeated execution follows the Kernel result, not a Stage 5 duplicate path", async () => {
    const { exec, store } = await harness();
    const first = await exec(eventOf("APP.NORMAL_OPEN", { serverState: {} }));
    const second = await exec(eventOf("APP.NORMAL_OPEN", { serverState: {} }));
    expect(first.status).toBe("APPLIED");
    expect(second.status).toBe("APPLIED");
    expect(second.persisted).toBe(true);
    expect(second.snapshot.controlState).toBe("RIM.LOBBY");
    expect(second.snapshot.extended.rimChat).toBeNull();
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.revision).toBe(second.revision);
    expect(loaded.revision).not.toBe(first.revision);
    expect(loaded.snapshot.controlState).toBe("RIM.LOBBY");
    const undefinedRepeat = await exec(eventOf("REPLY_BAN.CHANGE_BAN_TEXT", { banText: "nope" }));
    expect(undefinedRepeat.status).toBe("NOT_APPLIED");
    expect(undefinedRepeat.persisted).toBe(false);
    const afterUndefined = await store.loadProductSnapshot(USER_ID);
    expect(afterUndefined.revision).toBe(loaded.revision);
  });

  it("J. Stage 5 does not itself create Ban/Timer/Check/Notification facts", async () => {
    const { exec, store } = await harness();
    await exec(eventOf("APP.NORMAL_OPEN", { serverState: {} }));
    await exec(eventOf("CREATE_BAN.PRESS_START"));
    await exec(eventOf("CREATE_BAN.SELECT_CONTACT", { contactId: CONTACT_ID }));
    await exec(eventOf("CREATE_BAN.CHANGE_BAN_TEXT", { banText: "no phones" }));
    await exec(eventOf("CREATE_BAN.CHANGE_DURATION", { durationMinutes: 3 }));
    await exec(eventOf("CREATE_BAN.PRESS_NEXT"));
    const pending = await exec(eventOf("CREATE_BAN.PRESS_FORBID"));
    expect(pending.status).toBe("APPLIED");
    expect(Object.keys(pending.snapshot.extended.entities.bans)).toEqual([]);
    const operationId = Object.keys(pending.snapshot.runtime.pendingOperations)[0] as OperationId;
    const createdBanId = "ban-from-kernel" as BanId;
    const confirmed = await exec(
      eventOf("CREATE_BAN.SEND_CONFIRMED", { operationId, createdBanId }),
    );
    expect(confirmed.status).toBe("APPLIED");
    expect(confirmed.snapshot.extended.entities.bans[createdBanId]?.senderId).toBe(USER_ID);
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.extended.entities.bans[createdBanId]?.senderId).toBe(USER_ID);
    expect(loaded.snapshot.extended.entities.bans[createdBanId]?.receiverId).toBe(CONTACT_ID);
  });

  it("rejects non-canonical transport event names before Kernel execution", async () => {
    const { exec } = await harness();
    await expect(exec({ name: "AUTH.LOGIN", payload: {} })).rejects.toBeInstanceOf(
      ApplicationError,
    );
    await expect(exec({ name: "E-36", payload: {} })).rejects.toMatchObject({
      code: "INVALID_EVENT",
    });
  });

  it("H. missing identity is not silently created by Stage 5", async () => {
    const store = new InMemoryProductStore();
    const result = await executeProductEvent(
      {
        context: authContext(USER_ID, "tg-user"),
        event: eventOf("APP.NORMAL_OPEN", { serverState: {} }),
      },
      { store, clock: { nowMs: () => 1_000_000 }, allocateId: counterAllocator() },
    );
    expect(result.status).toBe("PERSISTENCE_ERROR");
    expect(result.persisted).toBe(false);
    expect(result.error?.code).toBe("PERSISTENCE_INVARIANT");
    expect(store.inspect().hasUser(USER_ID)).toBe(false);
  });

  it("G. Stage 3 identity establishment then Stage 5 APPLIED execution shares identity_users", async () => {
    const sql = new MemorySqlClient();
    const identityStore = new PostgresIdentityStore(sql);
    const store = new PostgresProductStore(sql);
    const context = await authenticate(
      { method: "development", secret: "secret", telegramUserId: "42" },
      loadIdentityConfig({
        NODE_ENV: "development",
        IDENTITY_ALLOW_DEV_AUTH: "true",
        IDENTITY_DEV_AUTH_SECRET: "secret",
      }),
      identityStore,
    );
    expect("registerIdentityUser" in store).toBe(false);
    const result = await executeProductEvent(
      {
        context,
        event: eventOf("APP.NORMAL_OPEN", { serverState: {} }),
        clientClaimedUserId: "spoofed-user",
      },
      { store, clock: { nowMs: () => 1_000_000 }, allocateId: counterAllocator() },
    );
    expect(result.status).toBe("APPLIED");
    expect(result.persisted).toBe(true);
    expect(result.currentUserId).toBe(context.currentUserId);
    expect(result.currentUserId).not.toBe("spoofed-user");
    expect(sql.tables.hasUser(context.currentUserId)).toBe(true);
    const loaded = await store.loadProductSnapshot(context.currentUserId);
    expect(loaded.snapshot.controlState).toBe("RIM.LOBBY");
  });
});
