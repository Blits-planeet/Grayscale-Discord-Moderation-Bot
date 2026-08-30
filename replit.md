# Sentinel/Ctrl Moderation Panel

Sentinel/Ctrl is a grayscale Discord moderation control panel with persistent server safety settings, reusable embeds, moderation actions, welcome media, ticket configuration, and an anti-nuke gateway listener.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `DISCORD_BOT_TOKEN` — the bot token used for Discord REST and Gateway access

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Discord: REST API v10 plus Gateway WebSocket listener
- Storage: Replit App Storage for welcome media uploads

## Where things live

- `artifacts/moderation-panel/src/` — routed control-panel UI and grayscale theme
- `artifacts/api-server/src/routes/discord.ts` — Discord-backed configuration, embeds, audit, and moderation API
- `artifacts/api-server/src/lib/discordGateway.ts` — welcome, anti-nuke, and ticket event handling
- `lib/db/src/schema/moderation.ts` — persistent server configs, embed templates, and audit events
- `lib/api-spec/openapi.yaml` — API source of truth; regenerate clients after edits
- `artifacts/api-server/src/lib/objectStorage.ts` — persistent upload and serving support

## Architecture decisions

- The Discord OAuth connection is used for account-level access, but live bot operations use the project secret `DISCORD_BOT_TOKEN` because Discord does not permit channel and moderation operations with a user OAuth token.
- Server settings and embed templates are stored as JSON payloads keyed by Discord guild ID so the panel can evolve without losing existing configuration.
- The anti-nuke bait channel follows the requested three-step escalation: configured first timeout, configured second timeout, then muted role; the exact warning is stored as a reusable embed template.
- Gateway events are enabled for guilds, members, messages, and message content; the bot must be invited with the matching privileged intents enabled in the Discord Developer Portal.

## Product

- Lists servers available to the bot and shows a command-center overview.
- Saves moderation defaults, welcome flow settings, ticketing IDs, anti-nuke thresholds, and welcome image metadata.
- Saves and sends welcome, rules, announcement, ticket, and anti-nuke embeds.
- Supports ban, kick, timeout, untimeout, mute, and unmute actions with confirmation-first UI and audit logging.
- The background bot listener welcomes new members, enforces the protected bait channel, DMs affected members, purges the bait channel, and creates tickets from `!ticket`.

## User preferences

- Keep the visible control panel grayscale and free of emojis.
- Preserve the anti-nuke warning copy as an embed template; the warning itself may contain the user's requested text.

## Gotchas

- The bot must be invited to a server and granted the permissions required by each configured action.
- The Discord Developer Portal must enable the privileged Server Members Intent and Message Content Intent for the Gateway listener.
- The app's upload URL route should be placed behind project access controls before making the panel public.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
