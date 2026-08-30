import WebSocket from "ws";
import { addAudit, discordFetch, ensureTemplates, readConfig } from "../routes/discord";

const intents = 1 | 2 | 512 | 32768;
const strikes = new Map<string, { count: number; lastAt: number }>();
let gatewaySocket: WebSocket | undefined;
let heartbeat: NodeJS.Timeout | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;

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

async function createTicket(guildId: string, userId: string, username: string, sourceChannelId: string) {
  const config = await readConfig(guildId);
  if (!config.tickets.enabled || !config.tickets.categoryId) return;
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
  if (config.moderation.deleteCommandMessages) {
    await discordFetch(`/channels/${sourceChannelId}/messages`, { method: "DELETE" }).catch(() => undefined);
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
  if (!config.welcome.enabled || !config.welcome.channelId) return;
  const guild = await discordFetch<{ name: string; approximate_member_count?: number }>(`/guilds/${member.guild_id}?with_counts=true`);
  await sendTemplate(config.welcome.channelId, "welcome", {
    guildId: member.guild_id,
    user: userMention(member.user.id),
    server: guild.name,
    memberCount: String(guild.approximate_member_count ?? 0),
    memberCountPadded: String(guild.approximate_member_count ?? 0).padStart(4, "0"),
  });
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
              properties: { os: "linux", browser: "sentinel-ctrl", device: "sentinel-ctrl" },
            },
          }));
        } else if (packet.op === 0 && packet.t === "MESSAGE_CREATE") {
          void handleBaitMessage(packet.d).catch(() => undefined);
          if (packet.d.content?.trim().toLowerCase() === "!ticket") {
            void createTicket(packet.d.guild_id, packet.d.author.id, packet.d.author.username ?? "member", packet.d.channel_id).catch(() => undefined);
          }
        } else if (packet.op === 0 && packet.t === "GUILD_MEMBER_ADD") {
          void handleWelcome(packet.d).catch(() => undefined);
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
      gatewaySocket.on("error", () => undefined);
    })
    .catch(() => {
      if (!reconnectTimer) reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connectGateway();
      }, 10_000);
    });
}

export function startDiscordGateway() {
  connectGateway();
}