const cache = new Map<string, { data: unknown; cachedAt: number }>();

const CACHE_TTL_MS = 5 * 60 * 1000;

function normalizeParams(params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).sort(([a], [b]) => a.localeCompare(b))
  );
}

export function buildCacheKey(
  endpoint: string,
  params: Record<string, string>
): string {
  return `${endpoint}:${JSON.stringify(normalizeParams(params))}`;
}

export async function getCached(key: string): Promise<unknown | null> {
  const row = cache.get(key);
  if (!row || Date.now() - row.cachedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return row.data;
}

export async function setCache(key: string, data: unknown): Promise<void> {
  cache.set(key, { data, cachedAt: Date.now() });
}
