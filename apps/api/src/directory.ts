import type { UserId } from "@98plus/product-model";
import { contactPartnerIdsFromBans } from "@98plus/product-model";
import { SQL, type PersistenceSqlClient } from "@98plus/persistence";

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
  isRegisteredUserId(userId: string): Promise<boolean>;
};

type IdentitySqlRow = { user_id: string; telegram_user_id: string };
type BanParticipantRow = { sender_id: string; receiver_id: string | null };

/**
 * Production MVP8 Contact set: derived exclusively from authoritative Ban facts
 * (senderId + receiverId) and identity_users. No test-grant fallback path exists
 * on this class. Reads go through PersistenceSqlClient, not MemorySqlClient.tables.
 */
export class MemorySqlRegisteredUserDirectory implements RegisteredUserDirectory {
  constructor(protected readonly sql: PersistenceSqlClient) {}

  async listSelectableContacts(
    currentUserId: UserId,
  ): Promise<readonly SelectableRegisteredUser[]> {
    const bans = await this.sql.query<BanParticipantRow>(SQL.selectBansForUser, [currentUserId]);
    const partnerIds = contactPartnerIdsFromBans(
      bans.rows.map((row) => ({
        senderId: row.sender_id as UserId,
        receiverId: row.receiver_id as UserId | null,
      })),
      currentUserId,
    );
    if (partnerIds.length === 0) {
      return [];
    }
    const identities = await this.sql.query<IdentitySqlRow>(SQL.selectIdentitiesByUserIds, [
      partnerIds,
    ]);
    const contacts = identities.rows.map((row) => ({
      userId: row.user_id as UserId,
      telegramUserId: row.telegram_user_id,
    }));
    return listSelectableRegisteredUsers(contacts, currentUserId);
  }

  async isRegisteredUserId(userId: string): Promise<boolean> {
    const result = await this.sql.query<{ user_id: string }>(SQL.selectIdentity, [userId]);
    return result.rows.length > 0;
  }

  protected async allIdentities(): Promise<readonly SelectableRegisteredUser[]> {
    const result = await this.sql.query<IdentitySqlRow>(SQL.selectAllIdentities, []);
    return result.rows.map((row) => ({
      userId: row.user_id as UserId,
      telegramUserId: row.telegram_user_id,
    }));
  }
}
