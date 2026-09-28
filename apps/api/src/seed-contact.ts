import type { Ban, DurationMinutes, UserId } from "@98plus/product-model";
import { MemorySqlClient } from "@98plus/persistence";
import {
  MemorySqlRegisteredUserDirectory,
  listSelectableRegisteredUsers,
  type RegisteredUserDirectory,
  type SelectableRegisteredUser,
} from "./directory.ts";
import type { CreateBanContactRuntime } from "./runtime.ts";
import { userIdOf } from "./runtime.ts";

let seedSeq = 0;

/**
 * Test-only Contact directory. Grants live only in this adapter's memory and are
 * never consulted by MemorySqlRegisteredUserDirectory (production default).
 * main.ts / production createCreateBanContactRuntime never construct this class.
 */
export class TestOnlyRegisteredUserDirectory extends MemorySqlRegisteredUserDirectory {
  private readonly testGrants = new Map<string, Set<string>>();

  constructor(sql: MemorySqlClient) {
    super(sql);
  }

  grantTestContactPair(leftUserId: UserId, rightUserId: UserId): void {
    if (leftUserId === rightUserId) {
      return;
    }
    this.addGrant(leftUserId, rightUserId);
    this.addGrant(rightUserId, leftUserId);
  }

  override async listSelectableContacts(
    currentUserId: UserId,
  ): Promise<readonly SelectableRegisteredUser[]> {
    const fromBans = await super.listSelectableContacts(currentUserId);
    const partnerIds = new Set<string>(fromBans.map((contact) => contact.userId));
    for (const granted of this.testGrants.get(currentUserId) ?? []) {
      partnerIds.add(granted);
    }
    const contacts = this.allIdentities().filter((user) => partnerIds.has(user.userId));
    return listSelectableRegisteredUsers(contacts, currentUserId);
  }

  private addGrant(ownerId: UserId, partnerId: UserId): void {
    const existing = this.testGrants.get(ownerId) ?? new Set<string>();
    existing.add(partnerId);
    this.testGrants.set(ownerId, existing);
  }
}

/** Persist a qualifying authoritative Ban so Ban-derived Contact rule includes the pair. */
export function seedAuthoritativeContactBan(
  runtime: CreateBanContactRuntime,
  senderUserId: UserId,
  receiverUserId: UserId,
  banId?: string,
): Ban {
  seedSeq += 1;
  const ban: Ban = {
    id: (banId ?? `seed-contact-ban-${seedSeq}`) as Ban["id"],
    senderId: senderUserId,
    receiverId: receiverUserId,
    banText: "seed authoritative contact ban",
    durationMinutes: 10 as DurationMinutes,
    acceptance: "PENDING",
    status: null,
    boundViaTelegramShareLink: false,
    sourceProposalId: null,
  };
  runtime.sql.tables.upsertBan(ban);
  return ban;
}

/**
 * Make A↔B selectable as Contacts for WHO / RIM without inserting an extra Ban.
 * Prefer this in Stage 6–11 helpers so Ban-count assertions stay about product Bans.
 * Stage 13B Ban-derivation tests should call seedAuthoritativeContactBan /
 * seedContactBetweenTelegramUsers instead.
 *
 * Installs TestOnlyRegisteredUserDirectory on the runtime if needed. Production
 * runtimes never import this module and never receive this adapter.
 */
export function grantContactBetweenTelegramUsers(
  runtime: CreateBanContactRuntime,
  senderTelegramUserId: string,
  receiverTelegramUserId: string,
): void {
  const senderUserId = userIdOf(runtime, senderTelegramUserId);
  const receiverUserId = userIdOf(runtime, receiverTelegramUserId);
  if (!senderUserId || !receiverUserId) {
    throw new Error("grantContactBetweenTelegramUsers requires both users to be registered");
  }
  const directory = ensureTestOnlyDirectory(runtime);
  directory.grantTestContactPair(senderUserId, receiverUserId);
}

export function seedContactBetweenTelegramUsers(
  runtime: CreateBanContactRuntime,
  senderTelegramUserId: string,
  receiverTelegramUserId: string,
): Ban {
  const senderUserId = userIdOf(runtime, senderTelegramUserId);
  const receiverUserId = userIdOf(runtime, receiverTelegramUserId);
  if (!senderUserId || !receiverUserId) {
    throw new Error("seedContactBetweenTelegramUsers requires both users to be registered");
  }
  return seedAuthoritativeContactBan(runtime, senderUserId, receiverUserId);
}

function ensureTestOnlyDirectory(
  runtime: CreateBanContactRuntime,
): TestOnlyRegisteredUserDirectory {
  if (runtime.directory instanceof TestOnlyRegisteredUserDirectory) {
    return runtime.directory;
  }
  if (!(runtime.directory instanceof MemorySqlRegisteredUserDirectory)) {
    throw new Error(
      "grantContactBetweenTelegramUsers requires MemorySqlRegisteredUserDirectory or TestOnlyRegisteredUserDirectory",
    );
  }
  const testDirectory = new TestOnlyRegisteredUserDirectory(runtime.sql);
  (runtime as { directory: RegisteredUserDirectory }).directory = testDirectory;
  return testDirectory;
}
