ALTER TABLE "provider_transaction_attempts" ADD COLUMN "broadcast_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_transaction_attempts" ADD COLUMN "finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_transaction_attempts" ADD COLUMN "reclaim_eligible_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_transaction_attempts" ADD CONSTRAINT "provider_transaction_attempts_finalized_status_check" CHECK ("provider_transaction_attempts"."finalized_at" is null or "provider_transaction_attempts"."status" = 'completed');--> statement-breakpoint
ALTER TABLE "provider_transaction_attempts" ADD CONSTRAINT "provider_transaction_attempts_reclaim_timestamps_check" CHECK ((
        "provider_transaction_attempts"."finalized_at" is null
        and "provider_transaction_attempts"."reclaim_eligible_at" is null
      ) or (
        "provider_transaction_attempts"."finalized_at" is not null
        and "provider_transaction_attempts"."reclaim_eligible_at" is not null
        and "provider_transaction_attempts"."reclaim_eligible_at" >= "provider_transaction_attempts"."finalized_at"
        and (
          "provider_transaction_attempts"."broadcast_accepted_at" is null
          or "provider_transaction_attempts"."reclaim_eligible_at" >= "provider_transaction_attempts"."broadcast_accepted_at" + interval '1 hour'
        )
      ));