import { Router, type IRouter } from "express";
import {
  GetStockHistoryQueryParams,
} from "@workspace/api-zod";
import {
  buildCacheKey,
  getCached,
  setCache,
} from "../lib/cache";
import { getStockHistory, StockDataError } from "../lib/stocks-service";

const router: IRouter = Router();

router.get("/stocks", async (req, res): Promise<void> => {
  const parsed = GetStockHistoryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid ticker and choose a supported period." });
    return;
  }

  const symbol = parsed.data.symbol.toUpperCase();
  const period = parsed.data.period ?? "3y";
  const endDate = new Date();
  const cacheKey = buildCacheKey("stock-history-v3", {
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
