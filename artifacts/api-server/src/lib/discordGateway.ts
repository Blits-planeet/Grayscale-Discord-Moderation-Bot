import WebSocket from "ws";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { addAudit, discordFetch, ensureTemplates, readConfig, saveConfig } from "../routes/discord";
import { logger } from "./logger";

const intents = 1 | 2 | 512 | 32768;
const execFileAsync = promisify(execFile);
const strikes = new Map<string, { count: number; lastAt: number }>();
let gatewaySocket: WebSocket | undefined;
let heartbeat: NodeJS.Timeout | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let applicationId = "";

type GatewayMessage = {
  op: number;
  d: any;
  s?: number;
  t?: string;
};

function expand(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`);
}

function userMention(userId: string): string {
  return `<@${userId}>`;
}

function discordColor(color: string): number {
  const parsed = Number.parseInt(color.replace("#", ""), 16);
  return Number.isFinite(parsed) ? parsed : 0x8e9196;
}

function botCanManageGuild(interaction: any): boolean {
  const permissions = BigInt(interaction.member?.permissions ?? "0");
  return (permissions & 8n) === 8n || (permissions & 32n) === 32n;
}

function interactionOption(interaction: any, name: string): any {
  return interaction.data?.options?.find((option: any) => option.name === name)?.value;
}

async function interactionCallback(interaction: any, data: Record<string, unknown>) {
  await discordFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

async function deferInteraction(interaction: any, ephemeral = false) {
  await interactionCallback(interaction, {
    type: 5,
    data: ephemeral ? { flags: 64 } : undefined,
  });
}

async function editInteraction(interaction: any, data: Record<string, unknown>) {
  if (!applicationId) return;
  await discordFetch(`/webhooks/${applicationId}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

async function rejectInteraction(interaction: any, content: string) {
  await interactionCallback(interaction, {
    type: 4,
    data: { content, flags: 64 },
  });
}

const slashCommands = [
  {
    name: "panel",
    description: "Open the CredX moderation panel",
  },
  {
    name: "ticket",
    description: "Create a private support ticket",
  },
  {
    name: "ban",
    description: "Ban a member from this server",
    default_member_permissions: "32",
    options: [
      { name: "user", description: "Member to ban", type: 6, required: true },
      { name: "reason", description: "Reason for the ban", type: 3, required: false },
    ],
  },
  {
    name: "kick",
    description: "Kick a member from this server",
    default_member_permissions: "32",
    options: [
      { name: "user", description: "Member to kick", type: 6, required: true },
      { name: "reason", description: "Reason for the kick", type: 3, required: false },
    ],
  },
  {
    name: "timeout",
    description: "Timeout a member",
    default_member_permissions: "32",
    options: [
      { name: "user", description: "Member to timeout", type: 6, required: true },
      { name: "minutes", description: "Timeout duration in minutes", type: 4, required: true, min_value: 1, max_value: 40320 },
      { name: "reason", description: "Reason for the timeout", type: 3, required: false },
    ],
  },
  {
    name: "untimeout",
    description: "Remove a member timeout",
    default_member_permissions: "32",
    options: [
      { name: "user", description: "Member to untimeout", type: 6, required: true },
      { name: "reason", description: "Reason for the action", type: 3, required: false },
    ],
  },
  {
    name: "mute",
    description: "Apply the configured muted role",
    default_member_permissions: "32",
    options: [
      { name: "user", description: "Member to mute", type: 6, required: true },
      { name: "reason", description: "Reason for the mute", type: 3, required: false },
    ],
  },
  {
    name: "unmute",
    description: "Remove the configured muted role",
    default_member_permissions: "32",
    options: [
      { name: "user", description: "Member to unmute", type: 6, required: true },
      { name: "reason", description: "Reason for the unmute", type: 3, required: false },
    ],
  },
];

async function registerSlashCommands(guildId: string) {
  if (!applicationId) return;
  await discordFetch(`/applications/${applicationId}/guilds/${guildId}/commands`, {
    method: "PUT",
    body: JSON.stringify(slashCommands),
  });
}

async function ensureBotName(currentName: string) {
  if (currentName === "CredX") return;
  try {
    await discordFetch("/users/@me", {
      method: "PATCH",
      body: JSON.stringify({ username: "CredX" }),
    });
    logger.info("Discord bot username set to CredX");
  } catch (error) {
    logger.warn({ err: error }, "Discord did not accept the CredX username update; set it in the Developer Portal");
  }
}

function panelPayload() {
  return {
    embeds: [{
      title: "CredX moderation panel",
      description: "Use the controls below to manage this server. Server setup actions are only available to moderators.",
      color: 0x252830,
      fields: [
        { name: "Welcome", value: "Preview the CredX welcome banner in the configured channel.", inline: false },
        { name: "Member role", value: "Create or connect the `Member` role and assign it to new members.", inline: false },
        { name: "Protection", value: "Send the saved rules or anti-nuke warning embed.", inline: false },
      ],
      footer: { text: "CredX • Discord controls" },
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 2, custom_id: "credx:welcome", label: "Welcome preview" },
        { type: 2, style: 2, custom_id: "credx:member-role", label: "Member role" },
        { type: 2, style: 2, custom_id: "credx:rules", label: "Send rules" },
        { type: 2, style: 2, custom_id: "credx:antinuke", label: "Send anti-nuke" },
        { type: 2, style: 1, custom_id: "credx:refresh", label: "Refresh" },
      ],
    }],
  };
}

async function findWelcomeBannerAsset(): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), "assets/credx-welcome-banner.png"),
    path.resolve(process.cwd(), "../api-server/assets/credx-welcome-banner.png"),
    path.resolve(__dirname, "../assets/credx-welcome-banner.png"),
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // Try the next known workspace/deployment location.
    }
  }
  throw new Error("CredX welcome banner asset is missing");
}

async function createWelcomeBanner(displayName: string, memberNumber: string): Promise<Buffer> {
  const inputPath = await findWelcomeBannerAsset();
  const outputPath = `/tmp/credx-welcome-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
  const safeName = displayName.replace(/\s+/g, " ").trim().slice(0, 28) || "Member";
  const safeNumber = `#${memberNumber.padStart(4, "0").slice(-4)}`;
  try {
    await execFileAsync("convert", [
      inputPath,
      "-gravity", "center",
      "-font", "DejaVu-Sans-Bold",
      "-fill", "white",
      "-pointsize", "72",
      "-annotate", "+0-18", safeName,
      "-font", "DejaVu-Sans",
      "-fill", "#b9bbc0",
      "-pointsize", "34",
      "-annotate", "+0+62", safeNumber,
      outputPath,
    ]);
    return await readFile(outputPath);
  } finally {
    await unlink(outputPath).catch(() => undefined);
  }
}

async function sendMultipartMessage(channelId: string, payload: Record<string, unknown>, file: Buffer) {
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  const bytes = new Uint8Array(file.byteLength);
  bytes.set(file);
  form.append("files[0]", new Blob([bytes.buffer], { type: "image/png" }), "credx-welcome.png");
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN ?? ""}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Discord ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return (await response.json()) as { id: string };
}

async function sendWelcomeMessage(
  guildId: string,
  channelId: string,
  userId: string,
  displayName: string,
  memberNumber: string,
  serverName: string,
) {
  const templates = await ensureTemplates(guildId);
  const template = templates.find((item) => item.key === "welcome");
  if (!template) return;
  const values = {
    guildId,
    user: userMention(userId),
    server: serverName,
    memberCount: memberNumber,
    memberCountPadded: memberNumber.padStart(4, "0"),
  };
  const banner = await createWelcomeBanner(displayName, memberNumber);
  await sendMultipartMessage(channelId, {
    content: expand(template.content, values) || undefined,
    embeds: [{
      description: expand(template.description, values),
      color: discordColor(template.color),
      image: { url: "attachment://credx-welcome.png" },
      footer: template.footer ? { text: expand(template.footer, values) } : undefined,
    }],
  }, banner);
}

async function ensureMemberRole(guildId: string): Promise<string> {
  const config = await readConfig(guildId);
  const roles = await discordFetch<Array<{ id: string; name: string; managed?: boolean }>>(`/guilds/${guildId}/roles`);
  let role = config.moderation.memberRoleId
    ? roles.find((item) => item.id === config.moderation.memberRoleId)
    : roles.find((item) => item.name.toLowerCase() === "member" && !item.managed);
  if (!role) {
    role = await discordFetch<{ id: string; name: string }>(`/guilds/${guildId}/roles`, {
      method: "POST",
      headers: { "X-Audit-Log-Reason": "CredX automatic Member role" },
      body: JSON.stringify({ name: "Member", color: 0x6e7178, mentionable: false }),
    });
  }
  if (config.moderation.memberRoleId !== role.id) {
    await saveConfig(guildId, {
      moderation: { ...config.moderation, memberRoleId: role.id },
      welcome: config.welcome,
      tickets: config.tickets,
      antiNuke: config.antiNuke,
    });
  }
  return role.id;
}

async function sendTemplate(
  channelId: string,
  templateKey: string,
  values: Record<string, string> = {},
) {
  const templates = await ensureTemplates(values.guildId ?? "");
  const template = templates.find((item) => item.key === templateKey);
  if (!template) return;
  await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: expand(template.content, values) || undefined,
      embeds: [{
        title: expand(template.name, values),
        description: expand(template.description, values),
        color: discordColor(template.color),
        fields: template.fields.map((field) => ({
          name: expand(field.name, values),
          value: expand(field.value, values),
          inline: field.inline,
        })),
        footer: template.footer ? { text: expand(template.footer, values) } : undefined,
      }],
    }),
  });
}

async function createTicket(guildId: string, userId: string, username: string, sourceChannelId?: string) {
  const config = await readConfig(guildId);
  if (!config.tickets.enabled || !config.tickets.categoryId) return null;
  const permissionOverwrites = [
    { id: guildId, type: 0, deny: "1024" },
    { id: userId, type: 1, allow: "3072" },
  ];
  if (config.tickets.supportRoleId) {
    permissionOverwrites.push({ id: config.tickets.supportRoleId, type: 0, allow: "3072" });
  }
  const channel = await discordFetch<{ id: string }>(`/guilds/${guildId}/channels`, {
    method: "POST",
    body: JSON.stringify({
      name: `ticket-${username.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 70) || userId.slice(-6)}`,
      type: 0,
      parent_id: config.tickets.categoryId,
      permission_overwrites: permissionOverwrites,
    }),
  });
  await sendTemplate(channel.id, "ticket", { guildId, user: userMention(userId), server: guildId });
  await addAudit(guildId, "ticket_created", channel.id, userId);
  if (sourceChannelId && config.moderation.deleteCommandMessages) {
    await discordFetch(`/channels/${sourceChannelId}/messages`, { method: "DELETE" }).catch(() => undefined);
  }
  return channel.id;
}

async function purgeBaitMessage(channelId: string, messageId: string, purgeRecent: boolean) {
  if (!purgeRecent) {
    await discordFetch(`/channels/${channelId}/messages/${messageId}`, { method: "DELETE" });
    return;
  }
  const messages = await discordFetch<Array<{ id: string }>>(`/channels/${channelId}/messages?limit=100`);
  const ids = messages.map((message) => message.id).filter((id) => id === messageId || id);
  if (ids.length > 1) {
    await discordFetch(`/channels/${channelId}/messages/bulk-delete`, {
      method: "POST",
      body: JSON.stringify({ messages: ids.slice(0, 100) }),
    }).catch(async () => {
      await discordFetch(`/channels/${channelId}/messages/${messageId}`, { method: "DELETE" }).catch(() => undefined);
    });
  } else {
    await discordFetch(`/channels/${channelId}/messages/${messageId}`, { method: "DELETE" }).catch(() => undefined);
  }
}

async function sendDm(userId: string, content: string) {
  const dm = await discordFetch<{ id: string }>("/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({ recipient_id: userId }),
  });
  await discordFetch(`/channels/${dm.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

async function handleBaitMessage(message: any) {
  if (!message.guild_id || message.author?.bot) return;
  const config = await readConfig(message.guild_id);
  if (!config.antiNuke.enabled || config.antiNuke.baitChannelId !== message.channel_id) return;

  const key = `${message.guild_id}:${message.author.id}`;
  const current = strikes.get(key);
  const next = !current || Date.now() - current.lastAt > 30 * 24 * 60 * 60_000 ? 1 : current.count + 1;
  strikes.set(key, { count: next, lastAt: Date.now() });

  const reason = "Message posted in the protected anti-nuke bait channel";
  if (next === 1) {
    await discordFetch(`/guilds/${message.guild_id}/members/${message.author.id}`, {
      method: "PATCH",
      headers: { "X-Audit-Log-Reason": encodeURIComponent(reason) },
      body: JSON.stringify({ communication_disabled_until: new Date(Date.now() + config.antiNuke.firstTimeoutHours * 3_600_000).toISOString() }),
    });
  } else if (next === 2) {
    await discordFetch(`/guilds/${message.guild_id}/members/${message.author.id}`, {
      method: "PATCH",
      headers: { "X-Audit-Log-Reason": encodeURIComponent(reason) },
      body: JSON.stringify({ communication_disabled_until: new Date(Date.now() + config.antiNuke.secondTimeoutDays * 86_400_000).toISOString() }),
    });
  } else {
    const roleId = config.antiNuke.mutedRoleId ?? config.moderation.mutedRoleId;
    if (roleId) {
      await discordFetch(`/guilds/${message.guild_id}/members/${message.author.id}/roles/${roleId}`, {
        method: "PUT",
        headers: { "X-Audit-Log-Reason": encodeURIComponent(reason) },
      });
    }
  }
  await purgeBaitMessage(message.channel_id, message.id, config.antiNuke.purgeRecentMessages);
  if (config.antiNuke.dmReason) {
    await sendDm(message.author.id, `Your message was removed because it was posted in the protected anti-nuke bait channel. Enforcement level ${Math.min(next, 3)} was applied. If you did not post it intentionally, change your Discord password, enable 2FA, log out of other devices, and remove unfamiliar authorised apps before contacting a moderator.`).catch(() => undefined);
  }
  await addAudit(message.guild_id, `anti_nuke_strike_${Math.min(next, 3)}`, message.author.id);
}

async function handleWelcome(member: any) {
  if (!member.guild_id || member.user?.bot) return;
  const config = await readConfig(member.guild_id);
  const memberRoleId = await ensureMemberRole(member.guild_id);
  await discordFetch(`/guilds/${member.guild_id}/members/${member.user.id}/roles/${memberRoleId}`, {
    method: "PUT",
    headers: { "X-Audit-Log-Reason": "CredX automatic Member role" },
  });
  if (!config.welcome.enabled || !config.welcome.channelId) return;
  const guild = await discordFetch<{ name: string; approximate_member_count?: number }>(`/guilds/${member.guild_id}?with_counts=true`);
  await sendWelcomeMessage(
    member.guild_id,
    config.welcome.channelId,
    member.user.id,
    member.user.global_name ?? member.user.username ?? "Member",
    String(guild.approximate_member_count ?? 0),
    guild.name,
  );
}

async function executeModerationCommand(interaction: any, action: string) {
  const guildId = interaction.guild_id;
  const userId = interactionOption(interaction, "user");
  const reason = interactionOption(interaction, "reason") || `CredX /${action}`;
  const durationMinutes = interactionOption(interaction, "minutes") || 60;
  const safeReason = String(reason).slice(0, 450);
  if (!guildId || !userId) return "This command can only be used inside a server.";

  if (action === "ban") {
    await discordFetch(`/guilds/${guildId}/bans/${userId}`, {
      method: "PUT",
      headers: { "X-Audit-Log-Reason": encodeURIComponent(safeReason) },
      body: JSON.stringify({ delete_message_seconds: 604800 }),
    });
  } else if (action === "kick") {
    await discordFetch(`/guilds/${guildId}/members/${userId}`, {
      method: "DELETE",
      headers: { "X-Audit-Log-Reason": encodeURIComponent(safeReason) },
    });
  } else if (action === "timeout" || action === "untimeout") {
    const until = action === "timeout"
      ? new Date(Date.now() + Number(durationMinutes) * 60_000).toISOString()
      : null;
    await discordFetch(`/guilds/${guildId}/members/${userId}`, {
      method: "PATCH",
      headers: { "X-Audit-Log-Reason": encodeURIComponent(safeReason) },
      body: JSON.stringify({ communication_disabled_until: until }),
    });
  } else {
    const config = await readConfig(guildId);
    if (!config.moderation.mutedRoleId) return "Set a muted role in CredX before using mute commands.";
    await discordFetch(`/guilds/${guildId}/members/${userId}/roles/${config.moderation.mutedRoleId}`, {
      method: action === "mute" ? "PUT" : "DELETE",
      headers: { "X-Audit-Log-Reason": encodeURIComponent(safeReason) },
    });
  }
  await addAudit(guildId, `slash_${action}`, userId, interaction.member?.user?.id ?? null);
  return `/${action} applied to <@${userId}>.`;
}

async function handleInteraction(interaction: any) {
  if (!interaction.guild_id) {
    await rejectInteraction(interaction, "CredX commands are only available inside a server.");
    return;
  }

  if (interaction.type === 2) {
    const command = interaction.data?.name;
    if (command === "ticket") {
      await deferInteraction(interaction, true);
      const member = interaction.member?.user;
      const channelId = await createTicket(
        interaction.guild_id,
        member?.id ?? interaction.member?.user_id,
        member?.username ?? "member",
      );
      await editInteraction(interaction, {
        content: channelId ? `Ticket created: <#${channelId}>` : "Tickets are not configured yet. Set a ticket category first.",
      });
      return;
    }

    if (!botCanManageGuild(interaction)) {
      await rejectInteraction(interaction, "You need the Manage Server permission to use CredX moderation controls.");
      return;
    }

    if (command === "panel") {
      await interactionCallback(interaction, { type: 4, data: { ...panelPayload(), flags: 64 } });
      return;
    }

    if (["ban", "kick", "timeout", "untimeout", "mute", "unmute"].includes(command)) {
      await deferInteraction(interaction, true);
      try {
        await editInteraction(interaction, { content: await executeModerationCommand(interaction, command) });
      } catch {
        await editInteraction(interaction, { content: `/${command} could not be applied. Check the bot role position and permissions.` });
      }
      return;
    }
  }

  if (interaction.type === 3) {
    if (!botCanManageGuild(interaction)) {
      await rejectInteraction(interaction, "You need the Manage Server permission to use the CredX panel.");
      return;
    }
    await deferInteraction(interaction, true);
    const action = interaction.data?.custom_id;
    try {
      if (action === "credx:member-role") {
        const roleId = await ensureMemberRole(interaction.guild_id);
        await editInteraction(interaction, { content: `The \`Member\` role is ready: <@&${roleId}>. New members will receive it automatically.` });
      } else if (action === "credx:welcome") {
        const config = await readConfig(interaction.guild_id);
        if (!config.welcome.channelId) {
          await editInteraction(interaction, { content: "Set a welcome channel before sending a preview." });
        } else {
          const guild = await discordFetch<{ name: string; approximate_member_count?: number }>(`/guilds/${interaction.guild_id}?with_counts=true`);
          const user = interaction.member.user;
          await sendWelcomeMessage(interaction.guild_id, config.welcome.channelId, user.id, user.global_name ?? user.username ?? "Member", String(guild.approximate_member_count ?? 0), guild.name);
          await editInteraction(interaction, { content: `Welcome preview sent to <#${config.welcome.channelId}>.` });
        }
      } else if (action === "credx:rules" || action === "credx:antinuke") {
        const config = await readConfig(interaction.guild_id);
        const templateKey = action === "credx:rules" ? "rules" : "antinuke";
        const targetChannelId = templateKey === "antinuke" ? config.antiNuke.baitChannelId : config.welcome.channelId;
        if (!targetChannelId) {
          await editInteraction(interaction, { content: `Set a target channel for the ${templateKey} embed first.` });
        } else {
          await sendTemplate(targetChannelId, templateKey, { guildId: interaction.guild_id });
          await editInteraction(interaction, { content: `${templateKey} embed sent to <#${targetChannelId}>.` });
        }
      } else if (action === "credx:refresh") {
        await editInteraction(interaction, panelPayload());
      } else {
        await editInteraction(interaction, { content: "Unknown CredX panel action." });
      }
    } catch {
      await editInteraction(interaction, { content: "CredX could not complete that panel action. Check the bot permissions and configuration." });
    }
  }
}

function connectGateway() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return;
  void discordFetch<{ url: string }>("/gateway/bot")
    .then(({ url }) => {
      gatewaySocket = new WebSocket(`${url}?v=10&encoding=json`);
      let sequence: number | null = null;
      gatewaySocket.on("message", (raw) => {
        const packet = JSON.parse(String(raw)) as GatewayMessage;
        if (packet.s !== undefined) sequence = packet.s;
        if (packet.op === 10) {
          heartbeat = setInterval(() => gatewaySocket?.send(JSON.stringify({ op: 1, d: sequence })), packet.d.heartbeat_interval);
          gatewaySocket?.send(JSON.stringify({
            op: 2,
            d: {
              token,
              intents,
              properties: { os: "linux", browser: "credx", device: "credx" },
            },
          }));
        } else if (packet.op === 0 && packet.t === "READY") {
          applicationId = packet.d.user.id;
          logger.info({ guildCount: packet.d.guilds?.length ?? 0 }, "CredX Gateway ready; registering slash commands");
          void ensureBotName(packet.d.user.username).catch(() => undefined);
          for (const guild of packet.d.guilds ?? []) {
            void registerSlashCommands(guild.id).catch(() => undefined);
          }
        } else if (packet.op === 0 && packet.t === "GUILD_CREATE") {
          void registerSlashCommands(packet.d.id).catch(() => undefined);
        } else if (packet.op === 0 && packet.t === "MESSAGE_CREATE") {
          void handleBaitMessage(packet.d).catch(() => undefined);
        } else if (packet.op === 0 && packet.t === "GUILD_MEMBER_ADD") {
          void handleWelcome(packet.d).catch(() => undefined);
        } else if (packet.op === 0 && packet.t === "INTERACTION_CREATE") {
          void handleInteraction(packet.d).catch(() => undefined);
        } else if (packet.op === 7 || packet.op === 9) {
          gatewaySocket?.close();
        }
      });
      gatewaySocket.on("close", () => {
        if (heartbeat) clearInterval(heartbeat);
        if (!reconnectTimer) reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          connectGateway();
        }, 10_000);
      });
      gatewaySocket.on("error", (error) => logger.warn({ err: error }, "CredX Gateway socket error"));
    })
    .catch((error) => {
      logger.warn({ err: error }, "CredX Gateway connection failed; retrying");
      if (!reconnectTimer) reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connectGateway();
      }, 10_000);
    });
}

export function startDiscordGateway() {
  connectGateway();
}