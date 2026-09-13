import type { UserId } from "@98plus/product-model";
import { contactPartnerIdsFromBans } from "@98plus/product-model";
import { MemorySqlClient } from "@98plus/persistence";

export type SelectableRegisteredUser = Readonly<{
  userId: UserId;
  /** TEST UI diagnostic label only. Never used as Ban.receiverId. */
  telegramUserId: string;
}>;

/**
 * Sort registered identities for stable TEST UI / WHO / RIM presentation.
 * Stage 13B: callers must already restrict the input to the MVP8 Contact set.
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

/**
 * Production MVP8 Contact set: derived exclusively from authoritative Ban facts
 * (senderId + receiverId). No test-grant fallback path exists on this class.
 */
export class MemorySqlRegisteredUserDirectory implements RegisteredUserDirectory {
  constructor(protected readonly sql: MemorySqlClient) {}

  async listSelectableContacts(
    currentUserId: UserId,
  ): Promise<readonly SelectableRegisteredUser[]> {
    const partnerIds = new Set<string>(
      contactPartnerIdsFromBans(this.sql.tables.listBansForUser(currentUserId), currentUserId),
    );
    const contacts = this.allIdentities().filter((user) => partnerIds.has(user.userId));
    return listSelectableRegisteredUsers(contacts, currentUserId);
  }

  isRegisteredUserId(userId: string): boolean {
    return this.sql.tables.hasUser(userId);
  }

  protected allIdentities(): readonly SelectableRegisteredUser[] {
    return [...this.sql.tables.snapshot().identities.values()].map((row) => ({
      userId: row.userId,
      telegramUserId: row.telegramUserId,
    }));
  }
}
