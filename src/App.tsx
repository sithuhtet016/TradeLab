import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "./utils/supabase";

type Portfolio = {
  balanceUsd: number;
  btcQuantity: number;
};

type Trade = {
  id: string;
  type: "BUY" | "SELL";
  price: number;
  quantity: number;
  totalValue: number;
  createdAt: string;
};

type StorageMode = "api" | "local";

const INITIAL_PORTFOLIO: Portfolio = {
  balanceUsd: 10000,
  btcQuantity: 0,
};

const STARTING_PRICE = 65000;

const MISSING_ENV_MESSAGE =
  "Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY to your .env file in the project root, then restart the dev server (Vite only reads .env at startup).";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(
  /\/$/,
  "",
);

function apiUrl(path: string): string {
  if (!path.startsWith("/")) return path;
  return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundBtc(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function toStorageKeys(userId: string) {
  return {
    portfolio: `tradelab:portfolio:${userId}`,
    trades: `tradelab:trades:${userId}`,
  };
}

function readLocalPortfolio(userId: string): Portfolio {
  const keys = toStorageKeys(userId);
  const raw = localStorage.getItem(keys.portfolio);
  if (!raw) return INITIAL_PORTFOLIO;

  try {
    const parsed = JSON.parse(raw) as Portfolio;
    if (
      typeof parsed.balanceUsd === "number" &&
      typeof parsed.btcQuantity === "number"
    ) {
      return parsed;
    }
  } catch {
    // Ignore corrupt local cache and fall back.
  }

  return INITIAL_PORTFOLIO;
}

function writeLocalPortfolio(userId: string, portfolio: Portfolio) {
  const keys = toStorageKeys(userId);
  localStorage.setItem(keys.portfolio, JSON.stringify(portfolio));
}

function readLocalTrades(userId: string): Trade[] {
  const keys = toStorageKeys(userId);
  const raw = localStorage.getItem(keys.trades);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as Trade[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalTrades(userId: string, trades: Trade[]) {
  const keys = toStorageKeys(userId);
  localStorage.setItem(keys.trades, JSON.stringify(trades));
}

function parseTradeRow(row: Record<string, unknown>): Trade | null {
  const id = row.id;
  const type = row.type;
  const price = row.price;
  const quantity = row.quantity;
  const totalValue = row.total_value;
  const createdAt = row.created_at;

  if (typeof id !== "string") return null;
  if (type !== "BUY" && type !== "SELL") return null;
  if (typeof createdAt !== "string") return null;

  const parsedPrice = Number(price);
  const parsedQuantity = Number(quantity);
  const parsedTotalValue = Number(totalValue);

  if (
    Number.isNaN(parsedPrice) ||
    Number.isNaN(parsedQuantity) ||
    Number.isNaN(parsedTotalValue)
  ) {
    return null;
  }

  return {
    id,
    type,
    price: parsedPrice,
    quantity: parsedQuantity,
    totalValue: parsedTotalValue,
    createdAt,
  };
}

function parsePortfolioRow(row: Record<string, unknown>): Portfolio | null {
  const balanceUsd = Number(row.balance_usd);
  const btcQuantity = Number(row.btc_quantity);
  if (Number.isNaN(balanceUsd) || Number.isNaN(btcQuantity)) return null;
  return { balanceUsd, btcQuantity };
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    if (payload.error) return payload.error;
  } catch {
    // fallback below
  }

  return `Request failed with status ${response.status}`;
}

declare global {
  interface Window {
    TradingView?: {
      widget: new (options: Record<string, unknown>) => unknown;
    };
  }
}

function TradingViewChart() {
  useEffect(() => {
    const scriptId = "tradelab-tradingview-script";
    const containerId = "tradelab-tv-chart";
    let cancelled = false;

    const initWidget = () => {
      if (cancelled || !window.TradingView?.widget) return;
      const container = document.getElementById(containerId);
      if (!container) return;

      container.innerHTML = "";

      new window.TradingView.widget({
        autosize: true,
        symbol: "BINANCE:BTCUSDT",
        interval: "5",
        timezone: "Etc/UTC",
        theme: "light",
        style: "1",
        locale: "en",
        allow_symbol_change: false,
        hide_side_toolbar: false,
        withdateranges: true,
        container_id: containerId,
        studies: ["RSI@tv-basicstudies", "MASimple@tv-basicstudies"],
        time_frames: [
          { text: "1m", resolution: "1", description: "1 minute" },
          { text: "5m", resolution: "5", description: "5 minutes" },
          { text: "1h", resolution: "60", description: "1 hour" },
          { text: "1d", resolution: "D", description: "1 day" },
        ],
      });
    };

    if (window.TradingView?.widget) {
      initWidget();
      return () => {
        cancelled = true;
      };
    }

    const existingScript = document.getElementById(
      scriptId,
    ) as HTMLScriptElement | null;

    if (existingScript) {
      existingScript.addEventListener("load", initWidget);
      return () => {
        cancelled = true;
        existingScript.removeEventListener("load", initWidget);
      };
    }

    const script = document.createElement("script");
    script.id = scriptId;
    script.src = "https://s3.tradingview.com/tv.js";
    script.async = true;
    script.onload = initWidget;
    document.body.appendChild(script);

    return () => {
      cancelled = true;
      script.onload = null;
    };
  }, []);

  return (
    <div className="tv-wrapper">
      <div id="tradelab-tv-chart" className="tv-chart" />
    </div>
  );
}

export default function App() {
  const client = supabase;
  const allowOfflineDemo = import.meta.env.DEV;
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [authMessage, setAuthMessage] = useState<string | null>(null);

  const [storageMode, setStorageMode] = useState<StorageMode>("api");
  const [portfolio, setPortfolio] = useState<Portfolio>(INITIAL_PORTFOLIO);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);

  const [trades, setTrades] = useState<Trade[]>([]);
  const [tradeHistoryLoading, setTradeHistoryLoading] = useState(false);

  const [price, setPrice] = useState(STARTING_PRICE);
  const [priceSource, setPriceSource] = useState<"api" | "demo">("demo");
  const [priceUpdatedAt, setPriceUpdatedAt] = useState<string>(
    new Date().toISOString(),
  );

  const [tradeType, setTradeType] = useState<"BUY" | "SELL">("BUY");
  const [buyMode, setBuyMode] = useState<"quantity" | "quote_usd">("quantity");
  const [quantityInput, setQuantityInput] = useState("0.01000000");
  const [usdInput, setUsdInput] = useState(
    roundUsd(STARTING_PRICE * 0.01).toFixed(2),
  );
  const [tradeBusy, setTradeBusy] = useState(false);
  const [tradeMessage, setTradeMessage] = useState<string | null>(null);

  const userId = session?.user.id ?? null;

  const totalValueUsd = useMemo(
    () => roundUsd(portfolio.balanceUsd + portfolio.btcQuantity * price),
    [portfolio.balanceUsd, portfolio.btcQuantity, price],
  );

  const pnlUsd = useMemo(
    () => roundUsd(totalValueUsd - 10000),
    [totalValueUsd],
  );

  const previewQuantity = useMemo(() => {
    if (tradeType === "BUY" && buyMode === "quote_usd") {
      const quoteUsd = Number(usdInput);
      if (!Number.isFinite(quoteUsd) || quoteUsd <= 0 || price <= 0) return 0;
      return roundBtc(quoteUsd / price);
    }

    const quantity = Number(quantityInput);
    if (!Number.isFinite(quantity) || quantity <= 0) return 0;
    return roundBtc(quantity);
  }, [tradeType, buyMode, usdInput, quantityInput, price]);

  const previewValueUsd = useMemo(
    () => roundUsd(previewQuantity * price),
    [previewQuantity, price],
  );

  useEffect(() => {
    if (!client) {
      setAuthLoading(false);
      return;
    }

    let active = true;

    client.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return;
        setSession(data.session ?? null);
      })
      .finally(() => {
        if (active) setAuthLoading(false);
      });

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [client]);

  useEffect(() => {
    let cancelled = false;

    async function updatePrice() {
      try {
        const response = await fetch(apiUrl("/api/market/price"), {
          method: "GET",
        });
        if (!response.ok) throw new Error("market api unavailable");
        const payload = (await response.json()) as { price?: number };
        const nextPrice = Number(payload.price);
        if (Number.isNaN(nextPrice) || nextPrice <= 0) {
          throw new Error("invalid market price payload");
        }
        if (!cancelled) {
          setPrice(nextPrice);
          setPriceSource("api");
          setPriceUpdatedAt(new Date().toISOString());
        }
      } catch {
        if (cancelled) return;
        setPrice((prev) => {
          const drift = prev * ((Math.random() - 0.5) * 0.003);
          return Math.max(1000, roundUsd(prev + drift));
        });
        setPriceSource("demo");
        setPriceUpdatedAt(new Date().toISOString());
      }
    }

    void updatePrice();
    const timer = window.setInterval(() => {
      void updatePrice();
    }, 2500);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!session || !userId) {
      setPortfolio(INITIAL_PORTFOLIO);
      setTrades([]);
      return;
    }

    const activeUserId = userId;
    const token = session.access_token;

    let cancelled = false;

    async function loadData() {
      setPortfolioLoading(true);
      setTradeHistoryLoading(true);
      setPortfolioError(null);

      try {
        const [portfolioResponse, tradesResponse] = await Promise.all([
          fetch(apiUrl("/api/portfolio"), {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch(apiUrl("/api/trades"), {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ]);

        if (!portfolioResponse.ok) {
          throw new Error(await parseErrorMessage(portfolioResponse));
        }

        if (!tradesResponse.ok) {
          throw new Error(await parseErrorMessage(tradesResponse));
        }

        const portfolioPayload = (await portfolioResponse.json()) as Record<
          string,
          unknown
        >;
        const nextPortfolio = parsePortfolioRow(portfolioPayload);

        if (!nextPortfolio) throw new Error("Could not parse portfolio row.");

        const tradesPayload = (await tradesResponse.json()) as {
          trades?: Array<Record<string, unknown>>;
        };
        const tradeRows = tradesPayload.trades ?? [];

        const parsedTrades = tradeRows
          .map((row) => parseTradeRow(row as Record<string, unknown>))
          .filter((trade): trade is Trade => trade !== null);

        if (!cancelled) {
          setStorageMode("api");
          setPortfolio(nextPortfolio);
          setTrades(parsedTrades);
          writeLocalPortfolio(activeUserId, nextPortfolio);
          writeLocalTrades(activeUserId, parsedTrades);
        }
      } catch (error) {
        if (!cancelled) {
          if (allowOfflineDemo) {
            setStorageMode("local");
            setPortfolio(readLocalPortfolio(activeUserId));
            setTrades(readLocalTrades(activeUserId));
            setPortfolioError("Running in offline demo mode.");
          } else {
            setStorageMode("api");
            setPortfolioError(
              error instanceof Error
                ? `Live data unavailable: ${error.message}`
                : "Live data unavailable. Please try again shortly.",
            );
          }
        }
      } finally {
        if (!cancelled) {
          setPortfolioLoading(false);
          setTradeHistoryLoading(false);
        }
      }
    }

    void loadData();

    return () => {
      cancelled = true;
    };
  }, [allowOfflineDemo, session, userId]);

  function syncFromQuantity(raw: string) {
    setQuantityInput(raw);
    const quantity = Number(raw);
    if (Number.isNaN(quantity) || quantity <= 0) {
      setUsdInput("");
      return;
    }
    setUsdInput(roundUsd(quantity * price).toFixed(2));
  }

  function syncFromUsd(raw: string) {
    setUsdInput(raw);
    const usd = Number(raw);
    if (Number.isNaN(usd) || usd <= 0 || price <= 0) {
      setQuantityInput("");
      return;
    }
    setQuantityInput(roundBtc(usd / price).toFixed(8));
  }

  async function refreshFromApi(
    token: string,
    activeUserId: string,
  ): Promise<Portfolio> {
    const [portfolioResponse, tradesResponse] = await Promise.all([
      fetch(apiUrl("/api/portfolio"), {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fetch(apiUrl("/api/trades"), {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);

    if (!portfolioResponse.ok) {
      throw new Error(await parseErrorMessage(portfolioResponse));
    }

    if (!tradesResponse.ok) {
      throw new Error(await parseErrorMessage(tradesResponse));
    }

    const portfolioPayload = (await portfolioResponse.json()) as Record<
      string,
      unknown
    >;
    const parsedPortfolio = parsePortfolioRow(portfolioPayload);

    if (!parsedPortfolio) throw new Error("Unable to parse portfolio row.");

    const tradesPayload = (await tradesResponse.json()) as {
      trades?: Array<Record<string, unknown>>;
    };

    const parsedTrades = (tradesPayload.trades ?? [])
      .map((row) => parseTradeRow(row))
      .filter((trade): trade is Trade => trade !== null);

    setPortfolio(parsedPortfolio);
    setTrades(parsedTrades);
    writeLocalPortfolio(activeUserId, parsedPortfolio);
    writeLocalTrades(activeUserId, parsedTrades);

    return parsedPortfolio;
  }

  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) return;

    setAuthBusy(true);
    setAuthMessage(null);

    try {
      if (authMode === "signup") {
        if (password !== confirmPassword) {
          setAuthMessage("Passwords do not match.");
          return;
        }

        const { data, error } = await client.auth.signUp({ email, password });
        if (error) throw error;

        if (!data.session) {
          setAuthMessage(
            "Signup succeeded. Check your email confirmation settings or sign in now.",
          );
        }
      } else {
        const { error } = await client.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      }
    } catch (error) {
      setAuthMessage(
        error instanceof Error ? error.message : "Auth request failed.",
      );
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignOut() {
    if (!client) return;
    await client.auth.signOut();
  }

  async function handleTrade(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!userId || !session) return;

    setTradeBusy(true);
    setTradeMessage(null);

    const quantity = Number(quantityInput);
    const quoteUsd = Number(usdInput);
    const activeUserId = userId;

    const effectiveQuantity =
      tradeType === "BUY" && buyMode === "quote_usd"
        ? roundBtc(quoteUsd / price)
        : roundBtc(quantity);

    if (!Number.isFinite(effectiveQuantity) || effectiveQuantity <= 0) {
      setTradeBusy(false);
      setTradeMessage("Enter a valid trade amount.");
      return;
    }

    const totalValue = roundUsd(effectiveQuantity * price);
    if (totalValue <= 0) {
      setTradeBusy(false);
      setTradeMessage("Trade amount is too small after rounding.");
      return;
    }

    const nextPortfolio: Portfolio =
      tradeType === "BUY"
        ? {
            balanceUsd: roundUsd(portfolio.balanceUsd - totalValue),
            btcQuantity: roundBtc(portfolio.btcQuantity + effectiveQuantity),
          }
        : {
            balanceUsd: roundUsd(portfolio.balanceUsd + totalValue),
            btcQuantity: roundBtc(portfolio.btcQuantity - effectiveQuantity),
          };

    if (tradeType === "BUY" && nextPortfolio.balanceUsd < 0) {
      setTradeBusy(false);
      setTradeMessage("Insufficient USD balance for this buy.");
      return;
    }

    if (tradeType === "SELL" && nextPortfolio.btcQuantity < 0) {
      setTradeBusy(false);
      setTradeMessage("Insufficient BTC balance for this sell.");
      return;
    }

    const nextTrade: Trade = {
      id: crypto.randomUUID(),
      type: tradeType,
      price,
      quantity: effectiveQuantity,
      totalValue,
      createdAt: new Date().toISOString(),
    };

    try {
      const endpoint =
        tradeType === "BUY"
          ? apiUrl("/api/trade/buy")
          : apiUrl("/api/trade/sell");
      const payload =
        tradeType === "BUY"
          ? buyMode === "quote_usd"
            ? { quote_usd: roundUsd(quoteUsd) }
            : { quantity: effectiveQuantity }
          : { quantity: effectiveQuantity };

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(await parseErrorMessage(response));
      }

      const refreshedPortfolio = await refreshFromApi(
        session.access_token,
        activeUserId,
      );
      setStorageMode("api");

      const refreshedTotalValue = roundUsd(
        refreshedPortfolio.balanceUsd + refreshedPortfolio.btcQuantity * price,
      );
      const refreshedPnl = roundUsd(refreshedTotalValue - 10000);

      setTradeMessage(
        `${tradeType} executed at $${price.toFixed(2)}. Balance: $${refreshedPortfolio.balanceUsd.toFixed(2)}. P&L: ${refreshedPnl >= 0 ? "+" : ""}$${refreshedPnl.toFixed(2)}.`,
      );
    } catch (error) {
      if (allowOfflineDemo) {
        const nextTrades = [nextTrade, ...trades].slice(0, 25);
        setStorageMode("local");
        setPortfolio(nextPortfolio);
        setTrades(nextTrades);
        writeLocalPortfolio(activeUserId, nextPortfolio);
        writeLocalTrades(activeUserId, nextTrades);

        const offlineTotalValue = roundUsd(
          nextPortfolio.balanceUsd + nextPortfolio.btcQuantity * price,
        );
        const offlinePnl = roundUsd(offlineTotalValue - 10000);

        setTradeMessage(
          `Running in offline demo mode. ${tradeType} simulated at $${price.toFixed(2)}. Balance: $${nextPortfolio.balanceUsd.toFixed(2)}. P&L: ${offlinePnl >= 0 ? "+" : ""}$${offlinePnl.toFixed(2)}.`,
        );
      } else {
        setStorageMode("api");
        setTradeMessage(
          error instanceof Error
            ? `Trade failed: ${error.message}`
            : "Trade failed. Please retry.",
        );
      }
    } finally {
      setTradeBusy(false);
    }
  }

  if (!isSupabaseConfigured()) {
    return (
      <main className="app-shell">
        <h1>TradeLab</h1>
        <p className="error">{MISSING_ENV_MESSAGE}</p>
      </main>
    );
  }

  if (authLoading) {
    return (
      <main className="app-shell loading-shell">
        <h1>TradeLab</h1>
        <p className="muted">Loading session…</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="app-shell auth-shell">
        <section className="hero-card">
          <h1>TradeLab</h1>
          <p className="muted">
            Starter flow for authentication, portfolio, and market trading.
          </p>
        </section>

        <section className="card">
          <div className="auth-mode-row">
            <button
              className={authMode === "signin" ? "active" : ""}
              onClick={() => {
                setAuthMode("signin");
                setAuthMessage(null);
              }}
              type="button"
            >
              Sign in
            </button>
            <button
              className={authMode === "signup" ? "active" : ""}
              onClick={() => {
                setAuthMode("signup");
                setAuthMessage(null);
              }}
              type="button"
            >
              Create account
            </button>
          </div>

          <form onSubmit={handleAuth} className="stack">
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </label>

            <label className="field">
              <span>Password</span>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Minimum 8 characters"
              />
            </label>

            {authMode === "signup" && (
              <label className="field">
                <span>Confirm password</span>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Re-enter your password"
                />
              </label>
            )}

            <button className="primary" type="submit" disabled={authBusy}>
              {authBusy
                ? "Working..."
                : authMode === "signin"
                  ? "Sign in"
                  : "Create account"}
            </button>
          </form>

          {authMessage && <p className="error auth-feedback">{authMessage}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell dashboard-shell">
      <header className="topbar">
        <div>
          <h1>TradeLab</h1>
          <p className="muted">{session.user.email}</p>
        </div>
        <button type="button" className="ghost" onClick={handleSignOut}>
          Sign out
        </button>
      </header>

      {portfolioError && <p className="warning">{portfolioError}</p>}

      <section className="grid">
        <article className="card">
          <h2>Market</h2>
          <p className="big-price">
            ${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </p>
          <p className="muted">
            BTC/USDT • source: {priceSource} • updated{" "}
            {new Date(priceUpdatedAt).toLocaleTimeString()}
          </p>
        </article>

        <article className="card">
          <h2>Portfolio</h2>
          {portfolioLoading ? (
            <p className="muted">Loading portfolio…</p>
          ) : (
            <ul className="stat-list">
              <li>
                <span>USD balance</span>
                <strong>${portfolio.balanceUsd.toFixed(2)}</strong>
              </li>
              <li>
                <span>BTC holding</span>
                <strong>{portfolio.btcQuantity.toFixed(8)} BTC</strong>
              </li>
              <li>
                <span>Total value</span>
                <strong>${totalValueUsd.toFixed(2)}</strong>
              </li>
              <li>
                <span>Unrealized P&L</span>
                <strong className={pnlUsd >= 0 ? "pos" : "neg"}>
                  {pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)}
                </strong>
              </li>
            </ul>
          )}
          <p className="muted">Storage: {storageMode}</p>
        </article>
      </section>

      <section className="card">
        <div className="chart-head">
          <h2>Chart</h2>
          <p className="muted">TradingView BTC/USDT with RSI + MA</p>
        </div>
        <TradingViewChart />
      </section>

      <section className="grid">
        <article className="card">
          <h2>Trade</h2>

          <form className="stack" onSubmit={handleTrade}>
            <div className="segmented">
              <button
                type="button"
                className={tradeType === "BUY" ? "active" : ""}
                onClick={() => setTradeType("BUY")}
              >
                Buy
              </button>
              <button
                type="button"
                className={tradeType === "SELL" ? "active" : ""}
                onClick={() => setTradeType("SELL")}
              >
                Sell
              </button>
            </div>

            {tradeType === "BUY" && (
              <div className="segmented">
                <button
                  type="button"
                  className={buyMode === "quantity" ? "active" : ""}
                  onClick={() => setBuyMode("quantity")}
                >
                  BTC qty
                </button>
                <button
                  type="button"
                  className={buyMode === "quote_usd" ? "active" : ""}
                  onClick={() => setBuyMode("quote_usd")}
                >
                  USD spend
                </button>
              </div>
            )}

            <label className="field">
              <span>BTC quantity</span>
              <input
                type="number"
                min="0"
                step="0.00000001"
                value={quantityInput}
                onChange={(event) => syncFromQuantity(event.target.value)}
                disabled={tradeType === "BUY" && buyMode === "quote_usd"}
              />
            </label>

            <label className="field">
              <span>USD value</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={usdInput}
                onChange={(event) => syncFromUsd(event.target.value)}
                disabled={tradeType === "BUY" && buyMode === "quantity"}
              />
            </label>

            <div className="preview-row">
              <span>Estimated quantity</span>
              <strong>{previewQuantity.toFixed(8)} BTC</strong>
            </div>
            <div className="preview-row">
              <span>Estimated value</span>
              <strong>${previewValueUsd.toFixed(2)}</strong>
            </div>

            <button type="submit" className="primary" disabled={tradeBusy}>
              {tradeBusy ? "Submitting..." : `Execute ${tradeType}`}
            </button>
          </form>

          {tradeMessage && <p className="muted">{tradeMessage}</p>}
        </article>

        <article className="card">
          <h2>Recent trades</h2>
          {tradeHistoryLoading && <p className="muted">Loading trades…</p>}
          {!tradeHistoryLoading && trades.length === 0 && (
            <p className="muted">No trades yet. Place your first order.</p>
          )}
          {!tradeHistoryLoading && trades.length > 0 && (
            <ul className="trade-list">
              {trades.map((trade) => (
                <li key={trade.id}>
                  <div>
                    <strong>{trade.type}</strong>
                    <span className="muted">
                      {" "}
                      {new Date(trade.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="muted">
                    {trade.quantity.toFixed(8)} BTC @ ${trade.price.toFixed(2)}{" "}
                    = ${trade.totalValue.toFixed(2)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>
    </main>
  );
}
