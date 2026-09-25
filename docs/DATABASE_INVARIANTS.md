# Database Invariants

This document defines the persistence rules for the current Core.

## Confirmed business model

The current customer flow is based on Energy package counts:

1. a user buys a package;
2. a confirmed payment credits count balance;
3. using Energy reserves the required count;
4. the provider delivery is dispatched;
5. successful delivery consumes the reservation;
6. final delivery failure releases the reservation.

The public Core does not introduce a separate Direct Rental product without explicit customer requirements.

## Package configuration

Customer-specific package prices are data, not source-code constants.

A purchase order stores immutable snapshots of package code, count, canonical USDT price, selected payment asset, payment destination, token contract (when applicable), required confirmation count, and quoted atomic payment amount. Later configuration changes therefore cannot rewrite historical order economics or payment expectations.

For USDT orders, the quote provider supplies the canonical USDT-micro package price. The persisted settlement amount must equal that canonical price plus a non-negative payment-attribution offset. The canonical package price itself never changes. TRX orders must keep the attribution offset at zero. TRX quote derivation remains outside the database until the customer rule is confirmed.

## TRX pricing boundary

USDT package prices are confirmed business data. TRX is also an accepted payment asset, but the rule for deriving a TRX quote is not yet confirmed.

Therefore the schema supports `payment_asset = TRX` and stores the resulting `quoted_amount_atomic`, but the Core does not hard-code an exchange-rate provider or TRX conversion formula yet.

## Payment idempotency

For this bot, `txid` is the global payment identity for both TRX and TRC-20. TRON may expose multiple contract events inside one transaction, but this product intentionally accepts at most one payment record per TXID. `event_index` remains evidence metadata for TRC-20 validation and replay comparison; it does not create a second payable identity.

TRC-20 records require a non-negative event position. Top-level TRX records must not carry an event position. A global unique TXID constraint prevents another TRX or TRC-20 payment row from reusing the same chain transaction, and a partial unique index additionally permits at most one `confirmed` payment for the same purchase order.

Package crediting is protected again at the ledger layer: both the purchase order and the payment transaction may appear only once in a `purchase_credit` ledger entry.

### USDT payment attribution

For USDT, one token-contract + destination + settlement-amount tuple may belong to only one purchase order for the lifetime of the database. A partial unique index enforces this rule for every USDT order regardless of order status. Expired, failed, paid and credited orders therefore keep their historical attribution amount permanently; the amount is never returned to an allocation pool.

The configured maximum attribution offset is an application/runtime policy, not a database constant. PostgreSQL allocation searches only inside that explicit range and fails closed with attribution unavailable when no amount remains. Concurrent order creation uses the unique index as the final collision authority; a read-before-write result is never trusted by itself.

A user-supplied TXID may later be used only as a lookup hint. It must never establish payment ownership by itself or bypass normal order attribution and finality verification.

### Payment finality

Candidate detection and final confirmation are separate decisions. FullNode data and historical indexers may discover payment candidates, but neither is sufficient by itself to authorize crediting.

A payment may become `confirmed` only after all immutable order fields match exactly (asset, token contract when applicable, destination and quoted atomic amount), the transaction has authoritative solidified evidence from a SolidityNode view or equivalent local solidified-block index, execution is successful, and the configured confirmation-depth policy is satisfied.

The stored `confirmations` count is therefore an additional policy signal, not a substitute for TRON solidification. If the authoritative solidified receipt is not available yet, the payment remains pending. A non-solidified failure observation must not immediately move the order to a terminal failed state.

Addresses reaching the Core payment evaluator must already be normalized by the adapter into one canonical representation. Under the current contract, underpayment or overpayment does not auto-credit; an amount mismatch remains a reconciliation case until a separate business rule is explicitly approved.

A confirmed payment must be credited exactly once inside one PostgreSQL transaction that performs the order transition, balance update and ledger insert together.

## Energy usage configuration

Energy usage options are configuration data, not handler constants.

The `energy_options` table is the Single Source of Truth for the Energy amount and count cost presented to users. An Energy consumption order references the selected option and stores immutable snapshots of option code, Energy amount, and count cost.

Customer-specific values such as the confirmed 65K/131K behavior are provisioned as runtime/database data rather than hard-coded into the public Core.

## Count balance

`package_balances` stores current available and reserved counts. Both must remain non-negative.

`balance_ledger` records every balance-changing business operation with its own unique idempotency key. Energy-related ledger entries are unique per Energy order and reason, preventing duplicate reserve, consume or release operations.

Energy consumption must not use a read-then-write balance update that can race. The Service layer must perform an atomic conditional update equivalent to:

```sql
UPDATE package_balances
SET
  available_count = available_count - :cost,
  reserved_count = reserved_count + :cost
WHERE user_id = :user_id
  AND available_count >= :cost
RETURNING available_count, reserved_count;
```

The balance update, ledger entry and Energy order transition must be in the same PostgreSQL transaction.

## Energy delivery failure

A reserved count is not permanently consumed before Energy delivery succeeds.

```text
created
  -> reserved
  -> dispatching
      -> completed
      -> delivery_failed
          -> released
```

A provider timeout or otherwise ambiguous result is not a final failure. The order remains in reconciliation until `findDeliveryByIdempotencyKey` determines whether the provider already accepted the original request.

## Provider idempotency

There is one logical Provider delivery per Energy consumption order. The Core-level `idempotency_key` is unique. The combination of `provider_name + provider_order_id` is also unique when a provider order ID exists.

A `HybridProvider` may manage multiple downstream provider attempts internally; the Core still sees one logical provider delivery.

## Admin adjustments and audit

Manual balance adjustment is allowed only when linked to an `audit_logs` row. The database reference rule prevents an `admin_adjustment` ledger entry without that audit reference.

Ledger deltas are constrained by reason:

- purchase credit increases available count only;
- Energy reservation moves count from available to reserved without changing the total;
- Energy consumption decreases reserved count only;
- Energy release moves reserved count back to available without changing the total;
- manual admin adjustment may change available count only and cannot mutate in-flight reserved count.

Audit rows store action/entity identifiers, not secrets.

Production tokens, private keys, seed phrases, Service Account Tokens, passwords and other customer secrets must never be stored in audit metadata or committed to this repository.
