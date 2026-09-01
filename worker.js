const BYBIT = "https://api.bybit.com";

/* =========================================================
   PUMP SCANNER — BYBIT PULLBACK RADAR V6
   15M
   PUMP → RED CANDLE → PULLBACK ZONE → RETEST
========================================================= */

const VERSION = "PUMP-SCANNER-BYBIT-PPR-V6";

const TF = "15";
const KLINE_LIMIT = 120;

const SYMBOL_PAGE_LIMIT = 1000;
const BATCH_SIZE = 20;

/* =========================
   PUMP RULES
========================= */

const MIN_PUMP_PERCENT = 6;

const MIN_PUMP_CANDLES = 2;
const MAX_PUMP_CANDLES = 6;

const MIN_GREEN_RATIO = 0.60;

const MIN_VOLUME_MULTIPLIER = 1.5;

/*
  Pump باید تازه باشد.
  24 ساعت = 96 کندل 15M
*/
const MAX_PUMP_AGE_MS =
  24 * 60 * 60 * 1000;

/* =========================
   PULLBACK RULES
========================= */

const MAX_PULLBACK_PERCENT = 4.5;

const NEAR_ZONE_PERCENT = 0.35;


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
   BYBIT REQUEST
========================================================= */

async function bybit(
  path,
  params = {}
) {

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
   تمام USDT Linear Perpetual
========================================================= */

async function getSymbols() {

  const symbols = [];

  let cursor = "";

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
      const item
      of list
    ) {

      if (
        item.status ===
          "Trading" &&

        item.quoteCoin ===
          "USDT" &&

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
    cursor
  );

  return [
    ...new Set(symbols)
  ];
}


/* =========================================================
   KLINES
========================================================= */

async function getKlines(
  symbol
) {

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

      time:
        Number(row[0]),

      open:
        Number(row[1]),

      high:
        Number(row[2]),

      low:
        Number(row[3]),

      close:
        Number(row[4]),

      volume:
        Number(row[5]),

      turnover:
        Number(row[6])

    }))
    .sort(
      (a, b) =>
        a.time - b.time
    );
}


/* =========================================================
   TICKER
========================================================= */

async function getTicker(
  symbol
) {

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
      Number(
        item.lastPrice
      ),

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

function percent(
  a,
  b
) {

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


function average(
  values
) {

  if (
    !values.length
  ) {

    return 0;
  }

  return (
    values.reduce(
      (sum, x) =>
        sum + x,
      0
    ) /
    values.length
  );
}


/* =========================================================
   PUMP DETECTION V6
========================================================= */

function detectPump(
  candles
) {

  /*
    آخرین کندل معمولاً در حال تشکیل است.
  */

  if (
    candles.length <
    40
  ) {

    return null;
  }

  const lastClosedIndex =
    candles.length - 2;

  const now =
    Date.now();

  let best =
    null;

  /*
    فقط 24 ساعت اخیر
  */

  const earliest =
    Math.max(
      5,
      lastClosedIndex - 96
    );

  /*
    end = آخرین کندل Pump
  */

  for (
    let end =
      lastClosedIndex - 1;

    end >= earliest;

    end--
  ) {

    /*
      اگر بعد از Pump هیچ کندلی
      برای Pullback وجود نداشته باشد
      این Pump را بررسی نمی‌کنیم.
    */

    if (
      end >=
      lastClosedIndex
    ) {

      continue;
    }

    for (
      let count =
        MIN_PUMP_CANDLES;

      count <=
        MAX_PUMP_CANDLES;

      count++
    ) {

      const start =
        end - count + 1;

      if (
        start < 5
      ) {

        continue;
      }

      const pumpCandles =
        candles.slice(
          start,
          end + 1
        );

      if (
        pumpCandles.length !==
        count
      ) {

        continue;
      }

      const base =
        candles[
          start - 1
        ];

      if (!base) {
        continue;
      }

      /*
        سن Pump
      */

      const pumpEnd =
        pumpCandles[
          pumpCandles.length - 1
        ];

      const age =
        now -
        pumpEnd.time;

      if (
        age < 0 ||
        age >
        MAX_PUMP_AGE_MS
      ) {

        continue;
      }

      /*
        درصد کندل‌های سبز
      */

      const greenCount =
        pumpCandles.filter(
          c =>
            c.close >
            c.open
        ).length;

      const greenRatio =
        greenCount /
        count;

      if (
        greenRatio <
        MIN_GREEN_RATIO
      ) {

        continue;
      }

      /*
        درصد Pump
      */

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
        High کل Pump
      */

      const pumpHigh =
        Math.max(
          ...pumpCandles.map(
            c =>
              c.high
          )
        );

      const pumpLow =
        Math.min(
          ...pumpCandles.map(
            c =>
              c.low
          )
        );

      /*
        باید حرکت واقعی باشد.
      */

      if (
        pumpHigh <=
        base.close
      ) {

        continue;
      }

      /*
        حجم قبل از Pump
      */

      const previousVolumes =
        candles
          .slice(
            Math.max(
              0,
              start - 12
            ),
            start
          )
          .map(
            c =>
              c.volume
          )
          .filter(
            v =>
              Number.isFinite(v) &&
              v > 0
          );

      const avgVolume =
        average(
          previousVolumes
        );

      const pumpVolumes =
        pumpCandles
          .map(
            c =>
              c.volume
          )
          .filter(
            v =>
              Number.isFinite(v) &&
              v > 0
          );

      const pumpAverageVolume =
        average(
          pumpVolumes
        );

      const volumeRatio =
        avgVolume > 0
          ? pumpAverageVolume /
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
        Score
      */

      let score = 0;

      score +=
        Math.min(
          40,
          move * 2.5
        );

      score +=
        Math.min(
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
          Number(
            score.toFixed(2)
          )
        );

      const candidate = {

        startIndex:
          start,

        endIndex:
          end,

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
          pumpLow,

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
        جدیدترین Pump را ترجیح می‌دهیم.
        اگر سن برابر بود، Score بالاتر.
      */

      if (
        !best
      ) {

        best =
          candidate;

      } else if (
        candidate.endTime >
        best.endTime
      ) {

        best =
          candidate;

      } else if (
        candidate.endTime ===
          best.endTime &&
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

function findPullbackCandle(
  candles,
  pump
) {

  if (!pump) {
    return null;
  }

  const from =
    pump.endIndex + 1;

  /*
    حداکثر 8 کندل بعد از Pump
  */

  const to =
    Math.min(
      candles.length - 2,
      from + 8
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
      Pullback نباید Base را بشکند.
    */

    if (
      c.low <
      pump.basePrice
    ) {

      continue;
    }

    /*
      Pullback نباید از Pump
      بیشتر از 4.5٪ فاصله بگیرد.
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

    /*
      Zone:
      Low تا Open
    */

    return {

      index:
        i,

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

      zoneLow:
        c.low,

      zoneHigh:
        c.open
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
    detectPump(
      candles
    );

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

  const last =
    candles[
      candles.length - 1
    ];

  const currentPrice =
    ticker?.price ??
    last.close;

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

  } else if (
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

    if (
      distancePercent <=
      NEAR_ZONE_PERCENT
    ) {

      state =
        "NEAR";

    } else {

      state =
        "APPROACHING";
    }

  } else {

    distancePercent =
      (
        (
          zoneLow -
          currentPrice
        ) /
        zoneLow
      ) * 100;

    state =
      "BELOW_ZONE";
  }

  /*
    شکست Base = Invalid
  */

  if (
    currentPrice <
    pump.basePrice
  ) {

    state =
      "INVALID";
  }

  /*
    Setup ID
  */

  const id =
    [
      symbol,
      pump.startIndex,
      pump.endIndex,
      pullback.index
    ].join("-");

  return {

    id,

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
          pump.rangePercent
            .toFixed(4)
        ),

      candles:
        pump.candles,

      greenRatio:
        Number(
          pump.greenRatio
            .toFixed(4)
        ),

      volumeRatio:
        Number(
          pump.volumeRatio
            .toFixed(4)
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
      candles.length <
      40
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
   MARKET SCAN
========================================================= */

async function scanMarket() {

  const symbols =
    await getSymbols();

  const results = [];

  /*
    تعداد ارزهایی که حداقل
    Pump معتبر + Pullback دارند.
  */

  let candidates = 0;

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
          24
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
          "/analyze?symbol=ACEUSDT"

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
        "/analyze?symbol=ACEUSDT"
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
