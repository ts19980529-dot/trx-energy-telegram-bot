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

Responsible for payment observations, confirmation and idempotent consumption.

A TRON transaction ID (TXID) that is consumed by the business must be unique in the database.

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

The PostgreSQL schema must enforce TXID uniqueness and non-negative count balances. Balance reservation/consumption/release must execute transactionally in the Service layer.
