import type { UserId } from "@98plus/product-model";
import { MemorySqlClient } from "@98plus/persistence";

export type SelectableRegisteredUser = Readonly<{
  userId: UserId;
  /** TEST UI diagnostic label only. Never used as Ban.receiverId. */
  telegramUserId: string;
}>;

/**
 * MVP5 does not define a Select Contact discovery/ranking algorithm.
 * Stage 6 implementation choice: return every other already-registered 98+ user,
 * sorted by internal UserId, excluding the authenticated caller.
 */
export function listSelectableRegisteredUsers(
  identities: readonly SelectableRegisteredUser[],
  currentUserId: UserId,
): readonly SelectableRegisteredUser[] {
  return identities
    .filter((user) => user.userId !== currentUserId)
    .slice()
    .sort((left, right) => {
      const byUserId = left.userId.localeCompare(right.userId);
      return byUserId !== 0 ? byUserId : left.telegramUserId.localeCompare(right.telegramUserId);
    });
}

export type RegisteredUserDirectory = {
  listSelectableContacts(currentUserId: UserId): Promise<readonly SelectableRegisteredUser[]>;
  isRegisteredUserId(userId: string): boolean;
};

export class MemorySqlRegisteredUserDirectory implements RegisteredUserDirectory {
  constructor(private readonly sql: MemorySqlClient) {}

  async listSelectableContacts(
    currentUserId: UserId,
  ): Promise<readonly SelectableRegisteredUser[]> {
    return listSelectableRegisteredUsers(this.allIdentities(), currentUserId);
  }

  isRegisteredUserId(userId: string): boolean {
    return this.sql.tables.hasUser(userId);
  }

  private allIdentities(): readonly SelectableRegisteredUser[] {
    return [...this.sql.tables.snapshot().identities.values()].map((row) => ({
      userId: row.userId,
      telegramUserId: row.telegramUserId,
    }));
  }
}
