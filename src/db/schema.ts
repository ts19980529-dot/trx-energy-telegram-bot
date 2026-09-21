import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  energyConsumptionStates,
  purchaseOrderStates,
} from "../core/orders/state-machine.js";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    telegramUserId: bigint("telegram_user_id", { mode: "bigint" }).notNull(),
    username: text("username"),
    status: text("status").default("active").notNull(),
    defaultTronAddress: text("default_tron_address"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("users_telegram_user_id_unique").on(table.telegramUserId),
    check(
      "users_status_check",
      sql`${table.status} in ('active', 'blocked')`,
    ),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorTelegramUserId: bigint("actor_telegram_user_id", { mode: "bigint" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_logs_entity_idx").on(table.entityType, table.entityId),
    index("audit_logs_actor_created_idx").on(
      table.actorTelegramUserId,
      table.createdAt,
    ),
  ],
);

export const adminAccounts = pgTable(
  "admin_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: text("role").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("admin_accounts_user_id_unique").on(table.userId),
    check(
      "admin_accounts_role_check",
      sql`${table.role} in ('SUPER_ADMIN', 'ADMIN', 'OPERATOR', 'VIEWER')`,
    ),
  ],
);

export const energyPackages = pgTable(
  "energy_packages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull(),
    count: integer("count").notNull(),
    priceUsdtMicros: bigint("price_usdt_micros", { mode: "bigint" }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("energy_packages_code_unique").on(table.code),
    check("energy_packages_count_positive", sql`${table.count} > 0`),
    check(
      "energy_packages_price_positive",
      sql`${table.priceUsdtMicros} > 0`,
    ),
  ],
);

export const packagePurchaseOrders = pgTable(
  "package_purchase_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    packageId: uuid("package_id")
      .notNull()
      .references(() => energyPackages.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    packageCodeSnapshot: text("package_code_snapshot").notNull(),
    countSnapshot: integer("count_snapshot").notNull(),
    priceUsdtMicrosSnapshot: bigint("price_usdt_micros_snapshot", {
      mode: "bigint",
    }).notNull(),
    paymentAsset: text("payment_asset").notNull(),
    quotedAmountAtomic: bigint("quoted_amount_atomic", {
      mode: "bigint",
    }).notNull(),
    quoteExpiresAt: timestamp("quote_expires_at", { withTimezone: true }),
    status: text("status").default("created").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("package_purchase_orders_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    index("package_purchase_orders_user_status_idx").on(
      table.userId,
      table.status,
    ),
    check(
      "package_purchase_orders_count_positive",
      sql`${table.countSnapshot} > 0`,
    ),
    check(
      "package_purchase_orders_usdt_price_positive",
      sql`${table.priceUsdtMicrosSnapshot} > 0`,
    ),
    check(
      "package_purchase_orders_quote_positive",
      sql`${table.quotedAmountAtomic} > 0`,
    ),
    check(
      "package_purchase_orders_asset_check",
      sql`${table.paymentAsset} in ('USDT', 'TRX')`,
    ),
    check(
      "package_purchase_orders_status_check",
      sql`${table.status} in (${sql.join(
        purchaseOrderStates.map((state) => sql.raw(`'${state}'`)),
        sql.raw(", "),
      )})`,
    ),
  ],
);

export const paymentTransactions = pgTable(
  "payment_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    purchaseOrderId: uuid("purchase_order_id").references(
      () => packagePurchaseOrders.id,
      { onDelete: "restrict" },
    ),
    txid: text("txid").notNull(),
    asset: text("asset").notNull(),
    tokenContractAddress: text("token_contract_address"),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    amountAtomic: bigint("amount_atomic", { mode: "bigint" }).notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }),
    blockTimestamp: timestamp("block_timestamp", { withTimezone: true }),
    confirmations: integer("confirmations").default(0).notNull(),
    status: text("status").default("detected").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("payment_transactions_txid_unique").on(table.txid),
    index("payment_transactions_purchase_order_idx").on(table.purchaseOrderId),
    uniqueIndex("payment_transactions_confirmed_order_unique")
      .on(table.purchaseOrderId)
      .where(
        sql`${table.status} = 'confirmed' and ${table.purchaseOrderId} is not null`,
      ),
    check(
      "payment_transactions_asset_check",
      sql`${table.asset} in ('USDT', 'TRX')`,
    ),
    check(
      "payment_transactions_amount_positive",
      sql`${table.amountAtomic} > 0`,
    ),
    check(
      "payment_transactions_confirmations_nonnegative",
      sql`${table.confirmations} >= 0`,
    ),
    check(
      "payment_transactions_status_check",
      sql`${table.status} in ('detected', 'confirming', 'confirmed', 'rejected')`,
    ),
    check(
      "payment_transactions_contract_check",
      sql`(
        (${table.asset} = 'TRX' and ${table.tokenContractAddress} is null)
        or
        (${table.asset} = 'USDT' and ${table.tokenContractAddress} is not null)
      )`,
    ),
  ],
);

export const packageBalances = pgTable(
  "package_balances",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "restrict" }),
    availableCount: integer("available_count").default(0).notNull(),
    reservedCount: integer("reserved_count").default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "package_balances_available_nonnegative",
      sql`${table.availableCount} >= 0`,
    ),
    check(
      "package_balances_reserved_nonnegative",
      sql`${table.reservedCount} >= 0`,
    ),
  ],
);

export const energyConsumptionOrders = pgTable(
  "energy_consumption_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    recipientAddress: text("recipient_address").notNull(),
    energyAmount: bigint("energy_amount", { mode: "bigint" }).notNull(),
    countCost: integer("count_cost").notNull(),
    status: text("status").default("created").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("energy_consumption_orders_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    index("energy_consumption_orders_user_status_idx").on(
      table.userId,
      table.status,
    ),
    check(
      "energy_consumption_orders_energy_positive",
      sql`${table.energyAmount} > 0`,
    ),
    check(
      "energy_consumption_orders_count_cost_positive",
      sql`${table.countCost} > 0`,
    ),
    check(
      "energy_consumption_orders_status_check",
      sql`${table.status} in (${sql.join(
        energyConsumptionStates.map((state) => sql.raw(`'${state}'`)),
        sql.raw(", "),
      )})`,
    ),
  ],
);

export const balanceLedger = pgTable(
  "balance_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    purchaseOrderId: uuid("purchase_order_id").references(
      () => packagePurchaseOrders.id,
      { onDelete: "restrict" },
    ),
    paymentTransactionId: uuid("payment_transaction_id").references(
      () => paymentTransactions.id,
      { onDelete: "restrict" },
    ),
    energyConsumptionOrderId: uuid("energy_consumption_order_id").references(
      () => energyConsumptionOrders.id,
      { onDelete: "restrict" },
    ),
    auditLogId: uuid("audit_log_id").references(() => auditLogs.id, {
      onDelete: "restrict",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    reason: text("reason").notNull(),
    availableDelta: integer("available_delta").default(0).notNull(),
    reservedDelta: integer("reserved_delta").default(0).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("balance_ledger_idempotency_key_unique").on(table.idempotencyKey),
    index("balance_ledger_user_created_idx").on(table.userId, table.createdAt),
    uniqueIndex("balance_ledger_purchase_credit_order_unique")
      .on(table.purchaseOrderId)
      .where(
        sql`${table.reason} = 'purchase_credit' and ${table.purchaseOrderId} is not null`,
      ),
    uniqueIndex("balance_ledger_purchase_credit_payment_unique")
      .on(table.paymentTransactionId)
      .where(
        sql`${table.reason} = 'purchase_credit' and ${table.paymentTransactionId} is not null`,
      ),
    uniqueIndex("balance_ledger_energy_reason_unique")
      .on(table.energyConsumptionOrderId, table.reason)
      .where(sql`${table.energyConsumptionOrderId} is not null`),
    check(
      "balance_ledger_reason_check",
      sql`${table.reason} in (
        'purchase_credit',
        'energy_reserve',
        'energy_consume',
        'energy_release',
        'admin_adjustment'
      )`,
    ),
    check(
      "balance_ledger_nonzero_delta",
      sql`${table.availableDelta} <> 0 or ${table.reservedDelta} <> 0`,
    ),
    check(
      "balance_ledger_reference_check",
      sql`(
        ${table.reason} = 'purchase_credit'
        and ${table.purchaseOrderId} is not null
        and ${table.paymentTransactionId} is not null
        and ${table.energyConsumptionOrderId} is null
        and ${table.auditLogId} is null
      ) or (
        ${table.reason} in ('energy_reserve', 'energy_consume', 'energy_release')
        and ${table.purchaseOrderId} is null
        and ${table.paymentTransactionId} is null
        and ${table.energyConsumptionOrderId} is not null
        and ${table.auditLogId} is null
      ) or (
        ${table.reason} = 'admin_adjustment'
        and ${table.purchaseOrderId} is null
        and ${table.paymentTransactionId} is null
        and ${table.energyConsumptionOrderId} is null
        and ${table.auditLogId} is not null
      )`,
    ),
  ],
);

export const providerDeliveries = pgTable(
  "provider_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    energyConsumptionOrderId: uuid("energy_consumption_order_id")
      .notNull()
      .references(() => energyConsumptionOrders.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    providerName: text("provider_name").notNull(),
    providerOrderId: text("provider_order_id"),
    status: text("status").default("pending").notNull(),
    lastErrorCode: text("last_error_code"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("provider_deliveries_consumption_order_unique").on(
      table.energyConsumptionOrderId,
    ),
    unique("provider_deliveries_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    uniqueIndex("provider_deliveries_provider_order_unique").on(
      table.providerName,
      table.providerOrderId,
    ),
    check(
      "provider_deliveries_status_check",
      sql`${table.status} in (
        'pending',
        'accepted',
        'processing',
        'completed',
        'failed',
        'unknown'
      )`,
    ),
  ],
);
