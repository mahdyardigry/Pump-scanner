const BYBIT = "https://api.bybit.com";

/* =========================================================
   PUMP SCANNER — BYBIT PULLBACK RADAR V5
   15M
   PUMP → RED CANDLE → PULLBACK ZONE → RETEST
========================================================= */

const VERSION = "PUMP-SCANNER-BYBIT-PPR-V5";

const TF = "15";
const KLINE_LIMIT = 120;

/*
  اسکن همه نمادهای مناسب Bybit
*/
const SYMBOL_PAGE_LIMIT = 1000;

/*
  حداقل/حداکثر Pump
*/
const MIN_PUMP_PERCENT = 6;
const MIN_PUMP_CANDLES = 2;
const MAX_PUMP_CANDLES = 6;
const MIN_GREEN_RATIO = 0.60;

/*
  حجم Pump
*/
const MIN_VOLUME_MULTIPLIER = 1.5;

/*
  Pullback
*/
const MAX_PULLBACK_PERCENT = 4.5;

/*
  فاصله برای Near
*/
const NEAR_ZONE_PERCENT = 0.35;

/*
  Pump باید نسبتاً تازه باشد.
  حداکثر 12 ساعت از پایان Pump.
*/
const MAX_PUMP_AGE_MS = 12 * 60 * 60 * 1000;

/*
  برای اینکه Worker بیش از حد تحت فشار قرار نگیرد.
*/
const BATCH_SIZE = 15;


/* =========================================================
   CORS
========================================================= */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};


/* =========================================================
   JSON
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

  const url =
    new URL(BYBIT + path);

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
          "Accept":
            "application/json"
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

  if (
    data.retCode !== 0
  ) {

    throw new Error(
      data.retMsg ||
      "Bybit API error"
    );
  }

  return data.result;
}


/* =========================================================
   SYMBOLS
   همه Linear Perpetual های USDT
========================================================= */

async function getSymbols() {

  let cursor = "";
  const symbols = [];

  do {

    const result =
      await bybit(
        "/v5/market/instruments-info",
        {
          category: "linear",
          status: "Trading",
          limit:
            SYMBOL_PAGE_LIMIT,
          cursor
        }
      );

    const list =
      result.list || [];

    for (
      const item of list
    ) {

      if (
        item.status === "Trading" &&
        item.quoteCoin === "USDT" &&
        item.contractType ===
          "LinearPerpetual" &&
        item.symbol
      ) {

        symbols.push(
          item.symbol
        );
      }
    }

    cursor =
      result.nextPageCursor || "";

  } while (
    cursor &&
    symbols.length < 10000
  );

  return [
    ...new Set(symbols)
  ];
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
    (a - b) /
    b
  ) * 100;
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


/* =========================================================
   PUMP DETECTION V5
========================================================= */

function detectPump(candles) {

  /*
    حداقل:
    چند کندل قبل +
    2 تا 6 کندل Pump +
    Pullback
  */

  if (
    candles.length <
    30
  ) {

    return null;
  }

  /*
    آخرین کندل در حال تشکیل است.
    پس آخرین کندل بسته‌شده:
  */

  const lastClosed =
    candles.length - 2;

  const now =
    Date.now();

  let best = null;

  /*
    Pump باید تازه باشد.
    از آخر بازار تا 48 کندل
    عقب می‌رویم.
  */

  const earliest =
    Math.max(
      10,
      lastClosed - 48
    );

  for (
    let end =
      lastClosed - 2;

    end >= earliest;

    end--
  ) {

    /*
      Pump بین 2 تا 6 کندل
    */

    for (
      let count =
        MAX_PUMP_CANDLES;

      count >=
        MIN_PUMP_CANDLES;

      count--
    ) {

      const start =
        end - count + 1;

      if (start < 5) {
        continue;
      }

      const base =
        candles[start - 1];

      if (!base) {
        continue;
      }

      const pumpCandles =
        candles.slice(
          start,
          end + 1
        );

      if (
        pumpCandles.length !== count
      ) {

        continue;
      }

      /*
        Pump باید تازه باشد.
      */

      const age =
        now -
        pumpCandles[
          pumpCandles.length - 1
        ].time;

      if (
        age >
        MAX_PUMP_AGE_MS
      ) {

        continue;
      }

      /*
        درصد سبز بودن Pump
      */

      const greenCount =
        pumpCandles.filter(
          candle =>
            candle.close >
            candle.open
        ).length;

      const greenRatio =
        greenCount /
        pumpCandles.length;

      if (
        greenRatio <
        MIN_GREEN_RATIO
      ) {

        continue;
      }

      /*
        قیمت شروع Pump
      */

      const pumpEnd =
        pumpCandles[
          pumpCandles.length - 1
        ];

      const move =
        percent(
          pumpEnd.close,
          base.close
        );

      if (
        move <
        MIN_PUMP_PERCENT
      ) {

        continue;
      }

      /*
        Pump باید سقف جدید
        نسبت به Base ساخته باشد.
      */

      const pumpHigh =
        Math.max(
          ...pumpCandles.map(
            x => x.high
          )
        );

      if (
        pumpHigh <=
        base.close
      ) {

        continue;
      }

      /*
        حجم قبل Pump
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
            x => x.volume
          )
          .filter(
            x =>
              Number.isFinite(x) &&
              x > 0
          );

      const avgVolume =
        average(
          previousVolumes
        );

      /*
        حجم Pump را مجموع می‌گیریم.
      */

      const pumpVolume =
        average(
          pumpCandles.map(
            x => x.volume
          )
        );

      const volumeRatio =
        avgVolume > 0
          ? pumpVolume /
            avgVolume
          : 0;

      if (
        avgVolume > 0 &&
        volumeRatio <
          MIN_VOLUME_MULTIPLIER
      ) {

        continue;
      }

      /*
        امتیاز Pump
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
        greenRatio * 20;

      score +=
        count >= 4
          ? 10
          : 5;

      score =
        Math.min(
          100,
          Number(score.toFixed(2))
        );

      const candidate = {

        startIndex: start,
        endIndex: end,

        startTime:
          base.time,

        endTime:
          pumpEnd.time,

        basePrice:
          base.close,

        pumpPrice:
          pumpEnd.close,

        high:
          pumpHigh,

        low:
          Math.min(
            ...pumpCandles.map(
              x => x.low
            )
          ),

        percent:
          move,

        rangePercent:
          percent(
            pumpHigh,
            base.close
          ),

        candles:
          count,

        greenRatio,

        volumeRatio,

        score
      };

      /*
        بهترین Pump:
        اول Score
        سپس درصد حرکت
      */

      if (
        !best ||
        candidate.score >
          best.score ||
        (
          candidate.score ===
            best.score &&
          candidate.percent >
            best.percent
        )
      ) {

        best =
          candidate;
      }
    }
  }

  return best;
}


/* =========================================================
   PULLBACK
========================================================= */

function findPullbackCandle(
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
      candles.length - 2,
      from + 12
    );

  /*
    اگر بعد از Pump هنوز
    Pullback تشکیل نشده باشد:
    Setup نداریم.
  */

  let best = null;

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
      فقط کندل قرمز
    */

    if (
      c.close >=
      c.open
    ) {

      continue;
    }

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
      Pullback نباید قبل از
      Pump Base کاملاً فروبریزد.
    */

    if (
      c.low <
      pump.basePrice
    ) {

      continue;
    }

    /*
      کندل قرمز باید در محدوده
      ساختار Pump باشد.
    */

    if (
      c.high <
      pump.basePrice
    ) {

      continue;
    }

    /*
      Zone:
      Low → Open
    */

    const zoneLow =
      c.low;

    const zoneHigh =
      c.open;

    /*
      اگر Low خیلی پایین‌تر از
      Pump End باشد، Pullback
      بیش از حد عمیق است.
    */

    const retracePercent =
      (
        (
          pump.pumpPrice -
          c.low
        ) /
        pump.pumpPrice
      ) * 100;

    if (
      retracePercent >
      MAX_PULLBACK_PERCENT
    ) {

      continue;
    }

    best = {

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

      bodyPercent,

      retracePercent,

      zoneLow,

      zoneHigh
    };

    /*
      اولین Pullback معتبر
      مهم‌ترین Pullback است.
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

  /*
    بالای Zone و خیلی نزدیک
  */

  } else if (
    currentPrice >
      zoneHigh &&
    distancePercent <=
      NEAR_ZONE_PERCENT
  ) {

    state =
      "NEAR";

  /*
    بالای Zone
  */

  } else if (
    currentPrice >
    zoneHigh
  ) {

    state =
      "APPROACHING";

  /*
    زیر Zone
  */

  } else {

    state =
      "BELOW_ZONE";
  }

  /*
    اگر Base Pump شکسته شود،
    Setup خراب است.
  */

  if (
    currentPrice <
    pump.basePrice
  ) {

    state =
      "INVALID";
  }

  /*
    اگر قیمت بیش از حد از Zone
    پایین رفته باشد، Invalid.
  */

  if (
    currentPrice <
      zoneLow &&
    (
      (
        zoneLow -
        currentPrice
      ) /
      zoneLow
    ) * 100 >
      MAX_PULLBACK_PERCENT
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
          pump.percent.toFixed(4)
        ),

      rangePercent:
        Number(
          pump.rangePercent.toFixed(4)
        ),

      candles:
        pump.candles,

      greenRatio:
        Number(
          pump.greenRatio.toFixed(4)
        ),

      volumeRatio:
        Number(
          pump.volumeRatio.toFixed(4)
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
          pullback.bodyPercent
            .toFixed(4)
        ),

      retracePercent:
        Number(
          pullback.retracePercent
            .toFixed(4)
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
      candles.length < 30
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

  const results = [];

  let candidates = 0;

  /*
    Batch
  */

  for (
    let i = 0;
    i < symbols.length;
    i += BATCH_SIZE
  ) {

    const batch =
      symbols.slice(
        i,
        i + BATCH_SIZE
      );

    const batchResults =
      await Promise.all(
        batch.map(
          analyzeSymbol
        )
      );

    for (
      const result
      of batchResults
    ) {

      if (!result) {
        continue;
      }

      candidates++;

      results.push(
        result
      );
    }
  }

  /*
    اول سیگنال‌های مهم
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
        (
          priority[a.state] ??
          99
        ) -
        (
          priority[b.state] ??
          99
        );

      if (p !== 0) {
        return p;
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
      symbols.length,

    candidates,

    setups:
      results.filter(
        x =>
          x.state !==
          "INVALID"
      ).length,

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
   REQUEST
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


/* =========================================================
   HEALTH
========================================================= */

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
          NEAR_ZONE_PERCENT,

        maxPumpAgeHours:
          MAX_PUMP_AGE_MS /
          3600000
      },

      timestamp:
        Date.now()
    });
  }


/* =========================================================
   SCAN
========================================================= */

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
        "Scan error:",
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


/* =========================================================
   RESULTS
========================================================= */

  if (
    path === "/results" ||
    path === "/api/results"
  ) {

    return json(
      lastScan
    );
  }


/* =========================================================
   ANALYZE
========================================================= */

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


/* =========================================================
   ROOT
========================================================= */

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
   CLOUDFLARE
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
