/* =======================================
NIFTY BACKEND
ANGEL ONE MIGRATION
======================================= */

const express = require("express");
const cors = require("cors");
require("dotenv").config();
const axios = require("axios");
const puppeteer = require("puppeteer-core");
const env = (key) => String(process.env[key] || "").trim();



const app = express();

app.use(cors());

app.use((req,res,next)=>{
res.header(
"Access-Control-Allow-Origin",
"*"
);

res.header(
"Access-Control-Allow-Headers",
"*"
);

next();
});

const CONFIG = {
  APP_NAME: "NIFTY_BACKEND",
  PORT: Number(env("PORT") || 3000),
  VERSION: "2.0.0",
  API_PREFIX: "/api",
  TIMEZONE: "Asia/Kolkata",
  JSON_SPACE: 2,
  MAX_BODY: "256kb",
  FETCH_TIMEOUT: 4000,
CACHE_MS: 2000,
POLL_MS: 2000,
AUTH_REFRESH_MS: 15 * 60 * 1000,
  STRIKE_STEP: 50,
  STRIKE_RANGE: 3,
  MARKET_OPEN: 9,
  MARKET_OPEN_MIN: 15,
  MARKET_CLOSE: 15,
  MARKET_CLOSE_MIN: 30,
  ALLOW_ORIGIN: "*",
  API_VERSION: "v1",
  SOURCE: "NSE Option Chain",
};

function must(name, value) {
  if (!value) {
    throw new Error(`Missing ${name} in .env`);
  }
  return value;
}



app.disable("x-powered-by");

app.use((req, res, next) => {
  const start = Date.now();
  res.setHeader("Access-Control-Allow-Origin", CONFIG.ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("X-API-Version", CONFIG.API_VERSION);
  if (req.method === "OPTIONS") return res.sendStatus(204);

  res.on("finish", () => {
    console.log("[RES]", req.method, req.url, Date.now() - start, "ms");
  });
  next();
});

app.use(express.json({ limit: CONFIG.MAX_BODY }));
app.use(express.urlencoded({ extended: true, limit: CONFIG.MAX_BODY }));

const runtime = {
  startedAt: Date.now(),
  requests: 0,
  errors: 0,
  lastRequest: null,
  healthy: true,
  cache: null,
  cacheTime: 0,
  lastSuccess: 0,
  lastFail: 0,
  recovered: true
};
const nseState = {
  browser: null,
  cookieHeader: "",
  cookieAt: 0,
  refreshPromise: null,
  sessionPromise: null,
};
function now() {
  return new Date().toLocaleString("en-IN", { timeZone: CONFIG.TIMEZONE });
}

function uptime() {
  return Math.floor((Date.now() - runtime.startedAt) / 1000);
}

function success(data = {}, code = 200) {
  return { ok: true, code, data };
}

function fail(msg, code = 500) {
  runtime.errors++;
  return { ok: false, code, error: msg };
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pick(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function sum(arr, fn) {
  return arr.reduce((acc, item) => acc + toNumber(fn(item), 0), 0);
}

function roundATM(spot) {
  return Math.round(spot / CONFIG.STRIKE_STEP) * CONFIG.STRIKE_STEP;
}

function getMarketStatus() {
  const day = new Date().toLocaleString("en-US", {
    weekday: "short",
    timeZone: CONFIG.TIMEZONE,
  });

  if (day === "Sat" || day === "Sun") return "CLOSED";

  const nowDate = new Date();
  const h = Number(
    nowDate.toLocaleString("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: CONFIG.TIMEZONE,
    })
  );
  const m = Number(
    nowDate.toLocaleString("en-US", {
      minute: "numeric",
      timeZone: CONFIG.TIMEZONE,
    })
  );

  const mins = h * 60 + m;
  const start = CONFIG.MARKET_OPEN * 60 + CONFIG.MARKET_OPEN_MIN;
  const end = CONFIG.MARKET_CLOSE * 60 + CONFIG.MARKET_CLOSE_MIN;

  return mins >= start && mins <= end ? "OPEN" : "CLOSED";
}

function calcImaginaryLine(spot, rows) {
  if (!rows.length) return null;

  for (let i = 0; i < rows.length; i++) {
    const strike = rows[i].strike;
    if (Math.abs(spot - strike) < 0.01) {
      return {
        index: Math.min(i + 1, rows.length - 1),
        mode: "between",
      };
    }
    if (spot < strike) {
      return { index: i, mode: "normal" };
    }
  }

  return {
    index: Math.max(0, rows.length - 1),
    mode: "end",
  };
}

function normalizeSide(side) {
  const vol = pick(
    side?.volume,
    side?.totalTradedVolume,
    side?.tradedVolume,
    side?.vol,
    side?.volumeTraded
  );
  const oi = pick(side?.oi, side?.openInterest, side?.open_interest);
  const oiChg = pick(
    side?.changeinOpenInterest,
    side?.changeInOpenInterest,
    side?.changeInOI,
    side?.changeinOI,
    side?.changeInOi,
    side?.changeInOi,
    side?.oiChange,
    side?.change,
    side?.chgInOI
  );
  const ltp = pick(
    side?.last_price,
    side?.lastPrice,
    side?.ltp,
    side?.lastTradedPrice,
    side?.last_trade_price,
    side?.closePrice
  );
  const prevOi = pick(side?.previous_oi, side?.previousOi, side?.prevOi);

  return {
    vol: toNumber(vol, 0),
    oi: toNumber(oi, 0),
    oiChg:
      oiChg !== undefined
        ? toNumber(oiChg, 0)
        : prevOi !== undefined
          ? toNumber(oi, 0) - toNumber(prevOi, 0)
          : 0,
    ltp: toNumber(ltp, 0),
  };
}

function extractEntries(raw) {
  const root = raw?.data ?? raw ?? {};

  // 1) array directly available
  const candidates = [
    root.records?.data,
    root.data,
    root.oc,
    root.optionChain,
    root.optionchain,
    root.result,
    root.payload,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  // 2) keyed object by strike
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      const values = Object.values(candidate);
      if (
        values.length &&
        values.every(
          (v) =>
            v &&
            typeof v === "object" &&
            ("CE" in v ||
              "ce" in v ||
              "PE" in v ||
              "pe" in v ||
              "strikePrice" in v ||
              "strike" in v)
        )
      ) {
        return values;
      }
    }
  }

  return [];
}

function extractSpot(raw) {
  const root = raw?.data ?? raw ?? {};
  return toNumber(
    pick(
      root.underlyingValue,
      root.underlying_value,
      root.last_price,
      root.lastPrice,
      root.ltp,
      root.spot,
      root.spotPrice,
      root.indexValue,
      root.index_value,
      root.underlyingLtp,
      root.underlyingLTP
    ),
    0
  );
}

function normalizeRow(entry) {
  const strike = toNumber(
    pick(
      entry?.strikePrice,
      entry?.strike,
      entry?.strike_price,
      entry?.strikePriceValue
    ),
    NaN
  );

  if (!Number.isFinite(strike)) return null;

  const ceRaw = entry?.CE ?? entry?.ce ?? entry?.call ?? entry?.calls;
  const peRaw = entry?.PE ?? entry?.pe ?? entry?.put ?? entry?.puts;

  const ce = normalizeSide(ceRaw);
  const pe = normalizeSide(peRaw);

  return {
    strike,
    ceVol: ce.vol,
    ceOi: ce.oi,
    ceOiChg: ce.oiChg,
    ceLtp: ce.ltp,
    ceRev: strike + 25,
    peRev: strike - 25,
    peLtp: pe.ltp,
    peVol: pe.vol,
    peOi: pe.oi,
    peOiChg: pe.oiChg,
  };
}

function buildSelectedRows(allRows, spot) {
  const strikes = [...new Set(allRows.map((r) => r.strike))].sort((a, b) => a - b);
  if (!strikes.length) return { atm: 0, rows: [], selected: [] };

  const atm = roundATM(spot || strikes[Math.floor(strikes.length / 2)] || strikes[0]);

  let nearestIndex = 0;
  let best = Infinity;
  strikes.forEach((strike, i) => {
    const d = Math.abs(strike - atm);
    if (d < best) {
      best = d;
      nearestIndex = i;
    }
  });

  const start = Math.max(0, nearestIndex - CONFIG.STRIKE_RANGE);
  const end = Math.min(strikes.length, nearestIndex + CONFIG.STRIKE_RANGE + 1);
  const selected = strikes.slice(start, end);

  const byStrike = new Map(allRows.map((r) => [r.strike, r]));
  const rows = selected.map((strike) => byStrike.get(strike) || {
    strike,
    ceVol: 0,
    ceOi: 0,
    ceOiChg: 0,
    ceLtp: 0,
    ceRev: strike + 25,
    peRev: strike - 25,
    peLtp: 0,
    peVol: 0,
    peOi: 0,
    peOiChg: 0,
  });

  return { atm, rows, selected };
}

function buildSummary(allRows) {
  const totalCeOiChg = sum(allRows, (r) => r.ceOiChg);
  const totalCeOi = sum(allRows, (r) => r.ceOi);
  const totalCeVol = sum(allRows, (r) => r.ceVol);
  const totalCeLtp = sum(allRows, (r) => r.ceLtp);

  const totalPeOiChg = sum(allRows, (r) => r.peOiChg);
  const totalPeOi = sum(allRows, (r) => r.peOi);
  const totalPeVol = sum(allRows, (r) => r.peVol);
  const totalPeLtp = sum(allRows, (r) => r.peLtp);

  return {
    totalCeOiChg,
    totalCeOi,
    totalCeVol,
    totalCeLtp,
    peCeOiChg: totalPeOiChg - totalCeOiChg,
    totalPeLtp,
    totalPeVol,
    totalPeOi,
    totalPeOiChg,
  };
}

function parseSmartApiOptionChain(raw) {
  const spot = extractSpot(raw);
  const entries = extractEntries(raw);
  const allRows = entries.map(normalizeRow).filter(Boolean);

  if (!allRows.length) {
    throw new Error("Empty option chain payload");
  }

  const { atm, rows } = buildSelectedRows(allRows, spot);
  const imaginaryLine = calcImaginaryLine(spot, rows);
  const summary = buildSummary(allRows);

  const nowDate = new Date();

  return {
    date: nowDate.toLocaleDateString("en-CA"),
    time: nowDate.toLocaleTimeString("en-IN", { hour12: true }),
    spot,
    atm,
    market: getMarketStatus(),
    imaginaryLine,
    rows,
    summary,
  };
}
async function ensureNSESession() {
  const fresh =
    nseState.cookieHeader &&
    Date.now() - nseState.cookieAt < CONFIG.AUTH_REFRESH_MS;

  if (fresh) return nseState.cookieHeader;

  if (nseState.sessionPromise) {
    return nseState.sessionPromise;
  }

  nseState.sessionPromise = (async () => {
    try {
      if (!nseState.browser) {
        nseState.browser = await puppeteer.launch({
          executablePath: "/data/data/com.termux/files/usr/bin/chromium-browser",
          headless: true,
          ignoreHTTPSErrors: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-features=IsolateOrigins",
            "--disable-site-isolation-trials"
          ]
        });
      }

      const page = await nseState.browser.newPage();
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(8000);

      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
      );

      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9"
      });

      await page.goto("https://www.nseindia.com", {
        waitUntil: "domcontentloaded",
        timeout: 8000
      });

      const cookies = await page.cookies("https://www.nseindia.com");

      nseState.cookieHeader = cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");

      nseState.cookieAt = Date.now();

      await page.close();
      return nseState.cookieHeader;
    } catch (e) {
      try {
        if (nseState.browser) {
          const pages = await nseState.browser.pages();
          await Promise.all(
            pages.map((p) => p.close().catch(() => {}))
          );
        }
      } catch {}
      throw e;
    } finally {
      nseState.sessionPromise = null;
    }
  })();

  return nseState.sessionPromise;
}
async function fetchNSEOptionChain() {
const nseStart =
  Date.now();
  const cookieHeader = await ensureNSESession();

  const response = await axios.get(
    "https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=09-Jun-2026",
    {
      timeout: CONFIG.FETCH_TIMEOUT,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.nseindia.com/option-chain",
        "Origin": "https://www.nseindia.com",
        "Connection": "keep-alive",
        "Cookie": cookieHeader
      }
    }
  );
console.log(
  "[NSE API]",
  Date.now() - nseStart,
  "ms"
);
  return response.data;
}
async function fetchNSEParsed() {

  const raw =
    await fetchNSEOptionChain();

  const spot =
raw?.records?.data?.[0]?.CE?.underlyingValue ||
raw?.records?.data?.[0]?.PE?.underlyingValue ||
0;

  const entries =
raw?.records?.data || [];

  const allRows =
    entries
      .map(normalizeRow)
      .filter(Boolean);

  const {
    atm,
    rows
  } =
    buildSelectedRows(
      allRows,
      spot
    );

  const imaginaryLine =
    calcImaginaryLine(
      spot,
      rows
    );

  const summary =
    buildSummary(
      allRows
    );

  const nowDate =
    new Date();

  return {

    date:
      nowDate.toLocaleDateString(
        "en-CA"
      ),

    time:
      nowDate.toLocaleTimeString(
        "en-IN",
        {
          hour12:true
        }
      ),

    spot,

    atm,

    market:
      getMarketStatus(),

    imaginaryLine,

    rows,

    summary

  };

}
function makeEmptyPayload(message = "Waiting for data") {
  return {
    date: "--",
    time: "--",
    spot: 0,
    atm: 0,
    market: "UNKNOWN",
    imaginaryLine: null,
    rows: [],
    summary: {
      totalCeOiChg: 0,
      totalCeOi: 0,
      totalCeVol: 0,
      totalCeLtp: 0,
      peCeOiChg: 0,
      totalPeLtp: 0,
      totalPeVol: 0,
      totalPeOi: 0,
      totalPeOiChg: 0,
    },
    error: message,
    server: {
      version: CONFIG.VERSION,
      healthy: false,
      source: CONFIG.SOURCE,
      authAgeMs: 0,
    },
  };
}

async function getNiftyPayload() {
  const wrap = (parsed) => ({
    ...parsed,
    server: {
      version: CONFIG.VERSION,
      healthy: runtime.recovered,
      source: CONFIG.SOURCE,
      authAgeMs: 0,
    },
  });

  if (runtime.cache) {
    if (
      !runtime.refreshPromise &&
      Date.now() - runtime.cacheTime >= CONFIG.CACHE_MS
    ) {
      runtime.refreshPromise = (async () => {
        try {
          const parsed = await fetchNSEParsed();
          const payload = wrap(parsed);
          runtime.cache = payload;
          runtime.cacheTime = Date.now();
          runtime.lastSuccess = Date.now();
          runtime.recovered = true;
        } catch (e) {
          runtime.recovered = false;
          runtime.lastFail = Date.now();
        } finally {
          runtime.refreshPromise = null;
        }
      })();
    }

    return runtime.cache;
  }

  if (!runtime.refreshPromise) {
    runtime.refreshPromise = (async () => {
      try {
        const parsed = await fetchNSEParsed();
        const payload = wrap(parsed);
        runtime.cache = payload;
        runtime.cacheTime = Date.now();
        runtime.lastSuccess = Date.now();
        runtime.recovered = true;
        return payload;
      } catch (e) {
        runtime.recovered = false;
        runtime.lastFail = Date.now();
        return null;
      } finally {
        runtime.refreshPromise = null;
      }
    })();
  }

  const first = await Promise.race([
    runtime.refreshPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
  ]);

  return first || runtime.cache || makeEmptyPayload();
}
getNiftyPayload().catch(() => {});

app.use((req, _res, next) => {
  runtime.requests++;
  runtime.lastRequest = Date.now();
  console.log("[REQ]", req.method, req.url);
  next();
});

app.get("/", (_req, res) => {
  res.status(200).json(
    success({
      message: "Backend Running",
      server: CONFIG.APP_NAME,
      version: CONFIG.VERSION,
      source: CONFIG.SOURCE,
    })
  );
});

app.get("/health", (_req, res) => {
  return res.status(200).json(
    success({
      status: runtime.healthy ? "healthy" : "down",
      time: now(),
      uptime: uptime(),
      requests: runtime.requests,
      errors: runtime.errors,
      cache: Boolean(runtime.cache),
      cacheAge: runtime.cacheTime ? Date.now() - runtime.cacheTime : 0,
      lastSuccess: runtime.lastSuccess,
      lastFail: runtime.lastFail,
      recovered: runtime.recovered,
      source: CONFIG.SOURCE,
      authAgeMs: 0,
    })
  );
});

app.get(
"/debug-time",
(_req,res)=>{

res.json({

cacheAge:
Date.now()
-
runtime.cacheTime,

lastSuccess:
runtime.lastSuccess,

lastFail:
runtime.lastFail,

cookieAge:
Date.now()
-
nseState.cookieAt

});

});

app.get(`${CONFIG.API_PREFIX}/nifty`, async (_req, res) => {
  try {
    const payload = await getNiftyPayload();
    return res.status(200).json(payload);
 } catch (e) {
    runtime.recovered = false;
    runtime.lastFail = Date.now();

    if (runtime.cache) {
      return res.status(200).json({
        ...runtime.cache,
        server: {
          ...(runtime.cache.server || {}),
          version: CONFIG.VERSION,
          healthy: false,
          source: CONFIG.SOURCE,
          authAgeMs: 0,
        },
        error: e.message,
      });
    }

    return res.status(500).json({
      date: "--",
      time: "--",
      spot: 0,
      atm: 0,
      market: "UNKNOWN",
      imaginaryLine: null,
      rows: [],
      summary: {
        totalCeOiChg: 0,
        totalCeOi: 0,
        totalCeVol: 0,
        totalCeLtp: 0,
        peCeOiChg: 0,
        totalPeLtp: 0,
        totalPeVol: 0,
        totalPeOi: 0,
        totalPeOiChg: 0,
      },
      error: e.message,
      server: {
        healthy: false,
        source: CONFIG.SOURCE,
      },
    });
  }
});

app.use((_req, res) => {
  res.status(404).json(fail("Route Not Found", 404));
});

app.use((err, _req, res, _next) => {
  console.log("[ERROR]", err);
  res.status(500).json(fail("Internal Error"));
});

let server = app.listen(
CONFIG.PORT,
"0.0.0.0", () => {
  console.log("================");
  console.log("NIFTY BACKEND");
  console.log("PORT:", CONFIG.PORT);
  console.log("TIME:", now());
  console.log("API:", `${CONFIG.API_PREFIX}/nifty`);
  console.log("HEALTH:", "/health");
  console.log("SOURCE:", CONFIG.SOURCE);
  console.log("READY");
  console.log("================");
});

// Prime auth in the background; fail fast only in logs.


process.on("SIGINT", async () => {
  console.log("\nStopping...");
  try {
    if (nseState.browser) {
      await nseState.browser.close();
    }
  } catch {}
  if (server) {
    server.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
});

process.on("uncaughtException", (e) => {
  console.log("[CRASH]", e.message);
});
