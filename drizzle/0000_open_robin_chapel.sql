CREATE TABLE "admin_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_accounts_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "admin_accounts_role_check" CHECK ("admin_accounts"."role" in ('SUPER_ADMIN', 'ADMIN', 'OPERATOR', 'VIEWER'))
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_telegram_user_id" bigint,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balance_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purchase_order_id" uuid,
	"payment_transaction_id" uuid,
	"energy_consumption_order_id" uuid,
	"audit_log_id" uuid,
	"idempotency_key" text NOT NULL,
	"reason" text NOT NULL,
	"available_delta" integer DEFAULT 0 NOT NULL,
	"reserved_delta" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balance_ledger_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "balance_ledger_reason_check" CHECK ("balance_ledger"."reason" in (
        'purchase_credit',
        'energy_reserve',
        'energy_consume',
        'energy_release',
        'admin_adjustment'
      )),
	CONSTRAINT "balance_ledger_nonzero_delta" CHECK ("balance_ledger"."available_delta" <> 0 or "balance_ledger"."reserved_delta" <> 0),
	CONSTRAINT "balance_ledger_delta_shape_check" CHECK ((
        "balance_ledger"."reason" = 'purchase_credit'
        and "balance_ledger"."available_delta" > 0
        and "balance_ledger"."reserved_delta" = 0
      ) or (
        "balance_ledger"."reason" = 'energy_reserve'
        and "balance_ledger"."available_delta" < 0
        and "balance_ledger"."reserved_delta" > 0
        and "balance_ledger"."available_delta" + "balance_ledger"."reserved_delta" = 0
      ) or (
        "balance_ledger"."reason" = 'energy_consume'
        and "balance_ledger"."available_delta" = 0
        and "balance_ledger"."reserved_delta" < 0
      ) or (
        "balance_ledger"."reason" = 'energy_release'
        and "balance_ledger"."available_delta" > 0
        and "balance_ledger"."reserved_delta" < 0
        and "balance_ledger"."available_delta" + "balance_ledger"."reserved_delta" = 0
      ) or (
        "balance_ledger"."reason" = 'admin_adjustment'
        and "balance_ledger"."available_delta" <> 0
        and "balance_ledger"."reserved_delta" = 0
      )),
	CONSTRAINT "balance_ledger_reference_check" CHECK ((
        "balance_ledger"."reason" = 'purchase_credit'
        and "balance_ledger"."purchase_order_id" is not null
        and "balance_ledger"."payment_transaction_id" is not null
        and "balance_ledger"."energy_consumption_order_id" is null
        and "balance_ledger"."audit_log_id" is null
      ) or (
        "balance_ledger"."reason" in ('energy_reserve', 'energy_consume', 'energy_release')
        and "balance_ledger"."purchase_order_id" is null
        and "balance_ledger"."payment_transaction_id" is null
        and "balance_ledger"."energy_consumption_order_id" is not null
        and "balance_ledger"."audit_log_id" is null
      ) or (
        "balance_ledger"."reason" = 'admin_adjustment'
        and "balance_ledger"."purchase_order_id" is null
        and "balance_ledger"."payment_transaction_id" is null
        and "balance_ledger"."energy_consumption_order_id" is null
        and "balance_ledger"."audit_log_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "energy_consumption_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"energy_option_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"option_code_snapshot" text NOT NULL,
	"recipient_address" text NOT NULL,
	"energy_amount" bigint NOT NULL,
	"count_cost" integer NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "energy_consumption_orders_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "energy_consumption_orders_energy_positive" CHECK ("energy_consumption_orders"."energy_amount" > 0),
	CONSTRAINT "energy_consumption_orders_count_cost_positive" CHECK ("energy_consumption_orders"."count_cost" > 0),
	CONSTRAINT "energy_consumption_orders_status_check" CHECK ("energy_consumption_orders"."status" in ('created', 'reserved', 'dispatching', 'completed', 'delivery_failed', 'released', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "energy_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"energy_amount" bigint NOT NULL,
	"count_cost" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "energy_options_code_unique" UNIQUE("code"),
	CONSTRAINT "energy_options_energy_positive" CHECK ("energy_options"."energy_amount" > 0),
	CONSTRAINT "energy_options_count_cost_positive" CHECK ("energy_options"."count_cost" > 0)
);
--> statement-breakpoint
CREATE TABLE "energy_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"count" integer NOT NULL,
	"price_usdt_micros" bigint NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "energy_packages_code_unique" UNIQUE("code"),
	CONSTRAINT "energy_packages_count_positive" CHECK ("energy_packages"."count" > 0),
	CONSTRAINT "energy_packages_price_positive" CHECK ("energy_packages"."price_usdt_micros" > 0)
);
--> statement-breakpoint
CREATE TABLE "package_balances" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"available_count" integer DEFAULT 0 NOT NULL,
	"reserved_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_balances_available_nonnegative" CHECK ("package_balances"."available_count" >= 0),
	CONSTRAINT "package_balances_reserved_nonnegative" CHECK ("package_balances"."reserved_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "package_purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"package_code_snapshot" text NOT NULL,
	"count_snapshot" integer NOT NULL,
	"price_usdt_micros_snapshot" bigint NOT NULL,
	"payment_asset" text NOT NULL,
	"payment_to_address_snapshot" text NOT NULL,
	"payment_token_contract_address_snapshot" text,
	"required_confirmations_snapshot" integer NOT NULL,
	"quoted_amount_atomic" bigint NOT NULL,
	"quote_expires_at" timestamp with time zone,
	"status" text DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_purchase_orders_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "package_purchase_orders_count_positive" CHECK ("package_purchase_orders"."count_snapshot" > 0),
	CONSTRAINT "package_purchase_orders_usdt_price_positive" CHECK ("package_purchase_orders"."price_usdt_micros_snapshot" > 0),
	CONSTRAINT "package_purchase_orders_quote_positive" CHECK ("package_purchase_orders"."quoted_amount_atomic" > 0),
	CONSTRAINT "package_purchase_orders_asset_check" CHECK ("package_purchase_orders"."payment_asset" in ('USDT', 'TRX')),
	CONSTRAINT "package_purchase_orders_payment_contract_check" CHECK ((
        ("package_purchase_orders"."payment_asset" = 'TRX' and "package_purchase_orders"."payment_token_contract_address_snapshot" is null)
        or
        ("package_purchase_orders"."payment_asset" = 'USDT' and "package_purchase_orders"."payment_token_contract_address_snapshot" is not null)
      )),
	CONSTRAINT "package_purchase_orders_usdt_quote_check" CHECK ("package_purchase_orders"."payment_asset" <> 'USDT'
        or "package_purchase_orders"."quoted_amount_atomic" = "package_purchase_orders"."price_usdt_micros_snapshot"),
	CONSTRAINT "package_purchase_orders_confirmations_positive" CHECK ("package_purchase_orders"."required_confirmations_snapshot" > 0),
	CONSTRAINT "package_purchase_orders_status_check" CHECK ("package_purchase_orders"."status" in ('created', 'waiting_payment', 'payment_detected', 'confirming', 'paid', 'credited', 'expired', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "payment_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid,
	"txid" text NOT NULL,
	"asset" text NOT NULL,
	"token_contract_address" text,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"amount_atomic" bigint NOT NULL,
	"block_number" bigint,
	"block_timestamp" timestamp with time zone,
	"confirmations" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'detected' NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_transactions_txid_unique" UNIQUE("txid"),
	CONSTRAINT "payment_transactions_asset_check" CHECK ("payment_transactions"."asset" in ('USDT', 'TRX')),
	CONSTRAINT "payment_transactions_amount_positive" CHECK ("payment_transactions"."amount_atomic" > 0),
	CONSTRAINT "payment_transactions_confirmations_nonnegative" CHECK ("payment_transactions"."confirmations" >= 0),
	CONSTRAINT "payment_transactions_status_check" CHECK ("payment_transactions"."status" in ('detected', 'confirming', 'confirmed', 'rejected')),
	CONSTRAINT "payment_transactions_contract_check" CHECK ((
        ("payment_transactions"."asset" = 'TRX' and "payment_transactions"."token_contract_address" is null)
        or
        ("payment_transactions"."asset" = 'USDT' and "payment_transactions"."token_contract_address" is not null)
      ))
);
--> statement-breakpoint
CREATE TABLE "provider_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"energy_consumption_order_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_name" text NOT NULL,
	"provider_order_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_deliveries_consumption_order_unique" UNIQUE("energy_consumption_order_id"),
	CONSTRAINT "provider_deliveries_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "provider_deliveries_status_check" CHECK ("provider_deliveries"."status" in (
        'pending',
        'accepted',
        'processing',
        'completed',
        'failed',
        'unknown'
      ))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"username" text,
	"status" text DEFAULT 'active' NOT NULL,
	"default_tron_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_telegram_user_id_unique" UNIQUE("telegram_user_id"),
	CONSTRAINT "users_status_check" CHECK ("users"."status" in ('active', 'blocked'))
);
--> statement-breakpoint
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_ledger" ADD CONSTRAINT "balance_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_ledger" ADD CONSTRAINT "balance_ledger_purchase_order_id_package_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."package_purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_ledger" ADD CONSTRAINT "balance_ledger_payment_transaction_id_payment_transactions_id_fk" FOREIGN KEY ("payment_transaction_id") REFERENCES "public"."payment_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_ledger" ADD CONSTRAINT "balance_ledger_energy_consumption_order_id_energy_consumption_orders_id_fk" FOREIGN KEY ("energy_consumption_order_id") REFERENCES "public"."energy_consumption_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_ledger" ADD CONSTRAINT "balance_ledger_audit_log_id_audit_logs_id_fk" FOREIGN KEY ("audit_log_id") REFERENCES "public"."audit_logs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "energy_consumption_orders" ADD CONSTRAINT "energy_consumption_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "energy_consumption_orders" ADD CONSTRAINT "energy_consumption_orders_energy_option_id_energy_options_id_fk" FOREIGN KEY ("energy_option_id") REFERENCES "public"."energy_options"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_balances" ADD CONSTRAINT "package_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_purchase_orders" ADD CONSTRAINT "package_purchase_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_purchase_orders" ADD CONSTRAINT "package_purchase_orders_package_id_energy_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."energy_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_purchase_order_id_package_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."package_purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_deliveries" ADD CONSTRAINT "provider_deliveries_energy_consumption_order_id_energy_consumption_orders_id_fk" FOREIGN KEY ("energy_consumption_order_id") REFERENCES "public"."energy_consumption_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_created_idx" ON "audit_logs" USING btree ("actor_telegram_user_id","created_at");--> statement-breakpoint
CREATE INDEX "balance_ledger_user_created_idx" ON "balance_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "balance_ledger_purchase_credit_order_unique" ON "balance_ledger" USING btree ("purchase_order_id") WHERE "balance_ledger"."reason" = 'purchase_credit' and "balance_ledger"."purchase_order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "balance_ledger_purchase_credit_payment_unique" ON "balance_ledger" USING btree ("payment_transaction_id") WHERE "balance_ledger"."reason" = 'purchase_credit' and "balance_ledger"."payment_transaction_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "balance_ledger_energy_reason_unique" ON "balance_ledger" USING btree ("energy_consumption_order_id","reason") WHERE "balance_ledger"."energy_consumption_order_id" is not null;--> statement-breakpoint
CREATE INDEX "energy_consumption_orders_user_status_idx" ON "energy_consumption_orders" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "package_purchase_orders_user_status_idx" ON "package_purchase_orders" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "payment_transactions_purchase_order_idx" ON "payment_transactions" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transactions_confirmed_order_unique" ON "payment_transactions" USING btree ("purchase_order_id") WHERE "payment_transactions"."status" = 'confirmed' and "payment_transactions"."purchase_order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_deliveries_provider_order_unique" ON "provider_deliveries" USING btree ("provider_name","provider_order_id");