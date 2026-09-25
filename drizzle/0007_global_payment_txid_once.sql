DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "payment_transactions"
    GROUP BY "txid"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'payment_transactions contains duplicate TXID values; manual reconciliation is required before enforcing global TXID uniqueness';
  END IF;
END
$$;--> statement-breakpoint
DROP INDEX "payment_transactions_txid_idx";--> statement-breakpoint
DROP INDEX "payment_transactions_trx_txid_unique";--> statement-breakpoint
DROP INDEX "payment_transactions_trc20_event_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transactions_txid_unique" ON "payment_transactions" USING btree ("txid");
