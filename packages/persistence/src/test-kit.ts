import type { ProductSnapshot, UserId } from "@98plus/product-model";
import { InMemoryProductStore } from "./in-memory-store.ts";
import { MemorySqlClient } from "./memory-sql.ts";
import { PostgresProductStore } from "./postgres-store.ts";
import type { LoadedSnapshot, PersistenceSqlClient, ProductStore } from "./types.ts";

/** Test-only identity fixture. Not a ProductStore production method. */

class InMemoryFixtureStore extends InMemoryProductStore {
  installFixture(currentUserId: UserId, snapshot: ProductSnapshot): Promise<LoadedSnapshot> {
    return this.write(currentUserId, 0, snapshot, true);
  }
}

class PostgresFixtureStore extends PostgresProductStore {
  installFixture(currentUserId: UserId, snapshot: ProductSnapshot): Promise<LoadedSnapshot> {
    return this.write(currentUserId, 0, snapshot, true);
  }
}

/** Test/bootstrap only. Must not be exported from the `@98plus/persistence` public entry point. */
export class PersistenceTestKit {
  private constructor(
    readonly store: ProductStore,
    private readonly install: (
      currentUserId: UserId,
      snapshot: ProductSnapshot,
    ) => Promise<LoadedSnapshot>,
    readonly memoryStore: InMemoryProductStore | null,
    readonly sqlClient: MemorySqlClient | null,
  ) {}

  static inMemory(): PersistenceTestKit {
    const memoryStore = new InMemoryFixtureStore();
    return new PersistenceTestKit(
      memoryStore,
      (currentUserId, snapshot) => memoryStore.installFixture(currentUserId, snapshot),
      memoryStore,
      null,
    );
  }

  static postgres(client: PersistenceSqlClient = new MemorySqlClient()): PersistenceTestKit {
    const fixtureStore = new PostgresFixtureStore(client);
    return new PersistenceTestKit(
      fixtureStore,
      (currentUserId, snapshot) => fixtureStore.installFixture(currentUserId, snapshot),
      null,
      client instanceof MemorySqlClient ? client : null,
    );
  }

  installFixtureSnapshot(
    currentUserId: UserId,
    snapshot: ProductSnapshot,
  ): Promise<LoadedSnapshot> {
    return this.install(currentUserId, snapshot);
  }

  /**
   * Test/composition only: insert an identity_users row as if Stage 3 already
   * established it. Not exported from the production ProductStore API.
   */
  establishIdentity(userId: UserId, telegramUserId: string): void {
    if (this.memoryStore) {
      this.memoryStore.inspect().registerIdentityUser(userId, telegramUserId);
      return;
    }
    if (this.sqlClient) {
      this.sqlClient.tables.registerIdentityUser(userId, telegramUserId);
      return;
    }
    throw new Error("PersistenceTestKit identity fixture requires in-memory identity_users tables");
  }
}
