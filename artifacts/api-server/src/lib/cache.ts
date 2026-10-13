import { apiCacheTable, db } from "@workspace/db";
import { eq } from "drizzle-orm";

const CACHE_TTL_MS = 5 * 60 * 1000;

function normalizeParams(
  params: Record<string, string>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  const now = Date.now();
  const endDatePattern = /date|time|until|end|to|before/i;

  for (const [key, value] of Object.entries(params)) {
    if (endDatePattern.test(key)) {
      const timestamp = new Date(value).getTime();
      if (!Number.isNaN(timestamp) && Math.abs(timestamp - now) < CACHE_TTL_MS) {
        const floored = timestamp - (timestamp % CACHE_TTL_MS);
        normalized[key] = new Date(floored).toISOString();
        continue;
      }
    }
    normalized[key] = value;
  }

  return normalized;
}

export function buildCacheKey(
  endpoint: string,
  params: Record<string, string>,
): string {
  const sorted = Object.fromEntries(
    Object.entries(normalizeParams(params)).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return `${endpoint}:${JSON.stringify(sorted)}`;
}

export async function getCached(key: string): Promise<unknown | null> {
  const [row] = await db
    .select()
    .from(apiCacheTable)
    .where(eq(apiCacheTable.cacheKey, key));

  if (!row || Date.now() - row.cachedAt.getTime() > CACHE_TTL_MS) {
    return null;
  }

  return row.responseData;
}

export async function setCache(key: string, data: unknown): Promise<void> {
  await db
    .insert(apiCacheTable)
    .values({ cacheKey: key, responseData: data, cachedAt: new Date() })
    .onConflictDoUpdate({
      target: apiCacheTable.cacheKey,
      set: { responseData: data, cachedAt: new Date() },
    });
}
