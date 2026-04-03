import "dotenv/config";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, "../dist");
const PORT = Number(process.env.PORT ?? 3000);
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  process.env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
const supabaseOrigin = (() => {
  if (!SUPABASE_URL) return null;
  try {
    return new URL(SUPABASE_URL).origin;
  } catch {
    return null;
  }
})();

const isProduction = process.env.NODE_ENV === "production";
const corsOrigins = (
  process.env.CORS_ORIGIN ??
  (isProduction ? "*" : "http://localhost:5173,http://127.0.0.1:5173")
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowAnyOrigin = corsOrigins.includes("*");

const connectSrc = [
  "'self'",
  "https://api.binance.com",
  "https://api.coinbase.com",
  "https://*.supabase.co",
  "wss://*.supabase.co",
  "https://*.tradingview.com",
  "wss://*.tradingview.com",
  "https://s3.tradingview.com",
];
if (supabaseOrigin) {
  connectSrc.push(supabaseOrigin);
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://s3.tradingview.com",
          "https://*.tradingview.com",
        ],
        styleSrc: ["'self'", "'unsafe-inline'", "https:"],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'", "data:", "https:"],
        connectSrc,
        frameSrc: ["'self'", "https://*.tradingview.com"],
      },
    },
  }),
);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowAnyOrigin) return callback(null, true);
      if (corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS origin not allowed"));
    },
  }),
);
app.use(express.json());
app.use(
  "/api",
  rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    max: Number(process.env.RATE_LIMIT_MAX ?? 120),
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "Missing SUPABASE_URL/SUPABASE_ANON_KEY (or VITE_SUPABASE_* fallback) in environment.",
  );
}

const adminAuthClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const PRICE_TTL_MS = 2500;
const STARTING_PRICE = 65000;
let priceCache = {
  value: STARTING_PRICE,
  source: "boot",
  updatedAt: null,
};

function hasValidCachedPrice() {
  return (
    Number.isFinite(priceCache.value) &&
    priceCache.value > 0 &&
    priceCache.updatedAt
  );
}

function roundUsd(value) {
  return Math.round(value * 100) / 100;
}

function roundBtc(value) {
  return Math.round(value * 1e8) / 1e8;
}

function parseNumeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function authTokenFromHeader(headerValue) {
  if (!headerValue || !headerValue.startsWith("Bearer ")) return null;
  return headerValue.slice("Bearer ".length).trim();
}

function createUserClient(token) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

async function getLatestPrice() {
  const now = Date.now();
  const age =
    typeof priceCache.updatedAt === "string"
      ? now - new Date(priceCache.updatedAt).getTime()
      : Number.POSITIVE_INFINITY;
  if (hasValidCachedPrice() && age <= PRICE_TTL_MS) {
    return priceCache;
  }

  const providers = [
    {
      name: "binance",
      url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
      parse(payload) {
        return parseNumeric(payload?.price);
      },
    },
    {
      name: "coinbase",
      url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
      parse(payload) {
        return parseNumeric(payload?.data?.amount);
      },
    },
  ];

  try {
    for (const provider of providers) {
      const response = await fetch(provider.url);
      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      const price = provider.parse(payload);
      if (!Number.isFinite(price) || price <= 0) {
        continue;
      }

      priceCache = {
        value: price,
        source: provider.name,
        updatedAt: new Date().toISOString(),
      };

      return priceCache;
    }

    throw new Error("No market provider returned a valid BTC price");
  } catch (error) {
    if (hasValidCachedPrice()) {
      priceCache = {
        value: priceCache.value,
        source: "stale-cache",
        updatedAt: priceCache.updatedAt,
      };
      return priceCache;
    }

    priceCache = {
      value: STARTING_PRICE,
      source: "fallback",
      updatedAt: new Date().toISOString(),
    };
    return priceCache;
  }

  return priceCache;
}

async function requireAuth(req, res, next) {
  const token = authTokenFromHeader(req.headers.authorization);
  if (!token) {
    return res.status(401).json({ error: "Missing bearer token" });
  }

  const { data, error } = await adminAuthClient.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  req.auth = {
    token,
    userId: data.user.id,
    userEmail: data.user.email ?? null,
  };

  return next();
}

function normalizeTrade(row) {
  return {
    id: row.id,
    type: row.type,
    price: parseNumeric(row.price),
    quantity: parseNumeric(row.quantity),
    total_value: parseNumeric(row.total_value),
    created_at: row.created_at,
  };
}

function normalizeTradeFromRpc(row) {
  return {
    id: row.trade_id,
    type: row.trade_type,
    price: parseNumeric(row.trade_price),
    quantity: parseNumeric(row.trade_quantity),
    total_value: parseNumeric(row.trade_total_value),
    created_at: row.trade_created_at,
  };
}

function normalizePortfolioFromRpc(row) {
  return {
    balance_usd: parseNumeric(row.balance_usd),
    btc_quantity: parseNumeric(row.btc_quantity),
  };
}

function ensureRpcRow(data, rpcName) {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`${rpcName} returned no rows`);
  }

  return data[0];
}

function mapRpcError(error, fallbackMessage) {
  if (!(error instanceof Error)) return fallbackMessage;

  if (
    (error.message.includes("function") &&
      error.message.includes("does not exist")) ||
    error.message.includes("Could not find the function") ||
    error.message.includes("schema cache")
  ) {
    return "Trade RPC not installed. Run the SQL setup shown in the frontend warning panel.";
  }

  if (error.message.includes("permission denied")) {
    return "Supabase permissions missing. Re-run the SQL setup script in Supabase SQL editor.";
  }

  if (error.message.includes("is ambiguous")) {
    return "Supabase trade function is outdated. Re-run server/sql/supabase_setup.sql in Supabase SQL editor.";
  }

  if (error.message.includes("Insufficient USD balance")) {
    return "Insufficient USD balance";
  }

  if (error.message.includes("Insufficient BTC balance")) {
    return "Insufficient BTC balance";
  }

  if (
    error.message.includes("Invalid quantity") ||
    error.message.includes("Invalid price")
  ) {
    return "Invalid trade request";
  }

  return error.message;
}

async function checkRpcExists(rpcName) {
  const probeClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { error } = await probeClient.rpc(rpcName, {
    p_user_id: "00000000-0000-0000-0000-000000000000",
    p_quantity: 0.01,
    p_price: 65000,
  });

  if (!error) {
    return { ok: true, state: "ok", verified: true };
  }

  if (error.message.includes("Could not find the function")) {
    return {
      ok: false,
      state: "missing",
      verified: false,
      message: error.message,
    };
  }

  if (error.message.includes("Not authorized")) {
    return {
      ok: true,
      state: "installed-unverified",
      verified: false,
      message: error.message,
    };
  }

  return { ok: false, state: "error", verified: false, message: error.message };
}

async function ensurePortfolio(userClient, userId) {
  const { data, error } = await userClient
    .from("portfolios")
    .select("balance_usd, btc_quantity")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (data) {
    return {
      balance_usd: parseNumeric(data.balance_usd),
      btc_quantity: parseNumeric(data.btc_quantity),
    };
  }

  const { data: created, error: createError } = await userClient
    .from("portfolios")
    .insert({
      user_id: userId,
      balance_usd: 10000,
      btc_quantity: 0,
      updated_at: new Date().toISOString(),
    })
    .select("balance_usd, btc_quantity")
    .single();

  if (createError || !created) {
    throw new Error(createError?.message ?? "Unable to create portfolio");
  }

  return {
    balance_usd: parseNumeric(created.balance_usd),
    btc_quantity: parseNumeric(created.btc_quantity),
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/market/price", async (_req, res) => {
  try {
    const price = await getLatestPrice();
    return res.json({
      symbol: "BTCUSDT",
      price: price.value,
      source: price.source,
      updated_at: price.updatedAt,
    });
  } catch (error) {
    return res.status(503).json({
      error:
        error instanceof Error
          ? error.message
          : "Market price temporarily unavailable",
    });
  }
});

app.get("/api/readiness", async (_req, res) => {
  const allowUnverifiedRpcReady =
    process.env.ALLOW_UNVERIFIED_RPC_READY === "true" || !isProduction;
  const checks = {
    env: {
      ok: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY),
    },
    market: {
      ok: true,
      source: "unknown",
      updated_at: null,
    },
    rpc_buy: {
      ok: false,
      state: "unknown",
      verified: false,
      message: null,
    },
    rpc_sell: {
      ok: false,
      state: "unknown",
      verified: false,
      message: null,
    },
  };

  try {
    const latestPrice = await getLatestPrice();
    checks.market.ok =
      Number.isFinite(latestPrice.value) && latestPrice.value > 0;
    checks.market.source = latestPrice.source;
    checks.market.updated_at = latestPrice.updatedAt;
  } catch (error) {
    checks.market.ok = false;
    checks.market.source = "error";
    checks.market.updated_at =
      error instanceof Error ? error.message : "market check failed";
  }

  const [buy, sell] = await Promise.all([
    checkRpcExists("execute_market_buy"),
    checkRpcExists("execute_market_sell"),
  ]);

  checks.rpc_buy = {
    ok: buy.ok,
    state: buy.state,
    verified: buy.verified,
    message: buy.message ?? null,
  };

  checks.rpc_sell = {
    ok: sell.ok,
    state: sell.state,
    verified: sell.verified,
    message: sell.message ?? null,
  };

  const allOk =
    checks.env.ok &&
    checks.market.ok &&
    checks.rpc_buy.ok &&
    checks.rpc_sell.ok &&
    (allowUnverifiedRpcReady || checks.rpc_buy.verified) &&
    (allowUnverifiedRpcReady || checks.rpc_sell.verified);

  return res.status(allOk ? 200 : 503).json({
    ready: allOk,
    checks,
  });
});

app.get("/api/portfolio", requireAuth, async (req, res) => {
  try {
    const userClient = createUserClient(req.auth.token);
    const portfolio = await ensurePortfolio(userClient, req.auth.userId);
    const latestPrice = await getLatestPrice();

    const totalValueUsd = roundUsd(
      portfolio.balance_usd + portfolio.btc_quantity * latestPrice.value,
    );

    return res.json({
      balance_usd: portfolio.balance_usd,
      btc_quantity: portfolio.btc_quantity,
      total_value_usd: totalValueUsd,
      unrealized_pnl: roundUsd(totalValueUsd - 10000),
      price: latestPrice.value,
      price_source: latestPrice.source,
      price_updated_at: latestPrice.updatedAt,
    });
  } catch (error) {
    return res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Could not load portfolio. Ensure Supabase tables and RLS are configured.",
    });
  }
});

app.get("/api/trades", requireAuth, async (req, res) => {
  try {
    const userClient = createUserClient(req.auth.token);

    const { data, error } = await userClient
      .from("trades")
      .select("id, type, price, quantity, total_value, created_at")
      .eq("user_id", req.auth.userId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      throw new Error(error.message);
    }

    return res.json({
      trades: (data ?? []).map(normalizeTrade),
    });
  } catch (error) {
    return res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Could not load trades. Ensure Supabase tables and RLS are configured.",
    });
  }
});

app.post("/api/trade/buy", requireAuth, async (req, res) => {
  try {
    const quantityInput = req.body?.quantity;
    const quoteUsdInput = req.body?.quote_usd;

    const hasQuantity = quantityInput !== undefined && quantityInput !== null;
    const hasQuoteUsd = quoteUsdInput !== undefined && quoteUsdInput !== null;

    if (hasQuantity === hasQuoteUsd) {
      return res.status(400).json({
        error: "Provide exactly one of quantity or quote_usd",
      });
    }

    const userClient = createUserClient(req.auth.token);
    await ensurePortfolio(userClient, req.auth.userId);
    const latestPrice = await getLatestPrice();

    let quantity = hasQuantity
      ? roundBtc(parseNumeric(quantityInput))
      : roundBtc(parseNumeric(quoteUsdInput) / latestPrice.value);

    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Invalid buy amount" });
    }

    const totalValue = roundUsd(quantity * latestPrice.value);
    if (totalValue <= 0) {
      return res.status(400).json({ error: "Trade amount too small" });
    }

    const { data: rpcRows, error: rpcError } = await userClient.rpc(
      "execute_market_buy",
      {
        p_user_id: req.auth.userId,
        p_quantity: quantity,
        p_price: latestPrice.value,
      },
    );

    if (rpcError) {
      throw new Error(rpcError.message);
    }

    const rpcRow = ensureRpcRow(rpcRows, "execute_market_buy");
    const trade = normalizeTradeFromRpc(rpcRow);
    const portfolio = normalizePortfolioFromRpc(rpcRow);

    const totalValueUsd = roundUsd(
      portfolio.balance_usd + portfolio.btc_quantity * latestPrice.value,
    );

    return res.json({
      trade,
      portfolio: {
        ...portfolio,
        total_value_usd: totalValueUsd,
        unrealized_pnl: roundUsd(totalValueUsd - 10000),
      },
      price: latestPrice.value,
      price_source: latestPrice.source,
      price_updated_at: latestPrice.updatedAt,
    });
  } catch (error) {
    const message = mapRpcError(
      error,
      "Buy failed. Ensure Supabase tables and RLS are configured.",
    );

    const statusCode =
      message === "Insufficient USD balance" ||
      message === "Invalid trade request"
        ? 400
        : 500;

    return res.status(statusCode).json({
      error: message,
    });
  }
});

app.post("/api/trade/sell", requireAuth, async (req, res) => {
  try {
    const quantity = roundBtc(parseNumeric(req.body?.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Invalid sell quantity" });
    }

    const userClient = createUserClient(req.auth.token);
    await ensurePortfolio(userClient, req.auth.userId);
    const latestPrice = await getLatestPrice();

    const { data: rpcRows, error: rpcError } = await userClient.rpc(
      "execute_market_sell",
      {
        p_user_id: req.auth.userId,
        p_quantity: quantity,
        p_price: latestPrice.value,
      },
    );

    if (rpcError) {
      throw new Error(rpcError.message);
    }

    const rpcRow = ensureRpcRow(rpcRows, "execute_market_sell");
    const trade = normalizeTradeFromRpc(rpcRow);
    const portfolio = normalizePortfolioFromRpc(rpcRow);

    const totalValueUsd = roundUsd(
      portfolio.balance_usd + portfolio.btc_quantity * latestPrice.value,
    );

    return res.json({
      trade,
      portfolio: {
        ...portfolio,
        total_value_usd: totalValueUsd,
        unrealized_pnl: roundUsd(totalValueUsd - 10000),
      },
      price: latestPrice.value,
      price_source: latestPrice.source,
      price_updated_at: latestPrice.updatedAt,
    });
  } catch (error) {
    const message = mapRpcError(
      error,
      "Sell failed. Ensure Supabase tables and RLS are configured.",
    );

    const statusCode =
      message === "Insufficient BTC balance" ||
      message === "Invalid trade request"
        ? 400
        : 500;

    return res.status(statusCode).json({ error: message });
  }
});

if (isProduction) {
  app.use(express.static(distPath));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) {
      return next();
    }
    return res.sendFile(path.join(distPath, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`TradeLab API listening on http://localhost:${PORT}`);
});
