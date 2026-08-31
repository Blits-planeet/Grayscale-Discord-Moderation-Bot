# CredX Discord Moderation Bot

CredX is a Discord-first moderation bot. Its primary setup is the editable `credx.config.json` file; ticket users interact with `/ticketpanel` inside Discord.

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

- `artifacts/moderation-panel/src/` — optional routed configuration UI and grayscale theme
- `artifacts/api-server/src/routes/discord.ts` — Discord-backed configuration, embeds, audit, and moderation API
- `artifacts/api-server/src/lib/discordGateway.ts` — welcome, anti-nuke, and ticket event handling
- `lib/db/src/schema/moderation.ts` — persistent server configs, embed templates, and audit events
- `lib/api-spec/openapi.yaml` — API source of truth; regenerate clients after edits
- `artifacts/api-server/src/lib/objectStorage.ts` — persistent upload and serving support

## Architecture decisions

- The Discord OAuth connection is used for account-level access, but live bot operations use the project secret `DISCORD_BOT_TOKEN` because Discord does not permit channel and moderation operations with a user OAuth token.
- Server settings and embed templates are stored as JSON payloads keyed by Discord guild ID so the panel can evolve without losing existing configuration.
- The anti-nuke bait channel follows the requested three-step escalation: configured first timeout, configured second timeout, then a longer timeout; no mute role is used.
- Gateway events are enabled for guilds, members, messages, message content, reactions, and invites; the bot must be invited with the matching intents enabled in the Discord Developer Portal.
- The bot registers slash commands per guild after Gateway READY; no prefix commands are used.
- Reaction-role verification requires the Guild Message Reactions Gateway intent.

## Product

- Registers `/ticket`, `/giveaway`, `/announcement`, `/annoucement`, `/r`, `/invites`, `/ban`, `/kick`, `/mute`, and `/unmute` in every guild the bot joins.
- Server IDs, channel IDs, role IDs, welcome settings, ticket settings, and anti-nuke thresholds are configured in `credx.config.json`.
- The bot's Discord status is configured globally in `credx.config.json` under `bot.status`, `bot.activityType`, and `bot.activity`.
- CredX automatically posts the ticket embed with categories Purchasing, Giveaway (claim/info), Scam (report), and Support (info) in `tickets.panelChannelId`.
- CredX automatically posts the reaction-role message in `verification.channelId`; reacting adds the configured `Member` role, removing the reaction removes it, and no role is assigned on join.
- `/giveaway` accepts a prize, duration in hours, up to three required roles, account/server age requirements, a claim deadline, and an optional winner count. Entries use a button, winners are selected randomly, winners receive an English DM, and unclaimed winners are automatically rerolled.
- `/announcement` (with the `/annoucement` compatibility alias) posts a configurable embed. `/r` creates a colored custom role and assigns it to a user. `/invites` counts invite-attributed members who are still in the server.
- Ticket channels use category prefixes such as `purchasing-name`, `giveaway-name`, `scam-name`, and `support-name`; each ticket has Close, Ping admin, and Claim controls.
- Claiming updates the ticket embed with the plain admin name while keeping the ticket user's mention in the embed.
- `mute` and the anti-nuke escalation use Discord timeouts only; no mute role is required.
- Saves moderation defaults, welcome flow settings, ticketing IDs, anti-nuke thresholds, and welcome image metadata.
- Saves and sends welcome, rules, announcement, ticket, and anti-nuke embeds.
- Supports ban, kick, mute, and unmute actions with confirmation-first UI and audit logging.
- Active giveaways are stored in the database and their timers are restored after a bot restart.
- The hoster start file is the root `index.js`; it runs `pnpm --filter @workspace/api-server run dev`. The API entrypoint is `artifacts/api-server/src/index.ts`.
- The background bot listener welcomes new members with the CredX banner, handles verification reactions, enforces the protected bait channel, DMs affected members, purges the bait channel, and creates tickets from `/ticket`.

## User preferences

- Keep the visible control panel grayscale and free of emojis.
- Preserve the anti-nuke warning copy as an embed template; the warning itself may contain the user's requested text.

## Gotchas

- The bot must be invited to a server and granted the permissions required by each configured action.
- The Discord Developer Portal must enable the privileged Server Members Intent and Message Content Intent for the Gateway listener.
- Enable the Guild Message Reactions intent for the reaction-based Member role.
- Enable the Guild Invites intent and grant Manage Server if invite tracking and `/invites` are required.
- The app's upload URL route should be placed behind project access controls before making the panel public.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
