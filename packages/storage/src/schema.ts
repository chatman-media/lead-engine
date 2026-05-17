import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  telegramId: integer("telegram_id").notNull().unique(),
  username: varchar("username", { length: 64 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  styleSlug: varchar("style_slug", { length: 128 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const leads = pgTable("leads", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const skillOutcomes = pgTable("skill_outcomes", {
  id: serial("id").primaryKey(),
  skillSlug: varchar("skill_slug", { length: 128 }).notNull(),
  styleSlug: varchar("style_slug", { length: 128 }).notNull(),
  leadId: integer("lead_id")
    .notNull()
    .references(() => leads.id),
  outcome: varchar("outcome", { length: 8 }).notNull(), // won|lost|draw
  source: varchar("source", { length: 32 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const styleRatings = pgTable("style_ratings", {
  id: serial("id").primaryKey(),
  styleId: integer("style_id").notNull().unique(),
  rating: integer("rating").notNull().default(1500),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const skills = pgTable("skills", {
  id: serial("id").primaryKey(),
  styleId: integer("style_id").notNull(),
  slug: varchar("slug", { length: 128 }).notNull(),
  family: varchar("family", { length: 64 }).notNull(),
  displayName: varchar("display_name", { length: 255 }).notNull(),
  promptFragment: text("prompt_fragment").notNull(),
  applicableStages: jsonb("applicable_stages").$type<string[]>().notNull().default([]),
  isEnabled: integer("is_enabled").notNull().default(1),
});

export const selfPlayMatches = pgTable("self_play_matches", {
  id: serial("id").primaryKey(),
  styleSlug: varchar("style_slug", { length: 128 }).notNull(),
  personaSlug: varchar("persona_slug", { length: 128 }).notNull(),
  outcome: varchar("outcome", { length: 8 }).notNull(),
  skills: jsonb("skills").$type<string[]>().notNull().default([]),
  judgeReason: text("judge_reason"),
  transcript: jsonb("transcript")
    .$type<Array<{ role: string; text: string }>>()
    .notNull()
    .default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const pairwiseMatches = pgTable("pairwise_matches", {
  id: serial("id").primaryKey(),
  matchAId: integer("match_a_id").notNull(),
  matchBId: integer("match_b_id").notNull(),
  styleASlug: varchar("style_a_slug", { length: 128 }).notNull(),
  styleBSlug: varchar("style_b_slug", { length: 128 }).notNull(),
  personaSlug: varchar("persona_slug", { length: 128 }).notNull(),
  winner: varchar("winner", { length: 8 }).notNull(), // a|b|draw
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const shadowEvaluations = pgTable("shadow_evaluations", {
  id: serial("id").primaryKey(),
  status: varchar("status", { length: 16 }).notNull().default("running"),
  decision: varchar("decision", { length: 16 }),
  totalPairs: integer("total_pairs").notNull().default(0),
  bWins: integer("b_wins").notNull().default(0),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
