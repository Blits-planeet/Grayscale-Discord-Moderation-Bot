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