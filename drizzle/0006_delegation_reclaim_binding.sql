ALTER TABLE "provider_transaction_attempts" ADD COLUMN "delegated_owner_address" text;--> statement-breakpoint
ALTER TABLE "provider_transaction_attempts" ADD COLUMN "delegated_receiver_address" text;--> statement-breakpoint
ALTER TABLE "provider_transaction_attempts" ADD COLUMN "delegated_resource" text;--> statement-breakpoint
ALTER TABLE "provider_transaction_attempts" ADD COLUMN "delegated_balance_sun" bigint;--> statement-breakpoint
CREATE TABLE "provider_reclaim_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_provider_transaction_attempt_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"attempt_key" text NOT NULL,
	"txid" text,
	"expiration_at" timestamp with time zone,
	"broadcast_accepted_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"status" text DEFAULT 'created' NOT NULL,
	"last_broadcast_result" text,
	"last_chain_status" text,
	"last_chain_observed_at" timestamp with time zone,
	"signer_unsigned_txid" text,
	"signer_unsigned_digest" text,
	"signed_transaction" jsonb,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_reclaim_attempts_source_number_unique" UNIQUE("source_provider_transaction_attempt_id","attempt_number"),
	CONSTRAINT "provider_reclaim_attempts_attempt_key_unique" UNIQUE("attempt_key"),
	CONSTRAINT "provider_reclaim_attempts_number_positive" CHECK ("provider_reclaim_attempts"."attempt_number" > 0),
	CONSTRAINT "provider_reclaim_attempts_status_check" CHECK ("provider_reclaim_attempts"."status" in ('created', 'signed', 'accepted', 'processing', 'completed', 'failed', 'expired', 'unknown')),
	CONSTRAINT "provider_reclaim_attempts_broadcast_check" CHECK ("provider_reclaim_attempts"."last_broadcast_result" is null or "provider_reclaim_attempts"."last_broadcast_result" in ('accepted', 'rejected', 'unknown')),
	CONSTRAINT "provider_reclaim_attempts_chain_check" CHECK ("provider_reclaim_attempts"."last_chain_status" is null or "provider_reclaim_attempts"."last_chain_status" in ('absent', 'processing', 'completed', 'failed', 'unknown')),
	CONSTRAINT "provider_reclaim_attempts_identity_check" CHECK (("provider_reclaim_attempts"."status" in ('created', 'failed') and "provider_reclaim_attempts"."txid" is null and "provider_reclaim_attempts"."expiration_at" is null) or ("provider_reclaim_attempts"."status" <> 'created' and "provider_reclaim_attempts"."txid" is not null and "provider_reclaim_attempts"."expiration_at" is not null)),
	CONSTRAINT "provider_reclaim_attempts_finalized_status_check" CHECK ("provider_reclaim_attempts"."finalized_at" is null or "provider_reclaim_attempts"."status" = 'completed'),
	CONSTRAINT "provider_reclaim_attempts_signer_state_check" CHECK ((
        "provider_reclaim_attempts"."signer_unsigned_txid" is null
        and "provider_reclaim_attempts"."signer_unsigned_digest" is null
        and "provider_reclaim_attempts"."signed_transaction" is null
        and "provider_reclaim_attempts"."signed_at" is null
      ) or (
        "provider_reclaim_attempts"."signer_unsigned_txid" is not null
        and "provider_reclaim_attempts"."signer_unsigned_digest" is not null
        and "provider_reclaim_attempts"."signed_transaction" is not null
        and "provider_reclaim_attempts"."signed_at" is not null
      ))
);--> statement-breakpoint
ALTER TABLE "provider_transaction_attempts" ADD CONSTRAINT "provider_transaction_attempts_delegation_binding_check" CHECK ((
        "provider_transaction_attempts"."delegated_owner_address" is null
        and "provider_transaction_attempts"."delegated_receiver_address" is null
        and "provider_transaction_attempts"."delegated_resource" is null
        and "provider_transaction_attempts"."delegated_balance_sun" is null
      ) or (
        "provider_transaction_attempts"."delegated_owner_address" is not null
        and "provider_transaction_attempts"."delegated_receiver_address" is not null
        and "provider_transaction_attempts"."delegated_resource" = 'ENERGY'
        and "provider_transaction_attempts"."delegated_balance_sun" is not null
        and "provider_transaction_attempts"."delegated_balance_sun" >= 1000000
      ));--> statement-breakpoint
ALTER TABLE "provider_reclaim_attempts" ADD CONSTRAINT "provider_reclaim_attempts_source_provider_transaction_attempt_id_provider_transaction_attempts_id_fk" FOREIGN KEY ("source_provider_transaction_attempt_id") REFERENCES "public"."provider_transaction_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_reclaim_attempts_txid_unique" ON "provider_reclaim_attempts" USING btree ("txid");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_reclaim_attempts_signer_unsigned_txid_unique" ON "provider_reclaim_attempts" USING btree ("signer_unsigned_txid") WHERE "provider_reclaim_attempts"."signer_unsigned_txid" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_reclaim_attempts_active_source_unique" ON "provider_reclaim_attempts" USING btree ("source_provider_transaction_attempt_id") WHERE "provider_reclaim_attempts"."status" in ('created', 'signed', 'accepted', 'processing', 'unknown');
