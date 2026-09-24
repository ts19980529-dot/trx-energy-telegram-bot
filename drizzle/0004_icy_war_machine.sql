ALTER TABLE "provider_transaction_attempts" ADD COLUMN "signer_unsigned_txid" text;--> statement-breakpoint
ALTER TABLE "provider_transaction_attempts" ADD COLUMN "signer_unsigned_digest" text;--> statement-breakpoint
ALTER TABLE "provider_transaction_attempts" ADD COLUMN "signed_transaction" jsonb;--> statement-breakpoint
ALTER TABLE "provider_transaction_attempts" ADD COLUMN "signed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_transaction_attempts_signer_unsigned_txid_unique" ON "provider_transaction_attempts" USING btree ("signer_unsigned_txid") WHERE "provider_transaction_attempts"."signer_unsigned_txid" is not null;--> statement-breakpoint
ALTER TABLE "provider_transaction_attempts" ADD CONSTRAINT "provider_transaction_attempts_signer_state_check" CHECK ((
        "provider_transaction_attempts"."signer_unsigned_txid" is null
        and "provider_transaction_attempts"."signer_unsigned_digest" is null
        and "provider_transaction_attempts"."signed_transaction" is null
        and "provider_transaction_attempts"."signed_at" is null
      ) or (
        "provider_transaction_attempts"."signer_unsigned_txid" is not null
        and "provider_transaction_attempts"."signer_unsigned_digest" is not null
        and "provider_transaction_attempts"."signed_transaction" is not null
        and "provider_transaction_attempts"."signed_at" is not null
      ));