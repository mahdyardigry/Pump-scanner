const BYBIT = "https://api.bybit.com";

const VERSION = "PUMP-SCANNER-BYBIT-PPR-V8";

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

  mode:
    "PUMP → RED CANDLE → PULLBACK ZONE → RETEST",

  scannedSymbols: 0,
  candidates: 0,
  setups: 0,

  signals: 0,
  near: 0,
  approaching: 0,
  invalid: 0,

  scanDurationMs: 0,

  timestamp: null,

  candidateDetails: [],

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
        "content-type":
          "application/json; charset=utf-8",

        "cache-control":
          "no-store, no-cache, must-revalidate",

        "pragma": "no-cache"
      }
    }
  );
}


function withCors(response) {
  const headers =
    new Headers(response.headers);

  headers.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  headers.set(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  return new Response(
    response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers
    }
  );
}


function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}


function num(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}


function round(value, digits = 4) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 0;
  }

  return Number(
    n.toFixed(digits)
  );
}


function percentChange(from, to) {
  if (!from || !Number.isFinite(from)) {
    return 0;
  }

  return (
    (to - from) /
    from
  ) * 100;
}


/* =========================
   Bybit Request
========================= */

async function bybit(path) {

  const response =
    await fetch(
      BYBIT + path,
      {
        method: "GET",
        headers: {
          "accept":
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
    !data ||
    data.retCode !== 0
  ) {
    throw new Error(
      data?.retMsg ||
      "Bybit API error"
    );
  }


  return data;
}


/* =========================
   Symbols
========================= */

async function getSymbols() {

  const data =
    await bybit(
      "/v5/market/instruments-info" +
      "?category=linear" +
      "&status=Trading" +
      "&limit=1000"
    );


  const list =
    Array.isArray(
      data?.result?.list
    )
      ? data.result.list
      : [];


  return list
    .filter(item => {

      return (
        item.status ===
          "Trading" &&

        item.quoteCoin ===
          "USDT" &&

        item.contractType ===
          "LinearPerpetual"
      );

    })
    .map(
      item =>
        item.symbol
    )
    .filter(Boolean);
}


/* =========================
   Tickers
========================= */

async function getAllTickers() {

  const data =
    await bybit(
      "/v5/market/tickers" +
      "?category=linear"
    );


  const list =
    Array.isArray(
      data?.result?.list
    )
      ? data.result.list
      : [];


  const map = new Map();


  for (
    const item of list
  ) {

    if (!item.symbol) {
      continue;
    }


    map.set(
      item.symbol,
      {
        symbol:
          item.symbol,

        lastPrice:
          num(item.lastPrice),

        volume24h:
          num(item.volume24h),

        turnover24h:
          num(item.turnover24h),

        price24hPcnt:
          num(item.price24hPcnt) *
          100,

        highPrice24h:
          num(item.highPrice24h),

        lowPrice24h:
          num(item.lowPrice24h),

        openInterest:
          num(item.openInterest),

        fundingRate:
          num(item.fundingRate)
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


  const data =
    await bybit(query);


  const list =
    Array.isArray(
      data?.result?.list
    )
      ? data.result.list
      : [];


  return list
    .map(row => {

      return {

        startTime:
          num(row[0]),

        open:
          num(row[1]),

        high:
          num(row[2]),

        low:
          num(row[3]),

        close:
          num(row[4]),

        volume:
          num(row[5]),

        turnover:
          num(row[6])
      };

    })
    .filter(c => {

      return (
        c.startTime > 0 &&
        c.open > 0 &&
        c.high > 0 &&
        c.low > 0 &&
        c.close > 0
      );

    })
    .sort(
      (a, b) =>
        a.startTime -
        b.startTime
    );
}


/* =========================
   Closed Candles
========================= */

function getClosedCandles(
  candles
) {

  const now =
    Date.now();


  return candles.filter(c => {

    const closeTime =
      c.startTime +
      TF_MS;


    return (
      closeTime <= now
    );

  });
}


/* =========================
   Candle Helpers
========================= */

function candleBodyPercent(
  candle
) {

  if (!candle.open) {
    return 0;
  }


  return (
    Math.abs(
      candle.close -
      candle.open
    ) /
    candle.open
  ) * 100;
}


/* =========================
   Average Volume
========================= */

function averageVolume(
  candles
) {

  if (!candles.length) {
    return 0;
  }


  let total = 0;


  for (
    const candle of candles
  ) {

    total +=
      num(candle.volume);
  }


  return (
    total /
    candles.length
  );
}


/* =========================
   Pump Detection
========================= */

function detectPumpSequences(
  candles
) {

  const pumps = [];


  if (
    !Array.isArray(candles) ||
    candles.length <
      MIN_PUMP_CANDLES + 5
  ) {
    return pumps;
  }


  const now =
    Date.now();


  const recent =
    candles.filter(c => {

      return (
        c.startTime +
          TF_MS >=
        now -
          MAX_PUMP_AGE_MS -
          TF_MS
      );

    });


  if (
    recent.length <
    MIN_PUMP_CANDLES
  ) {
    return pumps;
  }


  for (
    let start = 0;
    start < recent.length;
    start++
  ) {

    for (
      let length =
        MIN_PUMP_CANDLES;

      length <=
        MAX_PUMP_CANDLES;

      length++
    ) {

      const end =
        start +
        length -
        1;


      if (
        end >=
        recent.length
      ) {
        break;
      }


      const sequence =
        recent.slice(
          start,
          end + 1
        );


      const first =
        sequence[0];

      const last =
        sequence[
          sequence.length - 1
        ];


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


      let greenCount = 0;


      for (
        const candle of sequence
      ) {

        if (
          candle.close >
          candle.open
        ) {
          greenCount++;
        }

      }


      const greenRatio =
        greenCount /
        sequence.length;


      if (
        greenRatio <
        MIN_GREEN_RATIO
      ) {
        continue;
      }


      /*
        Reject severe structural drop
      */

      let invalidStructure =
        false;


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


        if (
          drop <
          -3.5
        ) {

          invalidStructure =
            true;

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
        baselineCandles.length <
        3
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
        baselineVolume <=
        0
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


      let basePrice =
        Number.POSITIVE_INFINITY;


      let highPrice =
        Number.NEGATIVE_INFINITY;


      for (
        const candle of sequence
      ) {

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
        !Number.isFinite(
          basePrice
        ) ||
        !Number.isFinite(
          highPrice
        ) ||
        basePrice <= 0
      ) {
        continue;
      }


      const score =
        (
          Math.min(
            100,
            pumpPercent * 8
          ) *
          0.45
        ) +
        (
          Math.min(
            100,
            volumeRatio * 30
          ) *
          0.30
        ) +
        (
          greenRatio *
          100 *
          0.25
        );


      pumps.push({

        startTime:
          first.startTime,

        endTime:
          last.startTime +
          TF_MS,

        basePrice,

        highPrice,

        endPrice:
          last.close,

        pumpPercent:
          round(
            pumpPercent,
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
          sequence.length *
          15
      });
    }
  }


  const unique = [];


  for (
    const pump of pumps
  ) {

    const duplicate =
      unique.some(
        existing =>
          existing.startTime ===
          pump.startTime
      );


    if (!duplicate) {
      unique.push(pump);
    }
  }


  return unique.sort(
    (a, b) =>
      b.endTime -
      a.endTime
  );
}


/* =========================
   Best Pump
========================= */

function selectBestPump(
  pumps
) {

  if (
    !Array.isArray(pumps) ||
    !pumps.length
  ) {
    return null;
  }


  return [...pumps].sort(
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
  )[0];
}


/* =========================
   Pullback
========================= */

function findPullbackCandle(
  candles,
  pump
) {

  const afterPump =
    candles.filter(
      c =>
        c.startTime >=
        pump.endTime
    );


  for (
    const candle of afterPump
  ) {

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


    if (
      candle.low <
      pump.basePrice
    ) {
      continue;
    }


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


    const retracePercent =
      Math.abs(
        percentChange(
          pump.endPrice,
          candle.close
        )
      );


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

      zoneLow,

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


  if (
    currentPrice >=
      pullback.zoneLow &&
    currentPrice <=
      pullback.zoneHigh
  ) {

    return "REACHED";
  }


  if (
    currentPrice >
    pullback.zoneHigh
  ) {

    const distance =
      (
        (
          currentPrice -
          pullback.zoneHigh
        ) /
        pullback.zoneHigh
      ) * 100;


    if (
      distance <=
      NEAR_ZONE_PERCENT
    ) {
      return "NEAR";
    }


    return "APPROACHING";
  }


  if (
    currentPrice >=
    pullback.zoneLow
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

    market:
      "FUTURES",

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


/* =========================================================
   LIVE FOOTPRINT
========================================================= */

function percentile(
  values,
  p
) {

  if (!values.length) {
    return 0;
  }


  const sorted =
    [...values].sort(
      (a, b) => a - b
    );


  const index =
    (sorted.length - 1) *
    p;


  const lower =
    Math.floor(index);

  const upper =
    Math.ceil(index);


  if (
    lower ===
    upper
  ) {
    return sorted[lower];
  }


  const weight =
    index - lower;


  return (
    sorted[lower] *
      (1 - weight) +
    sorted[upper] *
      weight
  );
}


/* =========================
   Recent Trades
========================= */

async function getRecentTrades(
  symbol
) {

  const data =
    await bybit(
      "/v5/market/recent-trade" +
      "?category=linear" +
      `&symbol=${encodeURIComponent(symbol)}` +
      "&limit=1000"
    );


  return Array.isArray(
    data?.result?.list
  )
    ? data.result.list
    : [];
}


/* =========================
   Footprint Builder
========================= */

function buildFootprint(
  trades
) {

  const now =
    Date.now();


  const normalized =
    trades
      .map(t => {

        return {

          execId:
            t.execId,

          price:
            num(t.price),

          size:
            num(t.size),

          side:
            t.side,

          time:
            num(t.time),

          isBlockTrade:
            !!t.isBlockTrade,

          notional:
            num(t.price) *
            num(t.size)
        };

      })
      .filter(
        t =>
          t.price > 0 &&
          t.size > 0 &&
          t.time > 0
      )
      .sort(
        (a, b) =>
          a.time - b.time
      );


  const windows = {

    "15s":
      15 * 1000,

    "30s":
      30 * 1000,

    "1m":
      60 * 1000,

    "3m":
      3 * 60 * 1000,

    "5m":
      5 * 60 * 1000
  };


  function aggregate(
    windowMs
  ) {

    const rows =
      normalized.filter(
        t =>
          t.time >=
          now - windowMs
      );


    let buyVolume = 0;
    let sellVolume = 0;

    let buyNotional = 0;
    let sellNotional = 0;

    let buyTrades = 0;
    let sellTrades = 0;

    let blockBuy = 0;
    let blockSell = 0;


    for (
      const trade of rows
    ) {

      if (
        trade.side ===
        "Buy"
      ) {

        buyVolume +=
          trade.size;

        buyNotional +=
          trade.notional;

        buyTrades++;

        if (
          trade.isBlockTrade
        ) {
          blockBuy +=
            trade.notional;
        }

      } else {

        sellVolume +=
          trade.size;

        sellNotional +=
          trade.notional;

        sellTrades++;

        if (
          trade.isBlockTrade
        ) {
          blockSell +=
            trade.notional;
        }
      }
    }


    const totalVolume =
      buyVolume +
      sellVolume;


    const totalNotional =
      buyNotional +
      sellNotional;


    const delta =
      buyVolume -
      sellVolume;


    const deltaNotional =
      buyNotional -
      sellNotional;


    const deltaPercent =
      totalVolume
        ? (
            delta /
            totalVolume
          ) * 100
        : 0;


    const buyShare =
      totalNotional
        ? (
            buyNotional /
            totalNotional
          ) * 100
        : 0;


    const sellShare =
      totalNotional
        ? (
            sellNotional /
            totalNotional
          ) * 100
        : 0;


    let pressure =
      "BALANCED";


    if (
      deltaPercent >= 10
    ) {
      pressure =
        "BUY_PRESSURE";
    } else if (
      deltaPercent <= -10
    ) {
      pressure =
        "SELL_PRESSURE";
    }


    return {

      trades:
        rows.length,

      buyVolume:
        round(
          buyVolume,
          8
        ),

      sellVolume:
        round(
          sellVolume,
          8
        ),

      totalVolume:
        round(
          totalVolume,
          8
        ),

      buyNotional:
        round(
          buyNotional,
          2
        ),

      sellNotional:
        round(
          sellNotional,
          2
        ),

      totalNotional:
        round(
          totalNotional,
          2
        ),

      delta:
        round(
          delta,
          8
        ),

      deltaNotional:
        round(
          deltaNotional,
          2
        ),

      deltaPercent:
        round(
          deltaPercent,
          2
        ),

      buyShare:
        round(
          buyShare,
          2
        ),

      sellShare:
        round(
          sellShare,
          2
        ),

      buyTrades,

      sellTrades,

      blockBuy:
        round(
          blockBuy,
          2
        ),

      blockSell:
        round(
          blockSell,
          2
        ),

      pressure
    };
  }


  const notionals =
    normalized.map(
      x => x.notional
    );


  const p95 =
    percentile(
      notionals,
      0.95
    );


  const averageNotional =
    notionals.length
      ? notionals.reduce(
          (a, b) =>
            a + b,
          0
        ) /
        notionals.length
      : 0;


  const largeThreshold =
    Math.max(
      averageNotional * 5,
      p95
    );


  let largeBuyCount = 0;
  let largeSellCount = 0;

  let largeBuyNotional = 0;
  let largeSellNotional = 0;


  for (
    const trade of normalized
  ) {

    if (
      trade.notional >=
      largeThreshold
    ) {

      if (
        trade.side ===
        "Buy"
      ) {

        largeBuyCount++;

        largeBuyNotional +=
          trade.notional;

      } else {

        largeSellCount++;

        largeSellNotional +=
          trade.notional;
      }
    }
  }


  const latest =
    normalized.at(-1);


  return {

    source:
      "Bybit Public Recent Trades",

    live:
      true,

    generatedAt:
      now,

    latestTradeTime:
      latest?.time ||
      null,

    latestPrice:
      latest?.price ||
      null,

    tradeCount:
      normalized.length,

    largeThreshold:
      round(
        largeThreshold,
        2
      ),

    largeBuyCount,

    largeSellCount,

    largeBuyNotional:
      round(
        largeBuyNotional,
        2
      ),

    largeSellNotional:
      round(
        largeSellNotional,
        2
      ),

    "15s":
      aggregate(
        windows["15s"]
      ),

    "30s":
      aggregate(
        windows["30s"]
      ),

    "1m":
      aggregate(
        windows["1m"]
      ),

    "3m":
      aggregate(
        windows["3m"]
      ),

    "5m":
      aggregate(
        windows["5m"]
      ),

    recentTrades:
      normalized
        .slice(-30)
        .reverse()
  };
}


/* =========================================================
   ORDER BOOK
========================================================= */

async function getOrderbook(
  symbol
) {

  const data =
    await bybit(
      "/v5/market/orderbook" +
      "?category=linear" +
      `&symbol=${encodeURIComponent(symbol)}` +
      "&limit=50"
    );


  const result =
    data?.result || {};


  const bids =
    Array.isArray(
      result.b
    )
      ? result.b
      : [];


  const asks =
    Array.isArray(
      result.a
    )
      ? result.a
      : [];


  let buyLiquidity = 0;
  let sellLiquidity = 0;


  for (
    const row of bids
  ) {

    buyLiquidity +=
      num(row[0]) *
      num(row[1]);
  }


  for (
    const row of asks
  ) {

    sellLiquidity +=
      num(row[0]) *
      num(row[1]);
  }


  const total =
    buyLiquidity +
    sellLiquidity;


  const buyShare =
    total
      ? (
          buyLiquidity /
          total
        ) * 100
      : 0;


  const sellShare =
    total
      ? (
          sellLiquidity /
          total
        ) * 100
      : 0;


  let pressure =
    "BALANCED";


  if (
    buyShare >
    sellShare + 8
  ) {

    pressure =
      "BUY_PRESSURE";

  } else if (
    sellShare >
    buyShare + 8
  ) {

    pressure =
      "SELL_PRESSURE";
  }


  return {

    live:
      true,

    timestamp:
      Date.now(),

    bestBid:
      num(
        bids[0]?.[0]
      ),

    bestAsk:
      num(
        asks[0]?.[0]
      ),

    buyLiquidity:
      round(
        buyLiquidity,
        2
      ),

    sellLiquidity:
      round(
        sellLiquidity,
        2
      ),

    totalLiquidity:
      round(
        total,
        2
      ),

    buyShare:
      round(
        buyShare,
        2
      ),

    sellShare:
      round(
        sellShare,
        2
      ),

    pressure,

    bids:
      bids
        .slice(0, 20)
        .map(
          x => [
            num(x[0]),
            num(x[1])
          ]
        ),

    asks:
      asks
        .slice(0, 20)
        .map(
          x => [
            num(x[0]),
            num(x[1])
          ]
        )
  };
}


/* =========================================================
   OPEN INTEREST
========================================================= */

async function getOpenInterest(
  symbol
) {

  const data =
    await bybit(
      "/v5/market/open-interest" +
      "?category=linear" +
      `&symbol=${encodeURIComponent(symbol)}` +
      "&intervalTime=5min" +
      "&limit=10"
    );


  const list =
    Array.isArray(
      data?.result?.list
    )
      ? data.result.list
      : [];


  const rows =
    list
      .map(x => {

        return {

          timestamp:
            num(
              x.timestamp
            ),

          openInterest:
            num(
              x.openInterest
            )
        };

      })
      .filter(
        x =>
          x.timestamp > 0
      )
      .sort(
        (a, b) =>
          a.timestamp -
          b.timestamp
      );


  const current =
    rows.at(-1);


  const previous =
    rows.at(-2);


  const oi =
    current?.openInterest ||
    0;


  const previousOI =
    previous?.openInterest ||
    0;


  const change =
    previousOI
      ? oi -
        previousOI
      : 0;


  const changePercent =
    previousOI
      ? (
          change /
          previousOI
        ) * 100
      : 0;


  return {

    available:
      true,

    current:
      oi,

    previous:
      previousOI,

    change:
      round(
        change,
        8
      ),

    changePercent:
      round(
        changePercent,
        4
      ),

    timestamp:
      current?.timestamp ||
      Date.now(),

    interval:
      "5m",

    history:
      rows.slice(-10)
  };
}


/* =========================================================
   FUNDING
========================================================= */

async function getFunding(
  symbol
) {

  const data =
    await bybit(
      "/v5/market/funding/history" +
      "?category=linear" +
      `&symbol=${encodeURIComponent(symbol)}` +
      "&limit=10"
    );


  const list =
    Array.isArray(
      data?.result?.list
    )
      ? data.result.list
      : [];


  const rows =
    list
      .map(x => {

        return {

          timestamp:
            num(
              x.fundingRateTimestamp
            ),

          fundingRate:
            num(
              x.fundingRate
            ),

          fundingPercent:
            num(
              x.fundingRate
            ) * 100

        };

      })
      .filter(
        x =>
          x.timestamp > 0
      )
      .sort(
        (a, b) =>
          a.timestamp -
          b.timestamp
      );


  const latest =
    rows.at(-1);


  const previous =
    rows.at(-2);


  const currentRate =
    latest?.fundingRate ||
    0;


  const previousRate =
    previous?.fundingRate ||
    0;


  const change =
    currentRate -
    previousRate;


  return {

    available:
      true,

    current:
      currentRate,

    currentPercent:
      currentRate * 100,

    previous:
      previousRate,

    previousPercent:
      previousRate * 100,

    change,

    changePercentPoints:
      change * 100,

    timestamp:
      latest?.timestamp ||
      null,

    history:
      rows.slice(-10)
  };
}


/* =========================================================
   LIVE ANALYSIS
========================================================= */

async function liveAnalysis(
  symbol
) {

  const started =
    Date.now();


  const [
    tickerMap,
    trades,
    orderbook,
    openInterest,
    funding
  ] =
    await Promise.all([
      getAllTickers(),
      getRecentTrades(symbol),
      getOrderbook(symbol),
      getOpenInterest(symbol),
      getFunding(symbol)
    ]);


  const ticker =
    tickerMap.get(symbol);


  const footprint =
    buildFootprint(
      trades
    );


  return {

    ok: true,

    live: true,

    source:
      "Bybit",

    market:
      "FUTURES",

    category:
      "linear",

    symbol,

    timestamp:
      Date.now(),

    latencyMs:
      Date.now() -
      started,

    price: {

      last:
        ticker?.lastPrice ||
        footprint.latestPrice ||
        0,

      change24h:
        ticker?.price24hPcnt ||
        0,

      high24h:
        ticker?.highPrice24h ||
        0,

      low24h:
        ticker?.lowPrice24h ||
        0
    },

    footprint,

    orderbook,

    openInterest,

    funding
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
    await getKlines(symbol);


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


  if (!freshPumps.length) {
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
    closedCandles.at(-1)?.close ||
    0;


  if (
    !currentPrice
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
    return null;
  }


  return setup;
}


/* =========================================================
   CANDIDATE DIAGNOSTIC
========================================================= */

async function analyzeCandidate(
  symbol,
  tickerMap
) {

  try {

    const candles =
      await getKlines(
        symbol
      );


    const closedCandles =
      getClosedCandles(
        candles
      );


    const pumps =
      detectPumpSequences(
        closedCandles
      );


    if (!pumps.length) {

      return {
        symbol,
        candidate: false,
        reason:
          "No valid recent pump sequence"
      };
    }


    const pump =
      selectBestPump(
        pumps
      );


    const now =
      Date.now();


    const ageHours =
      (
        now -
        pump.endTime
      ) /
      3600000;


    if (
      ageHours >
      MAX_PUMP_AGE_HOURS
    ) {

      return {

        symbol,

        candidate: true,

        valid: false,

        reason:
          "Pump is older than 12 hours",

        ageHours:
          round(
            ageHours,
            2
          ),

        pump
      };
    }


    const pullback =
      findPullbackCandle(
        closedCandles,
        pump
      );


    if (!pullback) {

      return {

        symbol,

        candidate: true,

        valid: false,

        reason:
          "No valid RED pullback candle",

        pump
      };
    }


    const ticker =
      tickerMap.get(
        symbol
      );


    const currentPrice =
      ticker?.lastPrice ||
      closedCandles.at(-1)?.close ||
      0;


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

      return {

        symbol,

        candidate: true,

        valid: false,

        reason:
          "Price invalidated the setup",

        setup
      };
    }


    return {

      symbol,

      candidate: true,

      valid: true,

      reason:
        "Valid setup",

      setup
    };

  } catch (error) {

    return {

      symbol,

      candidate: true,

      valid: false,

      reason:
        error?.message ||
        "Candidate analysis error"
    };
  }
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

  const candidateDetails =
    [];


  let candidates = 0;
  let invalid = 0;


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

                if (
                  candidateDetails.length <
                  50
                ) {

                  candidateDetails.push({

                    symbol,

                    candidate: true,

                    valid: false,

                    reason:
                      "Pump is older than 12 hours"
                  });

                }

                invalid++;

                return null;
              }


              const pump =
                selectBestPump(
                  freshPumps
                );


              const pullback =
                findPullbackCandle(
                  closedCandles,
                  pump
                );


              if (!pullback) {

                if (
                  candidateDetails.length <
                  50
                ) {

                  candidateDetails.push({

                    symbol,

                    candidate: true,

                    valid: false,

                    reason:
                      "No valid RED pullback candle",

                    pump
                  });

                }

                invalid++;

                return null;
              }


              const ticker =
                tickerMap.get(
                  symbol
                );


              const currentPrice =
                ticker?.lastPrice ||
                closedCandles.at(-1)?.close ||
                0;


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

                if (
                  candidateDetails.length <
                  50
                ) {

                  candidateDetails.push({

                    symbol,

                    candidate: true,

                    valid: false,

                    reason:
                      "Price invalidated setup",

                    setup
                  });

                }

                invalid++;

                return null;
              }


              if (
                candidateDetails.length <
                50
              ) {

                candidateDetails.push({

                  symbol,

                  candidate: true,

                  valid: true,

                  reason:
                    "Valid setup",

                  setup
                });

              }


              return setup;

            } catch (
              error
            ) {

              return null;
            }
          }
        )
      );


    for (
      const setup of
      batchResults
    ) {

      if (setup) {
        results.push(setup);
      }

    }


    if (
      i + SCAN_BATCH <
      symbols.length
    ) {
      await sleep(100);
    }
  }


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
          statePriority[
            a.state
          ] || 50
        ) -
        (
          statePriority[
            b.state
          ] || 50
        );


      if (
        stateDiff !== 0
      ) {
        return stateDiff;
      }


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

    setups:
      results.length,

    signals,

    near,

    approaching,

    invalid,

    scanDurationMs:
      Date.now() -
      scanStarted,

    timestamp:
      Date.now(),

    candidateDetails:

      candidateDetails
        .slice(0, 50),

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

    liveData: {

      footprint:
        true,

      recentTrades:
        true,

      orderbook:
        true,

      openInterest:
        true,

      funding:
        true

    },

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

      "/live?symbol=BTCUSDT",

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


  if (
    !symbol
  ) {

    return json(
      {
        ok: false,

        error:
          "Invalid symbol"
      },
      400
    );
  }


  if (
    !symbol.endsWith(
      "USDT"
    )
  ) {

    symbol +=
      "USDT";
  }


  const tickerMap =
    await getAllTickers();


  if (
    !tickerMap.has(
      symbol
    )
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

    return json({

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
    });
  }


  return json({

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
  });
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

        return withCors(
          json(
            await scanMarket()
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
         LIVE
      ========================= */

      if (
        path === "/live" ||
        path === "/api/live"
      ) {

        let symbol =
          url.searchParams.get(
            "symbol"
          );


        if (!symbol) {

          return withCors(
            json(
              {
                ok: false,

                error:
                  "symbol is required"
              },
              400
            )
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


        if (
          !symbol.endsWith(
            "USDT"
          )
        ) {

          symbol +=
            "USDT";
        }


        return withCors(
          json(
            await liveAnalysis(
              symbol
            )
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

        if (
          path === "/" ||
          path === ""
        ) {

          const indexRequest =
            new Request(
              new URL(
                "/index.html",
                request.url
              ),
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


      return withCors(
        json(
          {
            ok: false,

            error:
              "Not Found",

            path
          },
          404
        )
      );

    } catch (
      error
    ) {

      return withCors(
        json(
          {
            ok: false,

            version:
              VERSION,

            error:
              error?.message ||
              "Worker error"
          },
          500
        )
      );
    }
  }
};
