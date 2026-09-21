# Phase 1 Telegram Contract

## Scope

Phase 1 introduces the Telegram runtime foundation only.

Included:

- grammY adapter;
- long-polling startup;
- safe Telegram error handling;
- graceful SIGINT/SIGTERM shutdown;
- user onboarding by numeric Telegram user ID;
- package-balance row initialization;
- SUPER_ADMIN authorization by configured numeric ID only;
- read-only package menu;
- read-only package selection callback;
- admin role visibility.

Not included:

- payment order creation;
- USDT/TRX payment detection;
- TRX quote derivation;
- Energy delivery;
- refunds;
- wallet signing;
- Telegram profile mutation.

## Framework

The Core uses grammY.

The framework remains inside the Telegram adapter/runtime layer. Application services and domain contracts do not import Telegram framework types.

## Update transport

The initial runtime uses long polling.

Before polling begins, the runtime checks `getWebhookInfo`.

If a webhook URL is already configured, startup fails closed. It does not automatically call `deleteWebhook`, because silently taking over another runtime would violate the isolation boundary.

## User onboarding

`/start` performs one database transaction that:

1. upserts the Telegram user by numeric `telegram_user_id`;
2. ensures a package-balance row exists.

Telegram username is display metadata only and is never an authorization key.

Blocked users are registered/updated but do not receive package data.

## SUPER_ADMIN boundary

`SUPER_ADMIN_ID` is the bootstrap authorization authority for the customer owner.

The bot does not convert a username into an administrator and does not silently write or change DB admin roles from `/start`.

The configured numeric ID only receives SUPER_ADMIN access after the user exists and is active.

Future DB admin additions/removals are separate high-risk operations and must be audited.

## Package menu

Package buttons are generated from enabled rows in `energy_packages`.

Prices are rendered from integer USDT micros and never through floating-point conversion.

Package selection rechecks user status so historical buttons cannot bypass a later block.

Package selection is read-only in Phase 1. It does not create a purchase order or trigger payment logic.

## Secret boundary

The Telegram Bot Token and Database URL are loaded through `SecretProvider`.

The first concrete adapter is `EnvironmentSecretProvider`. Production can later replace it with another SecretProvider without changing Telegram handlers or application services.

Raw wallet private keys remain outside this contract.

## Telegram profile protection

Startup and deployment code must not call Bot API methods that modify bot name, description, short description, commands, or avatar.
