# MVP16 final production checkpoint

Read-only checkpoint recorded after MVP16 Stage 1B Pass C — DURABILITY PASS.

Verified at 2026-10-08T13:26:26Z. This file contains no connection strings, tokens, user identifiers, message text, share tokens, or conversation ids.

## A. Final production commit and deployment

| Item              | Value                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------- |
| Commit            | `203cc660cdfb354fcfbfcbc109516cde2cf127ea`                                            |
| Service           | Railway production `@98plus/api`                                                      |
| Deployment        | `7d0964c0-9eaa-4c93-bd98-8f23324e94c7`                                                |
| Deployment status | `SUCCESS`                                                                             |
| Created           | 2026-10-08T10:53:20.198Z                                                              |
| Replica count     | 1, one instance `RUNNING`                                                             |
| Public host       | `https://98plusapi-production.up.railway.app`                                         |
| Health            | `GET /api/meta` returns `"ui": "TEST"`, 30 / 60 / 360                                 |
| Persistence       | `persistence=postgres`, logged again at 2026-10-08T13:14:23Z after the Pass C restart |

Pass C restarted this same deployment at 2026-10-08T13:14:17.9236918Z. The restart did not create a new deployment id.

Active worker and miniapp deployments are not this commit and have no public domains:

| Service           | Active deployment                      | Commit                                     | Created                  | Status               |
| ----------------- | -------------------------------------- | ------------------------------------------ | ------------------------ | -------------------- |
| `@98plus/worker`  | `b76dd05e-ecd2-49ad-9219-0d8ba1e8f286` | `b252d79f4384ef2980f61555c0e5c10331b7290b` | 2026-09-12T10:07:22.194Z | `SUCCESS`, `RUNNING` |
| `@98plus/miniapp` | `4a43fdf3-ec4d-493a-bbb1-40e65d104950` | `2d38fa143274195598935ee8cdca160bb575f216` | 2026-10-06T09:35:22.706Z | `SUCCESS`, `RUNNING` |

## B. Database schema version and migration state

`schema_migrations` has exactly 10 rows. The versions are the repository files 001 through 010, each once:

1. `packages/identity/schema/001_identity_users.sql`
2. `packages/persistence/schema/002_product_persistence.sql`
3. `packages/persistence/schema/003_telegram_persistent_reentry.sql`
4. `packages/persistence/schema/004_telegram_persistent_reentry_bootstrap_claim.sql`
5. `packages/persistence/schema/005_telegram_persistent_reentry_bootstrap_claim_token.sql`
6. `packages/persistence/schema/006_telegram_persistent_reentry_cta_opportunity.sql`
7. `packages/persistence/schema/007_ban_source_proposal.sql`
8. `packages/persistence/schema/008_rim_provider_runtime.sql`
9. `packages/persistence/schema/009_share_operation_token_unique.sql`
10. `packages/persistence/schema/010_rim_history.sql`

The same ten files are present in the local tree at `203cc660`.

Canonical row counts at verification:

| Table                   | Rows |
| ----------------------- | ---: |
| `identity_users`        |    2 |
| `product_user_sessions` |    2 |
| `bans`                  |    2 |
| `domain_timers`         |    0 |
| `check_pairs`           |    0 |
| `notification_items`    |    4 |
| `pending_operations`    |    1 |
| `share_operations`      |    1 |
| `rim_chats`             |    1 |
| `rim_messages`          |    5 |

These counts match the Pass C baseline taken before the restart.

## C. Product Engine freeze counts

Production `GET /api/meta` and the local constants agree:

- 30 control states (`PRODUCT_CONTROL_STATE_COUNT`)
- 60 canonical events (`CANONICAL_EVENT_COUNT`)
- 360 Matrix rows

The live surface is the TEST UI served by the API. `apps/miniapp` is not the public production UI.

## D. Production E2E results

The Stage 1B two-account Telegram E2E succeeded. Production has two identity users, one share operation, and one completed RIM chat between those two users. The chat terminated through Create Ban.

Pass C then restarted the existing API replica and read the archive again. The chat, its Ban link, its conversation-id presence, and its five message payload hashes were unchanged. No canonical Product rows appeared or disappeared across that restart.

This checkpoint re-read the database and matched that proof. It did not send Telegram or OpenAI traffic.

## E. RIM archive durability proof

One `rim_chats` row:

- `terminated_at` is set
- `termination_reason` is `create_ban_success`
- `resulting_ban_id` matches an existing `bans` row
- the chat owner and contact are two different users
- an OpenAI conversation id is stored

Five `rim_messages` rows, ordinals 1–5, kinds `RIM`, `USER`, `RIM`, `USER`, `BAN_PROPOSALS`. There are no duplicate ordinal groups and no gap in 1–5.

Payload SHA-256 values, in ordinal order, match Pass C:

- `65ed7e954a4e6420ed7eda2f6eb20ad11513f97c5f54ed42ff7e5cbb419d410f`
- `ba12e70073eed36422609a0c07c95dccdc47e23fc54952e46a836080a3d92ad3`
- `6214337c1b3d581c3f12ce4456c090f56cf066a4c78c1fb7b794bfd0a7c71b6e`
- `7d85e803e1c30bd355a4a97ff196581bbd2d62a6a78933ce52c80008f154414f`
- `6b8a30a6ccf80bfe320835f3a2f6d00bea0558c503e5329cff5ae71662e421af`

## F. Backup and recovery status

Proven local artifact, outside git:

- File: `%LOCALAPPDATA%\mvp16-recovery\mvp16-public-20261008T103605Z.dump.enc`
- Size: 36116 bytes
- SHA-256: `7ab11595a4b18e77654929bbcdfc0c8e27454c58ed2c0c6bfb392560a933413e`
- Created: 2026-10-08T10:36:05.6074827Z
- Algorithm: AES-256-GCM
- Contents: PostgreSQL 17.11 custom-format dump of the `public` schema
- Source migrations recorded in the manifest: 001–009
- The decryption key file is present beside the dump. Do not copy it into the repository.

Limitations:

- The dump predates migration 010 and predates the production user rows. Restoring it over the current database would remove the archive and the Stage 1B rows.
- It is an application-schema dump, not a full Supabase project restore. Platform schemas, role passwords, and cluster globals are outside it.
- Managed Supabase backup and customer-facing point-in-time recovery were not confirmed. The logical dump is the proven recovery point for the pre-010 empty schema.
- Do not restore this backup into production as a rollback of 010.

## G. Deferred Conflicts

- MVP16-DC-01 RESOLVED
- MVP16-DC-02 OPEN — API replicas must remain exactly 1. Live RIM provider-flight ownership is process-local.
- MVP16-DC-03 RESOLVED FOR CURRENT MVP
- MVP16-DC-04 RESOLVED
- MVP16-DC-05 RESOLVED — production archive durability verified by Pass C and re-read here

## H. Known operational limitations

- The public product surface is the TEST UI on the API host.
- Worker and miniapp keep their older running deployments. They are not serving this production UI.
- `docs/operations/mvp17-pass-7b-cutover.md` now expects production history 001–010. Its earlier sections still describe the original empty-database cutover from memory.
- The startup log states the one-replica rule. The process does not read Railway's replica count.
- RIM history is stored in `rim_chats` and `rim_messages`. It is not automatically sent to OpenAI as retrieved history.
- No history retrieval UI exists.
- After 010 is applied, deploying `428a8de8` against this database is not a safe rollback. That runner treats 010 as an unknown version.

## I. Safe continuation rules

- Do not deploy commit `428a8de8` against schema 010.
- Do not down-migrate or delete archived history.
- Keep API replicas at 1 until DC-02 is resolved.
- New changes require a separate branch or isolated commit sequence.
- Preserve this production checkpoint for rollback planning.
- After migration 010, prefer a forward-fix that still contains migration 010 and the archive prefix checks.
- The existing backup predates user data and cannot restore later activity.
- RIM history is archived but not automatically supplied to OpenAI.
- No history retrieval UI exists yet.

## J. Recommended next implementation stage

Keep this commit as the production baseline. The next stage should be a separate design and implementation pass for reading the durable archive: owner-visible history retrieval, and an explicit decision about whether accepted archive rows are supplied to the provider. That pass must not add an API replica, must not down-migrate 010, and must not treat the pre-010 dump as a rollback of the current rows.
