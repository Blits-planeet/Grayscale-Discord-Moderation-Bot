import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const serverConfigsTable = pgTable("server_configs", {
  guildId: text("guild_id").primaryKey(),
  config: jsonb("config").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const embedTemplatesTable = pgTable(
  "embed_templates",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    guildId: text("guild_id").notNull(),
    templateKey: text("template_key").notNull(),
    template: jsonb("template").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    guildTemplateUnique: unique("guild_template_unique").on(
      table.guildId,
      table.templateKey,
    ),
  }),
);

export const auditEventsTable = pgTable("audit_events", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  guildId: text("guild_id").notNull(),
  action: text("action").notNull(),
  subject: text("subject").notNull(),
  actor: text("actor"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const giveawaysTable = pgTable("giveaways", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id").notNull(),
  prize: text("prize").notNull(),
  winnerCount: integer("winner_count").notNull().default(1),
  requiredRoleId: text("required_role_id"),
  requiredRoleIds: jsonb("required_role_ids").notNull().default([]),
  minAccountAgeDays: integer("min_account_age_days").notNull().default(7),
  minServerAgeDays: integer("min_server_age_days").notNull().default(0),
  claimDeadlineHours: integer("claim_deadline_hours").notNull().default(24),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  claimDeadlineAt: timestamp("claim_deadline_at", { withTimezone: true }),
  status: text("status").notNull().default("active"),
  participantIds: jsonb("participant_ids").notNull().default([]),
  winnerIds: jsonb("winner_ids").notNull().default([]),
  claimedWinnerIds: jsonb("claimed_winner_ids").notNull().default([]),
  rerollCount: integer("reroll_count").notNull().default(0),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const inviteMemberLinksTable = pgTable("invite_member_links", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  guildId: text("guild_id").notNull(),
  memberId: text("member_id").notNull(),
  inviterId: text("inviter_id").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
}, (table) => ({
  guildMemberUnique: unique("invite_member_links_guild_member_unique").on(table.guildId, table.memberId),
}));