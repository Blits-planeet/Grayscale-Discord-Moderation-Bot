---
name: Discord bot operations
description: Discord separates user OAuth capabilities from bot-token permissions needed for channel, message, role, and moderation actions.
---

Use the user OAuth connection for account-level discovery only; use a project secret bot token for live Discord bot REST and Gateway operations. Discord user OAuth tokens cannot reliably manage channels, post messages, or moderate members.

**Why:** The connected Discord integration explicitly limits user OAuth scopes to identity and guild discovery, while Discord rejects channel and moderation endpoints without a bot token.

**How to apply:** When extending this project, keep the bot token in Replit Secrets and never ask for or print it in chat. Gateway features also require the corresponding privileged intents to be enabled in the Discord Developer Portal.