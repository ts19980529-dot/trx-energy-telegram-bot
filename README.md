# trx-energy-telegram-bot

Reusable TRX / TRON Energy Telegram Bot core with pluggable EnergyProvider and SecretProvider interfaces.

## Repository boundary

This is a public Core repository. It may contain source code, tests, CI workflows, provider interfaces, schema/migrations, and public documentation.

Production secrets and customer-sensitive runtime credentials must never be committed.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the current architecture, production gates, and isolation rules.
