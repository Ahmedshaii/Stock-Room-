import { Router, type IRouter } from "express";
import {
  GetStockHistoryQueryParams,
  GetStockSearchQueryParams,
} from "@workspace/api-zod";
import {
  buildCacheKey,
  getCached,
  setCache,
} from "../lib/cache";
import {
  getStockHistory,
  searchStockSymbols,
  StockDataError,
} from "../lib/stocks-service";

const router: IRouter = Router();

router.get("/stocks/search", async (req, res): Promise<void> => {
  const parsed = GetStockSearchQueryParams.safeParse(req.query);
  const query = parsed.success ? parsed.data.query.trim() : "";
  if (!parsed.success || query.length === 0) {
    res.status(400).json({ error: "Enter a company name or ticker to search." });
    return;
  }

  try {
    const results = await searchStockSymbols(query);
    res.json(results);
  } catch (error) {
    const failure = error instanceof StockDataError
      ? error
      : new StockDataError(
          "Stock search is temporarily unavailable. Try again shortly.",
          502,
        );
    req.log.warn(
      { err: error, statusCode: failure.statusCode },
      "Stock symbol search failed",
    );
    res.status(failure.statusCode).json({ error: failure.message });
  }
});

router.get("/stocks", async (req, res): Promise<void> => {
  const rawRefresh = req.query.refresh;
  if (
    rawRefresh !== undefined &&
    rawRefresh !== "true" &&
    rawRefresh !== "false"
  ) {
    res.status(400).json({ error: "Enter a valid ticker and choose a supported period." });
    return;
  }

  const parsed = GetStockHistoryQueryParams.safeParse({
    ...req.query,
    ...(rawRefresh === undefined ? {} : { refresh: rawRefresh === "true" }),
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid ticker and choose a supported period." });
    return;
  }

  const symbol = parsed.data.symbol.toUpperCase();
  const period = parsed.data.period ?? "5y";
  const endDate = new Date();
  const cacheKey = buildCacheKey("stock-history-v4", {
    symbol,
    period,
    endDate: endDate.toISOString(),
  });

  try {
    const data = await getStockHistory(symbol, period, {
      cache: {
        key: cacheKey,
        read: () => getCached(cacheKey),
        write: (value) => setCache(cacheKey, value),
      },
      forceRefresh: parsed.data.refresh,
      onCacheFailure: (operation, error) => {
        req.log.warn(
          { err: error, operation },
          "Stock history cache operation failed",
        );
      },
    });
    res.json(data);
  } catch (error) {
    const failure = error instanceof StockDataError
      ? error
      : new StockDataError(
          "Market data is temporarily unavailable. Try again shortly.",
          502,
        );
    req.log.warn(
      { err: error, symbol, statusCode: failure.statusCode },
      "Market data request failed",
    );
    res.status(failure.statusCode).json({ error: failure.message });
  }
});

export default router;
