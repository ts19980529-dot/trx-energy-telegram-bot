CREATE TABLE "provider_transaction_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_delivery_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"attempt_key" text NOT NULL,
	"txid" text,
	"expiration_at" timestamp with time zone,
	"status" text DEFAULT 'created' NOT NULL,
	"last_broadcast_result" text,
	"last_chain_status" text,
	"last_chain_observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_transaction_attempts_delivery_number_unique" UNIQUE("provider_delivery_id","attempt_number"),
	CONSTRAINT "provider_transaction_attempts_attempt_key_unique" UNIQUE("attempt_key"),
	CONSTRAINT "provider_transaction_attempts_number_positive" CHECK ("provider_transaction_attempts"."attempt_number" > 0),
	CONSTRAINT "provider_transaction_attempts_status_check" CHECK ("provider_transaction_attempts"."status" in ('created', 'signed', 'accepted', 'processing', 'completed', 'failed', 'expired', 'unknown')),
	CONSTRAINT "provider_transaction_attempts_broadcast_check" CHECK ("provider_transaction_attempts"."last_broadcast_result" is null or "provider_transaction_attempts"."last_broadcast_result" in ('accepted', 'rejected', 'unknown')),
	CONSTRAINT "provider_transaction_attempts_chain_check" CHECK ("provider_transaction_attempts"."last_chain_status" is null or "provider_transaction_attempts"."last_chain_status" in ('absent', 'processing', 'completed', 'failed', 'unknown')),
	CONSTRAINT "provider_transaction_attempts_identity_check" CHECK (("provider_transaction_attempts"."status" in ('created', 'failed') and "provider_transaction_attempts"."txid" is null and "provider_transaction_attempts"."expiration_at" is null) or ("provider_transaction_attempts"."status" <> 'created' and "provider_transaction_attempts"."txid" is not null and "provider_transaction_attempts"."expiration_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "provider_transaction_attempts" ADD CONSTRAINT "provider_transaction_attempts_provider_delivery_id_provider_deliveries_id_fk" FOREIGN KEY ("provider_delivery_id") REFERENCES "public"."provider_deliveries"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_transaction_attempts_txid_unique" ON "provider_transaction_attempts" USING btree ("txid");
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_transaction_attempts_active_delivery_unique" ON "provider_transaction_attempts" USING btree ("provider_delivery_id") WHERE "provider_transaction_attempts"."status" in ('created', 'signed', 'accepted', 'processing', 'unknown');
