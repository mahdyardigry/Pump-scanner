const BYBIT = "https://api.bybit.com";

/* =========================================================
   PUMP SCANNER — BYBIT PULLBACK RADAR
   Timeframe: 15M
========================================================= */

const VERSION = "PUMP-SCANNER-BYBIT-PPR-V1";

const TF = "15";
const KLINE_LIMIT = 120;

const SCAN_BATCH = 25;
const MAX_SYMBOLS = 250;

const PUMP_LOOKBACK = 8;

/*
  حداقل حرکت برای اینکه یک حرکت را Pump بدانیم.
  این مقدار عمداً قابل تنظیم است.
*/
const MIN_PUMP_PERCENT = 6;

/*
  حجم کندل Pump باید حداقل چند برابر
  میانگین حجم قبلی باشد.
*/
const MIN_VOLUME_MULTIPLIER = 1.5;

/*
  کندل قرمز Pullback:
  Close < Open
*/
const MAX_PULLBACK_PERCENT = 4.5;

/*
  فاصله قیمت تا محدوده برای حالت نزدیک.
*/
const NEAR_ZONE_PERCENT = 0.35;

/*
  چند دقیقه یک بار اسکن بعدی انجام شود.
  چون داده 15M است، اسکن مداوم انجام می‌شود
  ولی از API بیش از حد درخواست نمی‌فرستیم.
*/
const SCAN_INTERVAL_MS = 45000;


/* =========================================================
   CORS
========================================================= */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};


/* =========================================================
   RESPONSE HELPERS
========================================================= */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}


/* =========================================================
   BYBIT REQUEST
========================================================= */

async function bybit(path, params = {}) {

  const url = new URL(BYBIT + path);

  for (const [key, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Bybit HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (data.retCode !== 0) {
    throw new Error(
      data.retMsg || "Bybit API error"
    );
  }

  return data.result;
}


/* =========================================================
   SYMBOL LIST
========================================================= */

async function getSymbols() {

  const result = await bybit(
    "/v5/market/instruments-info",
    {
      category: "linear",
      status: "Trading",
      limit: 1000
    }
  );

  const list = result.list || [];

  return list
    .filter(x =>
      x.status === "Trading" &&
      x.quoteCoin === "USDT" &&
      x.contractType === "LinearPerpetual"
    )
    .map(x => x.symbol)
    .filter(Boolean);
}


/* =========================================================
   KLINES
========================================================= */

async function getKlines(symbol) {

  const result = await bybit(
    "/v5/market/kline",
    {
      category: "linear",
      symbol,
      interval: TF,
      limit: KLINE_LIMIT
    }
  );

  const rows = result.list || [];

  /*
    Bybit newest candle first.
    تبدیل به قدیمی -> جدید
  */

  return rows
    .map(row => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      turnover: Number(row[6])
    }))
    .sort((a, b) => a.time - b.time);
}


/* =========================================================
   CURRENT PRICE
========================================================= */

async function getTicker(symbol) {

  const result = await bybit(
    "/v5/market/tickers",
    {
      category: "linear",
      symbol
    }
  );

  const item = result.list?.[0];

  if (!item) {
    return null;
  }

  return {
    symbol,
    price: Number(item.lastPrice),
    change24h: Number(item.price24hPcnt || 0) * 100,
    volume24h: Number(item.volume24h || 0),
    turnover24h: Number(item.turnover24h || 0)
  };
}


/* =========================================================
   MATH
========================================================= */

function percent(a, b) {

  if (!b) return 0;

  return ((a - b) / b) * 100;
}


function average(values) {

  if (!values.length) {
    return 0;
  }

  return values.reduce(
    (sum, x) => sum + x,
    0
  ) / values.length;
}


/* =========================================================
   PUMP DETECTION
========================================================= */

function detectPump(candles) {

  if (candles.length < PUMP_LOOKBACK + 6) {
    return null;
  }

  /*
    آخرین کندل بسته‌شده را فعلاً وارد
    تشخیص Setup نمی‌کنیم.

    candles.length - 2
  */

  const lastClosedIndex = candles.length - 2;

  /*
    از چند کندل آخر عقب می‌رویم و
    بزرگ‌ترین حرکت صعودی را پیدا می‌کنیم.
  */

  let best = null;

  const start = Math.max(
    2,
    lastClosedIndex - 30
  );

  for (
    let i = start;
    i <= lastClosedIndex - 2;
    i++
  ) {

    const startIndex = Math.max(
      0,
      i - PUMP_LOOKBACK
    );

    const base = candles[startIndex];

    const pump = candles[i];

    if (!base || !pump) {
      continue;
    }

    const move = percent(
      pump.close,
      base.close
    );

    if (move < MIN_PUMP_PERCENT) {
      continue;
    }

    const previousVolumes = candles
      .slice(
        Math.max(0, startIndex - 10),
        startIndex
      )
      .map(x => x.volume)
      .filter(x => x > 0);

    const avgVolume =
      average(previousVolumes);

    /*
      اگر حجم تاریخی در دسترس نبود،
      فقط حرکت قیمت را بررسی می‌کنیم.
    */

    const volumeRatio =
      avgVolume > 0
        ? pump.volume / avgVolume
        : 0;

    if (
      avgVolume > 0 &&
      volumeRatio < MIN_VOLUME_MULTIPLIER
    ) {
      continue;
    }

    /*
      Pump باید واقعاً صعودی باشد.
    */

    if (pump.close <= pump.open) {
      continue;
    }

    /*
      بالاترین Pump را نگه می‌داریم.
    */

    if (!best || move > best.move) {

      best = {
        pumpIndex: i,
        baseIndex: startIndex,
        basePrice: base.close,
        pumpPrice: pump.close,
        pumpHigh: pump.high,
        move,
        volumeRatio
      };
    }
  }

  return best;
}


/* =========================================================
   RED CANDLE / PULLBACK
========================================================= */

function findPullbackCandle(
  candles,
  pump
) {

  if (!pump) {
    return null;
  }

  /*
    فقط کندل‌های بعد از Pump را بررسی می‌کنیم.
  */

  const from =
    pump.pumpIndex + 1;

  const to =
    Math.min(
      candles.length - 2,
      from + 12
    );

  let best = null;

  for (
    let i = from;
    i <= to;
    i++
  ) {

    const c = candles[i];

    if (!c) {
      continue;
    }

    /*
      کندل باید قرمز باشد.
    */

    if (c.close >= c.open) {
      continue;
    }

    const bodyPercent =
      Math.abs(
        percent(c.close, c.open)
      );

    /*
      کندل قرمز خیلی بزرگ را Pullback
      معمولی در نظر نمی‌گیریم.
    */

    if (
      bodyPercent >
      MAX_PULLBACK_PERCENT
    ) {
      continue;
    }

    /*
      کندل باید هنوز در ساختار Pump باشد.
    */

    if (
      c.high < pump.basePrice
    ) {
      continue;
    }

    /*
      محدوده اصلی Pullback:

      Low -> Open
    */

    const zoneLow = c.low;
    const zoneHigh = c.open;

    best = {
      index: i,
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      bodyPercent,
      zoneLow,
      zoneHigh
    };

    /*
      اولین کندل قرمز معتبر را می‌گیریم.
    */

    break;
  }

  return best;
}


/* =========================================================
   SETUP
========================================================= */

function buildSetup(
  symbol,
  candles,
  ticker
) {

  const pump =
    detectPump(candles);

  if (!pump) {
    return null;
  }

  const pullback =
    findPullbackCandle(
      candles,
      pump
    );

  if (!pullback) {
    return null;
  }

  const currentPrice =
    ticker?.price ??
    candles[candles.length - 1].close;

  const zoneLow =
    Math.min(
      pullback.zoneLow,
      pullback.zoneHigh
    );

  const zoneHigh =
    Math.max(
      pullback.zoneLow,
      pullback.zoneHigh
    );

  /*
    اگر قیمت بالای Zone باشد،
    فاصله تا Zone محاسبه می‌شود.
  */

  let distancePercent = 0;

  if (currentPrice > zoneHigh) {

    distancePercent =
      ((currentPrice - zoneHigh) /
        zoneHigh) *
      100;

  } else if (currentPrice < zoneLow) {

    distancePercent =
      ((zoneLow - currentPrice) /
        zoneLow) *
      100;
  }

  let state =
    "WAITING";

  if (
    currentPrice >= zoneLow &&
    currentPrice <= zoneHigh
  ) {

    state = "REACHED";

  } else if (
    currentPrice > zoneHigh &&
    distancePercent <=
      NEAR_ZONE_PERCENT
  ) {

    state = "NEAR";

  } else if (
    currentPrice > zoneHigh
  ) {

    state = "APPROACHING";

  } else {

    state = "BELOW_ZONE";
  }

  /*
    اگر قیمت قبل از رسیدن Zone
    دوباره High مهم Pump را بشکند،
    Setup می‌تواند ادامه داشته باشد.

    اما اگر ساختار کاملاً خراب شود،
    آن را invalid می‌کنیم.
  */

  if (
    currentPrice <
    pump.basePrice
  ) {
    state = "INVALID";
  }

  const setupId = [
    symbol,
    pump.pumpIndex,
    pullback.index
  ].join("-");

  return {
    id: setupId,
    symbol,

    timeframe: "15m",

    state,

    currentPrice,

    distancePercent,

    pump: {
      basePrice: pump.basePrice,
      price: pump.pumpPrice,
      high: pump.pumpHigh,
      percent: pump.move,
      volumeRatio: pump.volumeRatio
    },

    pullback: {
      time: pullback.time,

      open: pullback.open,
      high: pullback.high,
      low: pullback.low,
      close: pullback.close,

      zoneLow,
      zoneHigh,

      bodyPercent:
        pullback.bodyPercent
    },

    detectedAt:
      Date.now()
  };
}


/* =========================================================
   SINGLE SYMBOL ANALYSIS
========================================================= */

async function analyzeSymbol(symbol) {

  try {

    const candles =
      await getKlines(symbol);

    if (!candles.length) {
      return null;
    }

    const ticker =
      await getTicker(symbol);

    return buildSetup(
      symbol,
      candles,
      ticker
    );

  } catch (error) {

    console.error(
      "Analyze error:",
      symbol,
      error.message
    );

    return null;
  }
}


/* =========================================================
   SCAN
========================================================= */

async function scanMarket() {

  const symbols =
    await getSymbols();

  /*
    برای جلوگیری از فشار زیاد روی API،
    فعلاً تعداد محدودی از ارزها را اسکن می‌کنیم.

    در نسخه بعدی می‌توانیم اسکن را
    Batch + Cache کنیم.
  */

  const selected =
    symbols.slice(
      0,
      MAX_SYMBOLS
    );

  const results = [];

  /*
    Batch processing
  */

  for (
    let i = 0;
    i < selected.length;
    i += SCAN_BATCH
  ) {

    const batch =
      selected.slice(
        i,
        i + SCAN_BATCH
      );

    const batchResults =
      await Promise.all(
        batch.map(analyzeSymbol)
      );

    for (
      const result of batchResults
    ) {

      if (result) {
        results.push(result);
      }
    }
  }

  /*
    اول REACHED
    بعد NEAR
    بعد APPROACHING
  */

  const priority = {
    REACHED: 0,
    NEAR: 1,
    APPROACHING: 2,
    BELOW_ZONE: 3,
    WAITING: 4,
    INVALID: 5
  };

  results.sort(
    (a, b) =>
      (priority[a.state] ?? 9) -
      (priority[b.state] ?? 9)
  );

  return {
    version: VERSION,
    timeframe: "15m",

    scannedSymbols:
      selected.length,

    setups:
      results.length,

    signals:
      results.filter(
        x => x.state === "REACHED"
      ).length,

    near:
      results.filter(
        x => x.state === "NEAR"
      ).length,

    approaching:
      results.filter(
        x => x.state === "APPROACHING"
      ).length,

    invalid:
      results.filter(
        x => x.state === "INVALID"
      ).length,

    timestamp:
      Date.now(),

    results
  };
}


/* =========================================================
   CACHE
========================================================= */

let lastScan = {
  version: VERSION,
  timeframe: "15m",
  scannedSymbols: 0,
  setups: 0,
  signals: 0,
  near: 0,
  approaching: 0,
  invalid: 0,
  timestamp: 0,
  results: []
};


/* =========================================================
   API
========================================================= */

async function handleRequest(request) {

  if (
    request.method === "OPTIONS"
  ) {

    return new Response(
      null,
      {
        headers:
          CORS_HEADERS
      }
    );
  }

  const url =
    new URL(request.url);

  const path =
    url.pathname;

  /*
    Health
  */

  if (
    path === "/health" ||
    path === "/api/health"
  ) {

    return json({
      ok: true,
      service: "Pump Scanner",
      version: VERSION,
      source: "Bybit",
      timeframe: "15m",
      timestamp: Date.now()
    });
  }


  /*
    Manual scan
  */

  if (
    path === "/scan" ||
    path === "/api/scan"
  ) {

    try {

      const result =
        await scanMarket();

      lastScan =
        result;

      return json(
        result
      );

    } catch (error) {

      return json({
        ok: false,
        error: error.message,
        version: VERSION
      }, 500);
    }
  }


  /*
    آخرین نتیجه
  */

  if (
    path === "/results" ||
    path === "/api/results"
  ) {

    return json(
      lastScan
    );
  }


  /*
    تحلیل یک ارز
  */

  if (
    path === "/analyze" ||
    path === "/api/analyze"
  ) {

    const symbol =
      url.searchParams
        .get("symbol")
        ?.toUpperCase()
        .trim();

    if (!symbol) {

      return json({
        ok: false,
        error:
          "symbol required"
      }, 400);
    }

    try {

      const result =
        await analyzeSymbol(
          symbol
        );

      return json({
        ok: true,
        result
      });

    } catch (error) {

      return json({
        ok: false,
        error: error.message
      }, 500);
    }
  }


  /*
    Root
  */

  return json({
    name: "Pump Scanner",
    version: VERSION,
    source: "Bybit",
    timeframe: "15m",

    endpoints: {
      health: "/health",
      scan: "/scan",
      results: "/results",
      analyze: "/analyze?symbol=BTCUSDT"
    }
  });
}


/* =========================================================
   CLOUDFLARE WORKER
========================================================= */

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
