import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const notificationChannelLinks = sqliteTable("notification_channel_links", {
    voiceChannelId: text().primaryKey(),
    guildId: text().notNull(),
    notifChannelId: text().notNull(),
    roleId: text().notNull(),
});

export const scribeLinks = sqliteTable("scribe_channel_links", {
    voiceChannelId: text().primaryKey(),
    guildId: text().notNull(),
    scribeChannelId: text().notNull(),
});

export const scribeConsent = sqliteTable("scribeConsent", {
    voiceChannelId: text().notNull(),
    guildId: text().notNull(),
    userId: text().notNull().primaryKey(),
});


