import { Router, type IRouter } from "express";
import {
  GetStockHistoryQueryParams,
  GetStockHistoryResponse,
} from "@workspace/api-zod";
import {
  buildCacheKey,
  getCached,
  setCache,
} from "../lib/cache";

const router: IRouter = Router();
const RSI_WINDOW = 14;
const SMA_SHORT_WINDOW = 50;
const SMA_LONG_WINDOW = 200;

type YahooChartResult = {
  meta?: {
    currency?: string;
    exchangeName?: string;
    symbol?: string;
  };
  timestamp?: number[];
  indicators?: {
    quote?: Array<{
      open?: Array<number | null>;
      high?: Array<number | null>;
      low?: Array<number | null>;
      close?: Array<number | null>;
      volume?: Array<number | null>;
    }>;
  };
};

type YahooChartPayload = {
  chart?: {
    result?: YahooChartResult[] | null;
    error?: { description?: string; code?: string } | null;
  };
};

type PriceBar = {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
};

function startForPeriod(period: "1y" | "3y" | "5y"): Date {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCFullYear(start.getUTCFullYear() - Number.parseInt(period, 10));
  return start;
}

function toFiniteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rollingMean(values: number[], index: number, window: number): number | null {
  if (index + 1 < window) return null;
  let total = 0;
  for (let position = index - window + 1; position <= index; position += 1) {
    total += values[position]!;
  }
  return total / window;
}

function calculateWilderRsi(values: number[], window: number): Array<number | null> {
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

function toHistoryRows(result: YahooChartResult): PriceBar[] {
  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0];
  if (!quote?.close) return [];

  return timestamps.flatMap((timestamp, index) => {
    const close = toFiniteOrNull(quote.close?.[index]);
    if (close === null) return [];

    return [{
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      open: toFiniteOrNull(quote.open?.[index]),
      high: toFiniteOrNull(quote.high?.[index]),
      low: toFiniteOrNull(quote.low?.[index]),
      close,
      volume: toFiniteOrNull(quote.volume?.[index]),
    }];
  });
}

function buildHistoryPayload(
  symbol: string,
  period: "1y" | "3y" | "5y",
  result: YahooChartResult,
) {
  const bars = toHistoryRows(result);
  if (bars.length === 0) return null;

  const closes = bars.map((bar) => bar.close);
  const rsiValues = calculateWilderRsi(closes, RSI_WINDOW);
  const rows = bars.map((bar, index) => ({
    ...bar,
    sma50: rollingMean(closes, index, SMA_SHORT_WINDOW),
    sma200: rollingMean(closes, index, SMA_LONG_WINDOW),
    rsi14: rsiValues[index] ?? null,
  }));

  const latest = rows[rows.length - 1]!;
  const previous = rows[rows.length - 2] ?? latest;
  const changePercent =
    previous.close === 0
      ? 0
      : ((latest.close - previous.close) / previous.close) * 100;

  return GetStockHistoryResponse.parse({
    symbol: result.meta?.symbol ?? symbol,
    currency: result.meta?.currency ?? null,
    exchangeName: result.meta?.exchangeName ?? null,
    period,
    updatedAt: new Date().toISOString(),
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
}

router.get("/stocks", async (req, res): Promise<void> => {
  const parsed = GetStockHistoryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid ticker and choose a supported period." });
    return;
  }

  const symbol = parsed.data.symbol.toUpperCase();
  const period = parsed.data.period ?? "3y";
  const endDate = new Date();
  const cacheKey = buildCacheKey("stock-history-v2", {
    symbol,
    period,
    endDate: endDate.toISOString(),
  });

  const cached = await getCached(cacheKey);
  if (cached !== null) {
    res.json(GetStockHistoryResponse.parse(cached));
    return;
  }

  const period1 = Math.floor(startForPeriod(period).getTime() / 1000);
  const period2 = Math.floor(endDate.getTime() / 1000) + 86_400;
  const upstreamUrl = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
  );
  upstreamUrl.searchParams.set("period1", String(period1));
  upstreamUrl.searchParams.set("period2", String(period2));
  upstreamUrl.searchParams.set("interval", "1d");
  upstreamUrl.searchParams.set("events", "history");

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0 (compatible; StockAnalysisDashboard/1.0)",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    req.log.warn({ err: error, symbol }, "Market data request failed");
    res.status(502).json({ error: "Market data is temporarily unavailable. Try again shortly." });
    return;
  }

  if (!upstreamResponse.ok) {
    req.log.warn(
      { statusCode: upstreamResponse.status, symbol },
      "Market data provider returned an error",
    );
    if (upstreamResponse.status === 404) {
      res.status(404).json({ error: "No history was found for this ticker." });
      return;
    }
    res.status(502).json({ error: "Market data is temporarily unavailable. Try again shortly." });
    return;
  }

  let payload: YahooChartPayload;
  try {
    payload = (await upstreamResponse.json()) as YahooChartPayload;
  } catch (error) {
    req.log.warn({ err: error, symbol }, "Market data response was invalid");
    res.status(502).json({ error: "Market data provider returned an unreadable response." });
    return;
  }

  const result = payload.chart?.result?.[0];
  if (!result) {
    const providerError = payload.chart?.error;
    if (providerError) {
      res.status(404).json({ error: providerError.description ?? "No history was found for this ticker." });
      return;
    }
    res.status(404).json({ error: "No history was found for this ticker." });
    return;
  }

  const data = buildHistoryPayload(symbol, period, result);
  if (!data) {
    res.status(404).json({ error: "No daily price history was found for this ticker." });
    return;
  }

  await setCache(cacheKey, data);
  res.json(data);
});

export default router;
