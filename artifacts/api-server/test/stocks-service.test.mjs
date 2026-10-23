import assert from "node:assert/strict";
import test from "node:test";
import {
  GetStockHistoryQueryParams,
  GetStockSearchQueryParams,
} from "@workspace/api-zod";
import {
  buildHistoryPayload,
  calculateWilderRsi,
  getStockHistory,
  rollingMean,
  searchStockSymbols,
  startForPeriod,
  StockDataError,
} from "../src/lib/stocks-service.ts";

const FIXED_NOW = new Date("2026-10-19T12:00:00.000Z");

function makeResult({
  symbol = "TEST",
  timezone = "UTC",
  timestamps = [Date.parse("2026-10-16T00:00:00.000Z") / 1_000],
  closes = [100],
  ...quoteValues
} = {}) {
  return {
    meta: {
      symbol,
      currency: "USD",
      exchangeName: "Test Exchange",
      exchangeTimezoneName: timezone,
    },
    timestamp: timestamps,
    indicators: {
      quote: [{
        close: closes,
        ...quoteValues,
      }],
    },
  };
}

function yahooResponse(result, error = null) {
  return new Response(JSON.stringify({
    chart: {
      result: result ? [result] : null,
      error,
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function yahooSearchResponse(quotes) {
  return new Response(JSON.stringify({ quotes }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function singleBarFetcher(result) {
  return async () => yahooResponse(result);
}

test("SMA 50 and SMA 200 return null before a complete window and use close values", () => {
  const closes = Array.from({ length: 201 }, (_, index) => index + 1);
  assert.equal(rollingMean(closes, 48, 50), null);
  assert.equal(rollingMean(closes, 49, 50), 25.5);
  assert.equal(rollingMean(closes, 198, 200), null);
  assert.equal(rollingMean(closes, 199, 200), 100.5);
  assert.equal(rollingMean(closes, 200, 200), 101.5);
});

test("Wilder RSI handles rising, falling, flat, mixed, and insufficient close history", () => {
  assert.deepEqual(calculateWilderRsi(Array(14).fill(10), 14), Array(14).fill(null));
  assert.equal(calculateWilderRsi(Array(15).fill(10), 14)[14], 50);
  assert.equal(calculateWilderRsi(Array.from({ length: 15 }, (_, i) => 100 + i), 14)[14], 100);
  assert.equal(calculateWilderRsi(Array.from({ length: 15 }, (_, i) => 100 - i), 14)[14], 0);

  const mixed = [...Array.from({ length: 15 }, (_, i) => 100 + i), 113];
  assert.equal(calculateWilderRsi(mixed, 14)[15], 92.85714285714286);
});

test("Yahoo session dates use the exchange timezone across day boundaries", () => {
  const timestamp = Date.parse("2026-10-15T23:00:00.000Z") / 1_000;
  const sydney = buildHistoryPayload(
    "BHP.AX",
    "1y",
    makeResult({ symbol: "BHP.AX", timezone: "Australia/Sydney", timestamps: [timestamp], closes: [48.2] }),
    FIXED_NOW,
  );
  assert.equal(sydney?.rows[0]?.date, "2026-10-16");
  assert.equal(sydney?.latest.date, "2026-10-16");

  const newYork = buildHistoryPayload(
    "NYSE",
    "1y",
    makeResult({
      timezone: "America/New_York",
      timestamps: [Date.parse("2026-01-02T02:00:00.000Z") / 1_000],
    }),
    FIXED_NOW,
  );
  assert.equal(newYork?.rows[0]?.date, "2026-01-01");
});

test("invalid timestamps and null or non-finite closes are filtered without corrupting rows", () => {
  const rows = buildHistoryPayload(
    "FILTER",
    "1y",
    makeResult({
      timestamps: [
        Date.parse("2026-01-01T00:00:00.000Z") / 1_000,
        Date.parse("2026-01-02T00:00:00.000Z") / 1_000,
        "not-a-timestamp",
        1e100,
        Date.parse("2026-01-05T00:00:00.000Z") / 1_000,
      ],
      closes: [10, null, 12, 13, Number.NaN],
      open: [9, 10, 11, 12, 13],
    }),
    FIXED_NOW,
  );
  assert.deepEqual(rows?.rows.map((row) => row.close), [10]);
  assert.deepEqual(rows?.rows.map((row) => row.date), ["2026-01-01"]);
});

test("unsorted and duplicate sessions are normalized before indicator calculations", () => {
  const observations = Array.from({ length: 201 }, (_, index) => ({
    timestamp: Date.UTC(2026, 0, 1 + index) / 1_000,
    close: 100 + index,
  }));
  const finalSession = observations.at(-1);
  assert.ok(finalSession);
  observations.push(
    { timestamp: finalSession.timestamp + 60 * 60, close: 999 },
    { timestamp: finalSession.timestamp + 4 * 60 * 60, close: 301 },
    { timestamp: Date.parse("2026-10-20T00:00:00.000Z") / 1_000, close: 1e9 },
  );
  observations.reverse();

  const normalizedCloses = Array.from({ length: 200 }, (_, index) => 100 + index);
  normalizedCloses.push(301);
  const history = buildHistoryPayload(
    "NORMALIZED",
    "5y",
    makeResult({
      timestamps: observations.map(({ timestamp }) => timestamp),
      closes: observations.map(({ close }) => close),
    }),
    FIXED_NOW,
  );

  assert.equal(history?.rows.length, 201);
  assert.equal(new Set(history?.rows.map((row) => row.date)).size, 201);
  assert.deepEqual(
    history?.rows.map((row) => row.date),
    history?.rows.map((row) => row.date).slice().sort(),
  );
  assert.equal(history?.latest.close, 301);
  assert.equal(
    history?.latest.sma50,
    rollingMean(normalizedCloses, normalizedCloses.length - 1, 50),
  );
  assert.equal(
    history?.latest.sma200,
    rollingMean(normalizedCloses, normalizedCloses.length - 1, 200),
  );
  assert.equal(
    history?.latest.rsi14,
    calculateWilderRsi(normalizedCloses, 14).at(-1),
  );
  assert.equal(history?.latest.date, "2026-07-20");
});

test("missing closes are excluded without inserting zeroes into indicators", () => {
  const timestamps = Array.from(
    { length: 205 },
    (_, index) => Date.UTC(2026, 0, 1 + index) / 1_000,
  );
  const sourceCloses = Array.from({ length: 205 }, (_, index) => 100 + index);
  sourceCloses[100] = null;
  const validCloses = sourceCloses.filter((value) => value !== null);
  const history = buildHistoryPayload(
    "GAPPED",
    "5y",
    makeResult({ timestamps, closes: sourceCloses }),
    FIXED_NOW,
  );

  assert.equal(history?.rows.length, 204);
  assert.equal(history?.rows.some((row) => row.close === 0), false);
  assert.equal(
    history?.latest.sma50,
    rollingMean(validCloses, validCloses.length - 1, 50),
  );
  assert.equal(
    history?.latest.sma200,
    rollingMean(validCloses, validCloses.length - 1, 200),
  );
  assert.equal(
    history?.latest.rsi14,
    calculateWilderRsi(validCloses, 14).at(-1),
  );
  assert.equal(history?.latest.close, validCloses.at(-1));
});

test("history rows and the summary align with Yahoo closes and indicators", () => {
  const timestamps = Array.from(
    { length: 201 },
    (_, index) => Date.UTC(2024, 0, index + 1) / 1_000,
  );
  const closes = Array.from({ length: 201 }, (_, index) => index + 1);
  const history = buildHistoryPayload(
    "TEST",
    "5y",
    makeResult({ timestamps, closes }),
    FIXED_NOW,
  );

  assert.equal(history?.rows.length, 201);
  assert.equal(history?.rows[0]?.close, closes[0]);
  assert.equal(history?.rows[200]?.close, closes[200]);
  assert.equal(history?.rows[49]?.sma50, 25.5);
  assert.equal(history?.rows[199]?.sma200, 100.5);
  assert.equal(history?.latest.sma50, 176.5);
  assert.equal(history?.latest.sma200, 101.5);
  assert.equal(history?.latest.rsi14, 100);
  assert.equal(history?.latest.date, history?.rows.at(-1)?.date);
});

test("ticker validation accepts representative US and international Yahoo formats", () => {
  const symbols = ["AAPL", "BRK-B", "BHP.AX", "7203.T", "RY.TO", "^GSPC", "EURUSD=X", "BTC-USD"];
  for (const symbol of symbols) {
    assert.equal(GetStockHistoryQueryParams.safeParse({ symbol, period: "1y" }).success, true, symbol);
  }
  assert.equal(GetStockHistoryQueryParams.safeParse({ symbol: "INVALID/FORMAT" }).success, false);
  assert.equal(GetStockHistoryQueryParams.safeParse({ symbol: "AAPL", period: "10y" }).success, false);
});

test("company-name searches return matching equity names and ticker symbols", async () => {
  let requestedUrl;
  const results = await searchStockSymbols("Apple", {
    fetcher: async (url) => {
      requestedUrl = url;
      return yahooSearchResponse([
        {
          symbol: "AAPL",
          quoteType: "EQUITY",
          longname: "Apple Inc.",
          exchDisp: "NasdaqGS",
        },
        {
          symbol: "APLE",
          quoteType: "EQUITY",
          shortname: "Apple Hospitality REIT, Inc.",
          exchange: "NYS",
        },
        {
          symbol: "SMSFT=F",
          quoteType: "FUTURE",
          shortname: "Microsoft stock future",
        },
        {
          symbol: "BAD/SYMBOL",
          quoteType: "EQUITY",
          longname: "Invalid symbol result",
        },
        {
          symbol: "AAPL",
          quoteType: "EQUITY",
          longname: "Duplicate Apple result",
        },
      ]);
    },
  });

  assert.equal(requestedUrl.searchParams.get("q"), "Apple");
  assert.deepEqual(results.results, [
    { symbol: "AAPL", name: "Apple Inc.", exchange: "NasdaqGS" },
    { symbol: "APLE", name: "Apple Hospitality REIT, Inc.", exchange: "NYS" },
  ]);
});

test("ticker searches prioritize exact ticker matches for common listed stocks", async () => {
  for (const [symbol, name] of [
    ["AAPL", "Apple Inc."],
    ["MSFT", "Microsoft Corporation"],
    ["TSLA", "Tesla, Inc."],
    ["AMZN", "Amazon.com, Inc."],
  ]) {
    const results = await searchStockSymbols(symbol, {
      fetcher: async (url) => {
        assert.equal(url.searchParams.get("q"), symbol);
        return yahooSearchResponse([
          {
            symbol: "OTHER",
            quoteType: "EQUITY",
            longname: "Another public company",
          },
          { symbol, quoteType: "EQUITY", longname: name },
        ]);
      },
    });

    assert.equal(results.results[0]?.symbol, symbol);
    assert.equal(results.results[0]?.name, name);
  }
});

test("stock search rejects empty or oversized input and safely returns no matches", async () => {
  assert.equal(GetStockSearchQueryParams.safeParse({ query: "Apple" }).success, true);
  assert.equal(GetStockSearchQueryParams.safeParse({ query: "AAPL" }).success, true);
  assert.equal(GetStockSearchQueryParams.safeParse({ query: "" }).success, false);
  assert.equal(
    GetStockSearchQueryParams.safeParse({ query: "A".repeat(81) }).success,
    false,
  );
  await assert.rejects(
    searchStockSymbols("   "),
    (error) => error instanceof StockDataError && error.statusCode === 400,
  );
  await assert.rejects(
    searchStockSymbols("A".repeat(81)),
    (error) => error instanceof StockDataError && error.statusCode === 400,
  );

  const noMatches = await searchStockSymbols("NoSuchCompany", {
    fetcher: async () => yahooSearchResponse([]),
  });
  assert.deepEqual(noMatches.results, []);
});

test("stock search converts provider failures and malformed responses to safe errors", async () => {
  await assert.rejects(
    searchStockSymbols("Microsoft", {
      fetcher: async () => new Response("", { status: 503 }),
    }),
    (error) => error instanceof StockDataError && error.statusCode === 502 && /temporarily unavailable/.test(error.message),
  );
  await assert.rejects(
    searchStockSymbols("Microsoft", {
      fetcher: async () => new Response("not json", { status: 200 }),
    }),
    (error) => error instanceof StockDataError && error.statusCode === 502 && /unreadable/.test(error.message),
  );
});

test("Yahoo requests encode ticker symbols and align each period with indicator pre-roll", async () => {
  const expectedPeriodStarts = {
    "1y": "2025-10-19T12:00:00.000Z",
    "3y": "2023-10-19T12:00:00.000Z",
    "5y": "2021-10-19T12:00:00.000Z",
    "7y": "2019-10-19T12:00:00.000Z",
  };
  const symbols = ["AAPL", "BHP.AX", "7203.T", "EURUSD=X"];

  for (const [period, expectedPeriodStart] of Object.entries(expectedPeriodStarts)) {
    assert.equal(
      startForPeriod(period, FIXED_NOW).toISOString(),
      expectedPeriodStart,
    );
    const expectedFetchStart = startForPeriod(
      "1y",
      new Date(expectedPeriodStart),
    ).toISOString();
    for (const symbol of symbols) {
      let requestUrl;
      const result = makeResult({
        symbol,
        timezone: symbol.endsWith(".AX") ? "Australia/Sydney" : "UTC",
        closes: [100, 101],
        timestamps: [
          Date.parse("2026-10-15T23:00:00.000Z") / 1_000,
          Date.parse("2026-10-16T23:00:00.000Z") / 1_000,
        ],
      });
      const history = await getStockHistory(symbol, period, {
        now: () => FIXED_NOW,
        fetcher: async (url) => {
          requestUrl = url;
          return yahooResponse(result);
        },
        sleep: async () => {},
      });
      assert.equal(decodeURIComponent(requestUrl.pathname.split("/").at(-1)), symbol);
      assert.equal(requestUrl.searchParams.get("period1"), String(Date.parse(expectedFetchStart) / 1_000));
      assert.equal(
        requestUrl.searchParams.get("period2"),
        String(Math.floor(FIXED_NOW.getTime() / 1_000) + 86_400),
      );
      assert.equal(history.period, period);
      assert.equal(history.rows.length, 2);
      assert.equal(history.rows[0].close, 100);
      assert.equal(history.rows[1].close, 101);
      assert.equal(history.latest.previousClose, 100);
      assert.equal(history.latest.changePercent, 1);
    }
  }
});

test("new provider data is recalculated and the displayed summary matches its latest row", async () => {
  const timestamps = Array.from(
    { length: 201 },
    (_, index) => Date.UTC(2026, 0, 1 + index) / 1_000,
  );
  const initialCloses = Array.from(
    { length: 201 },
    (_, index) => 100 + index / 3 + Math.sin(index / 5),
  );
  const updatedCloses = [...initialCloses];
  updatedCloses[200] = updatedCloses[200] - 7;
  let providerCalls = 0;
  const fetcher = async () => {
    providerCalls += 1;
    return yahooResponse(makeResult({
      timestamps,
      closes: providerCalls === 1 ? initialCloses : updatedCloses,
    }));
  };

  const first = await getStockHistory("UPDATED", "5y", {
    now: () => FIXED_NOW,
    fetcher,
    sleep: async () => {},
  });
  const second = await getStockHistory("UPDATED", "5y", {
    now: () => FIXED_NOW,
    fetcher,
    sleep: async () => {},
  });
  const lastRow = second.rows.at(-1);

  assert.equal(providerCalls, 2);
  assert.notEqual(first.latest.close, second.latest.close);
  assert.equal(second.latest.close, updatedCloses.at(-1));
  assert.equal(second.latest.date, lastRow?.date);
  assert.equal(second.latest.close, lastRow?.close);
  assert.equal(second.latest.sma50, lastRow?.sma50);
  assert.equal(second.latest.sma200, lastRow?.sma200);
  assert.equal(second.latest.rsi14, lastRow?.rsi14);
  assert.equal(
    lastRow?.sma50,
    rollingMean(updatedCloses, updatedCloses.length - 1, 50),
  );
  assert.equal(
    lastRow?.sma200,
    rollingMean(updatedCloses, updatedCloses.length - 1, 200),
  );
  assert.equal(
    lastRow?.rsi14,
    calculateWilderRsi(updatedCloses, 14).at(-1),
  );
});

test("forced refresh bypasses stale cached prices but replaces the cache with recalculated data", async () => {
  const timestamps = Array.from(
    { length: 201 },
    (_, index) => Date.UTC(2026, 0, 1 + index) / 1_000,
  );
  const staleCloses = Array.from({ length: 201 }, (_, index) => 100 + index);
  const freshCloses = [...staleCloses];
  freshCloses[200] = 250;
  const staleData = buildHistoryPayload(
    "FRESH",
    "5y",
    makeResult({ symbol: "FRESH", timestamps, closes: staleCloses }),
    FIXED_NOW,
  );
  let cacheReads = 0;
  let cacheWrites = 0;
  let providerCalls = 0;

  const fresh = await getStockHistory("FRESH", "5y", {
    now: () => FIXED_NOW,
    forceRefresh: true,
    cache: {
      key: "forced-refresh-test",
      read: async () => {
        cacheReads += 1;
        return staleData;
      },
      write: async () => {
        cacheWrites += 1;
      },
    },
    fetcher: async () => {
      providerCalls += 1;
      return yahooResponse(makeResult({
        symbol: "FRESH",
        timestamps,
        closes: freshCloses,
      }));
    },
    sleep: async () => {},
  });

  assert.equal(cacheReads, 0);
  assert.equal(cacheWrites, 1);
  assert.equal(providerCalls, 1);
  assert.equal(fresh.latest.close, 250);
  assert.equal(
    fresh.latest.sma50,
    rollingMean(freshCloses, freshCloses.length - 1, 50),
  );
  assert.equal(
    fresh.latest.sma200,
    rollingMean(freshCloses, freshCloses.length - 1, 200),
  );
  assert.equal(
    fresh.latest.rsi14,
    calculateWilderRsi(freshCloses, 14).at(-1),
  );
});

test("cache read and write failures do not fail a valid history request", async () => {
  const cacheFailures = [];
  let providerCalls = 0;
  const history = await getStockHistory("AAPL", "1y", {
    now: () => FIXED_NOW,
    cache: {
      key: "test",
      read: async () => { throw new Error("cache unavailable"); },
      write: async () => { throw new Error("cache unavailable"); },
    },
    onCacheFailure: (operation) => cacheFailures.push(operation),
    fetcher: async () => {
      providerCalls += 1;
      return yahooResponse(makeResult());
    },
    sleep: async () => {},
  });

  assert.equal(history.latest.close, 100);
  assert.equal(providerCalls, 1);
  assert.deepEqual(cacheFailures, ["read", "write"]);
});

test("invalid cached responses are ignored and replaced with valid provider data", async () => {
  let providerCalls = 0;
  const failures = [];
  const history = await getStockHistory("AAPL", "3y", {
    now: () => FIXED_NOW,
    cache: {
      key: "test",
      read: async () => ({ unexpected: true }),
      write: async () => {},
    },
    onCacheFailure: (operation) => failures.push(operation),
    fetcher: async () => {
      providerCalls += 1;
      return yahooResponse(makeResult());
    },
    sleep: async () => {},
  });

  assert.equal(history.latest.close, 100);
  assert.equal(providerCalls, 1);
  assert.deepEqual(failures, ["read"]);
});

test("transient network errors, HTTP 429, and 5xx responses retry with bounded backoff", async () => {
  for (const { failure, expectedWaits } of [
    { failure: () => { throw new TypeError("network disconnected"); }, expectedWaits: [200, 400] },
    { failure: () => new Response("", { status: 429, headers: { "retry-after": "20" } }), expectedWaits: [1_000, 1_000] },
    { failure: () => new Response("", { status: 503 }), expectedWaits: [200, 400] },
  ]) {
    let calls = 0;
    const waits = [];
    const history = await getStockHistory("AAPL", "1y", {
      now: () => FIXED_NOW,
      fetcher: async () => {
        calls += 1;
        if (calls < 3) return failure();
        return yahooResponse(makeResult());
      },
      sleep: async (milliseconds) => waits.push(milliseconds),
    });
    assert.equal(history.latest.close, 100);
    assert.equal(calls, 3);
    assert.deepEqual(waits, expectedWaits);
  }
});

test("exhausted transient retries fail clearly and stop after three attempts", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(
    getStockHistory("AAPL", "1y", {
      fetcher: async () => {
        calls += 1;
        return new Response("", { status: 503 });
      },
      sleep: async (milliseconds) => waits.push(milliseconds),
    }),
    (error) => error instanceof StockDataError && error.statusCode === 502 && /temporarily unavailable/.test(error.message),
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [200, 400]);
});

test("invalid symbols and permanent provider failures are recoverable and not retried", async () => {
  let calls = 0;
  await assert.rejects(
    getStockHistory("NOTREAL", "1y", {
      fetcher: async () => {
        calls += 1;
        return new Response("", { status: 404 });
      },
      sleep: async () => {},
    }),
    (error) => error instanceof StockDataError && error.statusCode === 404 && /No history/.test(error.message),
  );
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(
    getStockHistory("AAPL", "1y", {
      fetcher: async () => {
        calls += 1;
        return new Response("", { status: 403 });
      },
      sleep: async () => {},
    }),
    (error) => error instanceof StockDataError && error.statusCode === 502 && /rejected/.test(error.message),
  );
  assert.equal(calls, 1);

  await assert.rejects(
    getStockHistory("NOTREAL", "1y", {
      fetcher: async () => yahooResponse(null, { code: "Not Found", description: "unknown ticker" }),
      sleep: async () => {},
    }),
    (error) => error instanceof StockDataError && error.statusCode === 404,
  );
});

test("malformed provider payloads and invalid timezones fail explicitly", async () => {
  await assert.rejects(
    getStockHistory("AAPL", "1y", {
      fetcher: async () => new Response("not json", { status: 200 }),
      sleep: async () => {},
    }),
    (error) => error instanceof StockDataError && error.statusCode === 502 && /unreadable/.test(error.message),
  );

  await assert.rejects(
    Promise.resolve().then(() => buildHistoryPayload(
      "TEST",
      "1y",
      makeResult({ timezone: "Invalid/Timezone" }),
      FIXED_NOW,
    )),
    (error) => error instanceof StockDataError && error.statusCode === 502 && /timezone/.test(error.message),
  );

  await assert.rejects(
    getStockHistory("AAPL", "1y", {
      fetcher: async () => new Response(JSON.stringify({ chart: { result: "invalid" } }), { status: 200 }),
      sleep: async () => {},
    }),
    (error) => error instanceof StockDataError && error.statusCode === 502 && /malformed/.test(error.message),
  );
});
