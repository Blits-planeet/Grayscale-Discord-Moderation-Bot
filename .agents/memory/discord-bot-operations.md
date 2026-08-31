---
name: Discord bot operations
description: Discord separates user OAuth capabilities from bot-token permissions needed for channel, message, role, and moderation actions.
---

Use the user OAuth connection for account-level discovery only; use a project secret bot token for live Discord bot REST and Gateway operations. Discord user OAuth tokens cannot reliably manage channels, post messages, or moderate members.

Slash commands and Discord component panels are Gateway interaction events, while command registration is a REST operation. Register guild commands after Gateway READY and verify both paths separately.

Discord can show old global slash commands alongside guild commands; a guild PUT does not remove global registrations. Multipart message uploads also require leaving out the JSON Content-Type so fetch can set its boundary.

This bot's server setup is file-driven through `credx.config.json`; moderation `mute` means Discord communication timeout and must not depend on a mute role.

Bot presence is also configured in that file, with a validated Discord status, activity type, and activity text.

**Why:** The connected Discord integration explicitly limits user OAuth scopes to identity and guild discovery, while Discord rejects channel and moderation endpoints without a bot token.

**How to apply:** When extending this project, keep the bot token in Replit Secrets and never ask for or print it in chat. Put guild IDs, channel IDs, role IDs, and thresholds in `credx.config.json`; slash interactions themselves do not replace the member/message intents needed for joins and moderation automation.