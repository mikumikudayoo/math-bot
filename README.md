# math-bot

Moderator-controlled persistent reminders: see [reminder commands and operations](docs/reminders.md).

Current production: `/opt/math-bot`, Bun, `python3`, PM2 under `mathbot`. Future target: `/srv/math-bot` exact-SHA manual releases. See [operations](docs/operations.md) for the separate deployment instructions.

Discord.js + TypeScript study bot with a separate authenticated study service, durable queue and conversations, calculator/plotting, model adapter, moderation and QOTD. See [operations](docs/operations.md) for setup and [architecture](docs/architecture.md) for boundaries. See [reliability](docs/reliability.md) for guarded factual retrieval and model compatibility.

For the expanded setup, run `bun run setup:local`, start `bun run service:dev` in one WSL terminal and `bun run dev` in another. Install Python tools with `bash scripts/setup-python.sh` on a fresh machine. Run `bun run commands:deploy:dev` manually after definition changes. The existing checkout's local Python dependencies and service credentials are prepared.

Study/AI functionality is private by default: set `AI_TESTER_USER_IDS=821682594830614578` in the bot's environment file to permit the tester. Empty or missing allowlists deny everyone, including admins and coaches. Comma-separated IDs support additional testers. Ordinary commands keep their existing permissions. For mentions/reply chains, also enable Message Content Intent and `MESSAGE_FEATURES_ENABLED=true`. See [private testing setup](docs/operations.md#private-ai-testing) for Discord command visibility and restart steps.

## WSL development

Open Ubuntu WSL and run from this repository:

```sh
cd /mnt/d/devstuff/math-bot
bun --version
bun install --frozen-lockfile
cp .env.development.example .env.development
```

Use Bun 1.4.2 (pinned in .bun-version and package.json). Install dependencies with Linux Bun in WSL; do not mix Windows node_modules into this checkout.

In this checkout Bun is installed at `.cache/bun/bin/bun`; open a new Ubuntu terminal to pick up the installer-added PATH, or run `export PATH="$PWD/.cache/bun/bin:$PATH"` in the existing terminal. On another machine install the pinned version using the [Bun installation instructions](https://bun.com/docs/installation). Commit `bun.lock`; reproducible installs use `bun install --frozen-lockfile`.

Bun runs both TypeScript development entrypoints and compiled production JavaScript. TypeScript checking/building still uses `tsc`, explicitly executed with Bun. The existing `node:` compatibility APIs (including SQLite and the test imports) are supported by the pinned runtime; they do not launch Node.js. Python tools retain their separate virtual environment.

## Discord Developer Portal

1. Create a new application named `math-bot-dev` at https://discord.com/developers/applications.
2. General Information: copy **Application ID** into `DISCORD_APPLICATION_ID` in `.env.development`.
3. Bot: generate/reset the **bot token** and put it in `DISCORD_TOKEN` locally. Never paste the token into chat or commit it. A client secret/public key is not needed.
4. Installation: enable **Guild Install**; configure scopes `bot` and `applications.commands`. Grant **View Channels** and **Send Messages**, then use the install link to add the dev app to a private test server. No Administrator permission or privileged gateway intents are needed for /ping.
5. Discord user settings > Advanced > Developer Mode: right-click the test server, Copy Server ID, and put it in `DISCORD_GUILD_ID`.
6. Leave Interactions Endpoint URL blank: this bot uses the gateway, so no HTTP endpoint or tunnel is needed.

Then, in WSL:

```sh
bun run check
bun run test
bun run commands:json
bun run commands:deploy:dev
bun run dev
```

Wait for the login message, then run `/ping` in the test server; expect `pong! 🏓`. Ctrl+C stops the bot. Live login and registration require your real development credentials.

## Commands and deployment

Add command modules under `src/commands/` and import them into the list in `src/commands/index.ts`. Both runtime dispatch and generated definitions use this registry; source and compiled builds use the same imports.

`commands:deploy:dev` manually replaces the dev app's complete command set in the configured test guild. It skips if JSON matches the last successful local snapshot. It does not reconcile out-of-band Discord edits; delete the matching `.cache/commands-APP-GUILD.json` to intentionally resync. Failed API writes do not advance the snapshot. Keep one registration process active at a time.

`bun run build` creates `dist/`; `bun run start` runs it, using development config by default. Production is explicitly selected with `BOT_ENV=production bun run start` and a separate `.env.production` file. That file must contain a different production application's token and ID; do not reuse the dev application. Production application creation and deployment can wait. Environment files are isolated: inherited credential variables are intentionally ignored. Production command registration is a separate explicit `bun run commands:deploy:production` action; never run it for the dev app.

Existing GitHub remote: https://github.com/mikumikudayoo/math-bot.git. Review changes before committing/pushing. No CI deployment, PM2, VPS configuration or tunnels are installed by this foundation.

## Daily questions and solution manuals

See [the QOTD runbook](docs/qotd.md) for recursive PDF imports, reviewed source crops, modal-only private answers, deterministic grading, configurable scoring and persistent leaderboards. Latest answer and timestamp win; submissions close at 21:59:59 Manila and reveal at 22:00. `/qotd leaderboard` and `/qotd stats` are public. Imports stay pending until approved, no-repeat history survives re-imports, and the v2-to-v3 migration preserves existing state. Slash commands need manual redeployment; the runbook includes the VPS checklist. No production deployment is automatic.
