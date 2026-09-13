import type { UserId } from "./ids.ts";

export type BanParticipants = Readonly<{
  senderId: UserId;
  receiverId: UserId | null;
}>;

/**
 * MVP8 Contact rule (1.7.4 / 1.7.22): another registered user is a Contact iff there
 * exists at least one authoritative Ban where both participants have internal UserIds
 * as sender and receiver (any direction). Pair uniqueness; never self.
 */
export function contactPartnerIdsFromBans(
  bans: readonly BanParticipants[],
  currentUserId: UserId,
): readonly UserId[] {
  const partners = new Set<string>();
  for (const ban of bans) {
    if (ban.receiverId === null) {
      continue;
    }
    if (ban.senderId === ban.receiverId) {
      continue;
    }
    if (ban.senderId === currentUserId) {
      partners.add(ban.receiverId);
    } else if (ban.receiverId === currentUserId) {
      partners.add(ban.senderId);
    }
  }
  partners.delete(currentUserId);
  return [...partners].sort((left, right) => left.localeCompare(right)) as UserId[];
}

export function isQualifyingAuthoritativeBan(ban: BanParticipants): boolean {
  return ban.receiverId !== null && ban.senderId !== ban.receiverId;
}
