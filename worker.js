const BYBIT = "https://api.bybit.com";

const VERSION = "PUMP-SCANNER-BYBIT-PPR-V13";

const TF = "15";
const KLINE_LIMIT = 120;
const SCAN_BATCH = 20;

const MIN_PUMP_PERCENT = 6;
const MIN_VOLUME_MULTIPLIER = 1.5;
const MIN_PUMP_CANDLES = 2;
const MAX_PUMP_CANDLES = 6;
const MIN_GREEN_RATIO = 0.60;
const MAX_PULLBACK_PERCENT = 4.5;
const NEAR_ZONE_PERCENT = 0.35;
const MAX_PUMP_AGE_HOURS = 12;

const TRADE_HISTORY_MS = 24 * 60 * 60 * 1000;
const TRADE_HISTORY_MAX = 100000;

const RECENT_TRADE_LIMIT_LINEAR = 1000;
const RECENT_TRADE_LIMIT_SPOT = 60;

const tradeHistory = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));

const n = v => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, n(v)));

const avg = a => {
  const x = (a || []).filter(Number.isFinite);
  return x.length ? x.reduce((s, v) => s + v, 0) / x.length : 0;
};

const pct = (a, b) => {
  a = n(a);
  b = n(b);
  return b ? ((a - b) / b) * 100 : 0;
};

const absPct = (a, b) => Math.abs(pct(a, b));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-allow-headers": "*",
      "cache-control": "no-store"
    }
  });
}

function errorJson(message, status = 500, extra = {}) {
  return json({
    ok: false,
    error: message,
    ...extra,
    generatedAt: Date.now()
  }, status);
}

async function bybit(path, params = {}) {
  const u = new URL(BYBIT + path);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      u.searchParams.set(k, String(v));
    }
  }

  const r = await fetch(u.toString(), {
    method: "GET",
    headers: {
      "accept": "application/json"
    }
  });

  if (!r.ok) {
    throw new Error(`Bybit HTTP ${r.status}`);
  }

  const d = await r.json();

  if (d.retCode !== 0) {
    throw new Error(d.retMsg || `Bybit error ${d.retCode}`);
  }

  return d;
}

/* =========================
   KLINES
========================= */

async function klines(category, symbol, interval = "1", limit = 120) {
  const d = await bybit("/v5/market/kline", {
    category,
    symbol,
    interval,
    limit
  });

  const rows = d?.result?.list || [];

  return rows
    .map(x => ({
      start: n(x[0]),
      open: n(x[1]),
      high: n(x[2]),
      low: n(x[3]),
      close: n(x[4]),
      volume: n(x[5]),
      turnover: n(x[6])
    }))
    .sort((a, b) => a.start - b.start);
}

/* =========================
   INDICATORS
========================= */

function sma(values, period) {
  const a = values || [];
  if (a.length < period) return null;

  const x = a.slice(-period);
  return avg(x);
}

function ema(values, period) {
  const a = values || [];
  if (!a.length) return null;

  const k = 2 / (period + 1);
  let e = a[0];

  for (let i = 1; i < a.length; i++) {
    e = a[i] * k + e * (1 - k);
  }

  return e;
}

function stddev(values) {
  const a = values || [];
  if (!a.length) return 0;

  const m = avg(a);
  return Math.sqrt(
    avg(a.map(v => Math.pow(v - m, 2)))
  );
}

function rsi(values, period = 14) {
  const a = values || [];

  if (a.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const d = a[i] - a[i - 1];

    if (d >= 0) gains += d;
    else losses += Math.abs(d);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    const gain = Math.max(0, d);
    const loss = Math.max(0, -d);

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function atr(candles, period = 14) {
  if (!candles || candles.length <= period) return null;

  const tr = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    tr.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
  }

  return sma(tr, period);
}

function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  if (!values || values.length < slow + signalPeriod) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const fastArr = [];
  const slowArr = [];

  for (let i = 0; i < values.length; i++) {
    fastArr.push(ema(values.slice(0, i + 1), fast));
    slowArr.push(ema(values.slice(0, i + 1), slow));
  }

  const macdValues = [];

  for (let i = 0; i < values.length; i++) {
    if (fastArr[i] != null && slowArr[i] != null) {
      macdValues.push(fastArr[i] - slowArr[i]);
    }
  }

  const m = macdValues.at(-1);
  const s = ema(macdValues, signalPeriod);

  return {
    macd: m,
    signal: s,
    histogram: m != null && s != null ? m - s : null
  };
}

/* =========================
   CANDLE ANALYSIS
========================= */

function analyzeCandles(candles) {
  if (!candles || candles.length < 30) {
    return {
      error: "داده کندلی کافی نیست"
    };
  }

  const c = candles;
  const last = c.at(-1);

  const closes = c.map(x => x.close);
  const volumes = c.map(x => x.volume);

  const ma7 = sma(closes, 7);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);

  const e20 = ema(closes, 20);
  const r = rsi(closes, 14);
  const a = atr(c, 14);
  const m = macd(closes);

  const previous = c.at(-2);

  const volume20 = sma(volumes.slice(0, -1), 20) || 0;
  const volumeRatio = volume20
    ? last.volume / volume20
    : 0;

  const green = c.slice(-10).filter(x => x.close > x.open).length;
  const greenRatio = green / Math.min(10, c.length);

  const touchMA20 =
    ma20 != null &&
    absPct(last.close, ma20) <= 1;

  const touchMA7 =
    ma7 != null &&
    absPct(last.close, ma7) <= 1;

  const slope20 =
    ma20 != null &&
    c.length >= 25
      ? ma20 - sma(closes.slice(0, -5), 20)
      : 0;

  const marketState =
    volumeRatio >= 2 ||
    Math.abs(pct(last.close, previous.close)) >= 1
      ? "ACTIVE"
      : "NORMAL";

  const high20 = Math.max(...c.slice(-20).map(x => x.high));
  const low20 = Math.min(...c.slice(-20).map(x => x.low));

  const huntHigh =
    last.high > high20 &&
    last.close < high20;

  const huntLow =
    last.low < low20 &&
    last.close > low20;

  const bos =
    last.close > high20 ? "BULLISH" :
    last.close < low20 ? "BEARISH" :
    "NONE";

  const choch =
    previous.close < previous.open &&
    last.close > last.open &&
    last.close > previous.high
      ? "BULLISH"
      :
    previous.close > previous.open &&
    last.close < last.open &&
    last.close < previous.low
      ? "BEARISH"
      :
    "NONE";

  return {
    error: null,
    price: last.close,

    open: last.open,
    high: last.high,
    low: last.low,
    close: last.close,

    ma7,
    ma20,
    ma50,

    ema20: e20,

    rsi: r,

    atr: a,

    macd: m,

    volume: {
      current: last.volume,
      average20: volume20,
      ratio: volumeRatio,
      spike: volumeRatio >= MIN_VOLUME_MULTIPLIER
    },

    greenRatio,

    touchMA20,
    touchMA7,

    slope20,

    market: {
      state: marketState
    },

    hunt: {
      confirmed: huntHigh || huntLow,
      side: huntHigh ? "SHORT" : huntLow ? "LONG" : "NONE",
      high: huntHigh,
      low: huntLow
    },

    bos,
    choch,

    range20: {
      high: high20,
      low: low20
    },

    candle: {
      bullish: last.close > last.open,
      bearish: last.close < last.open,
      body: Math.abs(last.close - last.open),
      range: last.high - last.low,
      upperWick: last.high - Math.max(last.open, last.close),
      lowerWick: Math.min(last.open, last.close) - last.low
    }
  };
}

/* =========================
   PIVOTS
========================= */

function pivotHigh(c, i, left = 2, right = 2) {
  if (i < left || i + right >= c.length) return false;

  const p = c[i].high;

  for (let x = i - left; x <= i + right; x++) {
    if (x === i) continue;
    if (c[x].high >= p) return false;
  }

  return true;
}

function pivotLow(c, i, left = 2, right = 2) {
  if (i < left || i + right >= c.length) return false;

  const p = c[i].low;

  for (let x = i - left; x <= i + right; x++) {
    if (x === i) continue;
    if (c[x].low <= p) return false;
  }

  return true;
}

function swingLevels(c, strength = 2) {
  const highs = [];
  const lows = [];

  for (let i = strength; i < c.length - strength; i++) {
    if (pivotHigh(c, i, strength, strength)) {
      highs.push({
        index: i,
        price: c[i].high,
        time: c[i].start
      });
    }

    if (pivotLow(c, i, strength, strength)) {
      lows.push({
        index: i,
        price: c[i].low,
        time: c[i].start
      });
    }
  }

  return {
    highs,
    lows
  };
}

/* =========================
   FVG
========================= */

function detectFVG(c) {
  if (!c || c.length < 3) {
    return {
      type: "NONE",
      low: null,
      high: null
    };
  }

  const a = c.at(-3);
  const b = c.at(-2);
  const d = c.at(-1);

  if (a.high < d.low) {
    return {
      type: "BULLISH",
      low: a.high,
      high: d.low,
      midpoint: (a.high + d.low) / 2
    };
  }

  if (a.low > d.high) {
    return {
      type: "BEARISH",
      low: d.high,
      high: a.low,
      midpoint: (d.high + a.low) / 2
    };
  }

  return {
    type: "NONE",
    low: null,
    high: null
  };
}

/* =========================
   STRUCTURE
========================= */

function detectStructure(c) {
  const s = swingLevels(c, 2);

  const highs = s.highs.slice(-4);
  const lows = s.lows.slice(-4);

  let bos = "NONE";
  let choch = "NONE";

  if (highs.length >= 2) {
    const h1 = highs.at(-2);
    const h2 = highs.at(-1);

    if (h2.price > h1.price) {
      bos = "BULLISH";
    }
  }

  if (lows.length >= 2) {
    const l1 = lows.at(-2);
    const l2 = lows.at(-1);

    if (l2.price < l1.price) {
      bos = "BEARISH";
    }
  }

  const last = c.at(-1);

  if (highs.length) {
    if (last.close > highs.at(-1).price) {
      choch = "BULLISH";
    }
  }

  if (lows.length) {
    if (last.close < lows.at(-1).price) {
      choch = "BEARISH";
    }
  }

  return {
    bos,
    choch,
    highs,
    lows
  };
}

/* =========================
   CANDLE DETAIL
========================= */

function candleAnalysis(c) {
  const x = c.at(-1);

  if (!x) return {};

  const range = x.high - x.low;
  const body = Math.abs(x.close - x.open);

  return {
    direction:
      x.close > x.open
        ? "BULLISH"
        : x.close < x.open
          ? "BEARISH"
          : "DOJI",

    bodyPercent:
      range ? body / range * 100 : 0,

    upperWickPercent:
      range
        ? (x.high - Math.max(x.open, x.close)) / range * 100
        : 0,

    lowerWickPercent:
      range
        ? (Math.min(x.open, x.close) - x.low) / range * 100
        : 0
  };
}

/* =========================
   HUNT
========================= */

function hunt(c) {
  const s = swingLevels(c, 2);

  const last = c.at(-1);

  const lastHigh =
    s.highs.length
      ? s.highs.at(-1).price
      : null;

  const lastLow =
    s.lows.length
      ? s.lows.at(-1).price
      : null;

  const buySweep =
    lastLow != null &&
    last.low < lastLow &&
    last.close > lastLow;

  const sellSweep =
    lastHigh != null &&
    last.high > lastHigh &&
    last.close < lastHigh;

  return {
    confirmed: buySweep || sellSweep,
    side:
      buySweep
        ? "LONG"
        : sellSweep
          ? "SHORT"
          : "NONE",
    buySweep,
    sellSweep,
    lastHigh,
    lastLow
  };
}

/* =========================
   TRADE NORMALIZATION
========================= */

function normalizeTrade(t) {
  const price = n(t?.price);
  const size = n(t?.size);

  const ts =
    n(t?.time) ||
    n(t?.timestamp) ||
    Date.now();

  return {
    execId: String(
      t?.execId ||
      t?.id ||
      `${ts}-${price}-${size}-${Math.random()}`
    ),

    side: String(t?.side || "").toUpperCase(),

    price,

    size,

    qty: size,

    notional:
      n(t?.notional) ||
      price * size,

    time: ts,

    timestamp: ts,

    isBlockTrade:
      Boolean(
        t?.isBlockTrade === true ||
        t?.isBlockTrade === "true"
      )
  };
}

/* =========================
   RECENT BYBIT TRADES
========================= */

async function recentTrades(
  category,
  symbol,
  limit
) {
  const safeLimit =
    category === "spot"
      ? Math.min(60, limit || 60)
      : Math.min(1000, limit || 1000);

  const d = await bybit(
    "/v5/market/recent-trade",
    {
      category,
      symbol,
      limit: safeLimit
    }
  );

  return (d?.result?.list || [])
    .map(normalizeTrade)
    .filter(x =>
      x.price > 0 &&
      x.size > 0 &&
      x.time > 0
    )
    .sort((a, b) => a.time - b.time);
}

/* =========================
   TRADE HISTORY
========================= */

function historyKey(category, symbol) {
  return `${String(category).toLowerCase()}:${String(symbol).toUpperCase()}`;
}

function cleanupTradeHistory(key) {
  const now = Date.now();

  const arr = tradeHistory.get(key) || [];

  const clean = arr
    .filter(t =>
      t &&
      n(t.time) >= now - TRADE_HISTORY_MS &&
      n(t.time) <= now + 60000
    )
    .sort((a, b) => a.time - b.time);

  const unique = [];
  const seen = new Set();

  for (const t of clean) {
    const id =
      t.execId ||
      `${t.time}|${t.price}|${t.size}|${t.side}`;

    if (seen.has(id)) continue;

    seen.add(id);
    unique.push(t);
  }

  const finalRows =
    unique.length > TRADE_HISTORY_MAX
      ? unique.slice(-TRADE_HISTORY_MAX)
      : unique;

  tradeHistory.set(key, finalRows);

  return finalRows;
}

function storeTrades(category, symbol, trades) {
  const key = historyKey(category, symbol);

  const old = tradeHistory.get(key) || [];

  const incoming = (trades || [])
    .map(normalizeTrade)
    .filter(t =>
      t.price > 0 &&
      t.size > 0 &&
      t.time > 0
    );

  const merged = old.concat(incoming);

  tradeHistory.set(
    key,
    merged
  );

  return cleanupTradeHistory(key);
}

function getStoredTrades(category, symbol) {
  return cleanupTradeHistory(
    historyKey(category, symbol)
  );
}

function getTradeHistory(
  category,
  symbol,
  hours = 24
) {
  const now = Date.now();

  const h = clamp(
    Number(hours),
    0.01,
    24
  );

  const from =
    now - h * 60 * 60 * 1000;

  return getStoredTrades(
    category,
    symbol
  ).filter(t =>
    t.time >= from &&
    t.time <= now
  );
}

/* =========================
   EXACT TRADE FILTER
========================= */

function filterTradesByRange(
  trades,
  {
    from,
    to,
    minPrice,
    maxPrice
  } = {}
) {
  const f =
    Number.isFinite(Number(from))
      ? Number(from)
      : 0;

  const t =
    Number.isFinite(Number(to))
      ? Number(to)
      : Date.now();

  const min =
    minPrice !== undefined &&
    minPrice !== ""
      ? Number(minPrice)
      : null;

  const max =
    maxPrice !== undefined &&
    maxPrice !== ""
      ? Number(maxPrice)
      : null;

  return (trades || [])
    .filter(x => {
      const tm = n(x.time);
      const p = n(x.price);

      if (tm < f) return false;
      if (tm > t) return false;

      if (min !== null && p < min) {
        return false;
      }

      if (max !== null && p > max) {
        return false;
      }

      return true;
    })
    .sort((a, b) => a.time - b.time);
}

/* =========================
   TRADE AGGREGATION
========================= */

function aggregateTradesByPrice(rows) {
  const map = new Map();

  let buyVolume = 0;
  let sellVolume = 0;

  let buyNotional = 0;
  let sellNotional = 0;

  let buyTrades = 0;
  let sellTrades = 0;

  for (const t of rows || []) {
    const price = n(t.price);
    const size = n(t.size);
    const notional =
      n(t.notional) ||
      price * size;

    if (price <= 0 || size <= 0) {
      continue;
    }

    const key = price.toFixed(12);

    if (!map.has(key)) {
      map.set(key, {
        price,
        buyVolume: 0,
        sellVolume: 0,
        buyNotional: 0,
        sellNotional: 0,
        buyTrades: 0,
        sellTrades: 0
      });
    }

    const r = map.get(key);

    if (String(t.side).toUpperCase() === "BUY") {
      r.buyVolume += size;
      r.buyNotional += notional;
      r.buyTrades++;

      buyVolume += size;
      buyNotional += notional;
      buyTrades++;
    }

    if (String(t.side).toUpperCase() === "SELL") {
      r.sellVolume += size;
      r.sellNotional += notional;
      r.sellTrades++;

      sellVolume += size;
      sellNotional += notional;
      sellTrades++;
    }
  }

  const ranges = [...map.values()]
    .map(r => ({
      ...r,

      totalVolume:
        r.buyVolume +
        r.sellVolume,

      totalNotional:
        r.buyNotional +
        r.sellNotional,

      totalTrades:
        r.buyTrades +
        r.sellTrades,

      deltaVolume:
        r.buyVolume -
        r.sellVolume,

      deltaNotional:
        r.buyNotional -
        r.sellNotional,

      buyShare:
        r.buyVolume + r.sellVolume
          ? r.buyVolume /
            (r.buyVolume + r.sellVolume) *
            100
          : 0,

      sellShare:
        r.buyVolume + r.sellVolume
          ? r.sellVolume /
            (r.buyVolume + r.sellVolume) *
            100
          : 0
    }))
    .sort((a, b) => a.price - b.price);

  return {
    count: rows?.length || 0,

    buyVolume,
    sellVolume,

    buyNotional,
    sellNotional,

    buyTrades,
    sellTrades,

    totalVolume:
      buyVolume + sellVolume,

    totalNotional:
      buyNotional + sellNotional,

    totalTrades:
      buyTrades + sellTrades,

    deltaVolume:
      buyVolume - sellVolume,

    deltaNotional:
      buyNotional - sellNotional,

    buyShare:
      buyVolume + sellVolume
        ? buyVolume /
          (buyVolume + sellVolume) *
          100
        : 0,

    sellShare:
      buyVolume + sellVolume
        ? sellVolume /
          (buyVolume + sellVolume) *
          100
        : 0,

    ranges
  };
}

/* =========================
   FOOTPRINT
========================= */

async function footprint(
  category,
  symbol
) {
  try {
    const rows =
      await recentTrades(
        category,
        symbol,
        category === "spot"
          ? 60
          : 1000
      );

    storeTrades(
      category,
      symbol,
      rows
    );

    const all =
      getStoredTrades(
        category,
        symbol
      );

    const recent =
      all.slice(-1000);

    let buyVolume = 0;
    let sellVolume = 0;

    let buyNotional = 0;
    let sellNotional = 0;

    let buyTrades = 0;
    let sellTrades = 0;

    let largeBuyVolume = 0;
    let largeSellVolume = 0;

    const notionals =
      recent
        .map(t => n(t.notional))
        .filter(x => x > 0)
        .sort((a, b) => a - b);

    const p95 =
      notionals.length
        ? notionals[
            Math.floor(
              notionals.length * 0.95
            )
          ]
        : 0;

    const averageNotional =
      avg(notionals);

    const largeThreshold =
      Math.max(
        averageNotional * 5,
        p95
      );

    for (const t of recent) {
      const side =
        String(t.side).toUpperCase();

      const size = n(t.size);
      const notional =
        n(t.notional) ||
        n(t.price) * size;

      if (side === "BUY") {
        buyVolume += size;
        buyNotional += notional;
        buyTrades++;

        if (notional >= largeThreshold) {
          largeBuyVolume += size;
        }
      }

      if (side === "SELL") {
        sellVolume += size;
        sellNotional += notional;
        sellTrades++;

        if (notional >= largeThreshold) {
          largeSellVolume += size;
        }
      }
    }

    const totalVolume =
      buyVolume + sellVolume;

    const delta =
      buyVolume - sellVolume;

    const deltaPercent =
      totalVolume
        ? delta / totalVolume * 100
        : 0;

    return {
      available: true,

      rows: recent.length,

      buyVolume,
      sellVolume,

      buyNotional,
      sellNotional,

      buyTrades,
      sellTrades,

      delta,
      deltaPercent,

      largeThreshold,

      largeBuyVolume,
      largeSellVolume,

      pressure:
        deltaPercent >= 10
          ? "BUY_PRESSURE"
          : deltaPercent <= -10
            ? "SELL_PRESSURE"
            : "BALANCED",

      history: {
        count: all.length,
        oldest:
          all.length
            ? all[0].time
            : null,
        newest:
          all.length
            ? all.at(-1).time
            : null,
        hours:
          all.length
            ? (all.at(-1).time - all[0].time) /
              3600000
            : 0
      },

      updatedAt: Date.now()
    };

  } catch (e) {
    return {
      available: false,
      error: e.message
    };
  }
}

/* =========================
   ORDER BOOK
========================= */

async function walls(
  category,
  symbol,
  price
) {
  try {
    const d =
      await bybit(
        "/v5/market/orderbook",
        {
          category,
          symbol,
          limit: 50
        }
      );

    const bids =
      d?.result?.b || [];

    const asks =
      d?.result?.a || [];

    const buyLevels = [];
    const sellLevels = [];

    for (const q of bids) {
      const p = n(q[0]);
      const sz = n(q[1]);

      if (p <= 0 || sz <= 0) {
        continue;
      }

      const notional = p * sz;
      const distance = absPct(p, price);

      if (distance <= 3) {
        buyLevels.push({
          price: p,
          size: sz,
          notional,
          distancePct: distance
        });
      }
    }

    for (const q of asks) {
      const p = n(q[0]);
      const sz = n(q[1]);

      if (p <= 0 || sz <= 0) {
        continue;
      }

      const notional = p * sz;
      const distance = absPct(p, price);

      if (distance <= 3) {
        sellLevels.push({
          price: p,
          size: sz,
          notional,
          distancePct: distance
        });
      }
    }

    buyLevels.sort(
      (a, b) => b.notional - a.notional
    );

    sellLevels.sort(
      (a, b) => b.notional - a.notional
    );

    const buyLiquidity =
      buyLevels.reduce(
        (s, x) => s + x.notional,
        0
      );

    const sellLiquidity =
      sellLevels.reduce(
        (s, x) => s + x.notional,
        0
      );

    const totalLiquidity =
      buyLiquidity + sellLiquidity;

    const buyWall =
      buyLevels[0] || null;

    const sellWall =
      sellLevels[0] || null;

    const avgBuy =
      buyLevels.length
        ? avg(
            buyLevels.map(
              x => x.notional
            )
          )
        : 0;

    const avgSell =
      sellLevels.length
        ? avg(
            sellLevels.map(
              x => x.notional
            )
          )
        : 0;

    const buyStrength =
      buyWall && avgBuy
        ? clamp(
            buyWall.notional /
              avgBuy *
              20,
            0,
            100
          )
        : 0;

    const sellStrength =
      sellWall && avgSell
        ? clamp(
            sellWall.notional /
              avgSell *
              20,
            0,
            100
          )
        : 0;

    return {
      buy: buyWall,
      sell: sellWall,

      buyLevels:
        buyLevels.slice(0, 10),

      sellLevels:
        sellLevels.slice(0, 10),

      buyLiquidity,
      sellLiquidity,
      totalLiquidity,

      buyShare:
        totalLiquidity
          ? buyLiquidity /
            totalLiquidity *
            100
          : 0,

      sellShare:
        totalLiquidity
          ? sellLiquidity /
            totalLiquidity *
            100
          : 0,

      buyStrength,
      sellStrength,

      buyNear:
        !!buyWall &&
        buyWall.distancePct <= 1,

      sellNear:
        !!sellWall &&
        sellWall.distancePct <= 1,

      note:
        "Order Book نقدینگی لحظه‌ای است و ممکن است سفارش‌ها قبل از رسیدن قیمت حذف یا جابه‌جا شوند."
    };

  } catch (e) {
    return {
      error: e.message
    };
  }
}

/* =========================
   SUPPORT / RESISTANCE
========================= */

function supportResistance(
  c,
  wall,
  price
) {
  const s =
    swingLevels(c, 3);

  const supports = [];
  const resistances = [];

  for (const x of s.lows) {
    if (x.price < price) {
      supports.push({
        price: x.price,
        type: "SWING_SUPPORT",
        distancePct:
          absPct(x.price, price)
      });
    }
  }

  for (const x of s.highs) {
    if (x.price > price) {
      resistances.push({
        price: x.price,
        type: "SWING_RESISTANCE",
        distancePct:
          absPct(x.price, price)
      });
    }
  }

  for (const x of wall?.buyLevels || []) {
    if (x.price < price) {
      supports.push({
        price: x.price,
        type: "BUY_WALL",
        liquidity: x.notional,
        distancePct: x.distancePct
      });
    }
  }

  for (const x of wall?.sellLevels || []) {
    if (x.price > price) {
      resistances.push({
        price: x.price,
        type: "SELL_WALL",
        liquidity: x.notional,
        distancePct: x.distancePct
      });
    }
  }

  supports.sort(
    (a, b) =>
      a.distancePct -
      b.distancePct
  );

  resistances.sort(
    (a, b) =>
      a.distancePct -
      b.distancePct
  );

  const liquid = a =>
    a
      .filter(x => x.liquidity)
      .sort(
        (x, y) =>
          (y.liquidity || 0) -
          (x.liquidity || 0)
      )[0];

  return {
    nearestSupport:
      supports[0] || null,

    nearestResistance:
      resistances[0] || null,

    strongestSupport:
      liquid(supports) ||
      supports[0] ||
      null,

    strongestResistance:
      liquid(resistances) ||
      resistances[0] ||
      null,

    supports:
      supports.slice(0, 10),

    resistances:
      resistances.slice(0, 10)
  };
}

/* =========================
   TICKER
========================= */

async function ticker(
  category,
  symbol
) {
  const d =
    await bybit(
      "/v5/market/tickers",
      {
        category,
        symbol
      }
    );

  return (
    d?.result?.list?.[0] ||
    {}
  );
}

/* =========================
   OI / FUNDING
========================= */

async function oiFunding(symbol) {
  try {
    const t =
      await ticker(
        "linear",
        symbol
      );

    let oiHistory = [];
    let fundHistory = [];

    try {
      const oi =
        await bybit(
          "/v5/market/open-interest",
          {
            category: "linear",
            symbol,
            intervalTime: "5min",
            limit: 2
          }
        );

      oiHistory =
        oi?.result?.list || [];
    } catch (_) {}

    try {
      const fr =
        await bybit(
          "/v5/market/funding/history",
          {
            category: "linear",
            symbol,
            limit: 2
          }
        );

      fundHistory =
        fr?.result?.list || [];
    } catch (_) {}

    const oiNow =
      n(t.openInterest);

    const oiPrev =
      oiHistory.length > 1
        ? n(
            oiHistory[
              oiHistory.length - 2
            ].openInterest
          )
        : oiHistory.length === 1
          ? n(
              oiHistory[0]
                .openInterest
            )
          : 0;

    const fundingNow =
      n(t.fundingRate);

    const fundingPrev =
      fundHistory.length > 1
        ? n(
            fundHistory[
              fundHistory.length - 2
            ].fundingRate
          )
        : fundHistory.length === 1
          ? n(
              fundHistory[0]
                .fundingRate
            )
          : 0;

    return {
      openInterest: oiNow,

      openInterestPrevious:
        oiPrev,

      openInterestChange:
        oiPrev
          ? pct(oiNow, oiPrev)
          : 0,

      fundingRate:
        fundingNow,

      fundingRatePrevious:
        fundingPrev,

      fundingChange:
        fundingNow -
        fundingPrev,

      turnover24h:
        n(t.turnover24h),

      volume24h:
        n(t.volume24h),

      change24h:
        n(t.price24hPcnt) * 100
    };

  } catch (e) {
    return {
      error: e.message,
      openInterest: null,
      fundingRate: null
    };
  }
}

/* =========================
   TIMEFRAME SCORE
========================= */

const TF = [
  {
    key: "1",
    interval: "1"
  },
  {
    key: "3",
    interval: "3"
  },
  {
    key: "5",
    interval: "5"
  },
  {
    key: "15",
    interval: "15"
  },
  {
    key: "60",
    interval: "60"
  }
];

function score(
  tf,
  converted = null
) {
  let L = 0;
  let S = 0;

  const reasons = [];

  function add(side, points, text) {
    if (side === "L") {
      L += points;
    }

    if (side === "S") {
      S += points;
    }

    reasons.push({
      side,
      points,
      text
    });
  }

  const weights = {
    "1": 1.5,
    "3": 1.2,
    "5": 1.1,
    "15": 1,
    "60": 0.8
  };

  for (const x of TF) {
    const e = tf?.[x.key];

    if (!e || e.error) continue;

    const w =
      weights[x.key] || 1;

    if (
      e.ma20 &&
      e.close > e.ma20
    ) {
      add(
        "L",
        8 * w,
        `${x.interval}m قیمت بالای MA20`
      );
    }

    if (
      e.ma20 &&
      e.close < e.ma20
    ) {
      add(
        "S",
        8 * w,
        `${x.interval}m قیمت زیر MA20`
      );
    }

    if (
      e.ma7 &&
      e.ma20 &&
      e.ma7 > e.ma20
    ) {
      add(
        "L",
        5 * w,
        `${x.interval}m MA7 بالای MA20`
      );
    }

    if (
      e.ma7 &&
      e.ma20 &&
      e.ma7 < e.ma20
    ) {
      add(
        "S",
        5 * w,
        `${x.interval}m MA7 زیر MA20`
      );
    }

    if (
      e.rsi != null &&
      e.rsi >= 55 &&
      e.rsi <= 75
    ) {
      add(
        "L",
        5 * w,
        `${x.interval}m RSI صعودی`
      );
    }

    if (
      e.rsi != null &&
      e.rsi <= 45 &&
      e.rsi >= 25
    ) {
      add(
        "S",
        5 * w,
        `${x.interval}m RSI نزولی`
      );
    }

    if (
      e.macd?.histogram > 0
    ) {
      add(
        "L",
        5 * w,
        `${x.interval}m MACD مثبت`
      );
    }

    if (
      e.macd?.histogram < 0
    ) {
      add(
        "S",
        5 * w,
        `${x.interval}m MACD منفی`
      );
    }

    if (e.bos === "BULLISH") {
      add(
        "L",
        7 * w,
        `${x.interval}m BOS صعودی`
      );
    }

    if (e.bos === "BEARISH") {
      add(
        "S",
        7 * w,
        `${x.interval}m BOS نزولی`
      );
    }

    if (e.choch === "BULLISH") {
      add(
        "L",
        8 * w,
        `${x.interval}m CHoCH صعودی`
      );
    }

    if (e.choch === "BEARISH") {
      add(
        "S",
        8 * w,
        `${x.interval}m CHoCH نزولی`
      );
    }

    if (
      e.hunt?.confirmed &&
      e.hunt.side === "LONG"
    ) {
      add(
        "L",
        8 * w,
        `${x.interval}m Liquidity Sweep صعودی`
      );
    }

    if (
      e.hunt?.confirmed &&
      e.hunt.side === "SHORT"
    ) {
      add(
        "S",
        8 * w,
        `${x.interval}m Liquidity Sweep نزولی`
      );
    }

    if (
      e.volume?.spike &&
      e.close > e.open
    ) {
      add(
        "L",
        5 * w,
        `${x.interval}m حجم خرید افزایش یافته`
      );
    }

    if (
      e.volume?.spike &&
      e.close < e.open
    ) {
      add(
        "S",
        5 * w,
        `${x.interval}m حجم فروش افزایش یافته`
      );
    }
  }

  if (converted?.recent) {
    for (const e of converted.recent) {
      if (e.slope === "UP") {
        add(
          "L",
          5 * (e.weight || 1),
          `${e.ma} ${e.source} → MA${e.period1m}: برخورد با شیب صعودی`
        );
      }

      if (e.slope === "DOWN") {
        add(
          "S",
          5 * (e.weight || 1),
          `${e.ma} ${e.source} → MA${e.period1m}: برخورد با شیب نزولی`
        );
      }
    }
  }

  return {
    L,
    S,
    reasons
  };
}

/* =========================
   CONVERTED MA
========================= */

function convertedMAEvents(candles) {
  const closes =
    candles.map(x => x.close);

  const definitions = [
    {
      ma: "MA7",
      period1m: 7,
      source: "1m",
      weight: 1
    },
    {
      ma: "MA20",
      period1m: 20,
      source: "1m",
      weight: 1.5
    },
    {
      ma: "MA50",
      period1m: 50,
      source: "1m",
      weight: 1
    }
  ];

  const events = [];

  for (const d of definitions) {
    if (closes.length < d.period1m + 2) {
      continue;
    }

    const ma =
      sma(
        closes,
        d.period1m
      );

    const previousMA =
      sma(
        closes.slice(0, -1),
        d.period1m
      );

    const price =
      closes.at(-1);

    const previousPrice =
      closes.at(-2);

    const slope =
      ma > previousMA
        ? "UP"
        : ma < previousMA
          ? "DOWN"
          : "FLAT";

    const crossedUp =
      previousPrice <= previousMA &&
      price > ma;

    const crossedDown =
      previousPrice >= previousMA &&
      price < ma;

    if (crossedUp) {
      events.push({
        ...d,
        direction: "UP",
        slope
      });
    }

    if (crossedDown) {
      events.push({
        ...d,
        direction: "DOWN",
        slope
      });
    }
  }

  return {
    events,
    recent: events.slice(-20),
    latest:
      events.length
        ? events.at(-1)
        : null
  };
}

/* =========================
   DEEP ANALYZE
========================= */

const DEEP_1M_LIMIT = 200;

async function deepAnalyze(
  category,
  symbol
) {
  const tf = {};

  let oneMinute = [];

  try {
    oneMinute =
      await klines(
        category,
        symbol,
        "1",
        DEEP_1M_LIMIT
      );

    tf["1"] =
      analyzeCandles(
        oneMinute.slice(-100)
      );

  } catch (e) {
    tf["1"] = {
      error: e.message
    };
  }

  for (
    const x of TF.filter(
      z => z.interval !== "1"
    )
  ) {
    try {
      tf[x.key] =
        analyzeCandles(
          await klines(
            category,
            symbol,
            x.interval,
            100
          )
        );
    } catch (e) {
      tf[x.key] = {
        error: e.message
      };
    }
  }

  const converted =
    oneMinute.length
      ? convertedMAEvents(
          oneMinute
        )
      : {
          events: [],
          recent: [],
          latest: null
        };

  const valid =
    Object.values(tf)
      .filter(x => !x.error);

  const price =
    valid.at(0)?.price || 0;

  const fp =
    await footprint(
      category,
      symbol
    );

  const wall =
    await walls(
      category,
      symbol,
      price
    );

  const market =
    category === "linear"
      ? await oiFunding(symbol)
      : {
          openInterest: null,
          fundingRate: null,
          turnover24h: null,
          change24h: null
        };

  const sc =
    score(
      tf,
      converted
    );

  if (
    fp &&
    !fp.error
  ) {
    if (
      fp.deltaPercent >= 8
    ) {
      sc.L += 10;
    }

    if (
      fp.deltaPercent <= -8
    ) {
      sc.S += 10;
    }
  }

  if (wall.sellNear) {
    sc.S += 3;
  }

  if (wall.buyNear) {
    sc.L += 3;
  }

  const direction =
    sc.L > sc.S &&
    sc.L >= 45
      ? "LONG"
      :
    sc.S > sc.L &&
    sc.S >= 45
      ? "SHORT"
      :
      "WAIT";

  const top =
    direction === "LONG"
      ? sc.L
      :
    direction === "SHORT"
      ? sc.S
      :
      Math.max(
        sc.L,
        sc.S
      );

  const pump =
    clamp(
      sc.L * 1.2 +
      (
        market.change24h > 0
          ? market.change24h * 2
          : 0
      ) +
      (
        tf["1"]?.volume?.spike
          ? 15
          : 0
      ) +
      (
        tf["5"]?.volume?.spike
          ? 10
          : 0
      ),
      0,
      100
    );

  const dump =
    clamp(
      sc.S * 1.2 +
      (
        market.change24h < 0
          ? Math.abs(
              market.change24h
            ) * 2
          : 0
      ) +
      (
        tf["1"]?.volume?.spike
          ? 15
          : 0
      ) +
      (
        tf["5"]?.volume?.spike
          ? 10
          : 0
      ),
      0,
      100
    );

  const sr =
    supportResistance(
      oneMinute.slice(-100),
      wall,
      price
    );

  const history =
    getStoredTrades(
      category,
      symbol
    );

  return {
    symbol,
    category,

    price,

    direction,

    score:
      Math.round(
        clamp(
          top,
          0,
          100
        )
      ),

    pumpScore:
      Math.round(pump),

    dumpScore:
      Math.round(dump),

    pumpDumpStatus:
      pump >= 75
        ? "PUMP"
        :
      dump >= 75
        ? "DUMP"
        :
        "NORMAL",

    timeframes: tf,

    convertedMA1m:
      converted,

    footprint: fp,

    walls: wall,

    orderBook: wall,

    supportResistance: sr,

    market,

    reasons:
      sc.reasons
        .filter(
          x =>
            direction === "LONG"
              ? x.side === "L"
              :
            direction === "SHORT"
              ? x.side === "S"
              :
                true
        )
        .map(x => x.text),

    tradeHistory: {
      available: history.length > 0,

      count: history.length,

      oldest:
        history.length
          ? history[0].time
          : null,

      newest:
        history.length
          ? history.at(-1).time
          : null,

      hours:
        history.length > 1
          ? (
              history.at(-1).time -
              history[0].time
            ) / 3600000
          : 0,

      retentionHours: 24,

      mode:
        "ACCUMULATED_24H"
    },

    recentTrades:
      history
        .slice(-100)
        .reverse(),

    generatedAt:
      Date.now(),

    liquidation: {
      available: false,
      message:
        "داده لیکوئیدیشن تجمیعی از REST عمومی Bybit برای این اسکنر در دسترس نیست."
    }
  };
}

/* =========================
   MOVEMENT
========================= */

function movementAnalysis(
  c,
  market,
  tf,
  wall,
  sr,
  fp
) {
  const price =
    c.at(-1)?.close || 0;

  const p5 =
    c.length >= 6
      ? c.at(-6).close
      : price;

  const p15 =
    c.length >= 16
      ? c.at(-16).close
      : price;

  const p30 =
    c.length >= 31
      ? c.at(-31).close
      : price;

  const p60 =
    c.length >= 61
      ? c.at(-61).close
      : price;

  const change5 =
    pct(price, p5);

  const change15 =
    pct(price, p15);

  const change30 =
    pct(price, p30);

  const change60 =
    pct(price, p60);

  const vol20 =
    sma(
      c.slice(-21, -1)
        .map(x => x.volume),
      20
    );

  const currentVol =
    c.at(-1)?.volume || 0;

  const volumeRatio =
    vol20
      ? currentVol / vol20
      : 0;

  const h = hunt(c);

  const structure =
    detectStructure(c);

  const candle =
    candleAnalysis(c);

  const fvg =
    detectFVG(c);

  const oiCh =
    market?.openInterestChange || 0;

  const delta =
    fp && !fp.error
      ? fp.deltaPercent
      : 0;

  let pump = 0;
  let dump = 0;

  const pumpReasons = [];
  const dumpReasons = [];

  if (change5 >= 2) {
    pump += 12;
    pumpReasons.push("افزایش قیمت ۵ دقیقه‌ای");
  }

  if (change15 >= 3) {
    pump += 18;
    pumpReasons.push("افزایش قیمت ۱۵ دقیقه‌ای");
  }

  if (change30 >= 5) {
    pump += 15;
    pumpReasons.push("افزایش قیمت ۳۰ دقیقه‌ای");
  }

  if (change60 >= 8) {
    pump += 10;
    pumpReasons.push("افزایش قیمت ۱ ساعته");
  }

  if (change5 <= -2) {
    dump += 12;
    dumpReasons.push("افت قیمت ۵ دقیقه‌ای");
  }

  if (change15 <= -3) {
    dump += 18;
    dumpReasons.push("افت قیمت ۱۵ دقیقه‌ای");
  }

  if (change30 <= -5) {
    dump += 15;
    dumpReasons.push("افت قیمت ۳۰ دقیقه‌ای");
  }

  if (change60 <= -8) {
    dump += 10;
    dumpReasons.push("افت قیمت ۱ ساعته");
  }

  if (volumeRatio >= 1.5) {
    pump += 10;
    dump += 10;
  }

  if (volumeRatio >= 2.5) {
    pump += 8;
    dump += 8;
  }

  if (delta >= 8) {
    pump += 12;
    pumpReasons.push("فشار خرید Footprint");
  }

  if (delta <= -8) {
    dump += 12;
    dumpReasons.push("فشار فروش Footprint");
  }

  if (oiCh >= 3 && change15 > 0) {
    pump += 10;
    pumpReasons.push("افزایش OI همراه رشد");
  }

  if (oiCh >= 3 && change15 < 0) {
    dump += 10;
    dumpReasons.push("افزایش OI همراه افت");
  }

  if (oiCh <= -3 && change15 > 0) {
    pump += 5;
  }

  if (oiCh <= -3 && change15 < 0) {
    dump += 5;
  }

  if (
    h.confirmed &&
    h.side === "SHORT"
  ) {
    pump += 10;
    pumpReasons.push("Buy-side Sweep");
  }

  if (
    h.confirmed &&
    h.side === "LONG"
  ) {
    dump += 10;
    dumpReasons.push("Sell-side Sweep");
  }

  if (
    structure.bos === "BULLISH"
  ) {
    pump += 8;
    pumpReasons.push("BOS صعودی");
  }

  if (
    structure.bos === "BEARISH"
  ) {
    dump += 8;
    dumpReasons.push("BOS نزولی");
  }

  if (
    structure.choch === "BULLISH"
  ) {
    pump += 10;
    pumpReasons.push("CHoCH صعودی");
  }

  if (
    structure.choch === "BEARISH"
  ) {
    dump += 10;
    dumpReasons.push("CHoCH نزولی");
  }

  if (
    fvg.type === "BULLISH"
  ) {
    pump += 4;
    pumpReasons.push("FVG صعودی");
  }

  if (
    fvg.type === "BEARISH"
  ) {
    dump += 4;
    dumpReasons.push("FVG نزولی");
  }

  if (
    wall?.buyNear &&
    wall.buyStrength >= 60
  ) {
    pump += 8;
    pumpReasons.push("Buy Wall نزدیک");
  }

  if (
    wall?.sellNear &&
    wall.sellStrength >= 60
  ) {
    dump += 8;
    dumpReasons.push("Sell Wall نزدیک");
  }

  return {
    change5,
    change15,
    change30,
    change60,

    volumeRatio,

    pumpScore:
      Math.round(
        clamp(
          pump,
          0,
          100
        )
      ),

    dumpScore:
      Math.round(
        clamp(
          dump,
          0,
          100
        )
      ),

    pumpReversalScore:
      Math.round(
        clamp(
          pump * (
            candle.direction === "BEARISH"
              ? 1.15
              : 1
          ),
          0,
          100
        )
      ),

    dumpReversalScore:
      Math.round(
        clamp(
          dump * (
            candle.direction === "BULLISH"
              ? 1.15
              : 1
          ),
          0,
          100
        )
      ),

    pumpReasons,
    dumpReasons,

    structure,
    candle,
    fvg,

    status:
      pump >= 75
        ? "PUMP"
        :
      dump >= 75
        ? "DUMP"
        :
        "NORMAL"
  };
}

/* =========================
   MARKET INSTRUMENTS
========================= */

async function instruments(
  category
) {
  const all = [];

  let cursor = "";

  for (
    let page = 0;
    page < 5;
    page++
  ) {
    const d =
      await bybit(
        "/v5/market/instruments-info",
        {
          category,
          limit: 1000,
          ...(cursor
            ? { cursor }
            : {})
        }
      );

    all.push(
      ...(d?.result?.list || [])
    );

    cursor =
      d?.result?.nextPageCursor ||
      "";

    if (!cursor) break;
  }

  return all;
}

function validFutures(list) {
  return (
    list || []
  ).filter(
    x =>
      x.status === "Trading" &&
      x.quoteCoin === "USDT" &&
      x.contractType ===
        "LinearPerpetual"
  );
}

/* =========================
   FIND SYMBOL
========================= */

async function findSymbol(
  input
) {
  const raw =
    String(input || "")
      .trim()
      .toUpperCase();

  const bare =
    raw
      .replace(
        /[-_/:\s]/g,
        ""
      )
      .replace(
        /USDT$/,
        ""
      );

  const [lin, spot] =
    await Promise.all([
      instruments("linear"),
      instruments("spot")
    ]);

  const l =
    lin.find(
      x =>
        String(x.symbol)
          .toUpperCase() === raw ||
        String(x.symbol)
          .toUpperCase() ===
          bare + "USDT"
    );

  const s =
    spot.find(
      x =>
        String(x.symbol)
          .toUpperCase() === raw ||
        String(x.symbol)
          .toUpperCase() ===
          bare + "USDT"
    );

  return {
    input: raw,

    selected:
      l
        ? "FUTURES"
        : s
          ? "SPOT"
          : null,

    futures:
      l
        ? {
            symbol: l.symbol,
            status: l.status,
            baseCoin: l.baseCoin,
            quoteCoin: l.quoteCoin
          }
        : null,

    spot:
      s
        ? {
            symbol: s.symbol,
            status: s.status,
            baseCoin: s.baseCoin,
            quoteCoin: s.quoteCoin
          }
        : null
  };
}

/* =========================
   PUMP / DUMP DETECTION
========================= */

function detectPump(candles) {
  if (
    !candles ||
    candles.length < 20
  ) {
    return {
      detected: false,
      reason: "داده کافی نیست"
    };
  }

  const c =
    candles;

  const last =
    c.at(-1);

  let best = null;

  for (
    let count =
      MIN_PUMP_CANDLES;
    count <= MAX_PUMP_CANDLES;
    count++
  ) {
    const start =
      c.length - count;

    if (start < 1) continue;

    const first =
      c[start - 1];

    const rows =
      c.slice(start);

    const startPrice =
      first.close;

    const endPrice =
      last.close;

    const change =
      pct(
        endPrice,
        startPrice
      );

    const green =
      rows.filter(
        x => x.close > x.open
      ).length;

    const greenRatio =
      green /
      rows.length;

    const avgPrevVolume =
      avg(
        c
          .slice(
            Math.max(
              0,
              start - 20
            ),
            start
          )
          .map(
            x => x.volume
          )
      );

    const currentVolume =
      avg(
        rows.map(
          x => x.volume
        )
      );

    const volumeMultiplier =
      avgPrevVolume
        ? currentVolume /
          avgPrevVolume
        : 0;

    if (
      change >=
        MIN_PUMP_PERCENT &&
      greenRatio >=
        MIN_GREEN_RATIO &&
      volumeMultiplier >=
        MIN_VOLUME_MULTIPLIER
    ) {
      const high =
        Math.max(
          ...rows.map(
            x => x.high
          )
        );

      const pullback =
        pct(
          last.close,
          high
        );

      const ageHours =
        (
          Date.now() -
          rows[0].start
        ) / 3600000;

      if (
        pullback >=
          -MAX_PULLBACK_PERCENT &&
        ageHours <=
          MAX_PUMP_AGE_HOURS
      ) {
        const score =
          clamp(
            change * 5 +
            volumeMultiplier * 10 +
            greenRatio * 20 -
            Math.max(
              0,
              Math.abs(
                pullback
              )
            ) * 4,
            0,
            100
          );

        const candidate = {
          detected: true,

          startTime:
            rows[0].start,

          endTime:
            last.start,

          startPrice,

          endPrice,

          high,

          change,

          greenRatio,

          volumeMultiplier,

          pullbackPercent:
            pullback,

          ageHours,

          score:
            Math.round(score),

          entryZoneLow:
            high *
            (
              1 -
              NEAR_ZONE_PERCENT /
                100
            ),

          entryZoneHigh:
            high *
            (
              1 +
              NEAR_ZONE_PERCENT /
                100
            )
        };

        if (
          !best ||
          candidate.score >
            best.score
        ) {
          best =
            candidate;
        }
      }
    }
  }

  return (
    best || {
      detected: false,
      score: 0
    }
  );
}

/* =========================
   SCAN
========================= */

async function scan(
  offset = 0,
  settings = {}
) {
  const ms =
    validFutures(
      await instruments(
        "linear"
      )
    ).sort(
      (a, b) =>
        String(a.symbol)
          .localeCompare(
            String(b.symbol)
          )
    );

  if (!ms.length) {
    return {
      ok: false,
      error:
        "هیچ قرارداد USDT Perpetual فعال پیدا نشد."
    };
  }

  const safeOffset =
    Math.max(
      0,
      Math.min(
        offset,
        Math.max(
          0,
          ms.length - 1
        )
      )
    );

  const batch =
    ms.slice(
      safeOffset,
      safeOffset +
        SCAN_BATCH
    );

  const light = [];

  for (
    const m of batch
  ) {
    try {
      const c =
        await klines(
          "linear",
          m.symbol,
          "1",
          80
        );

      const analysis =
        analyzeCandles(c);

      if (
        analysis.error
      ) {
        continue;
      }

      const pump =
        detectPump(c);

      let activity = 0;

      if (
        analysis.touchMA20
      ) {
        activity += 20;
      }

      if (
        analysis.touchMA7
      ) {
        activity += 10;
      }

      if (
        analysis.volume.spike
      ) {
        activity += 20;
      }

      if (
        analysis.market.state ===
        "ACTIVE"
      ) {
        activity += 15;
      }

      if (
        analysis.hunt.confirmed
      ) {
        activity += 20;
      }

      if (
        analysis.bos !==
        "NONE"
      ) {
        activity += 10;
      }

      if (
        analysis.choch !==
        "NONE"
      ) {
        activity += 15;
      }

      if (
        pump.detected
      ) {
        activity +=
          pump.score * 0.5;
      }

      light.push({
        symbol: m.symbol,

        category:
          "linear",

        price:
          analysis.price,

        change1m:
          pct(
            analysis.close,
            c.at(-2)?.close ||
              analysis.close
          ),

        volumeRatio:
          analysis.volume.ratio,

        activity:
          Math.round(
            clamp(
              activity,
              0,
              100
            )
          ),

        pump,

        market:
          analysis.market,

        generatedAt:
          Date.now()
      });

    } catch (_) {}
  }

  light.sort(
    (a, b) =>
      b.activity -
      a.activity
  );

  return {
    ok: true,

    version:
      VERSION,

    offset:
      safeOffset,

    batchSize:
      batch.length,

    total:
      ms.length,

    nextOffset:
      safeOffset +
      SCAN_BATCH >=
      ms.length
        ? 0
        : safeOffset +
          SCAN_BATCH,

    items:
      light,

    generatedAt:
      Date.now()
  };
}

/* =========================
   LIVE
========================= */

async function live(
  category,
  symbol
) {
  const [
    t,
    trades
  ] =
    await Promise.all([
      ticker(
        category,
        symbol
      ),
      recentTrades(
        category,
        symbol,
        category === "spot"
          ? 60
          : 1000
      )
    ]);

  const price =
    n(
      t.lastPrice ||
      t.markPrice ||
      t.indexPrice
    );

  storeTrades(
    category,
    symbol,
    trades
  );

  const history =
    getStoredTrades(
      category,
      symbol
    );

  const last100 =
    history
      .slice(-100)
      .reverse();

  const range =
    aggregateTradesByPrice(
      history
    );

  return {
    ok: true,

    symbol,

    category,

    price,

    markPrice:
      n(t.markPrice),

    indexPrice:
      n(t.indexPrice),

    price24hPcnt:
      n(t.price24hPcnt) *
      100,

    turnover24h:
      n(t.turnover24h),

    volume24h:
      n(t.volume24h),

    recentTrades:
      last100,

    tradeHistory: {
      count:
        history.length,

      oldest:
        history.length
          ? history[0].time
          : null,

      newest:
        history.length
          ? history.at(-1).time
          : null,

      hours:
        history.length > 1
          ? (
              history.at(-1).time -
              history[0].time
            ) / 3600000
          : 0,

      retentionHours:
        24,

      mode:
        "ACCUMULATED_24H"
    },

    priceRangeSummary:
      range,

    generatedAt:
      Date.now()
  };
}

/* =========================
   ROUTER
========================= */

async function handleRequest(
  request
) {
  if (
    request.method ===
    "OPTIONS"
  ) {
    return new Response(
      null,
      {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,OPTIONS",
          "access-control-allow-headers": "*"
        }
      }
    );
  }

  const url =
    new URL(
      request.url
    );

  const path =
    url.pathname;

  try {
    /* ---------- ROOT ---------- */

    if (
      path === "/" ||
      path === ""
    ) {
      return json({
        ok: true,

        name:
          "اسکنر هوشمند جهش قیمت بای‌بیت",

        version:
          VERSION,

        message:
          "Worker آنلاین است",

        endpoints: [
          "/health",
          "/scan",
          "/analyze?symbol=BTCUSDT&category=linear",
          "/live?symbol=BTCUSDT&category=linear",
          "/trades?symbol=BTCUSDT&category=linear&hours=24"
        ],

        tradeHistoryMode:
          "ACCUMULATED_24H"
      });
    }

    /* ---------- HEALTH ---------- */

    if (
      path === "/health"
    ) {
      return json({
        ok: true,

        worker:
          "online",

        version:
          VERSION,

        bybit:
          BYBIT,

        tradeHistoryMode:
          "ACCUMULATED_24H",

        tradeHistoryRetentionHours:
          24,

        tradeHistoryMax:
          TRADE_HISTORY_MAX,

        tradeEndpoint:
          "/trades",

        note:
          "تاریخچه معاملات در Runtime Worker از معاملات دریافت‌شده از Bybit جمع‌آوری می‌شود.",

        generatedAt:
          Date.now()
      });
    }

    /* ---------- SCAN ---------- */

    if (
      path === "/scan"
    ) {
      const offset =
        Number(
          url.searchParams.get(
            "offset"
          ) || 0
        );

      return json(
        await scan(
          offset,
          {}
        )
      );
    }

    /* ---------- ANALYZE ---------- */

    if (
      path === "/analyze"
    ) {
      let symbol =
        url.searchParams.get(
          "symbol"
        );

      let category =
        url.searchParams.get(
          "category"
        ) || "";

      if (!symbol) {
        return errorJson(
          "symbol الزامی است",
          400
        );
      }

      symbol =
        String(symbol)
          .trim()
          .toUpperCase();

      if (
        category !==
          "linear" &&
        category !==
          "spot"
      ) {
        const found =
          await findSymbol(
            symbol
          );

        if (
          !found.selected
        ) {
          return errorJson(
            "نماد پیدا نشد",
            404
          );
        }

        category =
          found.selected ===
          "FUTURES"
            ? "linear"
            : "spot";
      }

      const result =
        await deepAnalyze(
          category,
          symbol
        );

      return json({
        ok: true,

        ...result,

        version:
          VERSION
      });
    }

    /* ---------- LIVE ---------- */

    if (
      path === "/live"
    ) {
      let symbol =
        url.searchParams.get(
          "symbol"
        );

      let category =
        url.searchParams.get(
          "category"
        ) || "";

      if (!symbol) {
        return errorJson(
          "symbol الزامی است",
          400
        );
      }

      symbol =
        String(symbol)
          .trim()
          .toUpperCase();

      if (
        category !==
          "linear" &&
        category !==
          "spot"
      ) {
        const found =
          await findSymbol(
            symbol
          );

        if (
          !found.selected
        ) {
          return errorJson(
            "نماد پیدا نشد",
            404
          );
        }

        category =
          found.selected ===
          "FUTURES"
            ? "linear"
            : "spot";
      }

      return json(
        await live(
          category,
          symbol
        )
      );
    }

    /* ---------- TRADES ---------- */

    if (
      path === "/trades"
    ) {
      let symbol =
        url.searchParams.get(
          "symbol"
        );

      let category =
        url.searchParams.get(
          "category"
        ) || "";

      if (!symbol) {
        return errorJson(
          "symbol الزامی است",
          400
        );
      }

      symbol =
        String(symbol)
          .trim()
          .toUpperCase();

      if (
        category !==
          "linear" &&
        category !==
          "spot"
      ) {
        const found =
          await findSymbol(
            symbol
          );

        if (
          !found.selected
        ) {
          return errorJson(
            "نماد پیدا نشد",
            404
          );
        }

        category =
          found.selected ===
          "FUTURES"
            ? "linear"
            : "spot";
      }

      const now =
        Date.now();

      const hoursParam =
        url.searchParams.get(
          "hours"
        );

      const hours =
        hoursParam !== null
          ? clamp(
              Number(
                hoursParam
              ),
              0.01,
              24
            )
          : 24;

      const defaultFrom =
        now -
        hours *
          60 *
          60 *
          1000;

      const fromParam =
        url.searchParams.get(
          "from"
        );

      const toParam =
        url.searchParams.get(
          "to"
        );

      const from =
        fromParam
          ? Number(
              fromParam
            )
          : defaultFrom;

      const to =
        toParam
          ? Number(
              toParam
            )
          : now;

      const minPrice =
        url.searchParams.get(
          "minPrice"
        );

      const maxPrice =
        url.searchParams.get(
          "maxPrice"
        );

      let history =
        getStoredTrades(
          category,
          symbol
        );

      /* هر بار دریافت جدید */
      try {
        const fresh =
          await recentTrades(
            category,
            symbol,
            category === "spot"
              ? 60
              : 1000
          );

        history =
          storeTrades(
            category,
            symbol,
            fresh
          );
      } catch (_) {}

      const filtered =
        filterTradesByRange(
          history,
          {
            from,
            to,
            minPrice,
            maxPrice
          }
        );

      const aggregation =
        aggregateTradesByPrice(
          filtered
        );

      return json({
        ok: true,

        symbol,

        category,

        filter: {
          from,
          to,
          minPrice:
            minPrice === null
              ? null
              : minPrice === ""
                ? null
                : Number(
                    minPrice
                  ),
          maxPrice:
            maxPrice === null
              ? null
              : maxPrice === ""
                ? null
                : Number(
                    maxPrice
                  )
        },

        history: {
          count:
            history.length,

          oldest:
            history.length
              ? history[0].time
              : null,

          newest:
            history.length
              ? history.at(-1).time
              : null,

          hours:
            history.length > 1
              ? (
                  history.at(-1).time -
                  history[0].time
                ) / 3600000
              : 0,

          retentionHours:
            24,

          mode:
            "ACCUMULATED_24H"
        },

        count:
          filtered.length,

        trades:
          filtered,

        recentTrades:
          filtered
            .slice(-100)
            .reverse(),

        aggregation,

        generatedAt:
          Date.now()
      });
    }

    /* ---------- 404 ---------- */

    return errorJson(
      "Endpoint پیدا نشد",
      404
    );

  } catch (e) {
    return errorJson(
      e?.message ||
        "خطای داخلی Worker",
      500
    );
  }
}

/* =========================
   EXPORT
========================= */

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    return handleRequest(
      request
    );
  }
};
