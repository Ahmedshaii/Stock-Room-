import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetStockHistoryQueryKey,
  getGetStockSearchQueryKey,
  useGetStockHistory,
  useGetStockSearch,
} from "@workspace/api-client-react";
import type { GetStockHistoryPeriod, StockSearchResult } from "@workspace/api-client-react";
import { CSVLink } from "react-csv";
import {
  Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  Activity, ArrowDownRight, ArrowUpRight, Check, ChevronDown, CircleHelp,
  Download, Moon, Printer, RefreshCw, Search, Sun, TrendingUp,
} from "lucide-react";

const PERIODS: { value: GetStockHistoryPeriod; label: string }[] = [
  { value: "1y", label: "1 year" },
  { value: "3y", label: "3 years" },
  { value: "5y", label: "5 years" },
  { value: "7y", label: "7 years" },
];
type ChartRange = "1M" | "6M" | "1Y" | "5Y" | "MAX";
const CHART_RANGES: ChartRange[] = ["1M", "6M", "1Y", "5Y", "MAX"];
const CHART_RANGE_MONTHS: Record<ChartRange, number> = {
  "1M": 1,
  "6M": 6,
  "1Y": 12,
  "5Y": 60,
  MAX: 84,
};
const CHART_RANGE_PERIOD: Record<ChartRange, GetStockHistoryPeriod> = {
  "1M": "1y",
  "6M": "1y",
  "1Y": "1y",
  "5Y": "5y",
  MAX: "7y",
};
const INTERVALS = [
  { label: "5 minutes", value: 5 * 60 * 1000 },
  { label: "15 minutes", value: 15 * 60 * 1000 },
  { label: "1 hour", value: 60 * 60 * 1000 },
  { label: "24 hours", value: 24 * 60 * 60 * 1000 },
];
const DATA_SOURCES = ["Yahoo Finance"];
const SERIES = { close: "#236f60", sma50: "#d99449", sma200: "#7c86a0", rsi: "#8f6caa" };
const SYMBOL_PATTERN = /^[A-Za-z0-9.^=_-]{1,20}$/;

function parseLocalDate(dateStr: string) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day);
}
function shortDate(dateStr: string, format: "short" | "long" = "short") {
  return parseLocalDate(dateStr).toLocaleDateString("en-US", format === "long"
    ? { month: "short", day: "numeric", year: "numeric" }
    : { month: "short", year: "2-digit" });
}
function money(value: number, currency: string | null) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${currency || "$"} ${value.toFixed(2)}`;
  }
}
function number(value: number | null | undefined, digits = 2) {
  return value == null ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function volume(value: number | null | undefined) {
  return value == null ? "N/A" : value.toLocaleString("en-US");
}
function subtractCalendarMonths(dateString: string, monthsToSubtract: number) {
  const [year, month, day] = dateString.split("-").map(Number);
  const monthIndex = year! * 12 + (month! - 1) - monthsToSubtract;
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day!, lastDay);
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}
function periodYears(period: GetStockHistoryPeriod) {
  return Number.parseInt(period, 10);
}
function formatUpdated(value?: string) {
  if (!value) return "Waiting for data";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
function ExportButton({
  data,
  filename,
  label,
}: {
  data: Array<Record<string, string | number | null>>;
  filename: string;
  label: string;
}) {
  return <CSVLink data={data} filename={filename} aria-label={label} title={label} data-testid={`button-${label.toLowerCase().replaceAll(" ", "-")}`} className="print-hide inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
    <Download size={14} strokeWidth={1.8} /> CSV
  </CSVLink>;
}

function ChartTooltip({ active, payload, label, currency }: { active?: boolean; payload?: Array<{ name?: string; value?: number; color?: string }>; label?: string; currency: string | null }) {
  if (!active || !payload?.length) return null;
  return <div className="rounded-lg border border-border bg-card px-3 py-2.5 text-xs">
    <p className="mb-2 font-medium text-muted-foreground">{label ? shortDate(label, "long") : ""}</p>
    {payload.map((entry, index) => <div key={`${entry.name}-${index}`} className="flex min-w-32 items-center justify-between gap-5 py-0.5">
      <span className="flex items-center gap-2 text-muted-foreground"><i className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />{entry.name}</span>
      <span className="mono-data font-medium text-foreground">{entry.value == null ? "—" : entry.name === "RSI 14" ? entry.value.toFixed(1) : money(entry.value, currency)}</span>
    </div>)}
  </div>;
}

function Metric({ label, value, detail, accent, testId, className = "" }: { label: string; value: string; detail: string; accent?: string; testId: string; className?: string }) {
  return <div className={`min-w-0 px-5 py-5 first:pl-0 last:pr-0 ${className}`}>
    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.13em] text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accent || "hsl(var(--primary))" }} />{label}
    </div>
    <div data-testid={testId} className="mono-data mt-3 whitespace-nowrap text-[19px] leading-none tracking-[-.05em] text-foreground sm:text-[23px] xl:text-[30px]">{value}</div>
    <div className="mt-2 text-[11px] leading-4 text-muted-foreground sm:text-xs">{detail}</div>
  </div>;
}

function StockDashboard() {
  const [symbolInput, setSymbolInput] = useState("AAPL");
  const [symbol, setSymbol] = useState("AAPL");
  const [period, setPeriod] = useState<GetStockHistoryPeriod>("5y");
  const [chartRange, setChartRange] = useState<ChartRange>("5Y");
  const [validation, setValidation] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [isDark, setIsDark] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshFromProvider, setRefreshFromProvider] = useState(false);
  const [intervalMs, setIntervalMs] = useState(INTERVALS[0].value);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    localStorage.setItem("stockroom-theme", isDark ? "dark" : "light");
  }, [isDark]);
  useEffect(() => {
    const stored = localStorage.getItem("stockroom-theme");
    if (stored) setIsDark(stored === "dark");
  }, []);
  useEffect(() => {
    function closeIfOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) setDropdownOpen(false);
    }
    document.addEventListener("mousedown", closeIfOutside);
    return () => document.removeEventListener("mousedown", closeIfOutside);
  }, []);
  useEffect(() => {
    function closeSuggestionsIfOutside(event: MouseEvent) {
      if (searchBoxRef.current && !searchBoxRef.current.contains(event.target as Node)) {
        setSuggestionsOpen(false);
      }
    }
    document.addEventListener("mousedown", closeSuggestionsIfOutside);
    return () => document.removeEventListener("mousedown", closeSuggestionsIfOutside);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(symbolInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [symbolInput]);

  const params = useMemo(
    () => ({
      symbol,
      period,
      ...(refreshFromProvider ? { refresh: true } : {}),
    }),
    [symbol, period, refreshFromProvider],
  );
  const query = useGetStockHistory(params, {
    query: { enabled: !!symbol, queryKey: getGetStockHistoryQueryKey(params), retry: false },
  });
  const chartFetchPeriod =
    periodYears(CHART_RANGE_PERIOD[chartRange]) > periodYears(period)
      ? CHART_RANGE_PERIOD[chartRange]
      : period;
  const chartParams = useMemo(
    () => ({
      symbol,
      period: chartFetchPeriod,
      ...(refreshFromProvider ? { refresh: true } : {}),
    }),
    [symbol, chartFetchPeriod, refreshFromProvider],
  );
  const needsLongerChartHistory = chartFetchPeriod !== period;
  const chartQuery = useGetStockHistory(chartParams, {
    query: {
      enabled: !!symbol && needsLongerChartHistory,
      queryKey: getGetStockHistoryQueryKey(chartParams),
      retry: false,
    },
  });
  const searchParams = useMemo(() => ({ query: debouncedSearch }), [debouncedSearch]);
  const searchMatchesInput = debouncedSearch === symbolInput.trim();
  const stockSearch = useGetStockSearch(searchParams, {
    query: {
      enabled: suggestionsOpen && symbolInput.trim().length >= 2 && searchMatchesInput,
      queryKey: getGetStockSearchQueryKey(searchParams),
      retry: false,
      staleTime: 30_000,
    },
  });
  const searchResults = stockSearch.data?.results ?? [];
  const history = query.data;
  const loading = query.isLoading || query.isFetching;
  const chartHistory = needsLongerChartHistory ? chartQuery.data : history;
  const chartLoading = needsLongerChartHistory && (chartQuery.isLoading || chartQuery.isFetching);
  const chartRows = useMemo(() => {
    const availableRows = chartHistory?.rows ?? [];
    const sortedRows = availableRows.slice().sort((left, right) => left.date.localeCompare(right.date));
    if (chartRange === "MAX") return sortedRows;
    const latestDate = chartHistory?.latest.date ?? sortedRows.at(-1)?.date;
    if (!latestDate) return [];
    const cutoff = subtractCalendarMonths(latestDate, CHART_RANGE_MONTHS[chartRange]);
    return sortedRows.filter((row) => row.date >= cutoff);
  }, [chartHistory, chartRange]);
  const expectedChartStart = chartHistory
    ? subtractCalendarMonths(chartHistory.latest.date, CHART_RANGE_MONTHS[chartRange])
    : null;
  const chartHasPartialHistory = !!(
    chartRows[0] &&
    expectedChartStart &&
    Date.parse(`${chartRows[0].date}T00:00:00.000Z`) -
      Date.parse(`${expectedChartStart}T00:00:00.000Z`) >
      10 * 24 * 60 * 60 * 1_000
  );
  useEffect(() => {
    if (autoRefresh) setRefreshFromProvider(true);
  }, [autoRefresh]);
  useEffect(() => {
    if (!autoRefresh || !symbol) return;
    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: getGetStockHistoryQueryKey(params) });
      if (needsLongerChartHistory) {
        void queryClient.invalidateQueries({
          queryKey: getGetStockHistoryQueryKey(chartParams),
        });
      }
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [autoRefresh, chartParams, intervalMs, needsLongerChartHistory, params, queryClient, symbol]);

  const rows = history?.rows || [];
  const tableRows = useMemo(() => rows.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12), [rows]);
  const financialMetrics = useMemo(() => {
    const firstDate = rows[0]?.date;
    const latestDate = history?.latest.date;
    if (!firstDate || !latestDate) {
      return { high: null, low: null, hasFull52Weeks: false };
    }

    const cutoff = subtractCalendarMonths(latestDate, 12);
    const yearRows = rows.filter((row) => row.date >= cutoff);
    const availableDays =
      (Date.parse(`${latestDate}T00:00:00.000Z`) -
        Date.parse(`${firstDate}T00:00:00.000Z`)) /
      (24 * 60 * 60 * 1_000);
    const hasFull52Weeks = availableDays >= 350;
    const highs = yearRows.flatMap((row) =>
      row.high != null && Number.isFinite(row.high) ? [row.high] : [],
    );
    const lows = yearRows.flatMap((row) =>
      row.low != null && Number.isFinite(row.low) ? [row.low] : [],
    );
    return {
      high: hasFull52Weeks && highs.length > 0 ? Math.max(...highs) : null,
      low: hasFull52Weeks && lows.length > 0 ? Math.min(...lows) : null,
      hasFull52Weeks,
    };
  }, [history, rows]);
  const currency = history?.currency || null;
  const change = history?.latest.changePercent ?? 0;
  const chartAxisColor = isDark ? "#a5ada9" : "#777e78";
  const gridColor = isDark ? "rgba(231,237,230,.11)" : "rgba(47,61,54,.12)";
  const errorData = query.error && typeof query.error === "object" && "data" in query.error
    ? query.error.data : null;
  const errorText = errorData && typeof errorData === "object" && "error" in errorData
    ? String(errorData.error)
    : query.error && typeof query.error === "object" && "message" in query.error
      ? String(query.error.message)
      : "The history provider could not return this ticker.";
  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextSymbol = symbolInput.trim().toUpperCase();
    if (nextSymbol.length > 80) {
      setValidation("Search using a ticker or company name up to 80 characters.");
      return;
    }
    if (!SYMBOL_PATTERN.test(nextSymbol)) {
      setSuggestionsOpen(true);
      setValidation("Choose a matching company from the suggestions to use its ticker.");
      return;
    }
    setValidation("");
    setSymbol(nextSymbol);
    setSuggestionsOpen(false);
  };
  const selectSuggestion = (result: StockSearchResult) => {
    setSymbolInput(result.symbol);
    setSymbol(result.symbol);
    setValidation("");
    setActiveSuggestion(-1);
    setSuggestionsOpen(false);
  };
  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setSuggestionsOpen(false);
      setActiveSuggestion(-1);
      return;
    }
    if (event.key === "ArrowDown" && suggestionsOpen && searchResults.length > 0) {
      event.preventDefault();
      setActiveSuggestion((current) => Math.min(current + 1, searchResults.length - 1));
      return;
    }
    if (event.key === "ArrowUp" && suggestionsOpen && searchResults.length > 0) {
      event.preventDefault();
      setActiveSuggestion((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter" && suggestionsOpen && searchResults.length > 0) {
      event.preventDefault();
      selectSuggestion(searchResults[activeSuggestion >= 0 ? activeSuggestion : 0]!);
    }
  };
  const refresh = () => {
    if (!refreshFromProvider) {
      setRefreshFromProvider(true);
      return;
    }
    void query.refetch();
    if (needsLongerChartHistory) void chartQuery.refetch();
  };
  const updatedLabel = formatUpdated(history?.updatedAt);

  return <main className="stock-shell min-h-[100dvh] bg-background text-foreground">
    <div className="mx-auto max-w-[1440px] px-5 pb-12 pt-5 sm:px-8 lg:px-12">
      <header className="enter flex flex-col gap-5 border-b border-border pb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Activity size={20} strokeWidth={1.8} /></div>
          <div>
            <div className="serif-display text-[23px] leading-none tracking-[-.03em]">Stockroom</div>
            <div className="mt-1.5 text-[10px] font-semibold uppercase tracking-[.19em] text-muted-foreground">Daily market research</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 print-hide">
          <div ref={dropdownRef} className="relative">
            <div className="flex h-10 items-center overflow-hidden rounded-lg border border-border bg-card">
              <button onClick={refresh} disabled={loading || !symbol} className="flex h-full items-center gap-2 px-3 text-xs font-semibold transition-colors hover:bg-muted disabled:opacity-50" aria-label="Refresh history" data-testid="button-refresh">
                <RefreshCw size={14} className={query.isFetching ? "animate-spin" : ""} />Refresh
              </button>
              <span className="h-5 w-px bg-border" />
              <button onClick={() => setDropdownOpen(open => !open)} aria-label="Auto-refresh settings" aria-expanded={dropdownOpen} data-testid="button-refresh-options" className="flex h-full items-center px-2.5 text-muted-foreground hover:bg-muted">
                <ChevronDown size={15} />
              </button>
            </div>
            {dropdownOpen && <div className="absolute right-0 top-12 z-20 w-60 rounded-xl border border-border bg-card p-3">
              <div className="flex items-center justify-between px-1 py-2">
                <div><p className="text-sm font-semibold">Auto-refresh</p><p className="mt-0.5 text-[11px] text-muted-foreground">Off unless you enable it</p></div>
                <button role="switch" aria-checked={autoRefresh} onClick={() => setAutoRefresh(value => !value)} data-testid="switch-auto-refresh" className={`relative h-6 w-11 rounded-full transition-colors ${autoRefresh ? "bg-primary" : "bg-muted"}`}>
                  <span className={`absolute top-1 h-4 w-4 rounded-full bg-card transition-transform ${autoRefresh ? "translate-x-6" : "translate-x-1"}`} />
                </button>
              </div>
              <div className="my-2 border-t border-border" />
              {INTERVALS.map(interval => <button key={interval.value} onClick={() => { setIntervalMs(interval.value); setAutoRefresh(true); }} data-testid={`interval-${interval.label.replaceAll(" ", "-")}`} className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                {interval.label}{intervalMs === interval.value && autoRefresh ? <Check size={14} className="text-primary" /> : null}
              </button>)}
            </div>}
          </div>
          <button onClick={() => window.print()} aria-label="Print or save as PDF" title="Print / save PDF" data-testid="button-print" className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-muted-foreground hover:bg-muted">
            <Printer size={15} /><span className="hidden sm:inline">Print</span>
          </button>
          <button onClick={() => setIsDark(value => !value)} aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"} data-testid="button-toggle-theme" className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:bg-muted">
            {isDark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </header>

      <section className="enter enter-delay-1 flex flex-col gap-6 py-8 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-xl">
          <div className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.19em] text-primary">
            <span className="h-px w-6 bg-primary" /> A clearer read on the past
          </div>
          <h1 className="serif-display text-[36px] leading-[1.06] tracking-[-.035em] sm:text-[46px]">History, with its workings shown.</h1>
          <p className="mt-3 max-w-lg text-sm leading-6 text-muted-foreground">Explore daily closing prices alongside simple moving averages and RSI. Context for your research, never a call to trade.</p>
        </div>
        <div className="w-full lg:max-w-[590px]">
          <form onSubmit={submitSearch} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1" ref={searchBoxRef}>
              <label htmlFor="ticker-input" className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[.16em] text-muted-foreground">Company or ticker</label>
              <div className="relative">
                <div className={`flex h-11 items-center gap-2 rounded-lg border bg-card px-3 focus-within:ring-2 focus-within:ring-primary/20 ${validation ? "border-destructive" : "border-border"}`}>
                  <Search size={16} className="shrink-0 text-muted-foreground" />
                  <input
                    id="ticker-input"
                    data-testid="input-ticker"
                    value={symbolInput}
                    onFocus={() => setSuggestionsOpen(true)}
                    onKeyDown={handleSearchKeyDown}
                    onChange={event => {
                      setSymbolInput(event.target.value);
                      setActiveSuggestion(-1);
                      setSuggestionsOpen(true);
                      if (validation) setValidation("");
                    }}
                    placeholder="Company name or ticker, e.g. Apple or AAPL"
                    className="mono-data min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:font-sans placeholder:normal-case placeholder:tracking-normal placeholder:text-muted-foreground"
                    maxLength={80}
                    aria-label="Search by company name or ticker"
                    aria-autocomplete="list"
                    aria-expanded={suggestionsOpen && symbolInput.trim().length >= 2}
                    aria-controls="stock-search-suggestions"
                    aria-activedescendant={activeSuggestion >= 0 ? `stock-search-option-${activeSuggestion}` : undefined}
                    aria-invalid={!!validation}
                  />
                  <span className="hidden text-[10px] text-muted-foreground sm:block">NYSE · NASDAQ</span>
                </div>
                {suggestionsOpen && symbolInput.trim().length >= 2 && <div
                  id="stock-search-suggestions"
                  role="listbox"
                  aria-label="Matching stocks"
                  className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
                >
                  {(!searchMatchesInput || stockSearch.isFetching) && <div role="status" className="px-3 py-3 text-xs text-muted-foreground">Searching stocks…</div>}
                  {searchMatchesInput && stockSearch.isError && <div role="alert" className="px-3 py-3 text-xs text-destructive">Stock search is unavailable. Try again, or enter a ticker directly.</div>}
                  {searchMatchesInput && !stockSearch.isFetching && !stockSearch.isError && stockSearch.data?.results.length === 0 && <div role="status" className="px-3 py-3 text-xs text-muted-foreground">No matching listed stocks found.</div>}
                  {searchMatchesInput && stockSearch.data?.results.map((result, index) => <button
                    id={`stock-search-option-${index}`}
                    key={result.symbol}
                    type="button"
                    role="option"
                    aria-selected={activeSuggestion === index}
                    onMouseEnter={() => setActiveSuggestion(index)}
                    onClick={() => selectSuggestion(result)}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted ${activeSuggestion === index ? "bg-muted" : ""}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-foreground">{result.name}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{result.exchange || "Listed equity"}</span>
                    </span>
                    <span className="mono-data shrink-0 text-xs font-semibold text-primary">{result.symbol}</span>
                  </button>)}
                </div>}
              </div>
              {validation && <p role="alert" className="mt-1.5 text-xs text-destructive">{validation}</p>}
            </div>
            <div className="flex gap-2">
              <div className="min-w-[132px]">
                <label htmlFor="period-select" className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[.16em] text-muted-foreground">History</label>
                <select id="period-select" data-testid="select-period" value={period} onChange={event => setPeriod(event.target.value as GetStockHistoryPeriod)} className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-primary/20">
                  {PERIODS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </div>
              <button type="submit" data-testid="button-search" className="mt-[22px] flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90">
                <Search size={15} />Analyze
              </button>
            </div>
          </form>
          <div className="mt-3 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
            {DATA_SOURCES.map(source => <span key={source} className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-[#d99449]" />{source}</span>)}
            <span aria-hidden="true">/</span><span>Delayed daily history</span>
            <span aria-hidden="true">/</span><span>Not investment advice</span>
          </div>
        </div>
      </section>

      {history && !loading && !query.error && rows.length > 0 && <>
        <section className="enter enter-delay-2 mb-5 flex flex-col justify-between gap-4 border-y border-border py-5 sm:flex-row sm:items-end">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="mono-data text-lg font-semibold tracking-tight">{history.symbol}</h2>
              {history.exchangeName && <span className="rounded-md border border-border px-2 py-1 text-[10px] font-medium uppercase tracking-[.12em] text-muted-foreground">{history.exchangeName}</span>}
              <span className="rounded-md bg-primary/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[.12em] text-primary">{history.period} history</span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Latest daily session · {shortDate(history.latest.date, "long")}</p>
          </div>
          <div className="text-left sm:text-right">
            <div className="mono-data text-[33px] leading-none tracking-[-.05em] sm:text-[38px]" data-testid="text-latest-close">{money(history.latest.close, currency)}</div>
            <div className={`mono-data mt-2 inline-flex items-center gap-1 text-sm font-medium ${change >= 0 ? "rise" : "fall"}`}>
              {change >= 0 ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}
              {change > 0 ? "+" : ""}{number(change)}% <span className="font-sans text-xs text-muted-foreground">daily change</span>
            </div>
          </div>
        </section>

        <section className="enter enter-delay-2 mb-6 grid grid-cols-2 divide-x divide-y divide-border rounded-xl border border-border bg-card px-5 sm:grid-cols-4 sm:divide-y-0 sm:px-7" aria-label="Latest technical metrics">
          <Metric label="Daily close" value={money(history.latest.close, currency)} detail={`Previous close ${money(history.latest.previousClose, currency)}`} accent={SERIES.close} testId="metric-close" />
          <Metric label="SMA · 50 day" value={history.latest.sma50 == null ? "—" : money(history.latest.sma50, currency)} detail={history.latest.sma50 == null ? "Not enough history" : "50-session average close"} accent={SERIES.sma50} testId="metric-sma50" />
          <Metric label="SMA · 200 day" value={history.latest.sma200 == null ? "—" : money(history.latest.sma200, currency)} detail={history.latest.sma200 == null ? "Not enough history" : "200-session average close"} accent={SERIES.sma200} testId="metric-sma200" />
          <Metric label="RSI · 14 day" value={history.latest.rsi14 == null ? "—" : number(history.latest.rsi14, 1)} detail="Wilder relative strength index" accent={SERIES.rsi} testId="metric-rsi14" />
        </section>

        <section className="enter enter-delay-2 mb-6 grid grid-cols-2 divide-x divide-y divide-border rounded-xl border border-border bg-card px-5 sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0 sm:px-7" aria-label="Market and valuation metrics">
          <Metric label="Market cap" value="N/A" detail="Not supplied by daily history API" testId="metric-market-cap" />
          <Metric label="P/E ratio" value="N/A" detail="Not supplied by daily history API" testId="metric-pe-ratio" />
          <Metric label="52-week high" value={financialMetrics.high == null ? "N/A" : money(financialMetrics.high, currency)} detail={financialMetrics.hasFull52Weeks ? "From daily session highs" : "Full 52-week history unavailable"} testId="metric-52-week-high" />
          <Metric label="52-week low" value={financialMetrics.low == null ? "N/A" : money(financialMetrics.low, currency)} detail={financialMetrics.hasFull52Weeks ? "From daily session lows" : "Full 52-week history unavailable"} testId="metric-52-week-low" />
          <Metric label="Trading volume" value={volume(rows.at(-1)?.volume)} detail="Latest reported session" testId="metric-trading-volume" className="col-span-2 sm:col-span-1" />
        </section>

        <section className="enter enter-delay-3 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.8fr)_minmax(300px,.9fr)]">
          <article className="panel min-w-0 p-4 sm:p-5">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
              <div><div className="flex items-center gap-2"><TrendingUp size={16} className="text-primary" /><h3 className="text-sm font-semibold tracking-tight">Price history</h3></div>
                <p className="mt-1.5 text-xs text-muted-foreground">Daily close, with 50- and 200-session averages · {chartRange}</p></div>
              <ExportButton
                label="Export price chart data"
                filename={`${symbol.toLowerCase()}-price-history-${chartRange.toLowerCase()}.csv`}
                data={chartRows.map(row => ({
                  date: row.date, close: row.close, sma50: row.sma50, sma200: row.sma200,
                }))}
              />
            </div>
            <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Price chart time range">
              {CHART_RANGES.map((range) => <button
                key={range}
                type="button"
                onClick={() => setChartRange(range)}
                aria-pressed={chartRange === range}
                data-testid={`chart-range-${range.toLowerCase()}`}
                className={`rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${chartRange === range ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
              >{range}</button>)}
            </div>
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-2">
              {[["Close", SERIES.close], ["SMA 50", SERIES.sma50], ["SMA 200", SERIES.sma200]].map(([label, color]) => <span key={label} className="inline-flex items-center gap-2 text-[11px] text-muted-foreground"><i className="h-[2px] w-4 rounded" style={{ backgroundColor: color }} />{label}</span>)}
            </div>
            <div className="h-[280px] w-full sm:h-[330px]">
              {chartLoading
                ? <div role="status" aria-label="Loading selected price range" className="flex h-full items-center justify-center rounded-lg bg-muted/30 text-sm text-muted-foreground">Loading {chartRange} history…</div>
                : needsLongerChartHistory && chartQuery.isError
                  ? <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 rounded-lg bg-muted/30 px-4 text-center">
                    <p className="text-sm text-muted-foreground">Could not load {chartRange} price history. The provider may have no data for this range or be temporarily unavailable.</p>
                    <button type="button" onClick={() => void chartQuery.refetch()} className="text-xs font-semibold text-primary hover:underline">Retry chart history</button>
                  </div>
                  : chartRows.length === 0
                    ? <div role="status" className="flex h-full items-center justify-center rounded-lg bg-muted/30 px-4 text-center text-sm text-muted-foreground">No daily price history is available for this range.</div>
                    : <ResponsiveContainer width="100%" height="100%" debounce={0}>
                      <AreaChart data={chartRows} margin={{ top: 8, right: 4, bottom: 0, left: 2 }}>
                        <defs><linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={SERIES.close} stopOpacity=".19" /><stop offset="100%" stopColor={SERIES.close} stopOpacity="0" /></linearGradient></defs>
                        <CartesianGrid vertical={false} stroke={gridColor} strokeDasharray="2 5" />
                        <XAxis dataKey="date" tickFormatter={value => shortDate(value)} tick={{ fill: chartAxisColor, fontSize: 10, fontFamily: "IBM Plex Mono" }} axisLine={false} tickLine={false} minTickGap={38} />
                        <YAxis domain={["auto", "auto"]} tickFormatter={value => Number(value).toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 })} tick={{ fill: chartAxisColor, fontSize: 10, fontFamily: "IBM Plex Mono" }} axisLine={false} tickLine={false} width={44} />
                        <Tooltip content={<ChartTooltip currency={currency} />} cursor={{ stroke: gridColor, strokeDasharray: "3 3" }} />
                        <Area type="monotone" dataKey="close" name="Close" stroke={SERIES.close} strokeWidth={2} fill="url(#priceFill)" dot={false} activeDot={{ r: 3, fill: SERIES.close, stroke: "hsl(var(--card))", strokeWidth: 2 }} isAnimationActive={false} />
                        <Line type="monotone" dataKey="sma50" name="SMA 50" stroke={SERIES.sma50} strokeWidth={1.4} dot={false} connectNulls isAnimationActive={false} />
                        <Line type="monotone" dataKey="sma200" name="SMA 200" stroke={SERIES.sma200} strokeWidth={1.5} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>}
            </div>
            <p className="mt-3 border-t border-border pt-3 text-[10px] leading-5 text-muted-foreground">
              Moving averages use daily closing prices.{" "}
              {chartHasPartialHistory && chartRows[0] && `Only provider history since ${shortDate(chartRows[0].date, "long")} is available for this range. `}
              MAX is limited to 7 years by the current API; provider gaps are preserved.
            </p>
          </article>

          <article className="panel min-w-0 p-4 sm:p-5">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
              <div><div className="flex items-center gap-2"><Activity size={16} className="text-[#8f6caa]" /><h3 className="text-sm font-semibold tracking-tight">Relative strength</h3></div>
                <p className="mt-1.5 text-xs text-muted-foreground">RSI · 14 sessions · {chartRange} · scale 0–100</p></div>
              <ExportButton
                label="Export RSI chart data"
                filename={`${symbol.toLowerCase()}-rsi-14-${chartRange.toLowerCase()}.csv`}
                data={chartRows.map(row => ({
                  date: row.date, rsi14: row.rsi14,
                }))}
              />
            </div>
            <div className="mb-3 flex items-center gap-2 text-[11px] text-muted-foreground"><i className="h-[2px] w-4 rounded" style={{ backgroundColor: SERIES.rsi }} />RSI 14</div>
            <div className="h-[280px] w-full sm:h-[330px]">
              {chartLoading
                ? <div role="status" aria-label="Loading selected RSI range" className="flex h-full items-center justify-center rounded-lg bg-muted/30 text-sm text-muted-foreground">Loading {chartRange} history…</div>
                : needsLongerChartHistory && chartQuery.isError
                  ? <div role="alert" className="flex h-full items-center justify-center rounded-lg bg-muted/30 px-4 text-center text-sm text-muted-foreground">RSI history is unavailable for this range.</div>
                  : chartRows.length === 0
                    ? <div role="status" className="flex h-full items-center justify-center rounded-lg bg-muted/30 px-4 text-center text-sm text-muted-foreground">No RSI history is available for this range.</div>
                    : <ResponsiveContainer width="100%" height="100%" debounce={0}>
                      <LineChart data={chartRows} margin={{ top: 8, right: 7, bottom: 0, left: 0 }}>
                        <CartesianGrid vertical={false} stroke={gridColor} strokeDasharray="2 5" />
                        <XAxis dataKey="date" tickFormatter={value => shortDate(value)} tick={{ fill: chartAxisColor, fontSize: 10, fontFamily: "IBM Plex Mono" }} axisLine={false} tickLine={false} minTickGap={38} />
                        <YAxis domain={[0, 100]} ticks={[0, 30, 50, 70, 100]} tick={{ fill: chartAxisColor, fontSize: 10, fontFamily: "IBM Plex Mono" }} axisLine={false} tickLine={false} width={28} />
                        <ReferenceArea y1={70} y2={100} fill={SERIES.rsi} fillOpacity=".07" />
                        <ReferenceArea y1={0} y2={30} fill={SERIES.close} fillOpacity=".06" />
                        <ReferenceLine y={70} stroke={SERIES.rsi} strokeDasharray="4 4" strokeOpacity=".65" />
                        <ReferenceLine y={30} stroke={SERIES.close} strokeDasharray="4 4" strokeOpacity=".65" />
                        <Tooltip content={<ChartTooltip currency={currency} />} cursor={{ stroke: gridColor, strokeDasharray: "3 3" }} />
                        <Line type="monotone" dataKey="rsi14" name="RSI 14" stroke={SERIES.rsi} strokeWidth={1.8} dot={false} activeDot={{ r: 3, fill: SERIES.rsi, stroke: "hsl(var(--card))", strokeWidth: 2 }} connectNulls isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>}
            </div>
            <div className="mt-3 flex flex-wrap justify-between gap-2 border-t border-border pt-3 text-[10px] leading-5 text-muted-foreground"><span>Dashed guides at 30 and 70</span><span>Context only, not a signal</span></div>
          </article>
        </section>

        <section className="panel mt-5 overflow-hidden">
          <div className="flex flex-wrap items-end justify-between gap-3 px-5 py-5 sm:px-6">
            <div><h3 className="text-sm font-semibold tracking-tight">Recent sessions</h3><p className="mt-1.5 text-xs text-muted-foreground">Most recent daily observations · newest first</p></div>
            <span className="mono-data text-[10px] text-muted-foreground">{Math.min(rows.length, 12)} of {rows.length} rows</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[690px] border-t border-border text-left">
              <thead><tr className="bg-muted/50 text-[10px] font-semibold uppercase tracking-[.12em] text-muted-foreground">
                <th className="px-5 py-3 sm:px-6">Date</th><th className="px-4 py-3 text-right">Open</th><th className="px-4 py-3 text-right">High</th><th className="px-4 py-3 text-right">Low</th><th className="px-4 py-3 text-right">Close</th><th className="px-4 py-3 text-right">Volume</th><th className="px-5 py-3 text-right sm:px-6">RSI 14</th>
              </tr></thead>
              <tbody>{tableRows.map((row, index) => <tr key={row.date} data-testid={`row-session-${index}`} className="border-t border-border/70 text-[13px] transition-colors hover:bg-muted/35">
                <td className="px-5 py-3 font-medium text-foreground sm:px-6">{shortDate(row.date, "long")}</td>
                <td className="mono-data px-4 py-3 text-right text-muted-foreground">{row.open == null ? "—" : money(row.open, currency)}</td>
                <td className="mono-data px-4 py-3 text-right text-muted-foreground">{row.high == null ? "—" : money(row.high, currency)}</td>
                <td className="mono-data px-4 py-3 text-right text-muted-foreground">{row.low == null ? "—" : money(row.low, currency)}</td>
                <td className="mono-data px-4 py-3 text-right font-medium">{money(row.close, currency)}</td>
                <td className="mono-data px-4 py-3 text-right text-muted-foreground">{row.volume == null ? "—" : row.volume.toLocaleString("en-US")}</td>
                <td className="mono-data px-5 py-3 text-right text-muted-foreground sm:px-6">{number(row.rsi14, 1)}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>
      </>}

      {loading && <section className="mt-5 space-y-5" aria-label="Loading stock history" data-testid="status-loading">
        <div className="flex items-end justify-between border-y border-border py-5"><div className="space-y-2"><div className="h-5 w-28 animate-pulse rounded bg-muted" /><div className="h-3 w-40 animate-pulse rounded bg-muted" /></div><div className="h-9 w-36 animate-pulse rounded bg-muted" /></div>
        <div className="grid grid-cols-2 gap-0 rounded-xl border border-border bg-card px-5 sm:grid-cols-4">{[0, 1, 2, 3].map(item => <div key={item} className="border-b border-border px-4 py-6 sm:border-b-0"><div className="h-3 w-20 animate-pulse rounded bg-muted" /><div className="mt-4 h-7 w-28 animate-pulse rounded bg-muted" /><div className="mt-3 h-3 w-32 animate-pulse rounded bg-muted" /></div>)}</div>
        <div className="grid grid-cols-2 gap-0 rounded-xl border border-border bg-card px-5 sm:grid-cols-3 lg:grid-cols-5">{[0, 1, 2, 3, 4].map(item => <div key={item} className="border-b border-border px-4 py-6 lg:border-b-0"><div className="h-3 w-20 animate-pulse rounded bg-muted" /><div className="mt-4 h-7 w-28 animate-pulse rounded bg-muted" /><div className="mt-3 h-3 w-32 animate-pulse rounded bg-muted" /></div>)}</div>
        <div className="grid gap-5 lg:grid-cols-2">{[0, 1].map(item => <div key={item} className="panel p-5"><div className="h-4 w-32 animate-pulse rounded bg-muted" /><div className="mt-7 h-[300px] animate-pulse rounded-lg bg-muted/70" /></div>)}</div>
      </section>}

      {!loading && query.error && <section className="panel mt-8 px-6 py-10 text-center" data-testid="status-error">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10 text-destructive"><CircleHelp size={21} /></div>
        <h2 className="serif-display mt-4 text-2xl">History unavailable</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{errorText}</p>
        <p className="mt-2 text-xs text-muted-foreground">Check the ticker symbol or try again shortly. Daily history is provided by Yahoo Finance.</p>
        <button onClick={refresh} data-testid="button-retry" className="mt-5 inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground"><RefreshCw size={14} />Try again</button>
      </section>}

      {!loading && !query.error && history && rows.length === 0 && <section className="panel mt-8 px-6 py-12 text-center" data-testid="status-empty">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground"><Activity size={20} /></div>
        <h2 className="serif-display mt-4 text-2xl">No daily rows found</h2>
        <p className="mt-2 text-sm text-muted-foreground">There is no history available for {symbol} over this period.</p>
        <button onClick={refresh} data-testid="button-empty-refresh" className="mt-5 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted">Check again</button>
      </section>}

      {!loading && !query.error && !history && <section className="panel mt-8 px-6 py-14 text-center" data-testid="status-empty">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary"><Activity size={22} /></div>
        <h2 className="serif-display mt-4 text-2xl">Start with a ticker</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">Enter a listed symbol above to explore its daily price history and technical indicators. Start with AAPL or look up another company.</p>
      </section>}

      <footer className="mt-8 flex flex-col gap-3 border-t border-border pt-5 text-[11px] leading-5 text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>Source: Yahoo Finance · Daily historical data may be delayed, adjusted, or incomplete.</p>
        <p className="flex items-center gap-1.5"><CircleHelp size={13} /> Indicators describe past price behavior; they are not investment advice.</p>
        <p className="mono-data">Updated {updatedLabel}</p>
      </footer>
    </div>
  </main>;
}

export default StockDashboard;
