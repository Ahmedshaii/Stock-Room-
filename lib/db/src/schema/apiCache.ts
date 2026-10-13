import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const apiCacheTable = pgTable("api_cache", {
  cacheKey: text("cache_key").primaryKey(),
  responseData: jsonb("response_data").notNull(),
  cachedAt: timestamp("cached_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type ApiCache = typeof apiCacheTable.$inferSelect;
