-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "public"."capacity_ledger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "program_id" UUID NOT NULL,
    "reservation_id" UUID,
    "event_type" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "source" TEXT NOT NULL,
    "external_message_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capacity_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."currencies" (
    "code" CHAR(3) NOT NULL,
    "exponent" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "public"."fx_rates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "base_currency" CHAR(3) NOT NULL,
    "quote_currency" CHAR(3) NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "source" TEXT NOT NULL,
    "valid_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."invoice_reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "program_id" UUID NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "invoice_currency" CHAR(3) NOT NULL,
    "invoice_currency_exponent" SMALLINT NOT NULL,
    "invoice_amount_minor" BIGINT NOT NULL,
    "program_currency" CHAR(3) NOT NULL,
    "program_currency_exponent" SMALLINT NOT NULL,
    "reserved_amount_minor" BIGINT NOT NULL,
    "fx_rate" DECIMAL(20,10) NOT NULL,
    "fx_rate_source" TEXT NOT NULL,
    "fx_rate_valid_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'API',
    "reconciled_at" TIMESTAMPTZ(6),
    "reconciliation_message_id" TEXT,

    CONSTRAINT "invoice_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."processed_kafka_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_type" TEXT NOT NULL,
    "program_external_ref" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "partition" INTEGER NOT NULL,
    "offset_value" BIGINT NOT NULL,
    "external_message_id" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_kafka_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."programs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "external_ref" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "currency_exponent" SMALLINT NOT NULL,
    "total_limit_minor" BIGINT NOT NULL,
    "reserved_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" BIGINT NOT NULL DEFAULT 0,
    "treasury_version" BIGINT,
    "last_treasury_event_at" TIMESTAMPTZ(6),
    "last_reconciled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."reconciliation_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "external_message_id" TEXT NOT NULL,
    "program_id" UUID NOT NULL,
    "treasury_total_limit_minor" BIGINT NOT NULL,
    "treasury_reserved_amount_minor" BIGINT NOT NULL,
    "local_total_limit_minor_before" BIGINT NOT NULL,
    "local_reserved_amount_minor_before" BIGINT NOT NULL,
    "total_limit_difference_minor" BIGINT NOT NULL,
    "reserved_difference_minor" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fx_rates_pair_valid_at_idx" ON "public"."fx_rates"("base_currency" ASC, "quote_currency" ASC, "valid_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_reservations_program_id_invoice_id_key" ON "public"."invoice_reservations"("program_id" ASC, "invoice_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "processed_kafka_messages_external_message_id_key" ON "public"."processed_kafka_messages"("external_message_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "processed_kafka_messages_topic_partition_offset_value_key" ON "public"."processed_kafka_messages"("topic" ASC, "partition" ASC, "offset_value" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "programs_external_ref_key" ON "public"."programs"("external_ref" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_runs_external_message_id_key" ON "public"."reconciliation_runs"("external_message_id" ASC);

-- AddForeignKey
ALTER TABLE "public"."capacity_ledger" ADD CONSTRAINT "capacity_ledger_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."capacity_ledger" ADD CONSTRAINT "capacity_ledger_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "public"."invoice_reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."invoice_reservations" ADD CONSTRAINT "invoice_reservations_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint
ALTER TABLE "currencies"
  ADD CONSTRAINT "currencies_exponent_range_check" CHECK ("exponent" >= 0 AND "exponent" <= 4);

-- CheckConstraint
ALTER TABLE "fx_rates"
  ADD CONSTRAINT "fx_rates_rate_positive_check" CHECK ("rate" > 0);

-- CheckConstraint
-- No upper-bound check against total_limit_minor: treasury reconciliation may
-- reveal an authoritative over-limit state (see dev plan section 10.1).
ALTER TABLE "programs"
  ADD CONSTRAINT "programs_total_limit_minor_nonnegative_check" CHECK ("total_limit_minor" >= 0),
  ADD CONSTRAINT "programs_reserved_amount_minor_nonnegative_check" CHECK ("reserved_amount_minor" >= 0);

-- CheckConstraint
ALTER TABLE "invoice_reservations"
  ADD CONSTRAINT "invoice_reservations_invoice_amount_minor_positive_check" CHECK ("invoice_amount_minor" > 0),
  ADD CONSTRAINT "invoice_reservations_reserved_amount_minor_positive_check" CHECK ("reserved_amount_minor" > 0);
