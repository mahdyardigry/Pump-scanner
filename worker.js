const BYBIT = "https://api.bybit.com";

/* =========================================================
   PUMP SCANNER — BYBIT PULLBACK RADAR
   PUMP → RED CANDLE → PULLBACK ZONE → APPROACH → REACHED

   Timeframe: 15M
   Source: Bybit
========================================================= */

const VERSION = "PUMP-SCANNER-BYBIT-PPR-V2";

const CATEGORY = "linear";
const TF = "15";

const KLINE_LIMIT = 120;

/*
  تعداد ارزهایی که در هر چرخه بررسی می‌شوند.
  ابتدا TICKER برای پیدا کردن کاندیدهای پامپی
  و سپس KLINE فقط برای کاندیدها.
*/
const MAX_SYMBOLS = 300;
const CANDIDATE_LIMIT = 80;

const SCAN_BATCH = 10;

/* =========================================================
   PUMP FILTERS
========================================================= */

/*
  حداقل رشد Pump
*/
const MIN_PUMP_PERCENT = 6;

/*
  برای جلوگیری از اینکه یک کندل تصادفی
  به عنوان Pump شناخته شود.
*/
const MIN_PUMP_CANDLES = 2;
const MAX_PUMP_CANDLES = 6;

/*
  حداقل رشد کندل‌های Pump
*/
const MIN_PUMP_BODY_PERCENT = 0.8;

/*
  حجم Pump نسبت به میانگین قبل
*/
const MIN_VOLUME_MULTIPLIER = 1.5;

/*
  حداقل نسبت خرید/حرکت صعودی ساختار Pump
*/
const MIN_GREEN_RATIO = 0.60;

/* =========================================================
   RED PULLBACK
========================================================= */

/*
  کندل قرمز باید بعد از Pump باشد.
*/
const MAX_PULLBACK_LOOKAHEAD = 10;

/*
  کندل قرمز خیلی بزرگ را Pullback سالم
  حساب نمی‌کنیم.
*/
const MAX_PULLBACK_PERCENT = 4.5;

/*
  کندل قرمز باید حداقل این مقدار بدنه داشته باشد.
*/
const MIN_PULLBACK_BODY_PERCENT = 0.15;

/*
  محدوده کندل قرمز.
*/
const ZONE_MODE = "OPEN_LOW";

/*
  فاصله برای NEAR
*/
const NEAR_ZONE_PERCENT = 0.35;

/*
  برای اینکه Setup خراب‌شده را حذف کنیم،
  قیمت نباید بیش از این مقدار زیر کف Pump/Base برود.
*/
const INVALIDATION_BUFFER_PERCENT = 0.25;

/* =========================================================
   CACHE
========================================================= */

let lastScan = {
  ok: true,
  version: VERSION,
  source: "Bybit",
  timeframe: "15m",

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

let symbolCache = {
  symbols: [],
  timestamp: 0
};

const SYMBOL_CACHE_MS = 5 * 60 * 1000;


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
========================================================= */

async function getSymbols() {

  const now = Date.now();

  if (
    symbolCache.symbols.length &&
    now - symbolCache.timestamp <
      SYMBOL_CACHE_MS
  ) {

    return symbolCache.symbols;
  }

  const result =
    await bybit(
      "/v5/market/instruments-info",
      {
        category:
          CATEGORY,
        status:
          "Trading",
        limit:
          1000
      }
    );

  const list =
    result.list || [];

  const symbols =
    list
      .filter(x =>
        x.status === "Trading" &&
        x.quoteCoin === "USDT" &&
        x.contractType ===
          "LinearPerpetual"
      )
      .map(x => x.symbol)
      .filter(Boolean)
      .slice(
        0,
        MAX_SYMBOLS
      );

  symbolCache = {
    symbols,
    timestamp: now
  };

  return symbols;
}


/* =========================================================
   TICKERS
========================================================= */

async function getAllTickers() {

  const result =
    await bybit(
      "/v5/market/tickers",
      {
        category:
          CATEGORY
      }
    );

  return result.list || [];
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
        category:
          CATEGORY,

        symbol,

        interval:
          TF,

        limit:
          KLINE_LIMIT
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
   TICKER SYMBOL
========================================================= */

async function getTicker(
  symbol
) {

  const result =
    await bybit(
      "/v5/market/tickers",
      {
        category:
          CATEGORY,

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

  const valid =
    values.filter(
      Number.isFinite
    );

  if (!valid.length) {
    return 0;
  }

  return (
    valid.reduce(
      (sum, value) =>
        sum + value,
      0
    ) /
    valid.length
  );
}


/* =========================================================
   PUMP STRUCTURE
========================================================= */

/*
  این تابع مهم‌ترین قسمت سیستم است.

  هدف:

  قبل از اینکه اصلاً دنبال کندل قرمز برویم،
  باید یک حرکت واقعی صعودی پیدا کنیم.

  Pump باید:
  - حداقل 6% رشد داشته باشد
  - حداقل 2 کندل داشته باشد
  - majority سبز باشد
  - حجم افزایش داشته باشد
  - ساختار صعودی داشته باشد
*/

function detectPump(
  candles
) {

  if (
    candles.length <
    30
  ) {

    return null;
  }

  /*
    آخرین کندل ممکن است هنوز باز باشد.
    بنابراین آخرین کندل را وارد Setup نمی‌کنیم.
  */

  const lastClosed =
    candles.length - 2;

  let best = null;

  /*
    از چند نقطه شروع مختلف حرکت را بررسی می‌کنیم.
  */

  const earliest =
    Math.max(
      10,
      lastClosed - 35
    );

  for (
    let startIndex =
      earliest;

    startIndex <
      lastClosed - MIN_PUMP_CANDLES;

    startIndex++
  ) {

    /*
      Pump را در طول 2 تا 6 کندل بررسی می‌کنیم.
    */

    for (
      let count =
        MIN_PUMP_CANDLES;

      count <=
        MAX_PUMP_CANDLES;

      count++
    ) {

      const endIndex =
        startIndex +
        count -
        1;

      if (
        endIndex >
        lastClosed
      ) {

        break;
      }

      const base =
        candles[startIndex];

      const end =
        candles[endIndex];

      if (
        !base ||
        !end
      ) {

        continue;
      }

      /*
        رشد کل حرکت
      */

      const move =
        percent(
          end.close,
          base.close
        );

      if (
        move <
        MIN_PUMP_PERCENT
      ) {

        continue;
      }

      /*
        بررسی کندل‌های حرکت
      */

      const segment =
        candles.slice(
          startIndex,
          endIndex + 1
        );

      const greenCount =
        segment.filter(
          c =>
            c.close >
            c.open
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
        بدنه کندل‌ها
      */

      const strongBodies =
        segment.filter(
          c =>
            percent(
              c.close,
              c.open
            ) >=
            MIN_PUMP_BODY_PERCENT
        ).length;

      if (
        strongBodies <
        1
      ) {

        continue;
      }

      /*
        سقف حرکت
      */

      const pumpHigh =
        Math.max(
          ...segment.map(
            c => c.high
          )
        );

      /*
        کف حرکت
      */

      const pumpLow =
        Math.min(
          ...segment.map(
            c => c.low
          )
        );

      /*
        حجم قبل از Pump
      */

      const previous =
        candles.slice(
          Math.max(
            0,
            startIndex - 10
          ),
          startIndex
        );

      const previousVolumes =
        previous
          .map(
            c => c.volume
          )
          .filter(
            x => x > 0
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
        اگر اطلاعات حجم داشتیم،
        Pump باید افزایش حجم داشته باشد.
      */

      if (
        avgVolume > 0 &&
        volumeRatio <
          MIN_VOLUME_MULTIPLIER
      ) {

        continue;
      }

      /*
        حرکت باید سقف بالاتری بسازد.
      */

      let higherHighs =
        0;

      for (
        let i = 1;
        i < segment.length;
        i++
      ) {

        if (
          segment[i].high >
          segment[i - 1].high
        ) {

          higherHighs++;
        }
      }

      if (
        segment.length >= 3 &&
        higherHighs <
          1
      ) {

        continue;
      }

      /*
        امتیاز Pump
      */

      let score = 0;

      score +=
        Math.min(
          40,
          move * 3
        );

      score +=
        Math.min(
          25,
          greenRatio * 25
        );

      score +=
        Math.min(
          25,
          Math.max(
            0,
            (volumeRatio - 1) *
              12
          )
        );

      score +=
        Math.min(
          10,
          higherHighs * 5
        );

      const candidate = {
        startIndex,
        endIndex,

        basePrice:
          base.close,

        pumpPrice:
          end.close,

        pumpHigh,

        pumpLow,

        move,

        volumeRatio,

        greenRatio,

        candles:
          segment.length,

        score
      };

      /*
        بهترین Pump را انتخاب می‌کنیم.
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
   RED PULLBACK CANDLE
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
      from +
        MAX_PULLBACK_LOOKAHEAD
    );

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
      bodyPercent <
      MIN_PULLBACK_BODY_PERCENT
    ) {

      continue;
    }

    if (
      bodyPercent >
      MAX_PULLBACK_PERCENT
    ) {

      continue;
    }

    /*
      کندل قرمز نباید کاملاً
      خارج از ساختار Pump باشد.
    */

    if (
      c.high <
      pump.basePrice
    ) {

      continue;
    }

    /*
      اگر Low آن خیلی پایین‌تر از
      کف Pump باشد، ساختار خراب شده.
    */

    const invalidationPrice =
      pump.basePrice *
      (
        1 -
        INVALIDATION_BUFFER_PERCENT /
          100
      );

    if (
      c.low <
      invalidationPrice
    ) {

      continue;
    }

    /*
      محدوده Pullback
    */

    let zoneLow;
    let zoneHigh;

    if (
      ZONE_MODE ===
      "OPEN_LOW"
    ) {

      zoneLow =
        c.low;

      zoneHigh =
        c.open;

    } else {

      zoneLow =
        c.low;

      zoneHigh =
        c.high;
    }

    /*
      Pullback نباید بالاتر از
      سقف اصلی Pump باشد.
    */

    if (
      zoneLow >
      pump.pumpHigh
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

      zoneLow,

      zoneHigh
    };

    /*
      اولین Pullback معتبر
      مهم‌تر از Pullbackهای بعدی است.
    */

    break;
  }

  return best;
}


/* =========================================================
   PRICE STATE
========================================================= */

function getPriceState(
  currentPrice,
  zoneLow,
  zoneHigh,
  pumpBase
) {

  if (
    !Number.isFinite(
      currentPrice
    )
  ) {

    return {
      state:
        "WAITING",

      distancePercent:
        0
    };
  }

  const invalidation =
    pumpBase *
    (
      1 -
      INVALIDATION_BUFFER_PERCENT /
        100
    );

  /*
    ساختار کاملاً خراب شده
  */

  if (
    currentPrice <
    invalidation
  ) {

    return {
      state:
        "INVALID",

      distancePercent:
        Math.abs(
          percent(
            currentPrice,
            zoneLow
          )
        )
    };
  }

  /*
    داخل محدوده
  */

  if (
    currentPrice >=
      zoneLow &&
    currentPrice <=
      zoneHigh
  ) {

    return {
      state:
        "REACHED",

      distancePercent:
        0
    };
  }

  /*
    قیمت بالای Zone
  */

  if (
    currentPrice >
    zoneHigh
  ) {

    const distancePercent =
      (
        (
          currentPrice -
          zoneHigh
        ) /
        zoneHigh
      ) *
      100;

    if (
      distancePercent <=
      NEAR_ZONE_PERCENT
    ) {

      return {
        state:
          "NEAR",

        distancePercent
      };
    }

    return {
      state:
        "APPROACHING",

      distancePercent
    };
  }

  /*
    قیمت پایین Zone
  */

  return {
    state:
      "BELOW_ZONE",

    distancePercent:
      (
        (
          zoneLow -
          currentPrice
        ) /
        zoneLow
      ) *
      100
  };
}


/* =========================================================
   BUILD SETUP
========================================================= */

function buildSetup(
  symbol,
  candles,
  ticker
) {

  /*
    مرحله اول:
    Pump
  */

  const pump =
    detectPump(
      candles
    );

  /*
    اگر Pump نیست،
    هیچ Setup وجود ندارد.
  */

  if (!pump) {
    return null;
  }

  /*
    مرحله دوم:
    کندل قرمز Pullback
  */

  const pullback =
    findPullbackCandle(
      candles,
      pump
    );

  /*
    اگر کندل قرمز معتبر نیست،
    سیگنال نداریم.
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
    Math.min(
      pullback.zoneLow,
      pullback.zoneHigh
    );

  const zoneHigh =
    Math.max(
      pullback.zoneLow,
      pullback.zoneHigh
    );

  const priceState =
    getPriceState(
      currentPrice,
      zoneLow,
      zoneHigh,
      pump.basePrice
    );

  /*
    Setup ID پایدار
  */

  const setupId = [
    symbol,
    pump.startIndex,
    pump.endIndex,
    pullback.index
  ].join("-");

  /*
    فقط زمانی که Pump و Pullback
    هر دو وجود دارند نتیجه می‌سازیم.
  */

  return {

    id:
      setupId,

    symbol,

    timeframe:
      "15m",

    state:
      priceState.state,

    currentPrice,

    distancePercent:
      priceState.distancePercent,

    pump: {

      startTime:
        candles[
          pump.startIndex
        ].time,

      endTime:
        candles[
          pump.endIndex
        ].time,

      basePrice:
        pump.basePrice,

      price:
        pump.pumpPrice,

      high:
        pump.pumpHigh,

      low:
        pump.pumpLow,

      percent:
        pump.move,

      candles:
        pump.candles,

      volumeRatio:
        pump.volumeRatio,

      greenRatio:
        pump.greenRatio,

      score:
        Number(
          pump.score.toFixed(2)
        )
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

      zoneLow,

      zoneHigh
    },

    detectedAt:
      Date.now()
  };
}


/* =========================================================
   QUICK PUMP CANDIDATE FILTER
========================================================= */

/*
  قبل از گرفتن 120 کندل برای هر ارز،
  از Ticker برای پیدا کردن ارزهایی استفاده
  می‌کنیم که امروز/اخیراً حرکت قوی داشته‌اند.

  این فقط Candidate Filter است.

  سیگنال نهایی فقط با KLINE ساخته می‌شود.
*/

function selectCandidates(
  tickers,
  symbols
) {

  const allowed =
    new Set(symbols);

  return tickers
    .filter(t =>
      allowed.has(
        t.symbol
      )
    )
    .map(t => ({

      symbol:
        t.symbol,

      change24h:
        Number(
          t.price24hPcnt || 0
        ) * 100,

      volume24h:
        Number(
          t.volume24h || 0
        ),

      turnover24h:
        Number(
          t.turnover24h || 0
        )
    }))
    .filter(x =>
      /*
        ارز باید حداقل حرکت روزانه
        قابل توجه داشته باشد.

        اینجا فقط برای کاهش تعداد
        درخواست‌های KLINE است.
      */
      x.change24h >= 3
    )
    .sort(
      (a, b) =>
        b.change24h -
        a.change24h
    )
    .slice(
      0,
      CANDIDATE_LIMIT
    );
}


/* =========================================================
   SINGLE SYMBOL
========================================================= */

async function analyzeSymbol(
  symbol
) {

  try {

    const [
      candles,
      ticker
    ] =
      await Promise.all([
        getKlines(symbol),
        getTicker(symbol)
      ]);

    if (
      !candles.length
    ) {

      return null;
    }

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
   BATCH
========================================================= */

async function processBatches(
  symbols
) {

  const results = [];

  for (
    let i = 0;
    i < symbols.length;
    i += SCAN_BATCH
  ) {

    const batch =
      symbols.slice(
        i,
        i + SCAN_BATCH
      );

    const batchResults =
      await Promise.all(
        batch.map(
          symbol =>
            analyzeSymbol(
              symbol
            )
        )
      );

    for (
      const result
      of batchResults
    ) {

      if (result) {

        results.push(
          result
        );
      }
    }
  }

  return results;
}


/* =========================================================
   MARKET SCAN
========================================================= */

async function scanMarket() {

  /*
    1.
    گرفتن لیست ارزها
  */

  const symbols =
    await getSymbols();

  /*
    2.
    گرفتن Ticker همه ارزها
  */

  const tickers =
    await getAllTickers();

  /*
    3.
    پیدا کردن Candidateهای پامپی
  */

  const candidates =
    selectCandidates(
      tickers,
      symbols
    );

  /*
    4.
    فقط Candidateها را با KLINE
    به صورت عمیق بررسی می‌کنیم.
  */

  const candidateSymbols =
    candidates.map(
      x => x.symbol
    );

  /*
    5.
    تحلیل Pump + Pullback
  */

  const results =
    await processBatches(
      candidateSymbols
    );

  /*
    اول سیگنال‌های مهم
  */

  const priority = {

    REACHED:
      0,

    NEAR:
      1,

    APPROACHING:
      2,

    BELOW_ZONE:
      3,

    INVALID:
      4
  };

  results.sort(
    (a, b) =>
      (
        priority[
          a.state
        ] ?? 9
      ) -
      (
        priority[
          b.state
        ] ?? 9
      )
  );

  return {

    ok:
      true,

    version:
      VERSION,

    source:
      "Bybit",

    timeframe:
      "15m",

    scannedSymbols:
      symbols.length,

    candidates:
      candidateSymbols.length,

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
   API
========================================================= */

async function handleRequest(
  request
) {

  /*
    OPTIONS
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


  /* =======================================================
     HEALTH
  ======================================================= */

  if (
    path === "/health" ||
    path === "/api/health"
  ) {

    return json({

      ok:
        true,

      service:
        "Pump Scanner",

      version:
        VERSION,

      source:
        "Bybit",

      timeframe:
        "15m",

      mode:
        "PUMP → PULLBACK → RETEST",

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
        "SCAN ERROR:",
        error
      );

      return json({

        ok:
          false,

        error:
          error.message,

        version:
          VERSION,

        source:
          "Bybit",

        timeframe:
          "15m",

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
     ANALYZE SYMBOL
  ======================================================= */

  if (
    path === "/analyze" ||
    path === "/api/analyze"
  ) {

    const symbol =
      url.searchParams
        .get(
          "symbol"
        )
        ?.toUpperCase()
        .trim();

    if (!symbol) {

      return json({

        ok:
          false,

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

        ok:
          true,

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

        ok:
          false,

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
