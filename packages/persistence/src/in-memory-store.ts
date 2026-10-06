import { randomUUID } from "node:crypto";
import type { Ban, ProductSnapshot, TransitionResult, UserId } from "@98plus/product-model";
import type { BanId } from "@98plus/product-model";
import {
  boundExistingClaimBan,
  classifyShareForClaim,
  newClaimIncomingCount,
  receiverSnapshotForClaim,
  snapshotForReceiverClaimPersist,
  type ClaimTemplateShareInput,
  type ClaimTemplateShareResult,
} from "./claim-template-share.ts";
import { assertCheckPairWriteAllowed } from "./check-pair-write.ts";
import { cloneJson, sessionFromSnapshot, snapshotFromRecords } from "./codec.ts";
import { PersistenceError } from "./errors.ts";
import { ProductTables } from "./tables.ts";
import { runtimeAttemptAllowsCommit } from "./runtime-attempt-authority.ts";
import type {
  CheckPairLockContext,
  CommitOwnedTransitionInput,
  CommitOwnedTransitionResult,
  LoadedSnapshot,
  PersistShareLinkResolvedInput,
  PersistShareLinkResolvedResult,
  PersistTransitionInput,
  ProductStore,
} from "./types.ts";

function requireApplied(result: TransitionResult): ProductSnapshot {
  if (result.outcome !== "APPLIED") {
    throw new PersistenceError(
      "APPLIED_TRANSITION_REQUIRED",
      "Only an APPLIED Product Kernel TransitionResult may be persisted",
    );
  }
  return result.snapshot;
}

export class InMemoryProductStore implements ProductStore {
  private readonly tables: ProductTables;
  private readonly userLocks = new Map<string, Promise<void>>();
  private readonly shareLocks = new Map<string, Promise<void>>();
  private failAfterBans = false;

  constructor(tables: ProductTables = new ProductTables()) {
    this.tables = tables;
  }

  inspect() {
    return this.tables;
  }

  failNextWriteAfterBans(): void {
    this.failAfterBans = true;
  }

  async loadProductSnapshot(currentUserId: UserId): Promise<LoadedSnapshot> {
    return this.read(currentUserId);
  }

  async persistTransition(input: PersistTransitionInput): Promise<LoadedSnapshot> {
    const snapshot = requireApplied(input.result);
    return this.write(input.currentUserId, input.expectedRevision, snapshot, false);
  }

  async commitOwnedTransition(
    input: CommitOwnedTransitionInput,
  ): Promise<CommitOwnedTransitionResult> {
    const snapshot = requireApplied(input.result);
    return this.withUserLock(input.currentUserId, () =>
      this.tables.transaction(() => {
        const current = this.tables.lockSession(input.currentUserId);
        if (!current || current.revision !== input.expectedRevision) {
          throw new PersistenceError(
            "REVISION_CONFLICT",
            "Conflicting writes to the same user's durable ProductSnapshot",
          );
        }
        if (!runtimeAttemptAllowsCommit(current.rimProviderRuntime, input.requireAttempt)) {
          return {
            status: "ATTEMPT_SUPERSEDED" as const,
            loaded: this.read(input.currentUserId),
          };
        }
        const loaded = this.writeUnlocked(
          input.currentUserId,
          input.expectedRevision,
          snapshot,
          false,
          "rimProviderRuntime" in input ? input.rimProviderRuntime : undefined,
        );
        return { status: "COMMITTED" as const, loaded };
      }),
    );
  }

  async saveRimProviderRuntime(
    currentUserId: UserId,
    expectedRevision: number,
    runtime: unknown | null,
  ): Promise<LoadedSnapshot> {
    return this.withUserLock(currentUserId, () =>
      this.tables.transaction(() => {
        if (!this.tables.hasUser(currentUserId)) {
          throw new PersistenceError(
            "IDENTITY_REQUIRED",
            "Persistence operations require an authenticated identity_users.user_id",
          );
        }
        const current = this.tables.lockSession(currentUserId);
        if (!current) {
          throw new PersistenceError(
            "INVARIANT",
            "rim provider runtime requires an existing product_user_sessions row",
          );
        }
        if (current.revision !== expectedRevision) {
          throw new PersistenceError(
            "REVISION_CONFLICT",
            "Conflicting writes to the same user's durable ProductSnapshot",
          );
        }
        this.tables.writeSession({
          ...current,
          revision: current.revision + 1,
          rimProviderRuntime: runtime === null ? null : cloneJson(runtime),
        });
        return this.read(currentUserId);
      }),
    );
  }

  async markTelegramPersistentReentryBootstrapSent(currentUserId: UserId, claimToken: string) {
    return this.withUserLock(currentUserId, () => {
      const session = this.tables.lockSession(currentUserId);
      if (!session || !session.telegramPersistentReentryEstablished) {
        return { status: "NOT_REQUIRED" as const };
      }
      if (session.telegramPersistentReentryBootstrapSent) {
        return { status: "ALREADY_MARKED" as const };
      }
      if (session.telegramPersistentReentryBootstrapClaimToken !== claimToken) {
        return { status: "STALE_CLAIM" as const };
      }
      this.tables.writeSession({
        ...session,
        revision: session.revision + 1,
        telegramPersistentReentryBootstrapSent: true,
        telegramPersistentReentryBootstrapClaimedUntilMs: null,
        telegramPersistentReentryBootstrapClaimToken: null,
      });
      return { status: "MARKED" as const };
    });
  }

  async claimTelegramPersistentReentryBootstrapDelivery(
    currentUserId: UserId,
    nowMs: number,
    leaseMs: number,
  ) {
    return this.withUserLock(currentUserId, () => {
      const session = this.tables.lockSession(currentUserId);
      if (!session || !session.telegramPersistentReentryEstablished) {
        return { status: "NOT_REQUIRED" as const };
      }
      if (session.telegramPersistentReentryBootstrapSent) {
        return { status: "ALREADY_SENT" as const };
      }
      const claimedUntil = session.telegramPersistentReentryBootstrapClaimedUntilMs;
      if (claimedUntil !== null && claimedUntil > nowMs) {
        return { status: "ALREADY_CLAIMED" as const, claimedUntilMs: claimedUntil };
      }
      const nextClaimedUntil = nowMs + leaseMs;
      const claimToken = randomUUID();
      this.tables.writeSession({
        ...session,
        revision: session.revision + 1,
        telegramPersistentReentryBootstrapClaimedUntilMs: nextClaimedUntil,
        telegramPersistentReentryBootstrapClaimToken: claimToken,
      });
      return { status: "CLAIMED" as const, claimToken, claimedUntilMs: nextClaimedUntil };
    });
  }

  async releaseTelegramPersistentReentryBootstrapClaim(currentUserId: UserId, claimToken: string) {
    return this.withUserLock(currentUserId, () => {
      const session = this.tables.lockSession(currentUserId);
      if (!session) {
        return { status: "NOT_HELD" as const };
      }
      if (session.telegramPersistentReentryBootstrapSent) {
        return { status: "ALREADY_SENT" as const };
      }
      if (session.telegramPersistentReentryBootstrapClaimToken === null) {
        return { status: "NOT_HELD" as const };
      }
      if (session.telegramPersistentReentryBootstrapClaimToken !== claimToken) {
        return { status: "STALE_CLAIM" as const };
      }
      this.tables.writeSession({
        ...session,
        revision: session.revision + 1,
        telegramPersistentReentryBootstrapClaimedUntilMs: null,
        telegramPersistentReentryBootstrapClaimToken: null,
      });
      return { status: "RELEASED" as const };
    });
  }

  async withCheckPairLock<T>(
    pairId: string,
    run: (context: CheckPairLockContext) => Promise<T>,
  ): Promise<T> {
    return this.tables.withPairLock(pairId, async () =>
      run({
        pair: this.tables.getPair(pairId) ?? null,
        loadProductSnapshot: async (currentUserId) => this.read(currentUserId),
        persistTransition: (input) => this.persistTransition(input),
      }),
    );
  }

  async listRelationshipBans(leftUserId: UserId, rightUserId: UserId) {
    return this.tables.listRelationshipBans(leftUserId, rightUserId);
  }

  async listRelationshipContextSources(leftUserId: UserId, rightUserId: UserId) {
    return this.tables.listRelationshipContextSources(leftUserId, rightUserId);
  }

  async findShareByToken(token: string) {
    const share = this.tables.findShareByToken(token);
    if (!share) {
      return null;
    }
    const { ownerId, ...operation } = share;
    return { share: operation, ownerId };
  }

  async getShareByAttemptId(attemptId: string) {
    const share = this.tables.getShare(attemptId);
    if (!share) {
      return null;
    }
    const { ownerId, ...operation } = share;
    return { share: operation, ownerId };
  }

  async claimTemplateShare(input: ClaimTemplateShareInput): Promise<ClaimTemplateShareResult> {
    return this.withShareLock(input.token, async () => {
      const stored = this.tables.findShareByToken(input.token);
      if (!stored) {
        return { status: "REJECTED" as const, reason: "UNKNOWN_TOKEN" as const };
      }
      return this.withOrderedUserLocks([stored.ownerId, input.receiverId], () =>
        this.tables.transaction(() => this.claimTemplateShareUnlocked(input)),
      );
    });
  }

  async getBanById(banId: BanId): Promise<Ban | null> {
    const ban = this.tables.getBan(banId);
    if (!ban) {
      return null;
    }
    const { createdSeq: _createdSeq, ...rest } = ban;
    return rest;
  }

  async bindBanReceiver(banId: BanId, receiverId: UserId) {
    return this.tables.bindBanReceiver(banId, receiverId);
  }

  async persistShareLinkResolved(
    input: PersistShareLinkResolvedInput,
  ): Promise<PersistShareLinkResolvedResult> {
    const snapshot = requireApplied(input.result);
    return this.withUserLock(input.currentUserId, () =>
      this.tables.transaction(() => {
        const bind = this.tables.bindBanReceiver(input.banId, input.receiverId);
        if (bind.status === "MISSING" || bind.status === "CONFLICT") {
          return { status: "BIND_REJECTED" as const, bindStatus: bind.status };
        }
        const loaded = this.writeUnlocked(
          input.currentUserId,
          input.expectedRevision,
          snapshot,
          false,
        );
        return {
          status: "PERSISTED" as const,
          loaded,
          bindStatus: bind.status,
        };
      }),
    );
  }

  private claimTemplateShareUnlocked(input: ClaimTemplateShareInput): ClaimTemplateShareResult {
    const stored = this.tables.findShareByToken(input.token);
    if (!stored) {
      return { status: "REJECTED", reason: "UNKNOWN_TOKEN" };
    }
    const { ownerId, ...share } = stored;
    const existingBan = share.createdBanId ? this.tables.getBan(share.createdBanId) : undefined;
    const ban = existingBan ? (({ createdSeq: _createdSeq, ...rest }) => rest)(existingBan) : null;
    const classification = classifyShareForClaim(ownerId, share, input.receiverId, ban);
    if (classification.action === "ALREADY_BOUND") {
      return { status: "ALREADY_BOUND", banId: classification.banId };
    }
    if (classification.action === "CONFLICT") {
      return { status: "CONFLICT", banId: classification.banId };
    }
    if (classification.action === "REJECTED") {
      return { status: "REJECTED", reason: classification.reason };
    }
    const cas = this.tables.bindBanReceiver(classification.banId, input.receiverId);
    if (cas.status === "ALREADY_BOUND") {
      return { status: "ALREADY_BOUND", banId: classification.banId };
    }
    if (cas.status === "CONFLICT") {
      return { status: "CONFLICT", banId: classification.banId };
    }
    if (cas.status !== "BOUND" || !ban) {
      return { status: "REJECTED", reason: "MALFORMED" };
    }
    const loaded = this.read(input.receiverId);
    const transition = input.reduceClaim({
      share,
      ownerId,
      ban,
      receiver: {
        revision: loaded.revision,
        snapshot: receiverSnapshotForClaim(loaded.snapshot, share, ban),
      },
    });
    if (transition.outcome !== "APPLIED") {
      return { status: "NOT_APPLIED", transition };
    }
    const created = boundExistingClaimBan(
      loaded.snapshot,
      transition.snapshot,
      classification.banId,
      input.receiverId,
      ownerId,
    );
    if (
      !created ||
      newClaimIncomingCount(
        loaded.snapshot,
        transition.snapshot,
        classification.banId,
        input.receiverId,
      ) !== 1
    ) {
      throw new PersistenceError(
        "INVARIANT",
        "Template share claim did not bind the existing Ban and create exactly one Incoming",
      );
    }
    const persisted = snapshotForReceiverClaimPersist(
      loaded.snapshot,
      transition.snapshot,
      share.attemptId,
    );
    const written = this.writeUnlocked(input.receiverId, loaded.revision, persisted, false);
    const confirmedShare = {
      ...share,
      status: "CONFIRMED" as const,
      createdBanId: created.id,
    };
    this.tables.upsertShare(ownerId, confirmedShare);
    const sender = this.read(ownerId);
    const observation = input.observeSender?.({
      ownerId,
      share: confirmedShare,
      ban: created,
      sender: { revision: sender.revision, snapshot: sender.snapshot },
    });
    if (observation) {
      if (observation.outcome !== "APPLIED") {
        throw new PersistenceError(
          "INVARIANT",
          "CREATE_BAN.CLAIM_OBSERVED did not apply for the pending sender",
        );
      }
      this.writeUnlocked(ownerId, sender.revision, observation.snapshot, false);
    }
    return {
      status: "CLAIMED",
      loadedRevision: written.revision,
      loadedSnapshot: written.snapshot,
      banId: created.id,
      transition,
    };
  }

  private async withShareLock<T>(token: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.shareLocks.get(token) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.shareLocks.set(
      token,
      previous.then(() => current),
    );
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.shareLocks.get(token) === current) {
        this.shareLocks.delete(token);
      }
    }
  }

  private async withOrderedUserLocks<T>(userIds: readonly UserId[], fn: () => T): Promise<T> {
    const ordered = [...new Set(userIds)].sort();
    const acquired: Array<{ userId: UserId; release: () => void; gate: Promise<void> }> = [];
    try {
      for (const userId of ordered) {
        const previous = this.userLocks.get(userId) ?? Promise.resolve();
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const gate = previous.then(() => held);
        this.userLocks.set(userId, gate);
        await previous;
        acquired.push({ userId, release, gate });
      }
      return fn();
    } finally {
      for (const lock of acquired.reverse()) {
        lock.release();
        if (this.userLocks.get(lock.userId) === lock.gate) {
          this.userLocks.delete(lock.userId);
        }
      }
    }
  }

  private async withUserLock<T>(userId: UserId, fn: () => T): Promise<T> {
    const previous = this.userLocks.get(userId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.userLocks.set(
      userId,
      previous.then(() => current),
    );
    await previous;
    try {
      return fn();
    } finally {
      release();
      if (this.userLocks.get(userId) === current) {
        this.userLocks.delete(userId);
      }
    }
  }

  private read(currentUserId: UserId): LoadedSnapshot {
    const session = this.tables.lockSession(currentUserId);
    const bans = this.tables.listBansForUser(currentUserId);
    const banIds = bans.map((ban) => ban.id);
    return {
      revision: session?.revision ?? 0,
      telegramPersistentReentryBootstrapSent:
        session?.telegramPersistentReentryBootstrapSent ?? false,
      telegramPersistentReentryBootstrapClaimedUntilMs:
        session?.telegramPersistentReentryBootstrapClaimedUntilMs ?? null,
      telegramPersistentReentryBootstrapClaimToken:
        session?.telegramPersistentReentryBootstrapClaimToken ?? null,
      rimProviderRuntime: session?.rimProviderRuntime ?? null,
      snapshot: snapshotFromRecords({
        session,
        bans,
        items: this.tables.listItemsForUser(currentUserId),
        timers: this.tables.listTimersForBans(banIds),
        pairs: this.tables.listPairsForBans(banIds),
        shares: this.tables.listSharesForUser(currentUserId),
        operations: this.tables.listOperationsForUser(currentUserId),
      }),
    };
  }

  protected async write(
    currentUserId: UserId,
    expectedRevision: number,
    snapshot: ProductSnapshot,
    seed: boolean,
  ): Promise<LoadedSnapshot> {
    return this.withUserLock(currentUserId, () =>
      this.tables.transaction(() =>
        this.writeUnlocked(currentUserId, expectedRevision, snapshot, seed),
      ),
    );
  }

  private writeUnlocked(
    currentUserId: UserId,
    expectedRevision: number,
    snapshot: ProductSnapshot,
    seed: boolean,
    runtimeReplacement?: unknown,
  ): LoadedSnapshot {
    if (!this.tables.hasUser(currentUserId)) {
      throw new PersistenceError(
        "IDENTITY_REQUIRED",
        "Persistence operations require an authenticated identity_users.user_id",
      );
    }
    const current = this.tables.lockSession(currentUserId);
    const currentRevision = current?.revision ?? 0;
    if (!seed && currentRevision !== expectedRevision) {
      throw new PersistenceError(
        "REVISION_CONFLICT",
        "Conflicting writes to the same user's durable ProductSnapshot",
      );
    }
    const nextRevision = currentRevision + 1;
    const entities = snapshot.extended.entities;
    for (const ban of Object.values(entities.bans)) {
      this.tables.upsertBan(ban);
    }
    if (this.failAfterBans) {
      this.failAfterBans = false;
      throw new PersistenceError("TRANSACTION_FAILED", "injected failure after Ban write");
    }
    for (const timer of Object.values(entities.domainTimers)) {
      this.tables.upsertTimer(timer);
    }
    for (const pair of Object.values(entities.checkPairs)) {
      assertCheckPairWriteAllowed(this.tables.getPair(pair.id), pair);
      this.tables.upsertPair(pair);
    }
    this.tables.replaceOwnedItems(currentUserId, Object.values(entities.notificationItems));
    this.tables.replaceOwnedShares(currentUserId, Object.values(entities.shareOperations));
    this.tables.replaceOperations(currentUserId, Object.values(snapshot.runtime.pendingOperations));
    this.tables.writeSession(
      sessionFromSnapshot(currentUserId, snapshot, nextRevision, {
        telegramPersistentReentryBootstrapSent:
          current?.telegramPersistentReentryBootstrapSent ?? false,
        telegramPersistentReentryBootstrapClaimedUntilMs:
          current?.telegramPersistentReentryBootstrapClaimedUntilMs ?? null,
        telegramPersistentReentryBootstrapClaimToken:
          current?.telegramPersistentReentryBootstrapClaimToken ?? null,
        rimProviderRuntime:
          runtimeReplacement === undefined
            ? (current?.rimProviderRuntime ?? null)
            : runtimeReplacement === null
              ? null
              : cloneJson(runtimeReplacement),
      }),
    );
    return this.read(currentUserId);
  }
}
