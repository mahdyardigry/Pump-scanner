const BYBIT = "https://api.bybit.com";

const VERSION = "PUMP-SCANNER-BYBIT-PPR-V7";

const TF = "15";
const TF_MS = 15 * 60 * 1000;

const KLINE_LIMIT = 120;
const SCAN_BATCH = 20;

/* =========================
   Pump Rules
========================= */

const MIN_PUMP_PERCENT = 6;

const MIN_VOLUME_MULTIPLIER = 1.5;

const MIN_PUMP_CANDLES = 2;
const MAX_PUMP_CANDLES = 6;

const MIN_GREEN_RATIO = 0.60;

const MAX_PULLBACK_PERCENT = 4.5;

const NEAR_ZONE_PERCENT = 0.35;

const MAX_PUMP_AGE_HOURS = 12;
const MAX_PUMP_AGE_MS =
  MAX_PUMP_AGE_HOURS * 60 * 60 * 1000;


/* =========================
   Runtime
========================= */

let lastScan = {
  ok: true,
  version: VERSION,
  source: "Bybit",
  timeframe: "15m",
  mode: "PUMP → RED CANDLE → PULLBACK ZONE → RETEST",

  scannedSymbols: 0,
  candidates: 0,
  setups: 0,

  signals: 0,
  near: 0,
  approaching: 0,
  invalid: 0,

  timestamp: null,
  results: []
};


/* =========================
   Helpers
========================= */

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate"
      }
    }
  );
}


function withCors(response) {
  const headers = new Headers(response.headers);

  headers.set("Access-Control-Allow-Origin", "*");
  headers.set(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}


function round(value, digits = 4) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 0;
  }

  return Number(n.toFixed(digits));
}


function percentChange(from, to) {
  if (!from || !Number.isFinite(from)) {
    return 0;
  }

  return ((to - from) / from) * 100;
}


/* =========================
   Bybit Request
========================= */

async function bybit(path) {
  const response = await fetch(
    BYBIT + path,
    {
      method: "GET",
      headers: {
        "accept": "application/json"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Bybit HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (!data || data.retCode !== 0) {
    throw new Error(
      data?.retMsg || "Bybit API error"
    );
  }

  return data;
}


/* =========================
   Symbols
========================= */

async function getSymbols() {

  const data = await bybit(
    "/v5/market/instruments-info" +
    "?category=linear" +
    "&status=Trading" +
    "&limit=1000"
  );

  const list = Array.isArray(data?.result?.list)
    ? data.result.list
    : [];

  return list
    .filter(item => {

      return (
        item.status === "Trading" &&
        item.quoteCoin === "USDT" &&
        item.contractType === "LinearPerpetual"
      );

    })
    .map(item => item.symbol)
    .filter(Boolean);
}


/* =========================
   Tickers
========================= */

async function getAllTickers() {

  const data = await bybit(
    "/v5/market/tickers?category=linear"
  );

  const list = Array.isArray(data?.result?.list)
    ? data.result.list
    : [];

  const map = new Map();

  for (const item of list) {

    if (!item.symbol) {
      continue;
    }

    map.set(
      item.symbol,
      {
        symbol: item.symbol,

        lastPrice: num(item.lastPrice),

        volume24h: num(item.volume24h),

        turnover24h: num(item.turnover24h),

        price24hPcnt: num(item.price24hPcnt) * 100,

        highPrice24h: num(item.highPrice24h),

        lowPrice24h: num(item.lowPrice24h),

        openInterest: num(item.openInterest),

        fundingRate: num(item.fundingRate)
      }
    );
  }

  return map;
}


/* =========================
   Klines
========================= */

async function getKlines(symbol) {

  const query =
    "/v5/market/kline" +
    "?category=linear" +
    `&symbol=${encodeURIComponent(symbol)}` +
    `&interval=${TF}` +
    `&limit=${KLINE_LIMIT}`;

  const data = await bybit(query);

  const list = Array.isArray(data?.result?.list)
    ? data.result.list
    : [];

  const candles = list
    .map(row => {

      return {
        startTime: num(row[0]),
        open: num(row[1]),
        high: num(row[2]),
        low: num(row[3]),
        close: num(row[4]),
        volume: num(row[5]),
        turnover: num(row[6])
      };

    })
    .filter(c =>
      c.startTime > 0 &&
      c.open > 0 &&
      c.high > 0 &&
      c.low > 0 &&
      c.close > 0
    )
    .sort(
      (a, b) =>
        a.startTime - b.startTime
    );

  return candles;
}


/* =========================
   Closed Candles
========================= */

function getClosedCandles(candles) {

  const now = Date.now();

  return candles.filter(c => {

    const closeTime =
      c.startTime + TF_MS;

    return closeTime <= now;

  });
}


/* =========================
   Candle Helpers
========================= */

function candleBodyPercent(candle) {

  if (!candle.open) {
    return 0;
  }

  return Math.abs(
    (candle.close - candle.open) /
    candle.open
  ) * 100;
}


function candleDirection(candle) {

  if (candle.close > candle.open) {
    return "GREEN";
  }

  if (candle.close < candle.open) {
    return "RED";
  }

  return "DOJI";
}


function averageVolume(candles) {

  if (!candles.length) {
    return 0;
  }

  let total = 0;

  for (const candle of candles) {
    total += num(candle.volume);
  }

  return total / candles.length;
}


/* =========================
   Pump Sequence Detection
========================= */

function detectPumpSequences(candles) {

  const pumps = [];

  if (
    !Array.isArray(candles) ||
    candles.length < MIN_PUMP_CANDLES + 5
  ) {
    return pumps;
  }

  /*
    فقط بخش اخیر بازار بررسی می‌شود.
    حداکثر 12 ساعت اخیر.
  */

  const now = Date.now();

  const recent = candles.filter(c => {

    return (
      c.startTime + TF_MS >=
      now - MAX_PUMP_AGE_MS - TF_MS
    );

  });

  if (recent.length < MIN_PUMP_CANDLES) {
    return pumps;
  }


  for (
    let start = 0;
    start < recent.length;
    start++
  ) {

    for (
      let length = MIN_PUMP_CANDLES;
      length <= MAX_PUMP_CANDLES;
      length++
    ) {

      const end =
        start + length - 1;

      if (end >= recent.length) {
        break;
      }

      const sequence =
        recent.slice(start, end + 1);

      if (!sequence.length) {
        continue;
      }


      const first = sequence[0];
      const last = sequence[sequence.length - 1];


      if (
        first.startTime + TF_MS >
        now
      ) {
        continue;
      }


      /*
        رشد کل Sequence
      */

      const pumpPercent =
        percentChange(
          first.open,
          last.close
        );


      if (
        pumpPercent <
        MIN_PUMP_PERCENT
      ) {
        continue;
      }


      /*
        نسبت کندل‌های سبز
      */

      let greenCount = 0;

      for (const candle of sequence) {

        if (
          candle.close >
          candle.open
        ) {
          greenCount++;
        }

      }

      const greenRatio =
        greenCount / sequence.length;


      if (
        greenRatio <
        MIN_GREEN_RATIO
      ) {
        continue;
      }


      /*
        جلوگیری از ساختار Pump خراب
        با افت شدید وسط حرکت
      */

      let invalidStructure = false;

      for (
        let i = 1;
        i < sequence.length;
        i++
      ) {

        const previous =
          sequence[i - 1];

        const current =
          sequence[i];

        const drop =
          percentChange(
            previous.close,
            current.close
          );

        if (drop < -3.5) {
          invalidStructure = true;
          break;
        }
      }

      if (invalidStructure) {
        continue;
      }


      /*
        Volume baseline
      */

      const baselineStart =
        Math.max(
          0,
          start - 10
        );

      const baselineCandles =
        recent.slice(
          baselineStart,
          start
        );


      if (
        baselineCandles.length < 3
      ) {
        continue;
      }


      const baselineVolume =
        averageVolume(
          baselineCandles
        );

      const pumpVolume =
        averageVolume(
          sequence
        );


      if (
        baselineVolume <= 0
      ) {
        continue;
      }


      const volumeRatio =
        pumpVolume /
        baselineVolume;


      if (
        volumeRatio <
        MIN_VOLUME_MULTIPLIER
      ) {
        continue;
      }


      /*
        Pump base / high
      */

      let basePrice =
        Number.POSITIVE_INFINITY;

      let highPrice =
        Number.NEGATIVE_INFINITY;


      for (const candle of sequence) {

        basePrice =
          Math.min(
            basePrice,
            candle.open,
            candle.low
          );

        highPrice =
          Math.max(
            highPrice,
            candle.high,
            candle.close
          );

      }


      if (
        !Number.isFinite(basePrice) ||
        !Number.isFinite(highPrice) ||
        basePrice <= 0
      ) {
        continue;
      }


      const calculatedPump =
        percentChange(
          basePrice,
          last.close
        );


      /*
        Score
      */

      const pumpStrength =
        Math.min(
          100,
          pumpPercent * 8
        );

      const volumeStrength =
        Math.min(
          100,
          volumeRatio * 30
        );

      const greenStrength =
        greenRatio * 100;


      const score =
        (
          pumpStrength * 0.45 +
          volumeStrength * 0.30 +
          greenStrength * 0.25
        );


      pumps.push({

        startTime:
          first.startTime,

        endTime:
          last.startTime +
          TF_MS,

        basePrice:
          basePrice,

        highPrice:
          highPrice,

        endPrice:
          last.close,

        pumpPercent:
          round(
            Math.max(
              pumpPercent,
              calculatedPump
            ),
            4
          ),

        candles:
          sequence.length,

        greenRatio:
          round(
            greenRatio,
            4
          ),

        volumeRatio:
          round(
            volumeRatio,
            4
          ),

        score:
          round(
            score,
            2
          ),

        durationMinutes:
          sequence.length * 15
      });

    }
  }


  /*
    حذف Pumpهای تکراری
  */

  const unique = [];

  for (const pump of pumps) {

    const duplicate =
      unique.some(existing => {

        return (
          existing.startTime ===
          pump.startTime
        );

      });

    if (!duplicate) {
      unique.push(pump);
    }
  }


  return unique.sort(
    (a, b) =>
      b.endTime - a.endTime
  );
}


/* =========================
   Best Pump
========================= */

function selectBestPump(pumps) {

  if (
    !Array.isArray(pumps) ||
    !pumps.length
  ) {
    return null;
  }

  /*
    ابتدا جدیدترین Pump معتبر.
    در صورت یکسان بودن، Score بالاتر.
  */

  const sorted =
    [...pumps].sort(
      (a, b) => {

        if (
          b.endTime !==
          a.endTime
        ) {
          return (
            b.endTime -
            a.endTime
          );
        }

        return (
          b.score -
          a.score
        );
      }
    );

  return sorted[0] || null;
}


/* =========================
   Pullback Detection
========================= */

function findPullbackCandle(
  candles,
  pump
) {

  if (
    !Array.isArray(candles) ||
    !pump
  ) {
    return null;
  }


  const afterPump =
    candles.filter(c =>
      c.startTime >=
      pump.endTime
    );


  for (const candle of afterPump) {

    /*
      اولین کندل قرمز بعد از Pump
    */

    if (
      candle.close >=
      candle.open
    ) {
      continue;
    }


    const bodyPercent =
      candleBodyPercent(
        candle
      );


    if (
      bodyPercent >
      MAX_PULLBACK_PERCENT
    ) {
      continue;
    }


    /*
      Pullback نباید کل Pump را خراب کند.
    */

    if (
      candle.low <
      pump.basePrice
    ) {
      continue;
    }


    /*
      Zone:
      Low تا Open کندل قرمز
    */

    const zoneLow =
      Math.min(
        candle.low,
        candle.close
      );

    const zoneHigh =
      candle.open;


    if (
      zoneHigh <=
      zoneLow
    ) {
      continue;
    }


    /*
      عمق Pullback نسبت به پایان Pump
    */

    const retrace =
      percentChange(
        pump.endPrice,
        candle.close
      );


    const retracePercent =
      Math.abs(retrace);


    if (
      retracePercent >
      MAX_PULLBACK_PERCENT
    ) {
      continue;
    }


    return {

      startTime:
        candle.startTime,

      endTime:
        candle.startTime +
        TF_MS,

      open:
        candle.open,

      high:
        candle.high,

      low:
        candle.low,

      close:
        candle.close,

      bodyPercent:
        round(
          bodyPercent,
          4
        ),

      retracePercent:
        round(
          retracePercent,
          4
        ),

      zoneLow:
        zoneLow,

      zoneHigh:
        zoneHigh,

      direction:
        "RED"

    };
  }


  return null;
}


/* =========================
   Setup State
========================= */

function getSetupState(
  currentPrice,
  pullback
) {

  if (
    !pullback ||
    !Number.isFinite(
      currentPrice
    )
  ) {
    return "INVALID";
  }


  const zoneLow =
    pullback.zoneLow;

  const zoneHigh =
    pullback.zoneHigh;


  /*
    داخل Zone
  */

  if (
    currentPrice >= zoneLow &&
    currentPrice <= zoneHigh
  ) {
    return "REACHED";
  }


  /*
    بالاتر از Zone
  */

  if (
    currentPrice > zoneHigh
  ) {

    const distance =
      (
        (
          currentPrice -
          zoneHigh
        ) /
        zoneHigh
      ) * 100;


    if (
      distance <=
      NEAR_ZONE_PERCENT
    ) {
      return "NEAR";
    }


    return "APPROACHING";
  }


  /*
    پایین Zone ولی هنوز
    بالاتر از Zone Low
  */

  if (
    currentPrice >= zoneLow
  ) {
    return "BELOW_ZONE";
  }


  return "INVALID";
}


/* =========================
   Build Setup
========================= */

function buildSetup(
  symbol,
  pump,
  pullback,
  currentPrice
) {

  const state =
    getSetupState(
      currentPrice,
      pullback
    );


  let distancePercent = 0;


  if (
    currentPrice >
    pullback.zoneHigh
  ) {

    distancePercent =
      (
        (
          currentPrice -
          pullback.zoneHigh
        ) /
        pullback.zoneHigh
      ) * 100;

  } else if (
    currentPrice <
    pullback.zoneLow
  ) {

    distancePercent =
      (
        (
          pullback.zoneLow -
          currentPrice
        ) /
        pullback.zoneLow
      ) * 100;
  }


  return {

    id:
      `${symbol}-${pump.startTime}-${pullback.startTime}`,

    symbol,

    timeframe:
      "15m",

    state,

    currentPrice:
      round(
        currentPrice,
        10
      ),

    distancePercent:
      round(
        distancePercent,
        4
      ),

    pump: {

      startTime:
        pump.startTime,

      endTime:
        pump.endTime,

      basePrice:
        round(
          pump.basePrice,
          10
        ),

      highPrice:
        round(
          pump.highPrice,
          10
        ),

      endPrice:
        round(
          pump.endPrice,
          10
        ),

      pumpPercent:
        pump.pumpPercent,

      candles:
        pump.candles,

      greenRatio:
        pump.greenRatio,

      volumeRatio:
        pump.volumeRatio,

      score:
        pump.score,

      durationMinutes:
        pump.durationMinutes

    },

    pullback: {

      startTime:
        pullback.startTime,

      endTime:
        pullback.endTime,

      open:
        round(
          pullback.open,
          10
        ),

      high:
        round(
          pullback.high,
          10
        ),

      low:
        round(
          pullback.low,
          10
        ),

      close:
        round(
          pullback.close,
          10
        ),

      bodyPercent:
        pullback.bodyPercent,

      retracePercent:
        pullback.retracePercent,

      zoneLow:
        round(
          pullback.zoneLow,
          10
        ),

      zoneHigh:
        round(
          pullback.zoneHigh,
          10
        ),

      direction:
        pullback.direction

    },

    detectedAt:
      Date.now()
  };
}


/* =========================
   Analyze Symbol
========================= */

async function analyzeSymbol(
  symbol,
  tickerMap
) {

  const candles =
    await getKlines(
      symbol
    );


  const closedCandles =
    getClosedCandles(
      candles
    );


  if (
    closedCandles.length <
    MIN_PUMP_CANDLES + 5
  ) {
    return null;
  }


  const pumps =
    detectPumpSequences(
      closedCandles
    );


  if (!pumps.length) {
    return null;
  }


  /*
    فقط Pumpهای حداکثر 12 ساعت اخیر
  */

  const now =
    Date.now();


  const freshPumps =
    pumps.filter(pump => {

      const age =
        now -
        pump.endTime;

      return (
        age >= 0 &&
        age <=
        MAX_PUMP_AGE_MS
      );

    });


  if (!freshPumps.length) {
    return null;
  }


  /*
    جدیدترین Pump معتبر
  */

  const pump =
    selectBestPump(
      freshPumps
    );


  if (!pump) {
    return null;
  }


  const pullback =
    findPullbackCandle(
      closedCandles,
      pump
    );


  if (!pullback) {
    return null;
  }


  const ticker =
    tickerMap?.get(symbol);


  const currentPrice =
    ticker?.lastPrice ||
    closedCandles[
      closedCandles.length - 1
    ]?.close ||
    0;


  if (
    !currentPrice ||
    currentPrice <= 0
  ) {
    return null;
  }


  const setup =
    buildSetup(
      symbol,
      pump,
      pullback,
      currentPrice
    );


  /*
    Setupهای خراب حذف می‌شوند.
  */

  if (
    setup.state ===
    "INVALID"
  ) {
    return null;
  }


  return setup;
}


/* =========================
   Scan Market
========================= */

async function scanMarket() {

  const scanStarted =
    Date.now();


  const symbols =
    await getSymbols();


  const tickerMap =
    await getAllTickers();


  const results = [];

  let candidates = 0;

  let invalid = 0;


  /*
    Batch scan
  */

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
          async symbol => {

            try {

              const candles =
                await getKlines(
                  symbol
                );


              const closedCandles =
                getClosedCandles(
                  candles
                );


              if (
                closedCandles.length <
                MIN_PUMP_CANDLES + 5
              ) {
                return null;
              }


              const pumps =
                detectPumpSequences(
                  closedCandles
                );


              if (!pumps.length) {
                return null;
              }


              candidates++;


              const now =
                Date.now();


              const freshPumps =
                pumps.filter(
                  pump => {

                    const age =
                      now -
                      pump.endTime;

                    return (
                      age >= 0 &&
                      age <=
                      MAX_PUMP_AGE_MS
                    );

                  }
                );


              if (
                !freshPumps.length
              ) {
                return null;
              }


              const pump =
                selectBestPump(
                  freshPumps
                );


              if (!pump) {
                return null;
              }


              const pullback =
                findPullbackCandle(
                  closedCandles,
                  pump
                );


              if (!pullback) {
                return null;
              }


              const ticker =
                tickerMap.get(
                  symbol
                );


              const currentPrice =
                ticker?.lastPrice ||
                closedCandles[
                  closedCandles.length - 1
                ]?.close ||
                0;


              if (
                !currentPrice ||
                currentPrice <= 0
              ) {
                return null;
              }


              const setup =
                buildSetup(
                  symbol,
                  pump,
                  pullback,
                  currentPrice
                );


              if (
                setup.state ===
                "INVALID"
              ) {
                invalid++;
                return null;
              }


              return setup;

            } catch (error) {

              return null;
            }

          }
        )
      );


    for (
      const setup of batchResults
    ) {

      if (setup) {
        results.push(
          setup
        );
      }

    }


    /*
      کمی فاصله برای جلوگیری
      از فشار بیش از حد API
    */

    if (
      i + SCAN_BATCH <
      symbols.length
    ) {
      await sleep(100);
    }
  }


  /*
    اولویت وضعیت‌ها
  */

  const statePriority = {

    REACHED: 1,

    NEAR: 2,

    APPROACHING: 3,

    BELOW_ZONE: 4,

    INVALID: 99
  };


  results.sort(
    (a, b) => {

      const stateDiff =
        (
          statePriority[a.state] ||
          50
        ) -
        (
          statePriority[b.state] ||
          50
        );


      if (
        stateDiff !== 0
      ) {
        return stateDiff;
      }


      /*
        Pump جدیدتر اول
      */

      return (
        b.pump.endTime -
        a.pump.endTime
      );
    }
  );


  const signals =
    results.filter(
      x =>
        x.state ===
        "REACHED"
    ).length;


  const near =
    results.filter(
      x =>
        x.state ===
        "NEAR"
    ).length;


  const approaching =
    results.filter(
      x =>
        x.state ===
        "APPROACHING"
    ).length;


  const setups =
    results.length;


  lastScan = {

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

    setups,

    signals,

    near,

    approaching,

    invalid,

    scanDurationMs:
      Date.now() -
      scanStarted,

    timestamp:
      Date.now(),

    results

  };


  return lastScan;
}


/* =========================
   Health
========================= */

function health() {

  return {

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

      minVolumeMultiplier:
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
        MAX_PUMP_AGE_HOURS

    },

    endpoints: [

      "/health",

      "/scan",

      "/results",

      "/analyze?symbol=BTCUSDT"

    ]

  };
}


/* =========================
   Analyze API
========================= */

async function handleAnalyze(
  request
) {

  const url =
    new URL(
      request.url
    );


  let symbol =
    url.searchParams.get(
      "symbol"
    );


  if (!symbol) {

    return json(
      {
        ok: false,
        error:
          "symbol is required"
      },
      400
    );
  }


  symbol =
    symbol
      .trim()
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        ""
      );


  if (!symbol) {

    return json(
      {
        ok: false,
        error:
          "Invalid symbol"
      },
      400
    );
  }


  /*
    اگر کاربر PEPE وارد کند،
    PEPEUSDT ساخته می‌شود.
  */

  if (
    !symbol.endsWith(
      "USDT"
    )
  ) {
    symbol += "USDT";
  }


  const tickerMap =
    await getAllTickers();


  /*
    بررسی وجود Symbol
  */

  if (
    !tickerMap.has(symbol)
  ) {

    return json(
      {
        ok: false,

        error:
          "Symbol not found on Bybit Linear USDT",

        symbol
      },
      404
    );
  }


  const setup =
    await analyzeSymbol(
      symbol,
      tickerMap
    );


  if (!setup) {

    return json(
      {
        ok: true,

        found: false,

        symbol,

        message:
          "No valid recent pump → red candle → pullback setup found",

        version:
          VERSION,

        source:
          "Bybit",

        timeframe:
          "15m"
      }
    );
  }


  return json(
    {
      ok: true,

      found: true,

      version:
        VERSION,

      source:
        "Bybit",

      timeframe:
        "15m",

      strategy:
        "PUMP → RED CANDLE → PULLBACK ZONE → RETEST",

      setup

    }
  );
}


/* =========================
   Worker
========================= */

export default {

  async fetch(
    request,
    env,
    ctx
  ) {

    /*
      CORS
    */

    if (
      request.method ===
      "OPTIONS"
    ) {

      return withCors(
        new Response(
          null,
          {
            status: 204
          }
        )
      );

    }


    const url =
      new URL(
        request.url
      );


    const path =
      url.pathname;


    try {

      /* =========================
         Health
      ========================= */

      if (
        path === "/health" ||
        path === "/api/health"
      ) {

        return withCors(
          json(
            health()
          )
        );

      }


      /* =========================
         Scan
      ========================= */

      if (
        path === "/scan" ||
        path === "/api/scan"
      ) {

        const result =
          await scanMarket();


        return withCors(
          json(
            result
          )
        );

      }


      /* =========================
         Results
      ========================= */

      if (
        path === "/results" ||
        path === "/api/results"
      ) {

        return withCors(
          json(
            lastScan
          )
        );

      }


      /* =========================
         Analyze
      ========================= */

      if (
        path === "/analyze" ||
        path === "/api/analyze"
      ) {

        return withCors(
          await handleAnalyze(
            request
          )
        );

      }


      /* =========================
         Static Assets
      ========================= */

      if (
        env &&
        env.ASSETS
      ) {

        /*
          Root → index.html
        */

        if (
          path === "/" ||
          path === ""
        ) {

          const indexUrl =
            new URL(
              "/index.html",
              request.url
            );


          const indexRequest =
            new Request(
              indexUrl,
              request
            );


          const indexResponse =
            await env.ASSETS.fetch(
              indexRequest
            );


          if (
            indexResponse.status !==
            404
          ) {

            return withCors(
              indexResponse
            );

          }

        }


        /*
          سایر فایل‌های public
        */

        const assetResponse =
          await env.ASSETS.fetch(
            request
          );


        if (
          assetResponse.status !==
          404
        ) {

          return withCors(
            assetResponse
          );

        }

      }


      /* =========================
         Not Found
      ========================= */

      return withCors(
        json(
          {
            ok: false,
            error: "Not Found",
            path
          },
          404
        )
      );


    } catch (error) {

      return withCors(
        json(
          {
            ok: false,

            version:
              VERSION,

            error:
              error &&
              error.message
                ? error.message
                : "Worker error"
          },
          500
        )
      );

    }

  }

};
