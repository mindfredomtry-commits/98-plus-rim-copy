import type { RelationshipContextSource } from "@98plus/persistence";
import type {
  BanStatus,
  CheckAnswer,
  CheckDerivedStatus,
  RelationshipContextData,
  RelationshipDirection,
  RelationshipRecentBan,
  UserId,
} from "@98plus/product-model";
import { RELATIONSHIP_BAN_LIMIT } from "@98plus/product-model";

function emptyAggregate() {
  return {
    bansSentCount: 0,
    statusCounts: {
      bantastic: 0,
      banflict: 0,
      fairEnough: 0,
      overboard: 0,
    },
  };
}

function directionOf(
  source: RelationshipContextSource,
  currentUserId: UserId,
): RelationshipDirection {
  return source.senderId === currentUserId ? "USER_TO_CONTACT" : "CONTACT_TO_USER";
}

function answersFor(
  source: RelationshipContextSource,
  direction: RelationshipDirection,
): { userAnswer: CheckAnswer | null; contactAnswer: CheckAnswer | null } {
  if (direction === "USER_TO_CONTACT") {
    return { userAnswer: source.senderAnswer, contactAnswer: source.receiverAnswer };
  }
  return { userAnswer: source.receiverAnswer, contactAnswer: source.senderAnswer };
}

function checkStatus(status: BanStatus | CheckDerivedStatus | null): CheckDerivedStatus | null {
  if (status === "BANTASTIC" || status === "BANFLICT" || status === "FAIR_ENOUGH") {
    return status;
  }
  return null;
}

function recentBan(
  source: RelationshipContextSource,
  currentUserId: UserId,
  nowMs: number,
): RelationshipRecentBan {
  const direction = directionOf(source, currentUserId);
  const answers = answersFor(source, direction);
  const completed = source.resultingStatus ?? checkStatus(source.status);
  let result: RelationshipRecentBan["result"];
  if (source.status === "OVERBOARD") {
    result = { kind: "OVERBOARD" };
  } else if (completed) {
    result = { kind: "CHECK_COMPLETED", ...answers, status: completed };
  } else if (source.checkPairCreated || source.receiverAnswer || source.senderAnswer) {
    result = { kind: "CHECK_PENDING", ...answers };
  } else if (source.acceptance === "ACCEPTED") {
    result = { kind: "ACTIVE" };
  } else {
    result = { kind: "AWAITING_RESPONSE" };
  }
  const ageHours =
    source.createdAtMs === null
      ? 0
      : Math.max(0, Math.floor((nowMs - source.createdAtMs) / 3_600_000));
  return { direction, banText: source.banText, ageHours, result };
}

function addStatus(
  counts: {
    bantastic: number;
    banflict: number;
    fairEnough: number;
    overboard: number;
  },
  result: RelationshipRecentBan["result"],
) {
  if (result.kind === "OVERBOARD") {
    counts.overboard += 1;
  } else if (result.kind === "CHECK_COMPLETED") {
    if (result.status === "BANTASTIC") counts.bantastic += 1;
    if (result.status === "BANFLICT") counts.banflict += 1;
    if (result.status === "FAIR_ENOUGH") counts.fairEnough += 1;
  }
}

/**
 * Builds frozen USER-relative RelationshipContextData from durable pair facts.
 * Does not write Product state.
 */
export function buildRelationshipContextData(input: {
  currentUserId: UserId;
  sources: readonly RelationshipContextSource[];
  nowMs: number;
}): RelationshipContextData {
  const userToContact = emptyAggregate();
  const contactToUser = emptyAggregate();
  const chronological = [...input.sources].sort(
    (left, right) => left.createdSeq - right.createdSeq,
  );
  for (const source of chronological) {
    const direction = directionOf(source, input.currentUserId);
    const aggregate = direction === "USER_TO_CONTACT" ? userToContact : contactToUser;
    aggregate.bansSentCount += 1;
    addStatus(aggregate.statusCounts, recentBan(source, input.currentUserId, input.nowMs).result);
  }
  const window = chronological.slice(-RELATIONSHIP_BAN_LIMIT);
  return {
    aggregates: { userToContact, contactToUser },
    recentBans: window.map((source) => recentBan(source, input.currentUserId, input.nowMs)),
  };
}
