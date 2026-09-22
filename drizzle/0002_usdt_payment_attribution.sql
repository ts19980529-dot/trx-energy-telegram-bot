ALTER TABLE "package_purchase_orders" ADD COLUMN "payment_attribution_offset_atomic" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "package_purchase_orders" DROP CONSTRAINT "package_purchase_orders_usdt_quote_check";--> statement-breakpoint
ALTER TABLE "package_purchase_orders" ADD CONSTRAINT "package_purchase_orders_attribution_offset_nonnegative" CHECK ("package_purchase_orders"."payment_attribution_offset_atomic" >= 0);--> statement-breakpoint
ALTER TABLE "package_purchase_orders" ADD CONSTRAINT "package_purchase_orders_trx_attribution_offset_zero" CHECK ("package_purchase_orders"."payment_asset" <> 'TRX'
        or "package_purchase_orders"."payment_attribution_offset_atomic" = 0);--> statement-breakpoint
ALTER TABLE "package_purchase_orders" ADD CONSTRAINT "package_purchase_orders_usdt_quote_check" CHECK ("package_purchase_orders"."payment_asset" <> 'USDT'
        or "package_purchase_orders"."quoted_amount_atomic"
          = "package_purchase_orders"."price_usdt_micros_snapshot"
          + "package_purchase_orders"."payment_attribution_offset_atomic");--> statement-breakpoint
CREATE UNIQUE INDEX "package_purchase_orders_usdt_attribution_unique" ON "package_purchase_orders" USING btree ("payment_token_contract_address_snapshot","payment_to_address_snapshot","quoted_amount_atomic") WHERE "package_purchase_orders"."payment_asset" = 'USDT';
