ALTER TABLE "payment_transactions" DROP CONSTRAINT "payment_transactions_txid_unique";--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "event_index" integer;--> statement-breakpoint
CREATE INDEX "payment_transactions_txid_idx" ON "payment_transactions" USING btree ("txid");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transactions_trx_txid_unique" ON "payment_transactions" USING btree ("txid") WHERE "payment_transactions"."asset" = 'TRX';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transactions_trc20_event_unique" ON "payment_transactions" USING btree ("token_contract_address","txid","event_index") WHERE "payment_transactions"."asset" = 'USDT';--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_event_position_check" CHECK ((
        ("payment_transactions"."asset" = 'TRX' and "payment_transactions"."event_index" is null)
        or
        (
          "payment_transactions"."asset" = 'USDT'
          and "payment_transactions"."event_index" is not null
          and "payment_transactions"."event_index" >= 0
        )
      ));
