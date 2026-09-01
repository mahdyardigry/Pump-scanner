const BYBIT = "https://api.bybit.com";

/* =========================================================
   PUMP SCANNER — BYBIT PULLBACK RADAR V4
   15M
   PUMP → RED CANDLE → PULLBACK ZONE → RETEST
========================================================= */

const VERSION = "PUMP-SCANNER-BYBIT-PPR-V4";

const TF = "15";
const KLINE_LIMIT = 160;

const SCAN_BATCH = 25;
const MAX_SYMBOLS = 300;

/* ---------- Pump ---------- */

const MIN_PUMP_PERCENT = 6;

const MIN_PUMP_CANDLES = 2;
const MAX_PUMP_CANDLES = 6;

const MIN_VOLUME_MULTIPLIER = 1.5;
const MIN_GREEN_RATIO = 0.60;

/*
  برای جلوگیری از اینکه یک حرکت معمولی
  به اشتباه Pump شناخته شود.
*/
const MIN_PUMP_RANGE_PERCENT = 5.0;

/*
  Pump باید از یک محدوده نسبتاً فشرده
  شروع شده باشد.
*/
const MAX_BASE_RANGE_PERCENT = 5.0;


/* ---------- Pullback ---------- */

const MAX_PULLBACK_PERCENT = 4.5;

const MIN_PULLBACK_PERCENT = 0.10;

const MAX_PULLBACK_CANDLES = 12;

const NEAR_ZONE_PERCENT = 0.35;


/* ---------- Scan ---------- */

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
   RESPONSE
========================================================= */

function json(data, status = 200) {

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  );
}


/* =========================================================
   BYBIT
========================================================= */

async function bybit(path, params = {}) {

  const url = new URL(
    BYBIT + path
  );

  for (
    const [key, value]
    of Object.entries(params)
  ) {

    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {

      url.searchParams.set(
        key,
        String(value)
      );
    }
  }

  const response =
    await fetch(
      url.toString(),
      {
        method: "GET",
        headers: {
          "Accept": "application/json"
        }
      }
    );

  if (!response.ok) {

    throw new Error(
      `Bybit HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (data.retCode !== 0) {

    throw new Error(
      data.retMsg ||
      "Bybit API error"
    );
  }

  return data.result;
}


/* =========================================================
   SYMBOLS
========================================================= */

async function getSymbols() {

  const all = [];

  let cursor = "";

  /*
    instruments-info ممکن است pagination داشته باشد.
  */

  for (let page = 0; page < 3; page++) {

    const params = {
      category: "linear",
      status: "Trading",
      limit: 1000
    };

    if (cursor) {
      params.cursor = cursor;
    }

    const result =
      await bybit(
        "/v5/market/instruments-info",
        params
      );

    const list =
      result.list || [];

    all.push(...list);

    cursor =
      result.nextPageCursor || "";

    if (!cursor) {
      break;
    }
  }

  /*
    فقط USDT Linear Perpetual
  */

  const symbols =
    all
      .filter(x =>
        x.status === "Trading" &&
        x.quoteCoin === "USDT" &&
        x.contractType ===
          "LinearPerpetual"
      )
      .map(x => x.symbol)
      .filter(Boolean);

  /*
    حذف Duplicate
  */

  return [...new Set(symbols)];
}


/* =========================================================
   KLINES
========================================================= */

async function getKlines(symbol) {

  const result =
    await bybit(
      "/v5/market/kline",
      {
        category: "linear",
        symbol,
        interval: TF,
        limit: KLINE_LIMIT
      }
    );

  const rows =
    result.list || [];

  /*
    Bybit:
    newest → oldest

    تبدیل:
    oldest → newest
  */

  const candles =
    rows
      .map(row => ({
        time: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
        turnover: Number(row[6])
      }))
      .sort(
        (a, b) =>
          a.time - b.time
      );

  /*
    آخرین کندل ممکن است هنوز باز باشد.
    برای تحلیل ساختاری آن را حذف می‌کنیم.
  */

  if (candles.length > 1) {
    candles.pop();
  }

  return candles;
}


/* =========================================================
   TICKER
========================================================= */

async function getTicker(symbol) {

  const result =
    await bybit(
      "/v5/market/tickers",
      {
        category: "linear",
        symbol
      }
    );

  const item =
    result.list?.[0];

  if (!item) {
    return null;
  }

  return {
    symbol,
    price:
      Number(item.lastPrice),

    change24h:
      Number(
        item.price24hPcnt || 0
      ) * 100,

    volume24h:
      Number(
        item.volume24h || 0
      ),

    turnover24h:
      Number(
        item.turnover24h || 0
      )
  };
}


/* =========================================================
   MATH
========================================================= */

function percent(a, b) {

  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    b === 0
  ) {
    return 0;
  }

  return (
    ((a - b) / b) *
    100
  );
}


function average(values) {

  if (!values.length) {
    return 0;
  }

  return (
    values.reduce(
      (sum, value) =>
        sum + value,
      0
    ) /
    values.length
  );
}


function clamp(
  value,
  min,
  max
) {

  return Math.max(
    min,
    Math.min(max, value)
  );
}


/* =========================================================
   VOLUME BASELINE
========================================================= */

function getVolumeRatio(
  candles,
  startIndex,
  pumpIndex
) {

  /*
    حجم کندل‌های قبل از شروع Pump
  */

  const previous =
    candles
      .slice(
        Math.max(
          0,
          startIndex - 20
        ),
        startIndex
      )
      .map(x => x.volume)
      .filter(
        x =>
          Number.isFinite(x) &&
          x > 0
      );

  if (!previous.length) {
    return 0;
  }

  const avg =
    average(previous);

  if (!avg) {
    return 0;
  }

  /*
    به جای فقط یک کندل،
    میانگین حجم کل Pump را بررسی می‌کنیم.
  */

  const pumpVolumes =
    candles
      .slice(
        startIndex,
        pumpIndex + 1
      )
      .map(x => x.volume)
      .filter(x => x > 0);

  const pumpAvg =
    average(pumpVolumes);

  return pumpAvg / avg;
}


/* =========================================================
   BASE STRUCTURE
========================================================= */

function baseStructure(
  candles,
  startIndex,
  pumpIndex
) {

  const baseLookback = 3;

  const from =
    Math.max(
      0,
      startIndex - baseLookback
    );

  const baseCandles =
    candles.slice(
      from,
      startIndex
    );

  if (!baseCandles.length) {
    return null;
  }

  const highs =
    baseCandles.map(
      x => x.high
    );

  const lows =
    baseCandles.map(
      x => x.low
    );

  const baseHigh =
    Math.max(...highs);

  const baseLow =
    Math.min(...lows);

  const baseRange =
    percent(
      baseHigh,
      baseLow
    );

  /*
    محدوده قبل از Pump نباید
    خودش یک حرکت بزرگ باشد.
  */

  if (
    baseRange >
    MAX_BASE_RANGE_PERCENT
  ) {
    return null;
  }

  return {
    baseHigh,
    baseLow,
    baseRange
  };
}


/* =========================================================
   PUMP DETECTION V4
========================================================= */

function detectPump(candles) {

  if (
    candles.length <
    MIN_PUMP_CANDLES + 10
  ) {
    return null;
  }

  let best = null;

  /*
    فقط ساختارهای بسته‌شده
    بررسی می‌شوند.
  */

  const last =
    candles.length - 1;

  /*
    حداکثر تا 40 کندل اخیر
  */

  const earliest =
    Math.max(
      5,
      last - 45
    );

  for (
    let end = earliest;
    end <= last;
    end++
  ) {

    /*
      Pump می‌تواند 2 تا 6 کندل باشد.
    */

    for (
      let count =
        MIN_PUMP_CANDLES;

      count <= MAX_PUMP_CANDLES;

      count++
    ) {

      const start =
        end - count + 1;

      if (start < 5) {
        continue;
      }

      /*
        بعد از Pump باید حداقل
        یک کندل برای Pullback وجود داشته باشد.
      */

      if (end >= last) {
        continue;
      }

      const first =
        candles[start];

      const final =
        candles[end];

      if (!first || !final) {
        continue;
      }

      /*
        حرکت کل Pump
      */

      const move =
        percent(
          final.close,
          first.open
        );

      if (
        move <
        MIN_PUMP_PERCENT
      ) {
        continue;
      }

      /*
        High واقعی Pump
      */

      const pumpCandles =
        candles.slice(
          start,
          end + 1
        );

      const pumpHigh =
        Math.max(
          ...pumpCandles.map(
            x => x.high
          )
        );

      const pumpLow =
        Math.min(
          ...pumpCandles.map(
            x => x.low
          )
        );

      const totalRange =
        percent(
          pumpHigh,
          first.open
        );

      if (
        totalRange <
        MIN_PUMP_RANGE_PERCENT
      ) {
        continue;
      }

      /*
        تعداد کندل‌های سبز
      */

      let green = 0;

      for (
        const c
        of pumpCandles
      ) {

        if (
          c.close >
          c.open
        ) {
          green++;
        }
      }

      const greenRatio =
        green /
        pumpCandles.length;

      if (
        greenRatio <
        MIN_GREEN_RATIO
      ) {
        continue;
      }

      /*
        Pump نباید با یک کندل قرمز
        بزرگ ساخته شده باشد.
      */

      if (
        final.close <=
        final.open
      ) {
        continue;
      }

      /*
        ساختار Base
      */

      const base =
        baseStructure(
          candles,
          start,
          end
        );

      if (!base) {
        continue;
      }

      /*
        حجم Pump
      */

      const volumeRatio =
        getVolumeRatio(
          candles,
          start,
          end
        );

      /*
        اگر baseline داریم،
        حجم Pump باید حداقل 1.5 برابر باشد.
      */

      if (
        volumeRatio > 0 &&
        volumeRatio <
          MIN_VOLUME_MULTIPLIER
      ) {
        continue;
      }

      /*
        امتیاز Pump
      */

      const priceScore =
        clamp(
          (
            move /
            15
          ) * 40,
          0,
          40
        );

      const volumeScore =
        clamp(
          (
            Math.max(
              volumeRatio,
              1
            ) /
            5
          ) * 30,
          0,
          30
        );

      const greenScore =
        clamp(
          (
            greenRatio -
            MIN_GREEN_RATIO
          ) /
          (1 -
            MIN_GREEN_RATIO ||
            1) *
          30,
          0,
          30
        );

      const score =
        Math.round(
          (
            priceScore +
            volumeScore +
            greenScore
          ) * 100
        ) / 100;

      const candidate = {

        startIndex: start,

        endIndex: end,

        startTime:
          first.time,

        endTime:
          final.time,

        basePrice:
          first.open,

        pumpPrice:
          final.close,

        high:
          pumpHigh,

        low:
          pumpLow,

        percent:
          move,

        rangePercent:
          totalRange,

        candles:
          pumpCandles.length,

        greenRatio,

        volumeRatio,

        score
      };

      /*
        قوی‌ترین Pump را انتخاب می‌کنیم.
      */

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

  return best;
}


/* =========================================================
   PULLBACK DETECTION
========================================================= */

function findPullback(
  candles,
  pump
) {

  if (!pump) {
    return null;
  }

  const from =
    pump.endIndex + 1;

  const to =
    Math.min(
      candles.length - 1,
      from +
        MAX_PULLBACK_CANDLES -
        1
    );

  for (
    let i = from;
    i <= to;
    i++
  ) {

    const c =
      candles[i];

    if (!c) {
      continue;
    }

    /*
      حتماً قرمز
    */

    if (
      c.close >=
      c.open
    ) {
      continue;
    }

    /*
      اندازه بدنه
    */

    const body =
      Math.abs(
        percent(
          c.close,
          c.open
        )
      );

    if (
      body <
      MIN_PULLBACK_PERCENT
    ) {
      continue;
    }

    if (
      body >
      MAX_PULLBACK_PERCENT
    ) {
      continue;
    }

    /*
      کندل قرمز باید هنوز
      داخل ساختار Pump باشد.
    */

    if (
      c.high <
      pump.basePrice
    ) {
      continue;
    }

    /*
      Pullback Zone:
      Low تا Open
    */

    const zoneLow =
      Math.min(
        c.low,
        c.open
      );

    const zoneHigh =
      Math.max(
        c.low,
        c.open
      );

    return {

      index: i,

      time:
        c.time,

      open:
        c.open,

      high:
        c.high,

      low:
        c.low,

      close:
        c.close,

      bodyPercent:
        body,

      zoneLow,

      zoneHigh
    };
  }

  return null;
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
    findPullback(
      candles,
      pump
    );

  /*
    Pump واقعی پیدا شده ولی
    هنوز Pullback نداریم.
  */

  if (!pullback) {
    return null;
  }

  const lastCandle =
    candles[
      candles.length - 1
    ];

  const currentPrice =
    ticker?.price ??
    lastCandle.close;

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

  let distancePercent = 0;

  if (
    currentPrice >
    zoneHigh
  ) {

    distancePercent =
      (
        (
          currentPrice -
          zoneHigh
        ) /
        zoneHigh
      ) * 100;

  } else if (
    currentPrice <
    zoneLow
  ) {

    distancePercent =
      (
        (
          zoneLow -
          currentPrice
        ) /
        zoneLow
      ) * 100;
  }

  let state =
    "WAITING";

  /*
    قیمت داخل Zone
  */

  if (
    currentPrice >=
      zoneLow &&
    currentPrice <=
      zoneHigh
  ) {

    state =
      "REACHED";

  }

  /*
    بالای Zone ولی نزدیک
  */

  else if (
    currentPrice >
      zoneHigh &&
    distancePercent <=
      NEAR_ZONE_PERCENT
  ) {

    state =
      "NEAR";

  }

  /*
    بالای Zone
  */

  else if (
    currentPrice >
    zoneHigh
  ) {

    state =
      "APPROACHING";

  }

  /*
    زیر Zone
  */

  else {

    state =
      "BELOW_ZONE";
  }

  /*
    اگر قیمت زیر Base Pump رفته،
    ساختار خراب شده.
  */

  if (
    currentPrice <
    pump.basePrice
  ) {

    state =
      "INVALID";
  }

  /*
    اگر قیمت بعد از Pullback
    دوباره High Pump را شکسته،
    Setup دیگر Pullback Retest
    فعلی نیست.
  */

  if (
    currentPrice >
    pump.high &&
    currentPrice >
    pullback.zoneHigh
  ) {

    state =
      "INVALID";
  }

  const setupId =
    [
      symbol,
      pump.startIndex,
      pump.endIndex,
      pullback.index
    ].join("-");

  return {

    id:
      setupId,

    symbol,

    timeframe:
      "15m",

    state,

    currentPrice,

    distancePercent,

    pump: {

      startTime:
        pump.startTime,

      endTime:
        pump.endTime,

      basePrice:
        pump.basePrice,

      price:
        pump.pumpPrice,

      high:
        pump.high,

      low:
        pump.low,

      percent:
        pump.percent,

      rangePercent:
        pump.rangePercent,

      candles:
        pump.candles,

      greenRatio:
        pump.greenRatio,

      volumeRatio:
        pump.volumeRatio,

      score:
        pump.score
    },

    pullback: {

      time:
        pullback.time,

      open:
        pullback.open,

      high:
        pullback.high,

      low:
        pullback.low,

      close:
        pullback.close,

      bodyPercent:
        pullback.bodyPercent,

      zoneLow:
        zoneLow,

      zoneHigh:
        zoneHigh
    },

    detectedAt:
      Date.now()
  };
}


/* =========================================================
   ANALYZE SYMBOL
========================================================= */

async function analyzeSymbol(
  symbol
) {

  try {

    const candles =
      await getKlines(
        symbol
      );

    if (
      candles.length <
      30
    ) {
      return null;
    }

    /*
      ابتدا Pump را پیدا می‌کنیم.
      اگر Pump نبود، ticker هم نمی‌گیریم.
    */

    const pump =
      detectPump(
        candles
      );

    if (!pump) {
      return null;
    }

    /*
      بعد Pullback
    */

    const pullback =
      findPullback(
        candles,
        pump
      );

    if (!pullback) {
      return null;
    }

    /*
      فقط Setup معتبر:
      ticker
    */

    const ticker =
      await getTicker(
        symbol
      );

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
   SCAN MARKET
========================================================= */

async function scanMarket() {

  const symbols =
    await getSymbols();

  /*
    حداکثر 300 ارز
  */

  const selected =
    symbols.slice(
      0,
      MAX_SYMBOLS
    );

  const results = [];

  let candidates = 0;

  /*
    Batch
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

    /*
      ابتدا تحلیل Pump
      برای کاهش درخواست‌ها
    */

    const batchResults =
      await Promise.all(
        batch.map(
          async symbol => {

            try {

              const candles =
                await getKlines(
                  symbol
                );

              if (
                candles.length <
                30
              ) {
                return null;
              }

              const pump =
                detectPump(
                  candles
                );

              if (!pump) {
                return null;
              }

              candidates++;

              const pullback =
                findPullback(
                  candles,
                  pump
                );

              if (!pullback) {
                return null;
              }

              const ticker =
                await getTicker(
                  symbol
                );

              return buildSetup(
                symbol,
                candles,
                ticker
              );

            } catch (error) {

              console.error(
                "Scan error:",
                symbol,
                error.message
              );

              return null;
            }
          }
        )
      );

    for (
      const result
      of batchResults
    ) {

      if (result) {
        results.push(result);
      }
    }
  }


  /*
    اول قوی‌ترین وضعیت
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
    (a, b) => {

      const stateDiff =
        (
          priority[a.state] ??
          99
        ) -
        (
          priority[b.state] ??
          99
        );

      if (
        stateDiff !== 0
      ) {
        return stateDiff;
      }

      return (
        (b.pump?.score || 0) -
        (a.pump?.score || 0)
      );
    }
  );


  return {

    ok: true,

    version:
      VERSION,

    source:
      "Bybit",

    timeframe:
      "15m",

    mode:
      "PUMP → RED CANDLE → PULLBACK ZONE → RETEST",

    scannedSymbols:
      selected.length,

    candidates,

    setups:
      results.length,

    signals:
      results.filter(
        x =>
          x.state ===
          "REACHED"
      ).length,

    near:
      results.filter(
        x =>
          x.state ===
          "NEAR"
      ).length,

    approaching:
      results.filter(
        x =>
          x.state ===
          "APPROACHING"
      ).length,

    invalid:
      results.filter(
        x =>
          x.state ===
          "INVALID"
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

  ok: true,

  version:
    VERSION,

  source:
    "Bybit",

  timeframe:
    "15m",

  mode:
    "PUMP → RED CANDLE → PULLBACK ZONE → RETEST",

  scannedSymbols:
    0,

  candidates:
    0,

  setups:
    0,

  signals:
    0,

  near:
    0,

  approaching:
    0,

  invalid:
    0,

  timestamp:
    0,

  results:
    []
};


/* =========================================================
   REQUEST HANDLER
========================================================= */

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
        headers:
          CORS_HEADERS
      }
    );
  }

  const url =
    new URL(
      request.url
    );

  const path =
    url.pathname;


  /* =======================================================
     HEALTH
  ======================================================= */

  if (
    path === "/health" ||
    path === "/api/health"
  ) {

    return json({

      ok: true,

      service:
        "Pump Scanner",

      version:
        VERSION,

      source:
        "Bybit",

      timeframe:
        "15m",

      strategy:
        "PUMP → RED CANDLE → PULLBACK ZONE → RETEST",

      rules: {

        minPumpPercent:
          MIN_PUMP_PERCENT,

        minPumpVolume:
          MIN_VOLUME_MULTIPLIER,

        minPumpCandles:
          MIN_PUMP_CANDLES,

        maxPumpCandles:
          MAX_PUMP_CANDLES,

        minGreenRatio:
          MIN_GREEN_RATIO,

        maxPullbackPercent:
          MAX_PULLBACK_PERCENT,

        nearZonePercent:
          NEAR_ZONE_PERCENT
      },

      timestamp:
        Date.now()
    });
  }


  /* =======================================================
     SCAN
  ======================================================= */

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

      console.error(
        "Scan failed:",
        error.message
      );

      return json({

        ok: false,

        version:
          VERSION,

        error:
          error.message,

        timestamp:
          Date.now()

      }, 500);
    }
  }


  /* =======================================================
     RESULTS
  ======================================================= */

  if (
    path === "/results" ||
    path === "/api/results"
  ) {

    return json(
      lastScan
    );
  }


  /* =======================================================
     ANALYZE
  ======================================================= */

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
          "symbol required",

        example:
          "/analyze?symbol=BTCUSDT"

      }, 400);
    }

    try {

      const result =
        await analyzeSymbol(
          symbol
        );

      return json({

        ok: true,

        version:
          VERSION,

        source:
          "Bybit",

        timeframe:
          "15m",

        result

      });

    } catch (error) {

      return json({

        ok: false,

        error:
          error.message

      }, 500);
    }
  }


  /* =======================================================
     ROOT
  ======================================================= */

  return json({

    name:
      "Pump Scanner",

    version:
      VERSION,

    source:
      "Bybit",

    timeframe:
      "15m",

    strategy:
      "PUMP → RED CANDLE → PULLBACK ZONE → RETEST",

    rules: {

      minPumpPercent:
        MIN_PUMP_PERCENT,

      minPumpVolume:
        MIN_VOLUME_MULTIPLIER,

      minPumpCandles:
        MIN_PUMP_CANDLES,

      maxPumpCandles:
        MAX_PUMP_CANDLES,

      minGreenRatio:
        MIN_GREEN_RATIO,

      maxPullbackPercent:
        MAX_PULLBACK_PERCENT,

      nearZonePercent:
        NEAR_ZONE_PERCENT
    },

    endpoints: {

      health:
        "/health",

      scan:
        "/scan",

      results:
        "/results",

      analyze:
        "/analyze?symbol=BTCUSDT"
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
