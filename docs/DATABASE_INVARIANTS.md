# Database Invariants

This document defines the persistence rules for the Phase 0 Core.

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

A purchase order stores immutable snapshots of package code, count, canonical USDT price, selected payment asset, and quoted atomic payment amount. Later package edits therefore cannot rewrite historical order economics.

## TRX pricing boundary

USDT package prices are confirmed business data. TRX is also an accepted payment asset, but the rule for deriving a TRX quote is not yet confirmed.

Therefore the schema supports `payment_asset = TRX` and stores the resulting `quoted_amount_atomic`, but the Core does not hard-code an exchange-rate provider or TRX conversion formula yet.

## Payment idempotency

`payment_transactions.txid` is globally unique, so the same TRON TXID cannot be consumed twice.

A partial unique index also permits at most one `confirmed` payment for the same purchase order. Extra or late transfers may still be recorded for reconciliation, but they cannot become a second confirmed payment for that order.

Package crediting is protected again at the ledger layer: both the purchase order and the payment transaction may appear only once in a `purchase_credit` ledger entry.

A confirmed payment must be credited exactly once inside one PostgreSQL transaction that performs the order transition, balance update and ledger insert together.

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

Audit rows store action/entity identifiers, not secrets.

Production tokens, private keys, seed phrases, Service Account Tokens, passwords and other customer secrets must never be stored in audit metadata or committed to this repository.
