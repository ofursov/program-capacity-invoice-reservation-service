# Program Capacity & Invoice Reservation Service

A NestJS backend that tracks financing-program capacity, holds capacity against invoices
("reservations"), supports multi-currency reservations via FX-rate snapshots, and
consumes treasury capacity/reconciliation events from Kafka.

## Quick Start

On a fresh machine, with Docker and Node installed:

```bash
./demo.sh
```

This copies `.env.example` to `.env`, installs dependencies, starts Postgres/Kafka/the app
via Docker Compose, applies migrations, seeds demo data, and prints the app URL, a dev
JWT, and the seeded program id. See [Local Setup](#11-local-setup) for the manual,
step-by-step version.

## 0. Trade-offs

| Decision | Reason | Future improvement |
|---|---|---|
| Explicit `SELECT ... FOR UPDATE` row locking for reserve/release | The per-program invariant is enforceable in a single Postgres transaction; no need for Redis/distributed locking at this scale, and the lock is the primary — not incidental — consistency mechanism. | If one program sees extreme write contention, consider per-program command serialization/queueing or capacity sharding. |
| Aggregate state (`programs`) plus an append-only ledger (`capacity_ledger`) | Fast reads for the hot path, full auditability for the ledger, without the complexity of full event sourcing. | Move toward event sourcing only if replay/audit requirements tighten materially. |
| Full reservation-level reconciliation (not aggregate-only) | Treasury's `activeReservations` snapshot is authoritative; upserting individual reservations keeps local reservation state consistent with treasury, not just the aggregate total. | Add discrepancy reporting/alerting when a reconciliation `CONFLICT` is recorded, instead of only logging it. |
| Simple seeded FX data instead of a real provider | The task is about capacity tracking, not FX integration. | External FX reference-data service with validity windows, fallback rules, and rate-source audit. |
| No Redis cache in front of availability reads | Correctness over read optimization — caching financial availability risks stale reads during a hold. | Add a cache only with strict invalidation or event-driven refresh if read traffic demands it. |
| Single Capacity Service, not multiple microservices | Keeps reservation/release/limit-update/ledger writes inside one transactional boundary. | Run the API and the Kafka consumer as separate processes from the same codebase; only extract treasury ingestion/FX/audit as separate services if operationally justified. |
| No balance/limit metrics exposed as Prometheus gauges | Financial position should stay behind authenticated APIs, not leak through operational metrics. | Expose operational counters (request rates, error rates, consumer lag), or add `capacity_available_minor` behind an internal-only metrics endpoint if observability needs it. |

## 1. Overview

Finance programs each have a total capacity limit in a program currency. Clients reserve
part of that capacity against an invoice (which may be denominated in a different
currency), and later release the reservation once the invoice is repaid. An external
treasury system publishes capacity-limit updates and periodic reconciliation events over
Kafka; this
service consumes them idempotently and keeps its own aggregate state and audit ledger in
sync.

This is implemented as a single deployable **Capacity Service** with clearly separated
internal modules (`auth`, `programs`, `reservations`, `treasury`, `fx`, `audit`,
`health`) rather than several microservices. The reservation/release path and the
treasury consumer both need to update the same per-program invariant
(`reserved_amount_minor <= total_limit_minor`), so keeping them in one transactional
boundary avoids distributed-locking complexity that the assignment scope doesn't need.

## 2. Key Business Assumptions

- PostgreSQL is the source of truth for capacity state; there is no cache in front of it.
- Program capacity and reservations are stored in **minor units** (e.g. cents), never
  floating point.
- Invoice currency may differ from program currency. FX conversion accounts for each
  currency's exponent (e.g. JPY has 0 minor-unit digits, USD/EUR have 2).
- FX is **snapshotted at reservation time** and stored on the reservation. Release never
  recalculates FX — it releases exactly the amount that was reserved.
- Reservation release is **full-only**; there is no partial release.
- There is **no timer-based auto-expiry**. A reservation only closes via the release API
  or a treasury reconciliation adjustment — auto-releasing on a wall clock could free
  capacity still committed to a live invoice.
- Normal API reservations can never push a program over its limit. Treasury
  reconciliation is authoritative and may reveal a genuine over-limit state
  (`OVER_LIMIT`), in which case new reservations against that program are rejected until
  it's resolved.
- A reservation superseded by treasury reconciliation (`RECONCILED`) can no longer be
  released through the API (`409 RECONCILIATION_CONFLICT`) — treasury is the source of
  truth for it going forward.
- Duplicate reservation attempts for the same invoice on the same program are rejected by
the database unique index on `(program_id, invoice_id)`; Kafka message processing is
  deduplicated primarily by `(topic, partition, offset)` — the exact redelivery case —
  with the message's own `messageId` as a secondary uniqueness check that also detects
  (and rejects) accidental ID reuse with a different payload.

## 3. Architecture

```text
                     ┌───────────────────────────┐
 API Clients ──JWT──▶│      Capacity Service      │
                     │  (NestJS, single process) │
                     │                            │
                     │  AuthModule                │
                     │  ProgramsModule            │
                     │  ReservationsModule        │
                     │  TreasuryModule (Kafka)    │
                     │  FxModule                  │
                     │  AuditModule (ledger)      │
                     └───────────┬────────────────┘
                                 │
                                 ▼
                          PostgreSQL
              (programs, invoice_reservations, capacity_ledger,
               reconciliation_runs, processed_kafka_messages, fx_rates, currencies)
                                 ▲
                                 │
      Kafka topics: treasury.program-capacity-updated.v1
                     treasury.program-reconciliation.v1
                  (keyed by programExternalRef)
                                 │
                     External Treasury System
```

Aggregate program state (`reserved_amount_minor`, `available`, `status`, ...) is kept on
the `programs` row for fast reads, while every capacity movement is additionally appended
to `capacity_ledger` for auditability. The API and the Kafka consumer both run in this one
process for the assignment; in production they could be split into separate processes
from the same codebase (`capacity-api`, `treasury-consumer`) without changing the domain
logic, since neither owns state the other doesn't also read through Postgres.

## 4. Data Model

Prisma schema (`prisma/schema.prisma`) — key tables:

| Table | Purpose |
|---|---|
| `programs` | Program capacity aggregate: `external_ref`, `currency`, `total_limit_minor`, `reserved_amount_minor`, `status` (`ACTIVE`/`OVER_LIMIT`), `treasury_version`, `last_reconciled_at`. |
| `invoice_reservations` | One row per reservation: `program_id`, `invoice_id`, `status` (`ACTIVE`/`RELEASED`/`RECONCILED`), invoice amount/currency, `reserved_amount_minor` in program currency, FX rate + source + `fx_rate_valid_at` snapshot, `released_at`, `source` (`API`/`TREASURY_RECONCILIATION`), `reconciled_at`, `reconciliation_message_id`. Unique on `(program_id, invoice_id)` to make duplicate-invoice behaviour explicit and to drive the reconciliation upsert. |
| `capacity_ledger` | Append-only audit trail of every capacity movement, using the v2 event vocabulary: `PROGRAM_CREATED`, `CAPACITY_INCREASED`, `CAPACITY_DECREASED`, `RESERVATION_CREATED`, `RESERVATION_RELEASED`, `TREASURY_UPDATE_APPLIED`, `TREASURY_RECONCILIATION_APPLIED`. |
| `reconciliation_runs` | One row per treasury reconciliation event received: `APPLIED`, `STALE_SKIPPED` (superseded by a newer `treasuryVersion`), or `CONFLICT` (currency mismatch or declared/sum mismatch in `activeReservations` — recorded but not applied). |
| `processed_kafka_messages` | Kafka de-duplication table, unique on `(topic, partition, offset_value)` (catches exact redelivery) and on `external_message_id` (catches the same treasury `messageId` arriving under a new offset); `payload_hash` detects accidental id reuse with a different payload. |
| `fx_rates`, `currencies` | Seeded FX reference data and per-currency minor-unit exponents. |

## 5. API Endpoints

All business endpoints require a `Bearer` JWT and the listed OAuth-style scope. Duplicate
reservation requests for the same invoice/program are rejected by the database unique
constraint. Interactive docs are served at `GET /docs` (Swagger UI) when
`SWAGGER_ENABLED=true`.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/health/live` | *(public)* | Liveness probe. |
| `GET` | `/health/ready` | *(public)* | Readiness probe; checks Postgres connectivity. |
| `GET` | `/v1/programs/:programId/availability` | `capacity:read` | Current capacity snapshot for a program. |
| `POST` | `/v1/reservations` | `capacity:write` | Create a reservation (holds capacity against an invoice). |
| `POST` | `/v1/reservations/:reservationId/release` | `capacity:write` | Fully release an active reservation. |
| `GET` | `/v1/reservations/:reservationId` | `capacity:read` | Fetch reservation detail. |

This is the full/minimum required API surface. There is intentionally no cancellation or
admin endpoint — see "Business Assumptions" and "Trade-offs" below.

### Create reservation

```http
POST /v1/reservations
Authorization: Bearer <token>
Content-Type: application/json

{
  "programId": "b6f1a2b0-....",
  "invoiceId": "INV-1001",
  "invoiceAmountMinor": 10000000,
  "invoiceCurrency": "EUR"
}
```

Response (`201`):

```json
{
  "reservationId": "d3c9....",
  "programId": "b6f1a2b0-....",
  "invoiceId": "INV-1001",
  "status": "ACTIVE",
  "invoiceAmountMinor": 10000000,
  "invoiceCurrency": "EUR",
  "reservedAmountMinor": 10800000,
  "programCurrency": "USD",
  "availableAmountMinor": 989200000,
  "fxRate": "1.08",
  "fxRateValidAt": "2026-07-01T00:00:00.000Z"
}
```

Notable error responses: `409 INSUFFICIENT_CAPACITY`, `409 INVOICE_ALREADY_RESERVED` /
`INVOICE_ALREADY_PROCESSED` (duplicate invoice on the same program).

### Release reservation

```http
POST /v1/reservations/{reservationId}/release
```

```json
{
  "reservationId": "d3c9....",
  "programId": "b6f1a2b0-....",
  "status": "RELEASED",
  "releasedAmountMinor": 10800000,
  "programCurrency": "USD",
  "availableAmountMinor": 1000000000,
  "releasedAt": "2026-07-03T10:15:00.000Z"
}
```

Status transitions on release:

- `ACTIVE -> RELEASED`: capacity is restored, one `RESERVATION_RELEASED` ledger event.
- `RELEASED -> RELEASED`: idempotent success, returns the same response, no new mutation.
- `RECONCILED -> `: `409 RECONCILIATION_CONFLICT` — the reservation was superseded by a
  treasury reconciliation snapshot and can only be resolved by a subsequent treasury
  message, not by the local release API.

## 6. Kafka Message Format

Two topics, both keyed by `programExternalRef` so that all events for one program stay in
order on the same partition:

- `treasury.program-capacity-updated.v1` — `PROGRAM_CAPACITY_UPDATED`
- `treasury.program-reconciliation.v1` — `PROGRAM_RECONCILIATION`

```json
// PROGRAM_CAPACITY_UPDATED
{
  "messageId": "6a49....",
  "type": "PROGRAM_CAPACITY_UPDATED",
  "programExternalRef": "PROGRAM-ABC",
  "treasuryVersion": 1751500000000,
  "occurredAt": "2026-07-03T08:00:00.000Z",
  "payload": {
    "currency": "USD",
    "currencyExponent": 2,
    "totalLimitMinor": 1500000000
  }
}

// PROGRAM_RECONCILIATION
{
  "messageId": "8f12....",
  "type": "PROGRAM_RECONCILIATION",
  "programExternalRef": "PROGRAM-ABC",
  "treasuryVersion": 1751500100000,
  "occurredAt": "2026-07-03T08:05:00.000Z",
  "payload": {
    "currency": "USD",
    "currencyExponent": 2,
    "totalLimitMinor": 1000000000,
    "reservedAmountMinor": 250000000,
    "activeReservations": [
      { "invoiceId": "INV-1", "reservedAmountMinor": 100000000, "currency": "USD" },
      { "invoiceId": "INV-2", "reservedAmountMinor": 150000000, "currency": "USD" }
    ]
  }
}
```

Behaviour:

- `PROGRAM_CAPACITY_UPDATED` creates the program if it doesn't exist yet, or updates its
  `total_limit_minor` — guarded by `treasuryVersion` so a stale/reordered message is
  ignored. Emits `PROGRAM_CREATED` or `TREASURY_UPDATE_APPLIED`.
- `PROGRAM_RECONCILIATION` is **full reservation-level reconciliation** (see below), not
  just an aggregate overwrite.
- Every message is deduplicated primarily by `(topic, partition, offset_value)` (an exact
  Kafka redelivery, e.g. after a crash before the offset commit) and secondarily by
  `external_message_id` (the treasury `messageId` showing up again under a *different*
  offset); if the same `messageId` reappears with a different `payload_hash`, it's logged
  as a conflict and not reapplied — `processed_kafka_messages` is the table backing this.
  Offsets are only committed after the handling DB transaction commits (DB-commit-first,
  then Kafka-offset-commit, giving effectively-once processing at the application level).
  Invalid/malformed messages are logged and skipped (offset still committed) rather than
  crashing the consumer.

### Reservation-level reconciliation

Each `PROGRAM_RECONCILIATION` message's `activeReservations` array is treated as the full,
authoritative snapshot of every reservation treasury still considers open for that
program:

1. The program row and every existing reservation for that program are locked
   (`SELECT ... FOR UPDATE`) for the duration of the transaction.
2. The message is validated: every `activeReservations[i].currency` must match the program
   currency, and `sum(activeReservations[*].reservedAmountMinor)` must equal the declared
   `reservedAmountMinor`. A mismatch is recorded as a `reconciliation_runs` row with
   status `CONFLICT` and **not applied** (logged, message marked processed so it isn't
   retried forever).
3. For each item in `activeReservations`: if a reservation with that `invoiceId` already
   exists and isn't `RELEASED`, its amount/currency are updated and it's (re)marked
   `ACTIVE`; if none exists, a new reservation is inserted with `source =
   TREASURY_RECONCILIATION`; if a matching reservation is already `RELEASED`, the
   mismatch is logged and **not reopened**.
4. Any locally `ACTIVE` reservation for that program that is *not* present in
   `activeReservations` is marked `RECONCILED` (with `reconciled_at` and
   `reconciliation_message_id` set) and excluded from the new aggregate.
5. `programs.total_limit_minor` and `programs.reserved_amount_minor` are set from the
   message's `totalLimitMinor` and from `sum(activeReservations[*].reservedAmountMinor)`
   (not the locally-summed `ACTIVE` rows — the snapshot is authoritative), `status`
   becomes `ACTIVE` or `OVER_LIMIT`, and `last_reconciled_at` is updated.
6. One `reconciliation_runs` row (before/after aggregate values, counts of
   inserted/updated/reconciled/conflicting reservations) and one
   `TREASURY_RECONCILIATION_APPLIED` ledger event (amount = aggregate reserved delta) are
   written.

A `treasuryVersion` older than or equal to the program's current version is recorded as
`STALE_SKIPPED` and not applied at all (handles out-of-order delivery).

## 7. Multi-Currency & FX Handling

Money is always stored as an integer in minor units. Converting between currencies with
different exponents (e.g. invoice in JPY, exponent 0, program in USD, exponent 2) is done
via `src/fx/money.ts` using `decimal.js` and `HALF_UP` rounding — never native floating
point. The FX rate, its source, and `fx_rate_valid_at` are snapshotted onto the
reservation at creation time; release always uses that stored `reserved_amount_minor`
and never re-derive FX from a (possibly since-changed) rate.

## 8. Consistency & Concurrency Strategy

Reservation creation locks the program row explicitly (`SELECT * FROM programs WHERE id =
$1 FOR UPDATE`) at the start of the transaction, checks available capacity in application
code, and only then updates `reserved_amount_minor` — the lock (not a client-side retry
loop) is what serializes concurrent requests against the same program row, so two
concurrent reservations can never both succeed past the limit. The `UPDATE` itself keeps a
defensive `WHERE total_limit_minor - reserved_amount_minor >= :amount` guard as
belt-and-braces, but the lock is the primary mechanism. Release locks the reservation row
first (`SELECT ... FOR UPDATE`), then the program row, before subtracting the reserved
amount — matching order avoids lock-ordering deadlocks between concurrent reserve/release
calls on the same program. This is verified directly by
`src/reservations/concurrency.integration.spec.ts`, which fires many concurrent
reservation requests at one program and asserts the final reserved amount never exceeds
the limit. This avoids needing a distributed lock (e.g. Redis) at the cost of the same
program's writes serializing on that row, which is an accepted trade-off (see below).

## 9. Duplicate Reservation Handling

Duplicate reservation requests for the same `(program_id, invoice_id)` are rejected by the
database unique index on `invoice_reservations`. This makes duplicate-invoice behaviour
explicit at the persistence layer and prevents a second reservation from being created
accidentally when the same invoice is submitted again.

## 10. Reconciliation Strategy

Treasury reconciliation is treated as authoritative and is full reservation-level
reconciliation from `activeReservations` — see "Reservation-level reconciliation" under
section 6 for the full algorithm. If reconciliation reveals `reserved_amount_minor >
total_limit_minor`, the program is marked `OVER_LIMIT` and new reservations against it are
rejected (`409 PROGRAM_OVER_LIMIT`) until a subsequent update resolves it. It is never
applied as a silent overwrite: every message produces a `reconciliation_runs` record
(`APPLIED`/`STALE_SKIPPED`/`CONFLICT`), and a net aggregate change produces a
`TREASURY_RECONCILIATION_APPLIED` ledger entry.

## 11. Local Setup

```bash
cp .env.example .env
npm install
npm run docker:up          # postgres + redpanda (Kafka-compatible broker)
npm run migrate            # apply Prisma migrations
npm run seed                # seed currencies, FX rates, and a demo program (PROGRAM-ABC)
npm run start:dev
```

The API listens on `http://localhost:3000`; Swagger UI is at `http://localhost:3000/docs`.

Get a dev JWT (scopes default to `capacity:read capacity:write`):

```bash
npm run token:dev
# npm run token:dev -- <subject> "capacity:read capacity:write"
```

## 12. Running Tests

```bash
npm test              # unit tests (fx/money, programs service, treasury schema/consumer wiring)
npm run test:cov      # unit tests with coverage
npm run test:e2e      # full HTTP e2e flow (test/*.e2e-spec.ts) — requires docker:up + migrate + seed
```

`npm test` also runs the integration and concurrency specs that live under `src/**/*.spec.ts`
(`reservations.integration.spec.ts`, `concurrency.integration.spec.ts`,
`treasury.integration.spec.ts`, `treasury-kafka.integration.spec.ts`), which need a real
Postgres (and, for the Kafka integration spec, a real broker) — run `npm run docker:up`
first.

## 13. Demo Commands

```bash
# HTTP: reserve, check availability, release
TOKEN=$(npm run token:dev --silent)
curl -s http://localhost:3000/v1/programs/<programId>/availability -H "Authorization: Bearer $TOKEN"
curl -s -X POST http://localhost:3000/v1/reservations \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"programId":"<programId>","invoiceId":"INV-1001","invoiceAmountMinor":10000000,"invoiceCurrency":"EUR"}'

# Kafka: publish a capacity update event for PROGRAM-ABC
npm run kafka:produce:capacity-update -- PROGRAM-ABC 1500000000 USD 2

# Kafka: publish a reconciliation event with two active reservations for PROGRAM-ABC
npm run kafka:produce:reconciliation -- PROGRAM-ABC 1000000000 USD 2 "$(date +%s%3N)" \
  '[{"invoiceId":"INV-1","reservedAmountMinor":100000000,"currency":"USD"},{"invoiceId":"INV-2","reservedAmountMinor":150000000,"currency":"USD"}]'
```


## 14. Future Improvements

- **Dead-letter handling for Kafka**: malformed/unparseable treasury messages are
  currently logged and the offset is committed immediately; a bounded retry-then-DLQ
  policy with alerting would be safer in production.
- **Bounded concurrency for reconciliation storms**: the consumer processes one message
  at a time (`eachMessage`); a bulk-reconciliation replay would benefit from throttled
  parallelism per partition.
- **Duplicate-invoice observability**: duplicate invoice conflicts are currently surfaced as
  application errors; a small operator-visible audit view or alert would make them easier
  to review.
- **Graceful shutdown**: `main.ts` doesn't yet handle `SIGTERM` to fail readiness, drain
  in-flight HTTP requests, and stop Kafka polling before exit.
- **Ledger primary key**: `capacity_ledger.id` currently uses `gen_random_uuid()`
  (UUIDv4); a sequential/time-ordered id (UUIDv7/ULID) would keep the append-heavy
  ledger's index better ordered at higher volume.
- **Reconciliation conflict handling**: a currency mismatch or a declared/sum mismatch in
  `activeReservations` is currently recorded (`reconciliation_runs.status = 'CONFLICT'`)
  and logged, but not surfaced anywhere actionable (e.g. an alert or an admin-visible
  queue) — an operator has to know to look at the table.

