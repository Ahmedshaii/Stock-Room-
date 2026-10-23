import assert from "node:assert/strict";
import test from "node:test";
import { GetStockHistoryQueryParams } from "@workspace/api-zod";
import {
  buildHistoryPayload,
  calculateWilderRsi,
  getStockHistory,
  rollingMean,
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

test("Yahoo requests encode ticker symbols and align 1y, 3y, and 5y periods", async () => {
  const expectedStarts = {
    "1y": "2025-10-01T00:00:00.000Z",
    "3y": "2023-10-01T00:00:00.000Z",
    "5y": "2021-10-01T00:00:00.000Z",
  };
  const symbols = ["AAPL", "BHP.AX", "7203.T", "EURUSD=X"];

  for (const [period, expectedStart] of Object.entries(expectedStarts)) {
    assert.equal(startForPeriod(period, FIXED_NOW).toISOString(), expectedStart);
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
      assert.equal(requestUrl.searchParams.get("period1"), String(Date.parse(expectedStart) / 1_000));
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
