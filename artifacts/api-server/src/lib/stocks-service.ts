import { GetStockHistoryResponse } from "@workspace/api-zod";

export type StockPeriod = "1y" | "3y" | "5y" | "7y";

type JsonRecord = Record<string, unknown>;

type YahooChartResult = JsonRecord & {
  meta?: JsonRecord;
};

type PriceBar = {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
};

type HistoryCache = {
  key: string;
  read: () => Promise<unknown | null>;
  write: (data: unknown) => Promise<void>;
};

type StockHistoryDependencies = {
  fetcher?: (input: URL, init: RequestInit) => Promise<Response>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  cache?: HistoryCache;
  onCacheFailure?: (operation: "read" | "write", error: unknown) => void;
};

const RSI_WINDOW = 14;
const SMA_SHORT_WINDOW = 50;
const SMA_LONG_WINDOW = 200;
const MAX_PROVIDER_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 200;
const RETRY_MAX_DELAY_MS = 1_000;
const PROVIDER_TIMEOUT_MS = 10_000;
const TEMPORARY_PROVIDER_ERROR =
  "Market data is temporarily unavailable. Try again shortly.";

export class StockDataError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "StockDataError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function toFiniteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function startForPeriod(period: StockPeriod, now = new Date()): Date {
  const start = new Date(now);
  const targetYear = start.getUTCFullYear() - Number.parseInt(period, 10);
  const month = start.getUTCMonth();
  const day = start.getUTCDate();
  start.setUTCDate(1);
  start.setUTCFullYear(targetYear);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetYear, month + 1, 0),
  ).getUTCDate();
  start.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return start;
}

export function rollingMean(
  values: number[],
  index: number,
  window: number,
): number | null {
  if (index + 1 < window) return null;
  let total = 0;
  for (let position = index - window + 1; position <= index; position += 1) {
    total += values[position]!;
  }
  return total / window;
}

export function calculateWilderRsi(
  values: number[],
  window: number,
): Array<number | null> {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= window) return output;

  let averageGain = 0;
  let averageLoss = 0;

  for (let index = 1; index <= window; index += 1) {
    const change = values[index]! - values[index - 1]!;
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }

  averageGain /= window;
  averageLoss /= window;

  const getRsi = (): number => {
    if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
    if (averageGain === 0) return 0;
    const relativeStrength = averageGain / averageLoss;
    return 100 - 100 / (1 + relativeStrength);
  };

  output[window] = getRsi();

  for (let index = window + 1; index < values.length; index += 1) {
    const change = values[index]! - values[index - 1]!;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = (averageGain * (window - 1) + gain) / window;
    averageLoss = (averageLoss * (window - 1) + loss) / window;
    output[index] = getRsi();
  }

  return output;
}

function getExchangeTimezone(meta: JsonRecord | undefined): string {
  const exchangeTimezone = toStringOrNull(meta?.exchangeTimezoneName);
  if (exchangeTimezone) return exchangeTimezone;

  const timezone = toStringOrNull(meta?.timezone);
  if (timezone && (timezone.includes("/") || /^(utc|gmt)$/i.test(timezone))) {
    return timezone;
  }

  return "UTC";
}

function formatSessionDate(timestamp: unknown, formatter: Intl.DateTimeFormat): string | null {
  if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)) return null;
  const date = new Date(timestamp * 1_000);
  if (!Number.isFinite(date.getTime())) return null;

  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const year = values.year;
  const month = values.month;
  const day = values.day;
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

function getSessionDateFormatter(meta: JsonRecord | undefined): Intl.DateTimeFormat {
  const timezone = getExchangeTimezone(meta);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    throw new StockDataError(
      "Yahoo Finance returned an invalid exchange timezone.",
      502,
    );
  }
}

function toHistoryRows(result: YahooChartResult): PriceBar[] {
  const timestamps = result.timestamp;
  const indicators = result.indicators;
  const quotes = isRecord(indicators) ? indicators.quote : null;
  const quote = Array.isArray(quotes) ? quotes[0] : null;
  const closes = isRecord(quote) ? quote.close : null;
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) {
    throw new StockDataError(
      "Yahoo Finance returned malformed market data.",
      502,
    );
  }

  const formatter = getSessionDateFormatter(result.meta);

  const getValueAt = (key: string, index: number): unknown => {
    const values = isRecord(quote) ? quote[key] : null;
    return Array.isArray(values) ? values[index] : null;
  };

  return timestamps.flatMap((timestamp, index) => {
    const date = formatSessionDate(timestamp, formatter);
    const close = toFiniteOrNull(closes[index]);
    if (date === null || close === null) return [];

    return [{
      date,
      open: toFiniteOrNull(getValueAt("open", index)),
      high: toFiniteOrNull(getValueAt("high", index)),
      low: toFiniteOrNull(getValueAt("low", index)),
      close,
      volume: toFiniteOrNull(getValueAt("volume", index)),
    }];
  });
}

export function buildHistoryPayload(
  symbol: string,
  period: StockPeriod,
  result: YahooChartResult,
  updatedAt = new Date(),
) {
  const bars = toHistoryRows(result);
  if (bars.length === 0) return null;

  const sessionDateFormatter = getSessionDateFormatter(result.meta);
  const periodStart = startForPeriod(period, updatedAt);
  const periodStartDate = formatSessionDate(
    Math.floor(periodStart.getTime() / 1_000),
    sessionDateFormatter,
  );
  if (!periodStartDate) {
    throw new StockDataError(
      "Yahoo Finance returned an invalid historical date.",
      502,
    );
  }

  const closes = bars.map((bar) => bar.close);
  const rsiValues = calculateWilderRsi(closes, RSI_WINDOW);
  const allRows = bars.map((bar, index) => ({
    ...bar,
    sma50: rollingMean(closes, index, SMA_SHORT_WINDOW),
    sma200: rollingMean(closes, index, SMA_LONG_WINDOW),
    rsi14: rsiValues[index] ?? null,
  }));
  const rows = allRows.filter((bar) => bar.date >= periodStartDate);
  if (rows.length === 0) return null;

  const latest = rows[rows.length - 1]!;
  const previous = rows[rows.length - 2] ?? latest;
  const changePercent =
    previous.close === 0
      ? 0
      : ((latest.close - previous.close) / previous.close) * 100;

  const response = GetStockHistoryResponse.safeParse({
    symbol: toStringOrNull(result.meta?.symbol) ?? symbol,
    currency: toStringOrNull(result.meta?.currency),
    exchangeName: toStringOrNull(result.meta?.exchangeName),
    period,
    updatedAt: updatedAt.toISOString(),
    latest: {
      date: latest.date,
      close: latest.close,
      previousClose: previous.close,
      changePercent,
      sma50: latest.sma50,
      sma200: latest.sma200,
      rsi14: latest.rsi14,
    },
    rows,
  });

  if (!response.success) {
    throw new StockDataError(
      "Yahoo Finance returned malformed market data.",
      502,
    );
  }
  return response.data;
}

type StockHistoryResponse = NonNullable<
  ReturnType<typeof buildHistoryPayload>
>;

const inFlightHistories = new Map<string, Promise<StockHistoryResponse>>();

function classifyProviderError(error: JsonRecord): StockDataError {
  const code = (toStringOrNull(error.code) ?? "").toLowerCase();
  const description = (toStringOrNull(error.description) ?? "").toLowerCase();
  const providerText = `${code} ${description}`;

  if (
    /too many requests|rate limit|internal server|service unavailable|gateway|(^|\D)50[0-9](\D|$)/.test(
      providerText,
    )
  ) {
    return new StockDataError(TEMPORARY_PROVIDER_ERROR, 502, true);
  }

  if (
    /not found|bad request|no data|invalid symbol|delisted|(^|\D)404(\D|$)/.test(
      providerText,
    )
  ) {
    return new StockDataError("No history was found for this ticker.", 404);
  }

  return new StockDataError(
    "Yahoo Finance could not process this market-data request.",
    502,
  );
}

function parseYahooPayload(payload: unknown): {
  result: YahooChartResult | null;
  error: JsonRecord | null;
} {
  if (!isRecord(payload) || !isRecord(payload.chart)) {
    throw new StockDataError(
      "Yahoo Finance returned an unreadable response.",
      502,
    );
  }

  const chart = payload.chart;
  const providerError = isRecord(chart.error) ? chart.error : null;
  if (
    chart.result === null ||
    chart.result === undefined ||
    (Array.isArray(chart.result) && chart.result.length === 0)
  ) {
    return { result: null, error: providerError };
  }

  if (!Array.isArray(chart.result) || !isRecord(chart.result[0])) {
    throw new StockDataError(
      "Yahoo Finance returned malformed market data.",
      502,
    );
  }
  return { result: chart.result[0], error: providerError };
}

function getRetryAfterMs(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function retryDelay(attempt: number, retryAfterMs?: number): number {
  const exponential = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(
    RETRY_MAX_DELAY_MS,
    Math.max(exponential, retryAfterMs ?? 0),
  );
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchYahooResult(
  url: URL,
  fetcher: (input: URL, init: RequestInit) => Promise<Response>,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<YahooChartResult> {
  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetcher(url, {
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0 (compatible; StockAnalysisDashboard/1.0)",
        },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });

      if (response.status === 429 || response.status >= 500) {
        throw new StockDataError(
          TEMPORARY_PROVIDER_ERROR,
          502,
          true,
          getRetryAfterMs(response),
        );
      }

      if (!response.ok) {
        if (response.status === 400 || response.status === 404) {
          throw new StockDataError(
            "No history was found for this ticker.",
            404,
          );
        }
        throw new StockDataError(
          "Yahoo Finance rejected this market-data request.",
          502,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new StockDataError(
          "Yahoo Finance returned an unreadable response.",
          502,
        );
      }

      const parsed = parseYahooPayload(payload);
      if (!parsed.result) {
        if (parsed.error) throw classifyProviderError(parsed.error);
        throw new StockDataError(
          "No history was found for this ticker.",
          404,
        );
      }
      return parsed.result;
    } catch (error) {
      const retryable =
        (error instanceof StockDataError && error.retryable) ||
        !(error instanceof StockDataError);
      if (!retryable) throw error;

      if (attempt === MAX_PROVIDER_ATTEMPTS) {
        throw new StockDataError(TEMPORARY_PROVIDER_ERROR, 502);
      }
      await sleep(retryDelay(attempt, response && getRetryAfterMs(response)));
    }
  }

  throw new StockDataError(TEMPORARY_PROVIDER_ERROR, 502);
}

export async function getStockHistory(
  symbol: string,
  period: StockPeriod,
  dependencies: StockHistoryDependencies = {},
): Promise<StockHistoryResponse> {
  const requestKey =
    dependencies.cache?.key ?? `${symbol.toUpperCase()}:${period}`;
  const existing = inFlightHistories.get(requestKey);
  if (existing) return existing;

  const request = loadStockHistory(symbol, period, dependencies);
  inFlightHistories.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (inFlightHistories.get(requestKey) === request) {
      inFlightHistories.delete(requestKey);
    }
  }
}

async function loadStockHistory(
  symbol: string,
  period: StockPeriod,
  dependencies: StockHistoryDependencies,
): Promise<StockHistoryResponse> {
  const now = dependencies.now?.() ?? new Date();
  const cache = dependencies.cache;
  if (cache) {
    try {
      const cached = await cache.read();
      if (cached !== null) {
        const parsedCache = GetStockHistoryResponse.safeParse(cached);
        if (parsedCache.success) return parsedCache.data;
        dependencies.onCacheFailure?.("read", parsedCache.error);
      }
    } catch (error) {
      dependencies.onCacheFailure?.("read", error);
    }
  }

  const url = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
  );
  const periodStart = startForPeriod(period, now);
  const indicatorLookbackStart = startForPeriod("1y", periodStart);
  url.searchParams.set(
    "period1",
    String(Math.floor(indicatorLookbackStart.getTime() / 1_000)),
  );
  url.searchParams.set("period2", String(Math.floor(now.getTime() / 1_000) + 86_400));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "history");

  const result = await fetchYahooResult(
    url,
    dependencies.fetcher ?? fetch,
    dependencies.sleep ?? defaultSleep,
  );
  const data = buildHistoryPayload(symbol, period, result, now);
  if (!data) {
    throw new StockDataError(
      "No daily price history was found for this ticker.",
      404,
    );
  }

  if (cache) {
    try {
      await cache.write(data);
    } catch (error) {
      dependencies.onCacheFailure?.("write", error);
    }
  }
  return data;
}
