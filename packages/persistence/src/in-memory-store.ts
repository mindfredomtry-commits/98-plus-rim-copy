import type { ProductSnapshot, TransitionResult, UserId } from "@98plus/product-model";
import { assertCheckPairWriteAllowed } from "./check-pair-write.ts";
import { sessionFromSnapshot, snapshotFromRecords } from "./codec.ts";
import { PersistenceError } from "./errors.ts";
import { ProductTables } from "./tables.ts";
import type {
  CheckPairLockContext,
  LoadedSnapshot,
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
      this.tables.transaction(() => {
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
        this.tables.replaceOperations(
          currentUserId,
          Object.values(snapshot.runtime.pendingOperations),
        );
        this.tables.writeSession(sessionFromSnapshot(currentUserId, snapshot, nextRevision));
        return this.read(currentUserId);
      }),
    );
  }
}
