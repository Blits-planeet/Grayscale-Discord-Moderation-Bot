import WebSocket from "ws";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { db, giveawaysTable } from "@workspace/db";
import { addAudit, discordFetch, ensureTemplates, readBotPresenceConfig, readConfig } from "../routes/discord";
import { logger } from "./logger";

const intents = 1 | 2 | 512 | 1024 | 32768;
const activityTypes = {
  playing: 0,
  streaming: 1,
  listening: 2,
  watching: 3,
  competing: 5,
} as const;
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
    name: "ticket",
    description: "Create a private support ticket",
    options: [{
      name: "category",
      description: "Choose what your ticket is about",
      type: 3,
      required: true,
      choices: [
        { name: "Purchasing", value: "purchasing" },
        { name: "Giveaway (claim/info)", value: "giveaway" },
        { name: "Scam (report)", value: "scam" },
        { name: "Support (info)", value: "support" },
      ],
    }],
  },
  {
    name: "giveaway",
    description: "Start a timed giveaway",
    default_member_permissions: "32",
    options: [
      { name: "prize", description: "What the winner will receive", type: 3, required: true, max_length: 200 },
      { name: "hours", description: "How many hours the giveaway lasts", type: 4, required: true, min_value: 1, max_value: 720 },
      { name: "role", description: "Only members with this role can enter", type: 8, required: false },
      { name: "winners", description: "Number of winners", type: 4, required: false, min_value: 1, max_value: 20 },
    ],
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
    name: "mute",
    description: "Timeout a member without using a role",
    default_member_permissions: "32",
    options: [
      { name: "minutes", description: "Timeout duration in minutes", type: 4, required: true, min_value: 1, max_value: 40320 },
      { name: "user", description: "Member to mute", type: 6, required: true },
      { name: "reason", description: "Reason for the mute", type: 3, required: false },
    ],
  },
  {
    name: "unmute",
    description: "Remove a member timeout without using a role",
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

const ticketCategories: Record<string, { label: string; channelPrefix: string; description: string }> = {
  purchasing: { label: "Purchasing", channelPrefix: "purchasing", description: "Questions about buying or orders." },
  giveaway: { label: "Giveaway (claim/info)", channelPrefix: "giveaway", description: "Claim or ask for information about a giveaway." },
  scam: { label: "Scam (report)", channelPrefix: "scam", description: "Report a scam or suspicious activity." },
  support: { label: "Support (info)", channelPrefix: "support", description: "General support and information." },
};

function ticketPanelPayload() {
  return {
    embeds: [{
      title: "CredX support tickets",
      description: "Choose a category below. CredX will create a private channel with a matching category name.",
      color: 0x252830,
      footer: { text: "CredX • Ticketing" },
    }],
    components: [{
      type: 1,
      components: [{
        type: 3,
        custom_id: "credx:ticket-category",
        placeholder: "Choose a ticket category",
        options: Object.entries(ticketCategories).map(([value, category]) => ({
          label: category.label,
          value,
          description: category.description,
        })),
      }],
    }],
  };
}

function ticketButtonRow(userId: string, claimed = false) {
  return {
    type: 1,
    components: [
      { type: 2, style: 4, custom_id: `credx:ticket:close:${userId}`, label: "Close" },
      { type: 2, style: 2, custom_id: `credx:ticket:ping-admin:${userId}`, label: "Ping admin" },
      { type: 2, style: 1, custom_id: `credx:ticket:claim:${userId}`, label: claimed ? "Claimed" : "Claim", disabled: claimed },
    ],
  };
}

function ticketMessagePayload(userId: string, categoryKey: string, claimedBy?: string) {
  const category = ticketCategories[categoryKey] ?? ticketCategories.support;
  return {
    content: `<@${userId}>`,
    embeds: [{
      title: `CredX Ticket • ${category.label}`,
      description: "Please explain your question clearly. A member of the team will help you here.",
      color: 0x6e7178,
      fields: [
        { name: "User", value: `<@${userId}>`, inline: true },
        { name: "Category", value: category.label, inline: true },
        { name: "Claimed", value: claimedBy ?? "Not claimed", inline: false },
      ],
      footer: { text: "CredX ticket controls" },
    }],
    components: [ticketButtonRow(userId)],
  };
}

function hasRole(interaction: any, roleId: string | null): boolean {
  return Boolean(roleId && (interaction.member?.roles ?? []).includes(roleId));
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

async function createTicket(
  guildId: string,
  userId: string,
  username: string,
  categoryKey = "support",
  sourceChannelId?: string,
) {
  const config = await readConfig(guildId);
  if (!config.tickets.enabled || !config.tickets.categoryId) return null;
  const category = ticketCategories[categoryKey] ?? ticketCategories.support;
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
      name: `${category.channelPrefix}-${username.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 70) || userId.slice(-6)}`,
      type: 0,
      parent_id: config.tickets.categoryId,
      permission_overwrites: permissionOverwrites,
    }),
  });
  await discordFetch(`/channels/${channel.id}/messages`, {
    method: "POST",
    body: JSON.stringify(ticketMessagePayload(userId, categoryKey)),
  });
  await addAudit(guildId, "ticket_created", channel.id, userId);
  if (sourceChannelId && config.moderation.deleteCommandMessages) {
    await discordFetch(`/channels/${sourceChannelId}/messages`, { method: "DELETE" }).catch(() => undefined);
  }
  return channel.id;
}

async function sendTicketPanel(channelId: string) {
  return discordFetch<{ id: string }>(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(ticketPanelPayload()),
  });
}

async function sendVerificationPanel(channelId: string, emoji: string) {
  const message = await discordFetch<{ id: string }>(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      embeds: [{
        title: "CredX verification",
        description: `React with ${emoji} to receive the Member role. Remove your reaction to remove the role again.`,
        color: 0x252830,
        footer: { text: "CredX • Verification" },
      }],
    }),
  });
  await discordFetch(`/channels/${channelId}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}/@me`, {
    method: "PUT",
  });
  return message;
}

type GiveawayRecord = typeof giveawaysTable.$inferSelect;
const giveawayTimers = new Map<string, NodeJS.Timeout>();

function giveawayParticipants(giveaway: GiveawayRecord): string[] {
  return Array.isArray(giveaway.participantIds)
    ? giveaway.participantIds.filter((id): id is string => typeof id === "string")
    : [];
}

function giveawayMessagePayload(giveaway: GiveawayRecord, ended = false, winnerIds: string[] = []) {
  const participants = giveawayParticipants(giveaway);
  const eligibility = giveaway.requiredRoleId
    ? `Required role: <@&${giveaway.requiredRoleId}>`
    : "Everyone can enter";
  const winners = winnerIds.length
    ? winnerIds.map((id) => `<@${id}>`).join(", ")
    : "No valid entries";
  return {
    embeds: [{
      title: `🎉 Giveaway • ${giveaway.prize}`,
      description: ended
        ? `This giveaway has ended.\n\nWinner${winnerIds.length === 1 ? "" : "s"}: ${winners}`
        : `Click the button below to enter.\n\n${eligibility}`,
      color: ended ? 0x6e7178 : 0x5865f2,
      fields: [
        { name: "Prize", value: giveaway.prize, inline: true },
        { name: "Entries", value: String(participants.length), inline: true },
        { name: ended ? "Ended" : "Ends", value: ended ? `<t:${Math.floor(giveaway.endsAt.getTime() / 1000)}:f>` : `<t:${Math.floor(giveaway.endsAt.getTime() / 1000)}:R>`, inline: false },
      ],
      footer: { text: `CredX • ${giveaway.winnerCount} winner${giveaway.winnerCount === 1 ? "" : "s"}` },
    }],
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 1,
        custom_id: `credx:giveaway:enter:${giveaway.id}`,
        label: ended ? "Giveaway ended" : "Enter giveaway",
        disabled: ended,
      }],
    }],
  };
}

async function updateGiveawayMessage(giveaway: GiveawayRecord, ended = false, winnerIds: string[] = []) {
  await discordFetch(`/channels/${giveaway.channelId}/messages/${giveaway.messageId}`, {
    method: "PATCH",
    body: JSON.stringify(giveawayMessagePayload(giveaway, ended, winnerIds)),
  });
}

function scheduleGiveaway(giveawayId: string, endsAt: Date) {
  const existing = giveawayTimers.get(giveawayId);
  if (existing) clearTimeout(existing);
  const remaining = endsAt.getTime() - Date.now();
  const delay = Math.min(Math.max(remaining, 0), 2_147_000_000);
  const timer = setTimeout(() => {
    giveawayTimers.delete(giveawayId);
    if (endsAt.getTime() > Date.now()) {
      scheduleGiveaway(giveawayId, endsAt);
    } else {
      void finishGiveaway(giveawayId).catch((error) => logger.warn({ err: error, giveawayId }, "CredX could not finish giveaway"));
    }
  }, delay);
  giveawayTimers.set(giveawayId, timer);
}

function pickGiveawayWinners(participants: string[], winnerCount: number): string[] {
  const shuffled = [...participants];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, winnerCount);
}

async function finishGiveaway(giveawayId: string) {
  const [giveaway] = await db.select().from(giveawaysTable).where(eq(giveawaysTable.id, giveawayId)).limit(1);
  if (!giveaway || giveaway.status !== "active") return;
  if (giveaway.endsAt.getTime() > Date.now()) {
    scheduleGiveaway(giveaway.id, giveaway.endsAt);
    return;
  }
  const winnerIds = pickGiveawayWinners(giveawayParticipants(giveaway), giveaway.winnerCount);
  await db.update(giveawaysTable)
    .set({ status: "ended", winnerIds })
    .where(and(eq(giveawaysTable.id, giveaway.id), eq(giveawaysTable.status, "active")));
  await updateGiveawayMessage(giveaway, true, winnerIds).catch((error) => logger.warn({ err: error, giveawayId }, "CredX could not update ended giveaway message"));
  let guildName = "the server";
  try {
    const guild = await discordFetch<{ name: string }>(`/guilds/${giveaway.guildId}`);
    guildName = guild.name;
  } catch {
    // The winner message remains valid without the guild name.
  }
  for (const winnerId of winnerIds) {
    await sendDm(
      winnerId,
      `Congratulations! You won the giveaway for **${giveaway.prize}** in **${guildName}**. Please contact the server staff to claim your prize.`,
    ).catch((error) => logger.warn({ err: error, giveawayId, winnerId }, "CredX could not DM giveaway winner"));
  }
  await addAudit(giveaway.guildId, "giveaway_ended", giveaway.id, winnerIds.join(",") || null);
}

async function restoreGiveaways() {
  const activeGiveaways = await db.select().from(giveawaysTable).where(eq(giveawaysTable.status, "active"));
  for (const giveaway of activeGiveaways) scheduleGiveaway(giveaway.id, giveaway.endsAt);
}

async function createGiveaway(interaction: any) {
  const guildId = interaction.guild_id as string;
  const channelId = interaction.channel_id as string;
  const prize = String(interactionOption(interaction, "prize") ?? "").trim();
  const hours = Number(interactionOption(interaction, "hours"));
  const winnerCount = Number(interactionOption(interaction, "winners") ?? 1);
  const requiredRoleId = interactionOption(interaction, "role") as string | undefined;
  if (!prize || !Number.isInteger(hours) || hours < 1 || hours > 720 || !Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 20) {
    throw new Error("Giveaway settings are invalid.");
  }
  const giveaway: GiveawayRecord = {
    id: randomUUID(),
    guildId,
    channelId,
    messageId: "",
    prize,
    winnerCount,
    requiredRoleId: requiredRoleId ?? null,
    endsAt: new Date(Date.now() + hours * 3_600_000),
    status: "active",
    participantIds: [],
    winnerIds: [],
    createdBy: interaction.member?.user?.id ?? interaction.user?.id ?? "",
    createdAt: new Date(),
  };
  const message = await discordFetch<{ id: string }>(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(giveawayMessagePayload(giveaway)),
  });
  giveaway.messageId = message.id;
  await db.insert(giveawaysTable).values(giveaway);
  scheduleGiveaway(giveaway.id, giveaway.endsAt);
  await addAudit(guildId, "giveaway_created", giveaway.id, giveaway.createdBy || null);
  return giveaway;
}

async function handleGiveawayInteraction(interaction: any) {
  const customId = String(interaction.data?.custom_id ?? "");
  const giveawayId = customId.split(":")[3];
  if (!giveawayId || !interaction.guild_id) return;
  await deferInteraction(interaction, true);
  const [giveaway] = await db.select().from(giveawaysTable).where(eq(giveawaysTable.id, giveawayId)).limit(1);
  if (!giveaway || giveaway.guildId !== interaction.guild_id) {
    await editInteraction(interaction, { content: "This giveaway could not be found." });
    return;
  }
  if (giveaway.status !== "active" || giveaway.endsAt.getTime() <= Date.now()) {
    await finishGiveaway(giveaway.id);
    await editInteraction(interaction, { content: "This giveaway has ended." });
    return;
  }
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  if (!userId) {
    await editInteraction(interaction, { content: "Your Discord user could not be identified." });
    return;
  }
  const participants = giveawayParticipants(giveaway);
  if (participants.includes(userId)) {
    await editInteraction(interaction, { content: "You are already entered in this giveaway." });
    return;
  }
  if (giveaway.requiredRoleId) {
    const member = await discordFetch<{ roles?: string[] }>(`/guilds/${giveaway.guildId}/members/${userId}`);
    if (!member.roles?.includes(giveaway.requiredRoleId)) {
      await editInteraction(interaction, { content: "You do not have the required role for this giveaway." });
      return;
    }
  }
  const updatedParticipants = [...participants, userId];
  await db.update(giveawaysTable)
    .set({ participantIds: updatedParticipants })
    .where(and(eq(giveawaysTable.id, giveaway.id), eq(giveawaysTable.status, "active")));
  await updateGiveawayMessage({ ...giveaway, participantIds: updatedParticipants });
  await editInteraction(interaction, { content: "You are entered in the giveaway. Good luck!" });
}

async function hasCredxPanel(channelId: string, title: string): Promise<boolean> {
  const messages = await discordFetch<Array<{ author?: { id?: string }; embeds?: Array<{ title?: string }> }>>(`/channels/${channelId}/messages?limit=100`);
  return messages.some((message) => message.author?.id === applicationId && message.embeds?.some((embed) => embed.title === title));
}

const panelSyncInFlight = new Set<string>();

async function ensureGuildPanels(guildId: string) {
  if (panelSyncInFlight.has(guildId)) return;
  panelSyncInFlight.add(guildId);
  try {
    const config = await readConfig(guildId);
    if (config.tickets.enabled && config.tickets.panelChannelId && !await hasCredxPanel(config.tickets.panelChannelId, "CredX support tickets")) {
      await sendTicketPanel(config.tickets.panelChannelId);
      logger.info({ guildId, channelId: config.tickets.panelChannelId }, "CredX ticket panel posted automatically");
    }
    if (config.verification.enabled && config.verification.channelId && !await hasCredxPanel(config.verification.channelId, "CredX verification")) {
      await sendVerificationPanel(config.verification.channelId, config.verification.emoji);
      logger.info({ guildId, channelId: config.verification.channelId }, "CredX verification panel posted automatically");
    }
  } finally {
    panelSyncInFlight.delete(guildId);
  }
}

function reactionMatches(reaction: any, configuredEmoji: string): boolean {
  if (reaction?.emoji?.name === configuredEmoji || reaction?.emoji?.id === configuredEmoji) return true;
  const customMatch = configuredEmoji.match(/^<a?:[^:>]+:(\d+)>$/);
  return Boolean(customMatch && reaction?.emoji?.id === customMatch[1]);
}

async function isCredxVerificationMessage(guildId: string, channelId: string, messageId: string, reaction: any) {
  const config = await readConfig(guildId);
  if (!config.verification.enabled || config.verification.channelId !== channelId || !reactionMatches(reaction, config.verification.emoji)) return false;
  const message = await discordFetch<any>(`/channels/${channelId}/messages/${messageId}`);
  return message.author?.id === applicationId && message.embeds?.[0]?.title === "CredX verification";
}

async function handleVerificationReaction(reaction: any, added: boolean) {
  if (!reaction.guild_id || reaction.user_id === applicationId) return;
  if (!await isCredxVerificationMessage(reaction.guild_id, reaction.channel_id, reaction.message_id, reaction)) return;
  const roleId = await ensureMemberRole(reaction.guild_id);
  await discordFetch(`/guilds/${reaction.guild_id}/members/${reaction.user_id}/roles/${roleId}`, {
    method: added ? "PUT" : "DELETE",
    headers: { "X-Audit-Log-Reason": `CredX verification reaction ${added ? "added" : "removed"}` },
  });
  await addAudit(reaction.guild_id, added ? "verification_role_added" : "verification_role_removed", reaction.user_id);
}

async function handleTicketInteraction(interaction: any) {
  const customId = interaction.data?.custom_id as string;
  if (customId === "credx:ticket-category") {
    const categoryKey = interaction.data?.values?.[0] ?? "support";
    await deferInteraction(interaction, true);
    const member = interaction.member?.user;
    const channelId = await createTicket(
      interaction.guild_id,
      member?.id ?? interaction.member?.user_id,
      member?.username ?? "member",
      categoryKey,
    );
    await editInteraction(interaction, {
      content: channelId
        ? `Ticket created: <#${channelId}>`
        : "Tickets are not configured yet. Set a ticket category first.",
    });
    return;
  }

  const [, , action, ownerId] = customId.split(":");
  const config = await readConfig(interaction.guild_id);
  const canManageTicket = botCanManageGuild(interaction) || hasRole(interaction, config.tickets.supportRoleId);
  if (!canManageTicket) {
    await rejectInteraction(interaction, "Only admins or the configured support role can manage tickets.");
    return;
  }

  if (action === "ping-admin") {
    if (!config.tickets.supportRoleId) {
      await rejectInteraction(interaction, "Set a support role before using Ping admin.");
      return;
    }
    await interactionCallback(interaction, {
      type: 4,
      data: {
        content: `<@&${config.tickets.supportRoleId}> a ticket needs attention from <@${ownerId}>.`,
        allowed_mentions: { roles: [config.tickets.supportRoleId], users: [ownerId] },
      },
    });
    return;
  }

  if (action === "close") {
    await interactionCallback(interaction, {
      type: 4,
      data: { content: "This ticket will close in a moment.", flags: 64 },
    });
    await addAudit(interaction.guild_id, "ticket_closed", interaction.channel_id, interaction.member?.user?.id ?? null);
    setTimeout(() => {
      void discordFetch(`/channels/${interaction.channel_id}`, {
        method: "DELETE",
        headers: { "X-Audit-Log-Reason": "Ticket closed from CredX panel" },
      }).catch(() => undefined);
    }, 1_500);
    return;
  }

  if (action === "claim") {
    const currentEmbed = interaction.message?.embeds?.[0] ?? {};
    const currentFields = Array.isArray(currentEmbed.fields) ? currentEmbed.fields : [];
    const claimant = interaction.member?.user?.global_name ?? interaction.member?.user?.username ?? "Admin";
    const fields = [
      ...currentFields.filter((field: any) => field.name !== "Claimed"),
      { name: "Claimed", value: claimant, inline: false },
    ];
    await interactionCallback(interaction, {
      type: 7,
      data: {
        content: `<@${ownerId}>`,
        embeds: [{
          title: currentEmbed.title ?? "CredX Ticket",
          description: currentEmbed.description ?? "A member of the team will help you here.",
          color: currentEmbed.color ?? 0x6e7178,
          fields,
          footer: { text: "CredX ticket controls" },
        }],
        components: [ticketButtonRow(ownerId, true)],
      },
    });
    await addAudit(interaction.guild_id, "ticket_claimed", interaction.channel_id, interaction.member?.user?.id ?? null);
  }
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
    const until = new Date(Date.now() + config.antiNuke.thirdTimeoutDays * 86_400_000).toISOString();
    await discordFetch(`/guilds/${message.guild_id}/members/${message.author.id}`, {
      method: "PATCH",
      headers: { "X-Audit-Log-Reason": encodeURIComponent(reason) },
      body: JSON.stringify({ communication_disabled_until: until }),
    });
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
  } else {
    const config = await readConfig(guildId);
    const until = action === "mute"
      ? new Date(Date.now() + Number(interactionOption(interaction, "minutes") ?? config.moderation.defaultTimeoutHours * 60) * 60_000).toISOString()
      : null;
    await discordFetch(`/guilds/${guildId}/members/${userId}`, {
      method: "PATCH",
      headers: { "X-Audit-Log-Reason": encodeURIComponent(safeReason) },
      body: JSON.stringify({ communication_disabled_until: until }),
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
        interactionOption(interaction, "category") ?? "support",
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

    if (command === "giveaway") {
      await deferInteraction(interaction, true);
      try {
        const giveaway = await createGiveaway(interaction);
        await editInteraction(interaction, {
          content: `Giveaway started for **${giveaway.prize}** and ends <t:${Math.floor(giveaway.endsAt.getTime() / 1000)}:R>.`,
        });
      } catch {
        await editInteraction(interaction, { content: "The giveaway could not be started. Check the bot's channel permissions and database connection." });
      }
      return;
    }

    if (["ban", "kick", "mute", "unmute"].includes(command)) {
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
    const customId = interaction.data?.custom_id as string;
    if (customId.startsWith("credx:giveaway:enter:")) {
      await handleGiveawayInteraction(interaction);
      return;
    }
    if (customId === "credx:ticket-category" || customId.startsWith("credx:ticket:")) {
      await handleTicketInteraction(interaction);
      return;
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
          void readBotPresenceConfig().then((presence) => {
            gatewaySocket?.send(JSON.stringify({
              op: 2,
              d: {
                token,
                intents,
                properties: { os: "linux", browser: "credx", device: "credx" },
                presence: {
                  since: null,
                  activities: presence.activity ? [{ name: presence.activity, type: activityTypes[presence.activityType] }] : [],
                  status: presence.status,
                  afk: false,
                },
              },
            }));
          });
        } else if (packet.op === 0 && packet.t === "READY") {
          applicationId = packet.d.user.id;
          logger.info({ guildCount: packet.d.guilds?.length ?? 0 }, "CredX Gateway ready; registering slash commands");
          void ensureBotName(packet.d.user.username).catch(() => undefined);
          for (const guild of packet.d.guilds ?? []) {
            void registerSlashCommands(guild.id).catch(() => undefined);
            void ensureGuildPanels(guild.id).catch((error) => logger.warn({ err: error, guildId: guild.id }, "CredX could not sync automatic panels"));
          }
          void restoreGiveaways().catch((error) => logger.warn({ err: error }, "CredX could not restore active giveaways"));
        } else if (packet.op === 0 && packet.t === "GUILD_CREATE") {
          void registerSlashCommands(packet.d.id).catch(() => undefined);
          void ensureGuildPanels(packet.d.id).catch((error) => logger.warn({ err: error, guildId: packet.d.id }, "CredX could not sync automatic panels"));
        } else if (packet.op === 0 && packet.t === "MESSAGE_CREATE") {
          void handleBaitMessage(packet.d).catch(() => undefined);
        } else if (packet.op === 0 && packet.t === "GUILD_MEMBER_ADD") {
          void handleWelcome(packet.d).catch(() => undefined);
        } else if (packet.op === 0 && packet.t === "MESSAGE_REACTION_ADD") {
          void handleVerificationReaction(packet.d, true).catch(() => undefined);
        } else if (packet.op === 0 && packet.t === "MESSAGE_REACTION_REMOVE") {
          void handleVerificationReaction(packet.d, false).catch(() => undefined);
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