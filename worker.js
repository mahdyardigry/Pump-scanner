const BYBIT = "https://api.bybit.com";

/* =========================================================
   PUMP SCANNER — BYBIT PULLBACK RADAR
   PUMP → RED CANDLE → PULLBACK ZONE → RETEST
   TIMEFRAME: 15 MINUTES
========================================================= */

const VERSION = "PUMP-SCANNER-BYBIT-PPR-V3";

const CATEGORY = "linear";
const TF = "15";

const KLINE_LIMIT = 120;

/*
  تعداد ارزهایی که بررسی می‌شوند
*/
const MAX_SYMBOLS = 300;

/*
  تعداد درخواست همزمان
*/
const SCAN_BATCH = 15;

/*
  Pump باید حداقل 2 و حداکثر 6 کندل
  ادامه داشته باشد.
*/
const MIN_PUMP_CANDLES = 2;
const MAX_PUMP_CANDLES = 6;

/*
  حداقل رشد Pump
*/
const MIN_PUMP_PERCENT = 6;

/*
  حجم Pump حداقل 1.5 برابر
  میانگین حجم قبل از Pump
*/
const MIN_VOLUME_MULTIPLIER = 1.5;

/*
  حداقل نسبت کندل‌های سبز Pump
*/
const MIN_GREEN_RATIO = 0.60;

/*
  حداکثر افت بدنه کندل قرمز Pullback
*/
const MAX_PULLBACK_PERCENT = 4.5;

/*
  فاصله از محدوده Pullback
*/
const NEAR_ZONE_PERCENT = 0.35;

/*
  حداکثر تعداد کندل بعد از Pump
  برای پیدا کردن Pullback
*/
const MAX_PULLBACK_CANDLES = 8;

/*
  حداقل حجم Pump
*/
const MIN_PUMP_VOLUME = 0;

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
      url.searchParams.set(
        key,
        String(value)
      );
    }
  }

  const response = await fetch(
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
    Bybit instruments-info ممکن است Pagination داشته باشد.
  */

  for (let page = 0; page < 3; page++) {

    const params = {
      category: CATEGORY,
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

    if (!cursor || !list.length) {
      break;
    }
  }

  return all
    .filter(x =>
      x.status === "Trading" &&
      x.quoteCoin === "USDT" &&
      x.contractType ===
        "LinearPerpetual"
    )
    .map(x => x.symbol)
    .filter(Boolean)
    .filter(
      (symbol, index, arr) =>
        arr.indexOf(symbol) === index
    )
    .slice(0, MAX_SYMBOLS);
}

/* =========================================================
   KLINES
========================================================= */

async function getKlines(symbol) {

  const result =
    await bybit(
      "/v5/market/kline",
      {
        category: CATEGORY,
        symbol,
        interval: TF,
        limit: KLINE_LIMIT
      }
    );

  const rows =
    result.list || [];

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
    .sort(
      (a, b) =>
        a.time - b.time
    );
}

/* =========================================================
   TICKER
========================================================= */

async function getTicker(symbol) {

  const result =
    await bybit(
      "/v5/market/tickers",
      {
        category: CATEGORY,
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

  if (!b) {
    return 0;
  }

  return (
    ((a - b) / b) * 100
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
    ) / values.length
  );
}

/* =========================================================
   PUMP DETECTION
========================================================= */

function detectPump(candles) {

  /*
    حداقل اطلاعات لازم
  */

  if (
    candles.length <
    MAX_PUMP_CANDLES + 20
  ) {
    return null;
  }

  /*
    آخرین کندل ممکن است هنوز باز باشد.
    پس آخرین کندل بسته‌شده:
  */

  const lastClosed =
    candles.length - 2;

  let best = null;

  /*
    فقط Pumpهای نسبتاً جدید را می‌خواهیم.
    حداکثر 40 کندل عقب.
  */

  const searchStart =
    Math.max(
      10,
      lastClosed - 40
    );

  for (
    let end = searchStart;
    end <= lastClosed - 1;
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

      if (start < searchStart) {
        continue;
      }

      const base =
        candles[start - 1];

      if (!base) {
        continue;
      }

      const segment =
        candles.slice(
          start,
          end + 1
        );

      if (
        segment.length !== count
      ) {
        continue;
      }

      /*
        تمام Pump باید بعد از Base
        اتفاق افتاده باشد.
      */

      const final =
        segment[segment.length - 1];

      /*
        رشد از Base تا پایان Pump
      */

      const move =
        percent(
          final.close,
          base.close
        );

      if (
        move <
        MIN_PUMP_PERCENT
      ) {
        continue;
      }

      /*
        حداقل نسبت کندل سبز
      */

      const greenCount =
        segment.filter(
          c =>
            c.close > c.open
        ).length;

      const greenRatio =
        greenCount /
        segment.length;

      if (
        greenRatio <
        MIN_GREEN_RATIO
      ) {
        continue;
      }

      /*
        High کل Pump
      */

      const pumpHigh =
        Math.max(
          ...segment.map(
            c => c.high
          )
        );

      const pumpLow =
        Math.min(
          ...segment.map(
            c => c.low
          )
        );

      /*
        حجم Pump
      */

      const previousVolumes =
        candles
          .slice(
            Math.max(
              0,
              start - 10
            ),
            start
          )
          .map(
            c => c.volume
          )
          .filter(
            v => v > 0
          );

      const avgVolume =
        average(
          previousVolumes
        );

      const pumpVolume =
        average(
          segment.map(
            c => c.volume
          )
        );

      const volumeRatio =
        avgVolume > 0
          ? pumpVolume /
            avgVolume
          : 0;

      /*
        اگر حجم تاریخی موجود است،
        Pump باید Volume واقعی داشته باشد.
      */

      if (
        avgVolume > 0 &&
        volumeRatio <
          MIN_VOLUME_MULTIPLIER
      ) {
        continue;
      }

      /*
        حجم صفر یا غیرواقعی
      */

      if (
        pumpVolume <
        MIN_PUMP_VOLUME
      ) {
        continue;
      }

      /*
        Score
      */

      let score = 0;

      score += Math.min(
        40,
        move * 2.5
      );

      score += Math.min(
        30,
        volumeRatio * 5
      );

      score +=
        greenRatio * 30;

      score = Math.min(
        100,
        Number(
          score.toFixed(2)
        )
      );

      /*
        فقط Pump معتبر
      */

      const candidate = {
        pumpIndex: end,

        baseIndex:
          start - 1,

        startTime:
          base.time,

        endTime:
          final.time,

        basePrice:
          base.close,

        pumpPrice:
          final.close,

        high:
          pumpHigh,

        low:
          pumpLow,

        move,

        candles: count,

        volumeRatio,

        greenRatio,

        score
      };

      /*
        Pump بزرگ‌تر و قوی‌تر اولویت دارد.
      */

      if (
        !best ||
        candidate.score >
          best.score
      ) {
        best = candidate;
      }
    }
  }

  return best;
}

/* =========================================================
   PULLBACK DETECTION
========================================================= */

function findPullbackCandle(
  candles,
  pump
) {

  if (!pump) {
    return null;
  }

  const from =
    pump.pumpIndex + 1;

  const to =
    Math.min(
      candles.length - 2,
      from +
        MAX_PULLBACK_CANDLES
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
      حتماً قرمز باشد
    */

    if (
      c.close >= c.open
    ) {
      continue;
    }

    /*
      اندازه بدنه
    */

    const bodyPercent =
      Math.abs(
        percent(
          c.close,
          c.open
        )
      );

    if (
      bodyPercent >
      MAX_PULLBACK_PERCENT
    ) {
      continue;
    }

    /*
      Pullback نباید کل Pump
      را خراب کرده باشد.
    */

    if (
      c.low <=
      pump.basePrice
    ) {
      continue;
    }

    /*
      باید بخشی از محدوده Pump
      را لمس کرده باشد.
    */

    if (
      c.high <
      pump.pumpPrice
    ) {
      /*
        اگر Pullback حتی به ناحیه
        انتهایی Pump نرسیده باشد،
        آن را Setup نمی‌دانیم.
      */

      continue;
    }

    /*
      محدوده Retest:
      Low تا Open کندل قرمز
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

      time: c.time,

      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,

      bodyPercent,

      zoneLow,
      zoneHigh
    };
  }

  return null;
}

/* =========================================================
   BUILD SETUP
========================================================= */

function buildSetup(
  symbol,
  candles,
  ticker
) {

  const pump =
    detectPump(candles);

  /*
    اگر Pump نداریم:
    هیچ نتیجه‌ای نده.
  */

  if (!pump) {
    return null;
  }

  const pullback =
    findPullbackCandle(
      candles,
      pump
    );

  /*
    Pump هست ولی Pullback معتبر
    هنوز تشکیل نشده.
    این ارز نباید سیگنال شود.
  */

  if (!pullback) {
    return null;
  }

  const currentPrice =
    ticker?.price ??
    candles[
      candles.length - 1
    ].close;

  const zoneLow =
    pullback.zoneLow;

  const zoneHigh =
    pullback.zoneHigh;

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

  /*
    وضعیت Setup
  */

  let state =
    "WAITING";

  if (
    currentPrice >= zoneLow &&
    currentPrice <= zoneHigh
  ) {

    state =
      "REACHED";

  } else if (
    currentPrice >
      zoneHigh &&
    distancePercent <=
      NEAR_ZONE_PERCENT
  ) {

    state =
      "NEAR";

  } else if (
    currentPrice >
    zoneHigh
  ) {

    state =
      "APPROACHING";

  } else {

    state =
      "BELOW_ZONE";
  }

  /*
    اگر قیمت Base Pump را از دست داده:
    Setup باطل
  */

  if (
    currentPrice <
    pump.basePrice
  ) {
    state =
      "INVALID";
  }

  /*
    اگر قیمت بیش از حد از Zone دور شده
    و هنوز به آن نرسیده،
    سیگنال فعال نیست.
  */

  const setupId = [
    symbol,
    pump.baseIndex,
    pump.pumpIndex,
    pullback.index
  ].join("-");

  return {
    id: setupId,

    symbol,

    timeframe: "15m",

    state,

    currentPrice,

    distancePercent:

      Number(
        distancePercent.toFixed(4)
      ),

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
        Number(
          pump.move.toFixed(2)
        ),

      candles:
        pump.candles,

      volumeRatio:
        Number(
          pump.volumeRatio.toFixed(2)
        ),

      greenRatio:
        Number(
          pump.greenRatio.toFixed(2)
        ),

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
        Number(
          pullback.bodyPercent.toFixed(2)
        ),

      zoneLow,

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

  const selected =
    symbols.slice(
      0,
      MAX_SYMBOLS
    );

  const results = [];

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

    const batchResults =
      await Promise.all(
        batch.map(
          analyzeSymbol
        )
      );

    for (
      const result of
      batchResults
    ) {

      /*
        فقط Setup معتبر
      */

      if (
        result &&
        result.pump &&
        result.pullback
      ) {
        results.push(
          result
        );
      }
    }
  }

  /*
    اولویت
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

      const p =
        (priority[a.state] ?? 9) -
        (priority[b.state] ?? 9);

      if (p !== 0) {
        return p;
      }

      /*
        اگر وضعیت یکی بود،
        Pump قوی‌تر بالاتر.
      */

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

    candidates:
      results.length,

    setups:
      results.length,

    /*
      سیگنال واقعی فقط وقتی است
      که قیمت داخل Pullback Zone باشد.
    */

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
   LAST RESULT
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

  scannedSymbols: 0,

  candidates: 0,

  setups: 0,

  signals: 0,

  near: 0,

  approaching: 0,

  invalid: 0,

  timestamp: 0,

  results: []
};

/* =========================================================
   REQUEST HANDLER
========================================================= */

async function handleRequest(
  request
) {

  /*
    CORS
  */

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

  /* =====================================================
     HEALTH
  ===================================================== */

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

      timestamp:
        Date.now()
    });
  }

  /* =====================================================
     SCAN
  ===================================================== */

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

        error:
          error.message,

        version:
          VERSION

      }, 500);
    }
  }

  /* =====================================================
     RESULTS
  ===================================================== */

  if (
    path === "/results" ||
    path === "/api/results"
  ) {

    return json(
      lastScan
    );
  }

  /* =====================================================
     ANALYZE
  ===================================================== */

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

  /* =====================================================
     ROOT
  ===================================================== */

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
