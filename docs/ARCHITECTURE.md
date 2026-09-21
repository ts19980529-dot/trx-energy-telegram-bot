# Architecture Baseline

## Scope

This repository contains the reusable public Core for a TRX / TRON Energy Telegram Bot.

It is intentionally separated from every customer's production runtime, database, wallet, secrets, logs, queue, webhook, backup, and provider account.

## Runtime baseline

- Node.js 24 LTS
- TypeScript
- Telegram: Bot API through a TypeScript framework
- TRON: TronWeb / TRON HTTP APIs behind adapters
- Database direction: PostgreSQL
- Deployment direction: Railway
- CI direction: GitHub Actions on standard hosted runners

Dependency versions are locked only after compatibility verification and a reproducible lockfile is created.

## Layer boundaries

```text
Telegram Adapter
      |
Application Services
      |
Domain / Contracts
 |        |         |
Payment  Energy   Secrets
 |        |         |
TRON    EnergyProvider  SecretProvider
Adapter     Adapter         Adapter
      \\       |       /
          PostgreSQL
```

### Domain / Contracts

Contains business contracts and invariants only.

It must not depend directly on Telegram, Railway, a specific Energy supplier, or a specific Secrets Manager.

### Telegram Adapter

Converts Telegram updates into application commands and converts application results into Telegram responses.

Business rules must not live in handlers.

### Payment

Responsible for payment observation, candidate matching, finality verification and idempotent consumption.

Detection and final confirmation are separate boundaries. A FullNode or historical indexer may discover a candidate, but it must not by itself authorize a final payment decision. Final confirmation requires evidence from a SolidityNode solidified view or an equivalent local solidified-block index, plus successful execution evidence. A missing solidified receipt remains pending rather than becoming an immediate failure.

For top-level TRX, the business identity is the TXID. For TRC-20, the business identity is token contract + TXID + normalized Event position. Payment adapters normalize addresses and Event identity before invoking Core matching rules.

The canonical Core representation for TRON addresses is Base58Check. External adapters may receive Base58Check or 21-byte `41...` hex forms depending on the upstream API, but they must pass addresses through a `TronAddressCodec` that converts and checksum-validates them before constructing a `PaymentObservation`. Raw TXIDs are normalized to lowercase 64-character hex. Atomic amounts and block numbers are parsed from unsigned decimal strings into `bigint`; floating-point conversion is forbidden. TRC-20 Event position must be a non-negative integer. The normalization boundary derives `solidified` from the declared evidence source rather than trusting an arbitrary upstream boolean.

The minimum TRON node read boundary for a known TXID is allowlisted to transaction-body and transaction-info reads only. Head reads map to `/wallet/gettransactionbyid` and `/wallet/gettransactioninfobyid`; finality reads map to the corresponding `/walletsolidity/` endpoints. The finality adapter always requests the solidified view. A solidified `not_found` result means “not final/available yet” and remains pending. Timeout, rate limit, upstream failure, malformed data, non-solidified evidence returned from a solidified read, or identity mismatch are adapter errors and must never be converted into `not_found` or a business rejection. This boundary contains no transaction creation, signing or broadcast operation.

The read-only HTTP transport uses separate head and solidified base origins and only appends the allowlisted paths above. It sends `POST` with `{ "value": "<txid>" }`, lowercases a validated 64-hex TXID, and may add `TRON-PRO-API-KEY` only when the caller supplies it. Base URLs must be plain HTTP(S) origins without embedded credentials, paths, query strings or fragments. Timeout is enforced with `AbortSignal`. An empty JSON object is `not_found`; HTTP 200 with an `Error` field is an upstream failure; 429 is rate-limited; authentication/authorization failures remain adapter errors; invalid JSON is malformed response. The transport does not decode transaction bodies or receipts and is not wired to runtime secrets in this phase.

The transaction/receipt parser is a separate pure boundary. A top-level TRX payment is accepted only from a single `TransferContract` and reads `owner_address`, `to_address` and `amount` from `raw_data.contract[0].parameter.value`. A TRC-20 payment is accepted only from a successful `TriggerSmartContract` receipt and only from the caller-requested `log[eventIndex]` when `topics[0]` is the canonical `Transfer(address,address,uint256)` signature. TRC-20 log contract addresses are reconstructed by prepending the TRON `41` prefix to the 20-byte log address; indexed sender/recipient topics use the final 20 bytes with the same prefix; the 32-byte `data` word is decoded as an unsigned `uint256`. The parser never searches another Event position and never invents confirmation depth: confirmations must be supplied by a higher layer. Unsafe JSON integers, mismatched TXIDs, malformed addresses/topics/data or inconsistent body/receipt pairs fail closed.

The HTTP payment-evidence reader composes the existing read-only transport and parser without adding network operations. It requests transaction body and transaction info for the same TXID and the same read view, gives transport unavailability precedence over `not_found`, validates the receipt `blockNumber`, obtains confirmation depth from an injected `TronConfirmationDepthProvider`, and only then invokes the parser. The reader never hard-codes or derives confirmation depth from the transaction/receipt pair. Parser `malformed` becomes `malformed_response`; parser `no_match` becomes `not_found` so the higher-level lifecycle can remain conservative.

The concrete HTTP confirmation-depth provider reads only the latest block height for the same view: `/wallet/getnowblock` for head and `/walletsolidity/getnowblock` for solidified. It reads `block_header.raw_data.number` and defines the project's additional numeric depth as inclusive view depth: `latestViewHeight - transactionBlockNumber + 1`. A transaction at the latest visible height therefore has depth 1. This number is an application policy input only; it is not TRON's finality algorithm. Protocol finality remains the separate SolidityNode solidification gate. A latest height behind the transaction height, an unsafe/malformed height, or an absent latest-block response fails closed as `malformed_response`.

Purchase-order payment economics are frozen before any chain evidence can be matched. The pure purchase-order payment contract receives a package snapshot plus an already-produced quote and creates the immutable fields required by `package_purchase_orders`: package code/count/USDT price, payment asset, destination, token contract, required confirmations, quoted atomic amount and optional quote expiry. It also derives the Core `PaymentExpectation` exclusively from those frozen fields. For USDT, the quoted atomic amount must exactly equal the canonical USDT-micro package price and a token contract is mandatory. For top-level TRX, the token contract must be null and the contract accepts only an explicit positive atomic quote; it intentionally does not derive any TRX exchange-rate formula. Persisted snapshots are revalidated before they can become a `PaymentExpectation`, preventing corrupted or inconsistent order rows from silently authorizing payment matching. Runtime wiring and quote-provider selection remain separate later boundaries.

### EnergyProvider

All Energy delivery implementations must satisfy one provider contract.

Planned adapters:

- MockEnergyProvider
- OwnPoolProvider
- SupplierApiProvider
- HybridProvider

The initial implementation uses MockEnergyProvider only.

Every provider adapter must preserve Energy order idempotency:

- the same `idempotencyKey` must not create a second provider order;
- an ambiguous create result (for example, a timeout after the provider accepted the order) must be recoverable by `idempotencyKey`;
- callers must query the existing order before deciding whether a create operation may be retried.

### SecretProvider

Runtime secret access must be abstracted behind a provider contract.

Production secrets must never be committed to this repository.

Potential adapters include environment-backed bootstrap, 1Password, Infisical, Doppler, or future providers.

### Signer boundary

Raw wallet private keys are not part of the Core `SecretProvider` contract.

The current Phase 0 Core does not sign TRON transactions. A future OwnPool implementation must use a dedicated signer boundary (for example, a signing service or restricted signing adapter) so application code requests an authorized signature/action rather than fetching a raw `TRON_PRIVATE_KEY`.

## Customer isolation

Shared:

- Source code
- Tests
- CI workflow
- Provider interfaces
- Migrations / schema definitions
- Public documentation

Never shared across customers:

- Bot Token
- Database
- Wallet / Private Key
- Secrets
- Railway service/runtime
- Logs
- Webhook
- Queue / Redis
- Backup
- Provider account

## Public repository security boundary

The following must never be committed:

- BOT_TOKEN
- TRON_PRIVATE_KEY
- SEED_PHRASE
- DATABASE_PASSWORD
- API_SECRET
- Service Account Token
- Signer credentials
- Other customer production secrets

`.env.example` may contain variable names and safe placeholders only.

## Configuration principle

Prices, package counts, Energy amounts, addresses, provider selections and feature switches are configuration/data.

They must not be duplicated across handlers or hard-coded into unrelated modules.

## Deployment principle

Code deployment must never automatically change Telegram profile fields such as bot name, description, short description or avatar.

## Current Phase 0 rule

This document establishes boundaries only. It does not authorize production payment processing, signing, Energy delegation, refunds or wallet custody.

## Persistence invariants

Database-level payment, balance and Energy-order invariants are defined in [DATABASE_INVARIANTS.md](DATABASE_INVARIANTS.md).

The PostgreSQL schema must enforce the asset-specific payment identity rules (TRX TXID uniqueness and TRC-20 token contract + TXID + Event position uniqueness) and non-negative count balances. Balance reservation/consumption/release must execute transactionally in the Service layer.
