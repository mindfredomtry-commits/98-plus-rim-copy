# MVP17 Pass 7B — controlled Supabase cutover

This runbook is the production cutover procedure. Pass 7A prepares it. Pass 7B executes it.

Do not put connection strings, passwords, or API keys in this file or in the repository.

## Frozen topology

MVP17: API replicas MUST equal 1.

Increasing API replicas above 1 is forbidden until MVP17-DC-02 is resolved.

DC-02 is open: live RIM provider-flight ownership is process-local. A second API replica can dispatch recovery for a provider call the first replica is still running.

The application cannot see Railway's replica count. The platform setting is the control. The startup log states the same constraint. It does not enforce it.

## Production configuration

The process reads configuration only from the environment.

| Variable            | Required                | Meaning                                                                                                                                                                                                                                                       |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERSISTENCE_MODE`  | yes                     | `memory` or `postgres`. Any other value, including an empty value, fails startup.                                                                                                                                                                             |
| `DATABASE_URL`      | when mode is `postgres` | Opaque PostgreSQL connection string. Do not put `sslmode`, `ssl`, `sslrootcert`, `sslcert`, or `sslkey` in it when `DATABASE_SSL` is set. Those parameters would replace the application TLS setting inside node-postgres.                                    |
| `DATABASE_SSL`      | no                      | `disable` or `require`. When omitted, TLS is whatever `DATABASE_URL` already expresses. `require` verifies the server certificate and hostname. `disable` is plaintext. Production Supabase uses `require`. There is no fallback from `require` to `disable`. |
| `DATABASE_SSL_CA`   | with Supabase `require` | PEM text, or a path to a PEM file, for the CA that signed the server. This is a public certificate, not a credential. For this Session Pooler set it to `packages/persistence/certs/supabase-root-2021.crt`. It is used only on the Postgres socket.          |
| `DATABASE_POOL_MAX` | no                      | Positive integer override. When omitted, node-postgres uses its driver default (10). That default is not a capacity decision.                                                                                                                                 |

Startup fails when postgres mode is selected and `DATABASE_URL` is missing. A failed Postgres connection does not start `MemorySqlClient`.

Logs may contain `persistence=postgres` or `persistence=memory` and `poolMax=driver-default` or `poolMax=<number>`. They must not contain `DATABASE_URL` or a password.

No Supabase SDK and no service-role key are required. `DATABASE_URL` is the PostgreSQL credential.

Local test UI, intentionally volatile:

```sh
PERSISTENCE_MODE=memory npm start
```

## Connection mode for Pass 7B

Product writes use a real PostgreSQL transaction and `SELECT FOR UPDATE`. The migration runner holds one session advisory lock across per-migration transactions.

Use a session-capable connection for `DATABASE_URL`:

- Supabase direct connection, or
- Supabase session pooler.

Do not use the transaction-mode pooler (commonly port 6543). That mode can move statements from one server session to another between transactions, which breaks the migration lock.

Confirm the chosen endpoint accepts:

- `BEGIN` / `COMMIT` / `ROLLBACK`
- `SELECT … FOR UPDATE`
- `SELECT pg_advisory_lock(integer, integer)` held on one session across several transactions

Do that with a disposable statement from an operator client before the API is pointed at the database. Do not encode the endpoint choice in application code.

## Pool capacity

```text
TOTAL POSSIBLE CONNECTIONS
≈ API replicas × pool max
+ migration/admin/other clients
```

For MVP17, API replicas = 1.

When `DATABASE_POOL_MAX` is unset, pool max is the node-postgres driver default, 10. During startup the migration runner checks out one connection from that same pool and releases it before listen. Steady state is the pool max, plus any dashboard or operator sessions.

Before traffic, confirm `pool max + operator headroom` is under the target database's connection limit. If it is not, set `DATABASE_POOL_MAX` to a smaller positive integer. That value is still a temporary cutover cap, not a load-tested size.

## What is not migrated

Current production (`npm start` before this cutover, and Pass 6 commit `e68f127f2aafd824d0f97600331ab7d5082f1b10`) constructs `MemorySqlClient` only. Product, identity, Share, and RIM state in that process are volatile. They disappear on restart. There is no durable canonical production Product dataset to export.

Pass 7B starts from an empty Supabase database. Do not attempt to scrape a live memory process.

## Startup sequence

`npm start` runs `tsx apps/api/src/main.ts`, which calls `startApiProcess`. The migration runner reads the canonical `.sql` files beside the TypeScript sources. Pass 7B keeps this start command so those files stay on the module path.

1. Read `PERSISTENCE_MODE` and, for postgres, `DATABASE_URL`.
2. Open one pool.
3. `SELECT 1`.
4. Run the production migration runner.
5. Construct one runtime: that pool's client, `PostgresIdentityStore`, `PostgresProductStore`, and the registered-user directory on the same client.
6. Listen.

The HTTP server does not listen if step 3 or 4 fails. The pool is closed. `SIGTERM`, `SIGINT`, and a normal close stop accepting HTTP work, then close the pool.

The runner is not the test helper `applyMigrations()`. `applyMigrations()` replays SQL and writes no history. Production uses `migrate()`.

## Migration runner

Canonical files, in order, read from disk:

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

History table `schema_migrations` stores `version` (the file path) and `applied_at`. A recorded version is not executed again. Each migration commits on its own. A failed migration is rolled back and is not inserted. A second runner waits on the session advisory lock, then sees the history.

The runner stops without changing later migrations when:

- history contains a version that is not in this chain
- history is not a prefix of this chain
- a recorded migration's table, index, named constraint, or column is missing
- a not-yet-recorded migration's object is already present

Those states need a person. The runner does not drop, rewrite, or mark them applied.

Migrations 001–010 are the canonical schema. Do not down-migrate them because an application deploy is rolled back. After `rim_chats` or `rim_messages` contain rows, do not drop 010.

## Pass 7B sequence

1. Create or select the Supabase project and its PostgreSQL database. Prefer an empty database.
2. Obtain one session-capable PostgreSQL connection string. Keep it in the platform secret store only.
3. From an operator client, verify `BEGIN`/`COMMIT`, `SELECT … FOR UPDATE`, and a session `pg_advisory_lock` using that string. Disconnect afterwards.
4. In Railway, set `PERSISTENCE_MODE=postgres` only when this deploy should serve the database. Set `DATABASE_URL` to the Session Pooler string with no `sslmode` parameter. Set `DATABASE_SSL=require`. Set `DATABASE_SSL_CA` to `packages/persistence/certs/supabase-root-2021.crt` (or the same PEM). Leave `DATABASE_POOL_MAX` unset unless the connection limit requires a smaller temporary cap. Do not set `DATABASE_SSL=disable`.
5. Set the API service to one replica. Confirm the count in the Railway UI. Do not add a second service that also runs this API against the same database.
6. Deploy this migration-capable application while the previous deployment is still the one serving traffic, or deploy it with the new command not yet receiving users. The deployed commit must be Pass 7A (`MVP17: prepare PostgreSQL production cutover`) or a later commit that preserves this startup path.
7. Start one process with `PERSISTENCE_MODE=postgres`. Startup runs migrations before listen. If the process exits before listen, stop. Read `schema_migrations` from an operator client. Resume only after the failure cause is understood. Do not delete the schema to "retry from scratch" if any row has been committed.
8. Confirm history:

```sql
SELECT version, applied_at
FROM schema_migrations
ORDER BY applied_at ASC, version ASC;
```

Expect the nine file paths above, each once. `applied_at` is non-null. A second process start must add zero rows.

9. Restart the API with `PERSISTENCE_MODE=postgres` and the same `DATABASE_URL`. Confirm the log contains `persistence=postgres` and the topology line, and does not contain the connection string.
10. Health: the process is listening only after migrations succeed. `GET /api/meta` returns `PRODUCT_CONTROL_STATE_COUNT` 30, `CANONICAL_EVENT_COUNT` 60, `MATRIX_RULE_COUNT` 360.
11. Controlled smoke, one operator, before opening public traffic. See below.
12. Restart the same single replica. Repeat the smoke reads. State must still be there.
13. Watch the rollback signals below during the smoke. Stop before public traffic if any fire.
14. Roll back only by the procedure below. Do not drop the database as a rollback.
15. Freeze only when the smoke and the restart proof pass, history stays at nine versions, replica count is still 1, and DC-02 is still recorded as open.

## Controlled smoke

Use the test UI or the existing HTTP API as one operator. No production OpenAI requirement beyond whatever RIM mode the deployment already uses. Prefer the fake RIM provider for the first smoke if `RIM_PROVIDER` is not `openai`. If OpenAI is enabled, the restart check below still applies.

After each write, read it back. Then restart the single API process and read it again.

- Identity: authenticate one Telegram user. The same Telegram user resolves to the same `user_id` after restart. Confirm a row in `identity_users`.
- Product: open the lobby (`APP.NORMAL_OPEN` or the normal open path). `product_user_sessions.control_state` is `RIM.LOBBY`. After restart the same revision and control state load.
- Create Ban: confirm one Ban. `bans` has one row for that id. Restart does not remove it or create a second Ban.
- Share: create one ACTIVE `share_operations` row. Restart still shows that token. Claim it once with a second user. One receiver, one Incoming Ban, status `CONFIRMED`, one `created_ban_id`.
- RIM: open one RIM chat that initializes a provider conversation. Note `rim_provider_runtime` and the stored conversation id. Restart. Recovery must not call initialize again for that stored conversation. The chat id is unchanged.
- Logs: `persistence=postgres`. No `DATABASE_URL`, no password, no Supabase service key.
- Platform: Railway still shows one API replica.

## Rollback signals

Stop before traffic:

- migration command or startup exits before listen
- `schema_migrations` is not the nine-version prefix
- startup log is missing, or it shows `persistence=memory`
- replica count is not 1
- `/api/meta` is not 30 / 60 / 360

Roll back the application (see below) and do not send users to it:

- the process never becomes healthy
- identity insert/select fails
- a Product write fails for a reason other than an expected revision conflict
- restart loads an empty session for a user who already had a committed snapshot

Database investigation, leave the schema in place, do not down-migrate, do not switch the live process to memory:

- `schema_migrations` disagrees with the tables (runner already refuses this)
- a snapshot reloads with a different revision or missing child rows
- revision/CAS fails on a write that used the revision just loaded, and a second replica is not the cause
- RIM restart creates a second provider conversation for a stored initialization
- Share restart loses an ACTIVE or CONFIRMED row, or a second claim creates a second receiver

## Rollback procedure

Application rollback and schema rollback are different.

Schema: do not run a down migration. 001–010 stay. A rolled-back application that cannot speak Postgres must not be given this database's traffic.

Application, before any user write has committed to Postgres:

- Keep or restore Railway on Pass 6, commit `e68f127f2aafd824d0f97600331ab7d5082f1b10`.
- That commit always uses `MemorySqlClient`. It ignores `DATABASE_URL`.
- Remove the new process from traffic.
- The Supabase schema may remain. It is unused. Do not drop it as part of the rollback.

Pass 6 cannot serve rows that were written by postgres mode. It will boot an empty volatile process and those rows become invisible.

Application, after any durable user write exists:

- Do not deploy Pass 6.
- Do not set `PERSISTENCE_MODE=memory`.
- Redeploy Pass 7A, or a later commit with this same startup path, with `PERSISTENCE_MODE=postgres` and the same `DATABASE_URL`.
- Keep API replicas at 1.
- If the failure is data-shaped, stop traffic and investigate `schema_migrations` and the affected user rows before redeploying.

The first commit that can run against the migrated database is the Pass 7A commit. Pass 6 is the last commit that is a safe volatile rollback, and only while Postgres still has no user writes that must remain visible.

## Carried observations

ACTIVE Share rows have no durable expiry. That is storage lifecycle debt, not a cutover blocker. Do not add a TTL in this cutover.

A RIM attempt in `returned-body-observed` without a `responseId` stays pending. That is a recoverability limitation, not schema corruption. Do not change it in this cutover.

DC-02 stays open. One replica is the mitigation, not the fix.
