import { and, desc, eq } from "drizzle-orm";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  type EmbedField,
  type EmbedTemplate,
  ExecuteModerationActionBody,
  ExecuteModerationActionParams,
  GetDiscordGuildSummaryParams,
  GetGuildConfigParams,
  type GuildConfig,
  ListDiscordGuildsResponse,
  ListGuildAuditEventsParams,
  ListGuildTemplatesParams,
  type ModerationResult,
  SendGuildTemplateBody,
  SendGuildTemplateParams,
  UpdateGuildConfigBody,
  UpdateGuildConfigParams,
  UpdateGuildTemplateBody,
  UpdateGuildTemplateParams,
} from "@workspace/api-zod";
import { auditEventsTable, db, embedTemplatesTable, serverConfigsTable } from "@workspace/db";

const router: IRouter = Router();
const DISCORD_API = "https://discord.com/api/v10";

type GuildConfigValue = {
  moderation: {
    logChannelId: string | null;
    mutedRoleId: string | null;
    memberRoleId: string | null;
    defaultTimeoutHours: number;
    dmUsers: boolean;
    deleteCommandMessages: boolean;
  };
  welcome: {
    enabled: boolean;
    channelId: string | null;
    message: string;
    imagePath: string | null;
    imageName?: string | null;
    showMemberCount: boolean;
  };
  tickets: {
    enabled: boolean;
    categoryId: string | null;
    panelChannelId: string | null;
    supportRoleId: string | null;
    transcriptChannelId: string | null;
  };
  verification: {
    enabled: boolean;
    channelId: string | null;
    emoji: string;
  };
  antiNuke: {
    enabled: boolean;
    baitChannelId: string | null;
    firstTimeoutHours: number;
    secondTimeoutDays: number;
    thirdTimeoutDays: number;
    mutedRoleId: string | null;
    purgeRecentMessages: boolean;
    dmReason: boolean;
  };
};

export type BotPresenceConfig = {
  status: "online" | "idle" | "dnd" | "invisible";
  activityType: "playing" | "streaming" | "listening" | "watching" | "competing";
  activity: string;
};

const defaultConfig = (): GuildConfigValue => ({
  moderation: {
    logChannelId: null,
    mutedRoleId: null,
    memberRoleId: null,
    defaultTimeoutHours: 5,
    dmUsers: true,
    deleteCommandMessages: true,
  },
  welcome: {
    enabled: true,
    channelId: null,
    message: "Welcome {user} to {server}. You are member #{memberCount}.",
    imagePath: null,
    imageName: null,
    showMemberCount: true,
  },
  tickets: {
    enabled: true,
    categoryId: null,
    panelChannelId: null,
    supportRoleId: null,
    transcriptChannelId: null,
  },
  verification: {
    enabled: true,
    channelId: null,
    emoji: "✅",
  },
  antiNuke: {
    enabled: false,
    baitChannelId: null,
    firstTimeoutHours: 5,
    secondTimeoutDays: 5,
    thirdTimeoutDays: 30,
    mutedRoleId: null,
    purgeRecentMessages: true,
    dmReason: true,
  },
});

const defaultTemplates: Record<string, Omit<EmbedTemplate, "guildId">> = {
  welcome: {
    key: "welcome",
    name: "Welcome",
    description: "The first impression for every new member.",
    color: "#8E9196",
    content: "Welcome {user} to {server}.",
    fields: [
      { name: "Member", value: "{memberCount} members", inline: true },
      { name: "Member ID", value: "#{memberCountPadded}", inline: true },
    ],
    footer: "Configured in Moderation Panel",
    enabled: true,
  },
  rules: {
    key: "rules",
    name: "Server rules",
    description: "Your canonical rules message, ready to resend.",
    color: "#686C72",
    content: "Read these rules before participating.",
    fields: [
      { name: "Respect", value: "Treat people and the space with respect.", inline: false },
      { name: "Safety", value: "No scams, harassment, or malicious links.", inline: false },
      { name: "Moderation", value: "Follow moderator instructions and appeals.", inline: false },
    ],
    footer: "Rules can be edited from the panel",
    enabled: true,
  },
  announcement: {
    key: "announcement",
    name: "Announcement",
    description: "A clean reusable announcement template.",
    color: "#B0B3B8",
    content: "New announcement from the moderation team.",
    fields: [],
    footer: "Announcement",
    enabled: true,
  },
  ticket: {
    key: "ticket",
    name: "Ticketing",
    description: "Instructions shown when a ticket is opened.",
    color: "#777B81",
    content: "A moderator will be with you shortly.",
    fields: [
      { name: "Include", value: "A clear description and any relevant evidence.", inline: false },
    ],
    footer: "Support ticket",
    enabled: true,
  },
  antinuke: {
    key: "antinuke",
    name: "Anti-nuke bait channel",
    description: "The warning embed for a monitored channel.",
    color: "#54585E",
    content:
      "🚨 DO NOT SEND MESSAGES IN THIS CHANNEL\n\nAny message posted here is punished automatically.\nNo warning, no countdown. Not even a single character.\n\nWhat happens if you post\n• 1st time — 5 hour timeout\n• 2nd time — 5 day timeout\n• 3rd time — 30 day timeout\n\nYour message is deleted, your recent messages across the server are purged, and you get a DM explaining why.\n\nWhy this channel exists\nHacked and compromised accounts are used to blast scam links into every channel they can reach. This channel is bait — it is one of the first they hit, and no real member ever posts here by accident.\n\nIf that already happened to you\nTreat your account as compromised: change your Discord password, turn on 2FA, log out of all devices, and remove any authorised apps you don't recognise. Then ask a moderator.\n\nJust don't type here. That's it.",
    fields: [],
    footer: "Automated enforcement is enabled in this channel",
    enabled: true,
  },
};

function botHeaders(extra?: Record<string, string>, multipart = false): Record<string, string> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not configured");
  return {
    Authorization: `Bot ${token}`,
    ...(!multipart && !extra?.["Content-Type"] ? { "Content-Type": "application/json" } : {}),
    ...extra,
  };
}

export async function discordFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${DISCORD_API}${path}`, {
    ...init,
    headers: botHeaders(init?.headers as Record<string, string> | undefined, typeof FormData !== "undefined" && init?.body instanceof FormData),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Discord ${response.status}: ${detail.slice(0, 300)}`);
  }
  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
}

function hexToInt(color: string): number {
  const normalized = color.trim().replace("#", "");
  const parsed = Number.parseInt(normalized, 16);
  return Number.isFinite(parsed) ? parsed : 0x8e9196;
}

function withGuildId(guildId: string, template: Omit<EmbedTemplate, "guildId">): EmbedTemplate {
  return { guildId, ...template };
}

export async function readConfig(guildId: string): Promise<GuildConfig> {
  const [row] = await db
    .select()
    .from(serverConfigsTable)
    .where(eq(serverConfigsTable.guildId, guildId))
    .limit(1);
  const fileConfig = await readFileConfig();
  const fileDefaults = fileConfig?.defaults ?? {};
  const fileGuild = fileConfig?.guilds?.[guildId] ?? {};
  const storedConfig = row?.config as Partial<GuildConfigValue> | undefined;
  const base = defaultConfig();
  const value = {
    moderation: { ...base.moderation, ...storedConfig?.moderation, ...fileDefaults.moderation, ...fileGuild.moderation },
    welcome: { ...base.welcome, ...storedConfig?.welcome, ...fileDefaults.welcome, ...fileGuild.welcome },
    tickets: { ...base.tickets, ...storedConfig?.tickets, ...fileDefaults.tickets, ...fileGuild.tickets },
    verification: { ...base.verification, ...storedConfig?.verification, ...fileDefaults.verification, ...fileGuild.verification },
    antiNuke: { ...base.antiNuke, ...storedConfig?.antiNuke, ...fileDefaults.antiNuke, ...fileGuild.antiNuke },
  };
  return {
    guildId,
    ...value,
    updatedAt: row?.updatedAt?.toISOString() ?? new Date().toISOString(),
  } as GuildConfig;
}

type ConfigFile = {
  bot?: Partial<BotPresenceConfig>;
  defaults?: Partial<GuildConfigValue>;
  guilds?: Record<string, Partial<GuildConfigValue>>;
};

let configFileCache: { path: string; mtimeMs: number; value: ConfigFile } | null = null;

async function readFileConfig(): Promise<ConfigFile | null> {
  const candidates = [
    path.resolve(process.cwd(), "credx.config.json"),
    path.resolve(process.cwd(), "../../credx.config.json"),
    path.resolve(__dirname, "../../../credx.config.json"),
  ];
  for (const candidate of candidates) {
    try {
      const metadata = await stat(candidate);
      if (configFileCache?.path === candidate && configFileCache.mtimeMs === metadata.mtimeMs) {
        return configFileCache.value;
      }
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as ConfigFile;
      configFileCache = { path: candidate, mtimeMs: metadata.mtimeMs, value: parsed };
      return parsed;
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`Unable to read credx.config.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}

export async function readBotPresenceConfig(): Promise<BotPresenceConfig> {
  const fileConfig = await readFileConfig();
  const status = String(fileConfig?.bot?.status ?? "online").toLowerCase();
  const activityType = String(fileConfig?.bot?.activityType ?? "watching").toLowerCase();
  const activity = String(fileConfig?.bot?.activity ?? "CredX moderation");
  if (!["online", "idle", "dnd", "invisible"].includes(status)) {
    throw new Error("credx.config.json bot.status must be online, idle, dnd, or invisible");
  }
  if (!["playing", "streaming", "listening", "watching", "competing"].includes(activityType)) {
    throw new Error("credx.config.json bot.activityType must be playing, streaming, listening, watching, or competing");
  }
  return {
    status: status as BotPresenceConfig["status"],
    activityType: activityType as BotPresenceConfig["activityType"],
    activity,
  };
}

export async function saveConfig(guildId: string, config: unknown) {
  const updatedAt = new Date();
  await db
    .insert(serverConfigsTable)
    .values({ guildId, config, updatedAt })
    .onConflictDoUpdate({
      target: serverConfigsTable.guildId,
      set: { config, updatedAt },
    });
  return readConfig(guildId);
}

export async function ensureTemplates(guildId: string): Promise<EmbedTemplate[]> {
  const rows = await db
    .select()
    .from(embedTemplatesTable)
    .where(eq(embedTemplatesTable.guildId, guildId));
  const byKey = new Map(rows.map((row) => [row.templateKey, row.template as Omit<EmbedTemplate, "guildId">]));
  return Object.entries(defaultTemplates).map(([key, template]) =>
    withGuildId(guildId, { ...(template as EmbedTemplate), ...(byKey.get(key) ?? {}), key }),
  );
}

export async function addAudit(guildId: string, action: string, subject: string, actor: string | null = "panel") {
  await db.insert(auditEventsTable).values({ guildId, action, subject, actor });
}

router.get("/discord/guilds", async (req: Request, res: Response) => {
  try {
    const guilds = await discordFetch<Array<{ id: string; name: string; icon: string | null; approximate_member_count?: number }>>(
      "/users/@me/guilds?with_counts=true",
    );
    res.json(
      ListDiscordGuildsResponse.parse(
        guilds.map((guild) => ({
          id: guild.id,
          name: guild.name,
          icon: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : null,
          memberCount: guild.approximate_member_count ?? 0,
        })),
      ),
    );
  } catch (error) {
    req.log.error({ err: error }, "Unable to list Discord guilds");
    res.status(502).json({ error: "Unable to reach Discord with the configured bot token" });
  }
});

router.get("/discord/guilds/:guildId/summary", async (req, res) => {
  const parsed = GetDiscordGuildSummaryParams.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Invalid guild id" });
  try {
    const { guildId } = parsed.data;
    const [guild, channels, roles, recentActions] = await Promise.all([
      discordFetch<{ id: string; name: string; icon: string | null; approximate_member_count?: number }>(`/guilds/${guildId}?with_counts=true`),
      discordFetch<Array<unknown>>(`/guilds/${guildId}/channels`),
      discordFetch<Array<unknown>>(`/guilds/${guildId}/roles`),
      db.select().from(auditEventsTable).where(eq(auditEventsTable.guildId, guildId)).orderBy(desc(auditEventsTable.createdAt)).limit(6),
    ]);
    const config = await readConfig(guildId);
    return res.json({
      guild: {
        id: guild.id,
        name: guild.name,
        icon: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : null,
        memberCount: guild.approximate_member_count ?? 0,
      },
      channelCount: channels.length,
      roleCount: roles.length,
      enabledModules: [
        config.welcome.enabled && "Welcome",
        config.tickets.enabled && "Ticketing",
        config.antiNuke.enabled && "Anti-nuke",
      ].filter(Boolean),
      recentActions: recentActions.map((event) => ({
        id: String(event.id),
        action: event.action,
        subject: event.subject,
        actor: event.actor,
        createdAt: event.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    req.log.error({ err: error }, "Unable to load Discord guild summary");
    return res.status(502).json({ error: "Unable to load server summary" });
  }
});

router.get("/discord/guilds/:guildId/config", async (req, res) => {
  const parsed = GetGuildConfigParams.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Invalid guild id" });
  try {
    return res.json(await readConfig(parsed.data.guildId));
  } catch (error) {
    req.log.error({ err: error }, "Unable to load server config");
    return res.status(500).json({ error: "Unable to load server configuration" });
  }
});

router.put("/discord/guilds/:guildId/config", async (req, res) => {
  const params = UpdateGuildConfigParams.safeParse(req.params);
  const body = UpdateGuildConfigBody.safeParse(req.body);
  if (!params.success || !body.success) return res.status(400).json({ error: "Invalid configuration" });
  try {
    return res.json(await saveConfig(params.data.guildId, body.data));
  } catch (error) {
    req.log.error({ err: error }, "Unable to save server config");
    return res.status(500).json({ error: "Unable to save server configuration" });
  }
});

router.get("/discord/guilds/:guildId/templates", async (req, res) => {
  const parsed = ListGuildTemplatesParams.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Invalid guild id" });
  try {
    return res.json(await ensureTemplates(parsed.data.guildId));
  } catch (error) {
    req.log.error({ err: error }, "Unable to load embed templates");
    return res.status(500).json({ error: "Unable to load embed templates" });
  }
});

router.put("/discord/guilds/:guildId/templates/:templateKey", async (req, res) => {
  const params = UpdateGuildTemplateParams.safeParse(req.params);
  const body = UpdateGuildTemplateBody.safeParse(req.body);
  if (!params.success || !body.success) return res.status(400).json({ error: "Invalid template" });
  try {
    const template = { ...body.data, key: params.data.templateKey };
    await db
      .insert(embedTemplatesTable)
      .values({ guildId: params.data.guildId, templateKey: params.data.templateKey, template, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [embedTemplatesTable.guildId, embedTemplatesTable.templateKey],
        set: { template, updatedAt: new Date() },
      });
    return res.json(withGuildId(params.data.guildId, template));
  } catch (error) {
    req.log.error({ err: error }, "Unable to save embed template");
    return res.status(500).json({ error: "Unable to save embed template" });
  }
});

router.post("/discord/guilds/:guildId/templates/:templateKey/send", async (req, res) => {
  const params = SendGuildTemplateParams.safeParse(req.params);
  const body = SendGuildTemplateBody.safeParse(req.body);
  if (!params.success || !body.success) return res.status(400).json({ error: "Invalid send request" });
  try {
    const templates = await ensureTemplates(params.data.guildId);
    const template = templates.find((item) => item.key === params.data.templateKey);
    if (!template) return res.status(404).json({ error: "Template not found" });
    const payload = await discordFetch<{ id: string }>(`/channels/${body.data.channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: template.content || undefined,
        embeds: [{
          title: template.name,
          description: template.description,
          color: hexToInt(template.color),
          fields: template.fields.map((field: EmbedField) => ({ name: field.name, value: field.value, inline: field.inline })),
          footer: template.footer ? { text: template.footer } : undefined,
        }],
      }),
    });
    await addAudit(params.data.guildId, `sent_${params.data.templateKey}`, body.data.channelId);
    return res.json({ id: payload.id, channelId: body.data.channelId });
  } catch (error) {
    req.log.error({ err: error }, "Unable to send embed template");
    return res.status(502).json({ error: "Discord rejected the embed send request" });
  }
});

router.post("/discord/guilds/:guildId/moderation/actions", async (req, res) => {
  const params = ExecuteModerationActionParams.safeParse(req.params);
  const body = ExecuteModerationActionBody.safeParse(req.body);
  if (!params.success || !body.success) return res.status(400).json({ error: "Invalid moderation action" });
  try {
    const { guildId } = params.data;
    const { action, userId, reason, durationMinutes } = body.data;
    const safeReason = reason?.slice(0, 450) || "Moderation Panel action";
    if (action === "ban") {
      await discordFetch(`/guilds/${guildId}/bans/${userId}`, { method: "PUT", headers: { "X-Audit-Log-Reason": encodeURIComponent(safeReason) }, body: JSON.stringify({ delete_message_seconds: 604800 }) });
    } else if (action === "kick") {
      await discordFetch(`/guilds/${guildId}/members/${userId}`, { method: "DELETE", headers: { "X-Audit-Log-Reason": encodeURIComponent(safeReason) } });
    } else if (action === "timeout" || action === "untimeout") {
      const until = action === "timeout" ? new Date(Date.now() + (durationMinutes ?? 60) * 60_000).toISOString() : null;
      await discordFetch(`/guilds/${guildId}/members/${userId}`, { method: "PATCH", headers: { "X-Audit-Log-Reason": encodeURIComponent(safeReason) }, body: JSON.stringify({ communication_disabled_until: until }) });
    } else {
      const config = await readConfig(guildId);
      const until = action === "mute"
        ? new Date(Date.now() + (durationMinutes ?? config.moderation.defaultTimeoutHours * 60) * 60_000).toISOString()
        : null;
      await discordFetch(`/guilds/${guildId}/members/${userId}`, {
        method: "PATCH",
        headers: { "X-Audit-Log-Reason": encodeURIComponent(safeReason) },
        body: JSON.stringify({ communication_disabled_until: until }),
      });
    }
    await addAudit(guildId, action, userId);
    return res.json({ success: true, action, userId, message: `${action} applied to ${userId}` } satisfies ModerationResult);
  } catch (error) {
    req.log.error({ err: error }, "Unable to execute moderation action");
    return res.status(502).json({ error: "Discord rejected the moderation action" });
  }
});

router.get("/discord/guilds/:guildId/audit", async (req, res) => {
  const parsed = ListGuildAuditEventsParams.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Invalid guild id" });
  try {
    const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.guildId, parsed.data.guildId)).orderBy(desc(auditEventsTable.createdAt)).limit(30);
    return res.json(events.map((event) => ({
      id: String(event.id),
      action: event.action,
      subject: event.subject,
      actor: event.actor,
      createdAt: event.createdAt.toISOString(),
    })));
  } catch (error) {
    req.log.error({ err: error }, "Unable to load audit events");
    return res.status(500).json({ error: "Unable to load audit events" });
  }
});

export default router;