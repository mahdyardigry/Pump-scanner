const BYBIT = "https://api.bybit.com";

const VERSION = "PUMP-SCANNER-BYBIT-PPR-V12";

const TF = "15";
const TF_MS = 15 * 60 * 1000;

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

/*
=========================================================
TRADE HISTORY
=========================================================

Bybit recent-trade فقط آخر معاملات بازار را می‌دهد.
برای اینکه فیلتر زمانی بتواند واقعاً روی بازه طولانی‌تر
کار کند، Worker معاملات دریافت‌شده را در حافظه Worker
نگه می‌دارد و در هر درخواست معاملات جدید را به آن اضافه
می‌کند.

بازه نگهداری:
24 ساعت

نکته:
برای حفظ تاریخچه بعد از Restart شدن کامل Worker،
باید بعداً KV/D1/Durable Object اضافه شود.
=========================================================
*/

const TRADE_HISTORY_MS = 24 * 60 * 60 * 1000;
const TRADE_HISTORY_MAX = 100000;

const RECENT_TRADE_LIMIT_LINEAR = 1000;
const RECENT_TRADE_LIMIT_SPOT = 60;

const tradeHistory = new Map();


const FOOTPRINT_WINDOWS = [
  {
    key: "1m",
    label: "1 دقیقه",
    ms: 60 * 1000
  },
  {
    key: "3m",
    label: "3 دقیقه",
    ms: 3 * 60 * 1000
  },
  {
    key: "5m",
    label: "5 دقیقه",
    ms: 5 * 60 * 1000
  },
  {
    key: "15m",
    label: "15 دقیقه",
    ms: 15 * 60 * 1000
  },
  {
    key: "30m",
    label: "30 دقیقه",
    ms: 30 * 60 * 1000
  },
  {
    key: "1h",
    label: "1 ساعت",
    ms: 60 * 60 * 1000
  }
];


const OI_WINDOWS = [
  {
    key: "5m",
    label: "5 دقیقه",
    interval: "5min"
  },
  {
    key: "15m",
    label: "15 دقیقه",
    interval: "15min"
  },
  {
    key: "30m",
    label: "30 دقیقه",
    interval: "30min"
  },
  {
    key: "1h",
    label: "1 ساعت",
    interval: "1h"
  }
];


/* =====================================================
   RESPONSE
===================================================== */

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

        "access-control-allow-origin":
          "*",

        "access-control-allow-methods":
          "GET,OPTIONS",

        "access-control-allow-headers":
          "*"
      }
    }
  );
}


function text(data, status = 200) {
  return new Response(
    data,
    {
      status,
      headers: {
        "content-type":
          "text/plain; charset=utf-8",

        "access-control-allow-origin":
          "*"
      }
    }
  );
}


/* =====================================================
   HELPERS
===================================================== */

function num(v, fallback = 0) {
  const n = Number(v);

  return Number.isFinite(n)
    ? n
    : fallback;
}


function pct(a, b) {
  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    b === 0
  ) {
    return 0;
  }

  return (
    ((a - b) /
      Math.abs(b)) *
    100
  );
}


function median(values) {
  const a = values
    .map(Number)
    .filter(Number.isFinite)
    .sort(
      (x, y) =>
        x - y
    );

  if (!a.length) {
    return 0;
  }

  const m =
    Math.floor(
      a.length / 2
    );

  return a.length % 2
    ? a[m]
    : (
        a[m - 1] +
        a[m]
      ) / 2;
}


function normalizeSide(side) {
  const s =
    String(side || "")
      .trim()
      .toLowerCase();

  if (s === "buy") {
    return "Buy";
  }

  if (s === "sell") {
    return "Sell";
  }

  return "";
}


/* =====================================================
   BYBIT API
===================================================== */

async function bybit(
  path,
  params = {}
) {
  const url =
    new URL(
      BYBIT + path
    );

  for (
    const [
      k,
      v
    ]
    of Object.entries(params)
  ) {
    if (
      v !== undefined &&
      v !== null &&
      v !== ""
    ) {
      url.searchParams.set(
        k,
        String(v)
      );
    }
  }

  const res =
    await fetch(
      url.toString(),
      {
        headers: {
          accept:
            "application/json"
        }
      }
    );

  if (!res.ok) {
    throw new Error(
      `Bybit HTTP ${res.status}`
    );
  }

  const data =
    await res.json();

  if (
    data.retCode !== 0
  ) {
    throw new Error(
      data.retMsg ||
      `Bybit error ${data.retCode}`
    );
  }

  return data;
}


/* =====================================================
   SYMBOL / MARKET
===================================================== */

async function getInstruments(
  category = "linear"
) {
  const out = [];
  let cursor = "";

  for (
    let page = 0;
    page < 5;
    page++
  ) {
    const data =
      await bybit(
        "/v5/market/instruments-info",
        {
          category,
          limit: 1000,
          cursor
        }
      );

    const list =
      data?.result?.list ||
      [];

    for (
      const x of list
    ) {
      if (
        x.status !==
        "Trading"
      ) {
        continue;
      }

      if (
        x.quoteCoin !==
        "USDT"
      ) {
        continue;
      }

      if (
        category ===
          "linear" &&
        x.contractType !==
          "LinearPerpetual"
      ) {
        continue;
      }

      out.push(
        x.symbol
      );
    }

    cursor =
      data?.result
        ?.nextPageCursor ||
      "";

    if (!cursor) {
      break;
    }
  }

  return [
    ...new Set(out)
  ];
}


async function findSymbol(
  symbol
) {
  let s =
    String(symbol || "")
      .trim()
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        ""
      );

  if (!s) {
    return null;
  }

  if (
    !s.endsWith("USDT")
  ) {
    s += "USDT";
  }

  for (
    const category
    of [
      "linear",
      "spot"
    ]
  ) {
    try {
      const data =
        await bybit(
          "/v5/market/instruments-info",
          {
            category,
            symbol: s
          }
        );

      const list =
        data?.result?.list ||
        [];

      if (
        list.length
      ) {
        return {
          category,
          symbol:
            list[0].symbol
        };
      }
    } catch {}
  }

  return null;
}


/* =====================================================
   KLINES
===================================================== */

function parseKlines(
  list
) {
  return (
    list || []
  )
    .map(x => ({
      time:
        num(x[0]),

      open:
        num(x[1]),

      high:
        num(x[2]),

      low:
        num(x[3]),

      close:
        num(x[4]),

      volume:
        num(x[5]),

      turnover:
        num(x[6])
    }))
    .filter(
      x =>
        x.time > 0
    )
    .sort(
      (a, b) =>
        a.time -
        b.time
    );
}


async function getKlines(
  category,
  symbol,
  interval = "15",
  limit = KLINE_LIMIT
) {
  const data =
    await bybit(
      "/v5/market/kline",
      {
        category,
        symbol,
        interval,
        limit
      }
    );

  return parseKlines(
    data?.result?.list ||
      []
  );
}


/* =====================================================
   PUMP DETECTION
===================================================== */

function detectPump(
  candles
) {
  if (
    !candles ||
    candles.length < 30
  ) {
    return {
      candidate: false,
      reason:
        "Not enough candles"
    };
  }

  const lastIndex =
    candles.length - 1;

  let best = null;

  for (
    let end =
      lastIndex - 1;

    end >=
      Math.max(
        10,
        lastIndex - 48
      );

    end--
  ) {
    for (
      let count =
        MIN_PUMP_CANDLES;

      count <=
        MAX_PUMP_CANDLES;

      count++
    ) {
      const start =
        end -
        count +
        1;

      if (
        start < 1
      ) {
        continue;
      }

      const segment =
        candles.slice(
          start,
          end + 1
        );

      const firstOpen =
        segment[0].open;

      const lastClose =
        segment[
          segment.length - 1
        ].close;

      if (
        firstOpen <= 0
      ) {
        continue;
      }

      const pumpPercent =
        (
          (
            lastClose -
            firstOpen
          ) /
          firstOpen
        ) * 100;

      const greenCount =
        segment.filter(
          c =>
            c.close >
            c.open
        ).length;

      const greenRatio =
        greenCount /
        segment.length;

      const previous =
        candles.slice(
          Math.max(
            0,
            start - 20
          ),
          start
        );

      const avgVolume =
        previous.length
          ? previous.reduce(
              (s, c) =>
                s +
                c.volume,
              0
            ) /
            previous.length
          : 0;

      const pumpVolume =
        segment.reduce(
          (s, c) =>
            s +
            c.volume,
          0
        ) /
        segment.length;

      const volumeRatio =
        avgVolume > 0
          ? pumpVolume /
            avgVolume
          : 0;

      if (
        pumpPercent <
        MIN_PUMP_PERCENT
      ) {
        continue;
      }

      if (
        volumeRatio <
        MIN_VOLUME_MULTIPLIER
      ) {
        continue;
      }

      if (
        greenRatio <
        MIN_GREEN_RATIO
      ) {
        continue;
      }

      const pumpHigh =
        Math.max(
          ...segment.map(
            c =>
              c.high
          )
        );

      const pumpLow =
        Math.min(
          ...segment.map(
            c =>
              c.low
          )
        );

      const pumpEndTime =
        segment[
          segment.length - 1
        ].time;

      const ageHours =
        (
          Date.now() -
          pumpEndTime
        ) /
        3600000;

      if (
        ageHours < 0 ||
        ageHours >
          MAX_PUMP_AGE_HOURS
      ) {
        continue;
      }

      const score =
        Math.min(
          40,
          pumpPercent * 4
        ) +
        Math.min(
          30,
          volumeRatio * 10
        ) +
        Math.min(
          20,
          greenRatio * 20
        ) +
        Math.min(
          10,
          count * 2
        );

      const candidate = {
        startTime:
          segment[0].time,

        endTime:
          pumpEndTime,

        candles:
          count,

        pumpPercent,

        greenRatio,

        volumeRatio,

        pumpHigh,

        pumpLow,

        pumpOpen:
          firstOpen,

        pumpClose:
          lastClose,

        score
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

  if (!best) {
    return {
      candidate: false,
      reason:
        "Pump conditions not met"
    };
  }

  return {
    candidate: true,
    ...best
  };
}


/* =====================================================
   RED CANDLE + PULLBACK
===================================================== */

function buildSetup(
  candles,
  pump
) {
  if (!pump) {
    return null;
  }

  const after =
    candles.filter(
      c =>
        c.time >
        pump.endTime
    );

  const red =
    after.find(
      c =>
        c.close <
        c.open
    );

  if (!red) {
    return {
      redCandle: null,

      pullbackPercent:
        0,

      zoneLow:
        pump.pumpLow,

      zoneHigh:
        pump.pumpHigh,

      zonePrice:
        (
          pump.pumpLow +
          pump.pumpHigh
        ) / 2,

      status:
        "WAITING_RED",

      reason:
        "Waiting for red candle"
    };
  }

  const pumpRange =
    pump.pumpHigh -
    pump.pumpLow;

  if (
    pumpRange <= 0
  ) {
    return {
      redCandle: {
        time:
          red.time,

        open:
          red.open,

        high:
          red.high,

        low:
          red.low,

        close:
          red.close
      },

      pullbackPercent:
        0,

      zoneLow:
        pump.pumpLow,

      zoneHigh:
        pump.pumpHigh,

      zonePrice:
        (
          pump.pumpLow +
          pump.pumpHigh
        ) / 2,

      status:
        "INVALID",

      reason:
        "Invalid pump range"
    };
  }

  const pullbackPercent =
    (
      (
        pump.pumpHigh -
        red.close
      ) /
      pump.pumpHigh
    ) * 100;

  const zoneLow =
    pump.pumpLow +
    pumpRange * 0.382;

  const zoneHigh =
    pump.pumpLow +
    pumpRange * 0.618;

  const zonePrice =
    (
      zoneLow +
      zoneHigh
    ) / 2;

  return {
    redCandle: {
      time:
        red.time,

      open:
        red.open,

      high:
        red.high,

      low:
        red.low,

      close:
        red.close
    },

    pullbackPercent,

    zoneLow,
    zoneHigh,
    zonePrice,

    status:
      pullbackPercent <=
      MAX_PULLBACK_PERCENT
        ? "READY"
        : "INVALID",

    reason:
      pullbackPercent <=
      MAX_PULLBACK_PERCENT
        ? "Pullback valid"
        : "Pullback exceeded maximum"
  };
}


/* =====================================================
   TICKER
===================================================== */

async function getTicker(
  category,
  symbol
) {
  const data =
    await bybit(
      "/v5/market/tickers",
      {
        category,
        symbol
      }
    );

  const x =
    data?.result?.list?.[0];

  if (!x) {
    return null;
  }

  return {
    symbol,

    lastPrice:
      num(
        x.lastPrice
      ),

    markPrice:
      num(
        x.markPrice
      ),

    indexPrice:
      num(
        x.indexPrice
      ),

    bid1Price:
      num(
        x.bid1Price
      ),

    ask1Price:
      num(
        x.ask1Price
      ),

    volume24h:
      num(
        x.volume24h
      ),

    turnover24h:
      num(
        x.turnover24h
      ),

    price24hPcnt:
      num(
        x.price24hPcnt
      ) * 100,

    fundingRate:
      num(
        x.fundingRate
      ),

    nextFundingTime:
      num(
        x.nextFundingTime
      ),

    openInterest:
      num(
        x.openInterest
      )
  };
}


/* =====================================================
   SETUP STATE
===================================================== */

function evaluateSetup(
  setup,
  price
) {
  if (!setup) {
    return {
      state:
        "INVALID",

      reason:
        "No setup data",

      distancePercent:
        0
    };
  }

  if (
    !price ||
    price <= 0
  ) {
    return {
      state:
        "INVALID",

      reason:
        "Price unavailable",

      distancePercent:
        0
    };
  }

  if (
    setup.status ===
    "INVALID"
  ) {
    return {
      state:
        "INVALID",

      reason:
        setup.reason,

      distancePercent:
        0
    };
  }

  if (
    setup.status ===
    "WAITING_RED"
  ) {
    return {
      state:
        "WAITING",

      reason:
        "Waiting for red candle",

      distancePercent:
        0
    };
  }

  const distanceToZone =
    price <
    setup.zoneLow
      ? setup.zoneLow -
        price
      : price >
          setup.zoneHigh
        ? price -
          setup.zoneHigh
        : 0;

  const distancePercent =
    price > 0
      ? (
          distanceToZone /
          price
        ) * 100
      : 0;

  if (
    price >=
      setup.zoneLow &&
    price <=
      setup.zoneHigh
  ) {
    return {
      state:
        "REACHED",

      reason:
        "Price is inside pullback zone",

      distancePercent:
        0
    };
  }

  if (
    distancePercent <=
    NEAR_ZONE_PERCENT
  ) {
    return {
      state:
        "NEAR",

      reason:
        "Price is near pullback zone",

      distancePercent
    };
  }

  if (
    price >
    setup.zoneHigh
  ) {
    return {
      state:
        "APPROACHING",

      reason:
        "Price is approaching pullback zone",

      distancePercent
    };
  }

  return {
    state:
      "INVALID",

    reason:
      "Price invalidated setup",

    distancePercent
  };
}


/* =====================================================
   TRADE NORMALIZATION
===================================================== */

function normalizeTrade(t) {
  const price =
    num(t.price);

  const size =
    num(
      t.size ??
      t.qty
    );

  const time =
    num(
      t.time ??
      t.timestamp
    );

  return {
    execId:
      String(
        t.execId || ""
      ),

    side:
      normalizeSide(
        t.side
      ),

    price,

    size,

    qty:
      size,

    /*
      ارزش واقعی هر معامله
      قیمت × حجم
    */
    notional:
      price * size,

    time,

    timestamp:
      time,

    isBlockTrade:
      !!t.isBlockTrade,

    isRPITrade:
      !!t.isRPITrade
  };
}


/* =====================================================
   TRADE HISTORY STORAGE
===================================================== */

function historyKey(
  category,
  symbol
) {
  return (
    category +
    ":" +
    symbol
  );
}


function cleanupTradeHistory(
  key,
  now = Date.now()
) {
  const rows =
    tradeHistory.get(
      key
    ) || [];

  const minTime =
    now -
    TRADE_HISTORY_MS;

  const filtered =
    rows.filter(
      t =>
        t.time >=
        minTime
    );

  if (
    filtered.length >
    TRADE_HISTORY_MAX
  ) {
    filtered.splice(
      0,
      filtered.length -
        TRADE_HISTORY_MAX
    );
  }

  tradeHistory.set(
    key,
    filtered
  );

  return filtered;
}


function storeTrades(
  category,
  symbol,
  trades,
  now = Date.now()
) {
  const key =
    historyKey(
      category,
      symbol
    );

  const old =
    tradeHistory.get(
      key
    ) || [];

  const map =
    new Map();

  for (
    const t of old
  ) {
    if (
      t.execId
    ) {
      map.set(
        t.execId,
        t
      );
    }
  }

  for (
    const raw of trades
  ) {
    const t =
      normalizeTrade(
        raw
      );

    if (
      !t.time ||
      !t.price ||
      !t.size ||
      !t.side
    ) {
      continue;
    }

    const id =
      t.execId ||
      `${t.time}:${t.price}:${t.size}:${t.side}`;

    map.set(
      id,
      t
    );
  }

  const rows =
    [
      ...map.values()
    ]
      .filter(
        t =>
          t.time >=
          now -
            TRADE_HISTORY_MS
      )
      .sort(
        (a, b) =>
          a.time -
          b.time
      );

  if (
    rows.length >
    TRADE_HISTORY_MAX
  ) {
    rows.splice(
      0,
      rows.length -
        TRADE_HISTORY_MAX
    );
  }

  tradeHistory.set(
    key,
    rows
  );

  return rows;
}


function getStoredTrades(
  category,
  symbol,
  now = Date.now()
) {
  return cleanupTradeHistory(
    historyKey(
      category,
      symbol
    ),
    now
  );
}


/* =====================================================
   BYBIT RECENT TRADES
===================================================== */

async function getRecentTrades(
  category,
  symbol
) {
  const limit =
    category === "spot"
      ? RECENT_TRADE_LIMIT_SPOT
      : RECENT_TRADE_LIMIT_LINEAR;

  const data =
    await bybit(
      "/v5/market/recent-trade",
      {
        category,
        symbol,
        limit
      }
    );

  const rows =
    data?.result?.list ||
    [];

  return rows
    .map(
      normalizeTrade
    )
    .filter(
      t =>
        t.time > 0 &&
        t.price > 0 &&
        t.size >= 0 &&
        t.side !== ""
    )
    .sort(
      (a, b) =>
        a.time -
        b.time
    );
}


/* =====================================================
   GET ALL AVAILABLE HISTORY
===================================================== */

async function getTradeHistory(
  category,
  symbol,
  now = Date.now()
) {
  const fresh =
    await getRecentTrades(
      category,
      symbol
    );

  const stored =
    storeTrades(
      category,
      symbol,
      fresh,
      now
    );

  return stored;
}


/* =====================================================
   FOOTPRINT
===================================================== */

function makeFootprint(
  trades,
  now = Date.now()
) {
  const result = {};

  for (
    const window
    of FOOTPRINT_WINDOWS
  ) {
    const from =
      now -
      window.ms;

    const rows =
      trades.filter(
        t =>
          t.time >=
            from &&
          t.time <=
            now
      );

    let buyVolume = 0;
    let sellVolume = 0;

    let buyNotional = 0;
    let sellNotional = 0;

    let buyTrades = 0;
    let sellTrades = 0;

    for (
      const t of rows
    ) {
      const notional =
        t.price *
        t.size;

      if (
        t.side === "Buy"
      ) {
        buyVolume +=
          t.size;

        buyNotional +=
          notional;

        buyTrades++;
      }

      if (
        t.side === "Sell"
      ) {
        sellVolume +=
          t.size;

        sellNotional +=
          notional;

        sellTrades++;
      }
    }

    const totalNotional =
      buyNotional +
      sellNotional;

    const delta =
      buyNotional -
      sellNotional;

    const deltaPercent =
      totalNotional > 0
        ? (
            delta /
            totalNotional
          ) * 100
        : 0;

    const notionals =
      rows.map(
        t =>
          t.price *
          t.size
      );

    const med =
      median(
        notionals
      );

    const largeThreshold =
      med > 0
        ? med * 5
        : 0;

    let largeBuyVolume = 0;
    let largeSellVolume = 0;

    let largeBuyTrades = 0;
    let largeSellTrades = 0;

    for (
      const t of rows
    ) {
      const n =
        t.price *
        t.size;

      if (
        n >=
          largeThreshold &&
        largeThreshold > 0
      ) {
        if (
          t.side ===
          "Buy"
        ) {
          largeBuyVolume +=
            t.size;

          largeBuyTrades++;
        }

        if (
          t.side ===
          "Sell"
        ) {
          largeSellVolume +=
            t.size;

          largeSellTrades++;
        }
      }
    }

    result[
      window.key
    ] = {
      key:
        window.key,

      label:
        window.label,

      from,

      to:
        now,

      tradeCount:
        rows.length,

      coverageMs:
        rows.length
          ? Math.max(
              0,
              now -
                rows[0].time
            )
          : 0,

      buyVolume,
      sellVolume,

      buyNotional,
      sellNotional,

      buyTrades,
      sellTrades,

      delta,
      deltaPercent,

      pressure:
        deltaPercent >=
        10
          ? "BUY_PRESSURE"
          : deltaPercent <=
              -10
            ? "SELL_PRESSURE"
            : "NEUTRAL",

      largeThreshold,

      largeBuyVolume,
      largeSellVolume,

      largeBuyTrades,
      largeSellTrades
    };
  }

  return result;
}


/* =====================================================
   ORDERBOOK
===================================================== */

async function getOrderbook(
  category,
  symbol
) {
  const data =
    await bybit(
      "/v5/market/orderbook",
      {
        category,
        symbol,
        limit: 50
      }
    );

  const r =
    data?.result ||
    {};

  const bids =
    (r.b || [])
      .map(x => ({
        price:
          num(x[0]),

        size:
          num(x[1])
      }))
      .filter(
        x =>
          x.price > 0 &&
          x.size >= 0
      );

  const asks =
    (r.a || [])
      .map(x => ({
        price:
          num(x[0]),

        size:
          num(x[1])
      }))
      .filter(
        x =>
          x.price > 0 &&
          x.size >= 0
      );

  const allNotionals = [
    ...bids.map(
      x =>
        x.price *
        x.size
    ),

    ...asks.map(
      x =>
        x.price *
        x.size
    )
  ];

  const med =
    median(
      allNotionals
    );

  const wallThreshold =
    med > 0
      ? med * 4
      : 0;

  const current =
    bids[0]?.price ||
    asks[0]?.price ||
    0;

  function makeWalls(
    levels,
    side
  ) {
    return levels
      .map(x => ({
        side,

        price:
          x.price,

        size:
          x.size,

        notional:
          x.price *
          x.size,

        distancePercent:
          current > 0
            ? Math.abs(
                (
                  (
                    x.price -
                    current
                  ) /
                  current
                ) * 100
              )
            : 0
      }))
      .filter(
        x =>
          wallThreshold > 0 &&
          x.notional >=
            wallThreshold
      )
      .sort(
        (a, b) =>
          b.notional -
          a.notional
      )
      .slice(
        0,
        10
      )
      .map(x => ({
        ...x,

        strength:
          med > 0
            ? x.notional /
              med
            : 0
      }));
  }

  const buyLiquidity =
    bids.reduce(
      (s, x) =>
        s +
        x.price *
          x.size,
      0
    );

  const sellLiquidity =
    asks.reduce(
      (s, x) =>
        s +
        x.price *
          x.size,
      0
    );

  const totalLiquidity =
    buyLiquidity +
    sellLiquidity;

  const buyShare =
    totalLiquidity > 0
      ? (
          buyLiquidity /
          totalLiquidity
        ) * 100
      : 0;

  const sellShare =
    totalLiquidity > 0
      ? (
          sellLiquidity /
          totalLiquidity
        ) * 100
      : 0;

  return {
    timestamp:
      Date.now(),

    bestBid:
      bids[0]?.price ||
      0,

    bestAsk:
      asks[0]?.price ||
      0,

    buyLiquidity,
    sellLiquidity,

    totalLiquidity,

    buyShare,
    sellShare,

    pressure:
      buyShare >
      sellShare + 8
        ? "BUY_PRESSURE"
        : sellShare >
            buyShare + 8
          ? "SELL_PRESSURE"
          : "NEUTRAL",

    medianLevelNotional:
      med,

    wallThreshold,

    buyWalls:
      makeWalls(
        bids,
        "BUY"
      ),

    sellWalls:
      makeWalls(
        asks,
        "SELL"
      ),

    bids,
    asks
  };
}


/* =====================================================
   OPEN INTEREST
===================================================== */

async function getOI(
  category,
  symbol
) {
  if (
    category !==
      "linear" &&
    category !==
      "inverse"
  ) {
    return {
      available: false,
      rows: []
    };
  }

  const rows = [];

  for (
    const window
    of OI_WINDOWS
  ) {
    try {
      const data =
        await bybit(
          "/v5/market/open-interest",
          {
            category,
            symbol,

            intervalTime:
              window.interval,

            limit: 20
          }
        );

      const list =
        data?.result?.list ||
        [];

      const parsed =
        list
          .map(x => ({
            timestamp:
              num(
                x.timestamp
              ),

            openInterest:
              num(
                x.openInterest
              )
          }))
          .sort(
            (a, b) =>
              a.timestamp -
              b.timestamp
          );

      const current =
        parsed.at(-1) ||
        null;

      const previous =
        parsed.at(-2) ||
        null;

      const change =
        current &&
        previous
          ? current.openInterest -
            previous.openInterest
          : 0;

      const changePercent =
        current &&
        previous
          ? pct(
              current.openInterest,
              previous.openInterest
            )
          : 0;

      rows.push({
        key:
          window.key,

        label:
          window.label,

        interval:
          window.interval,

        current:
          current
            ? current.openInterest
            : 0,

        previous:
          previous
            ? previous.openInterest
            : 0,

        change,
        changePercent,

        trend:
          change > 0
            ? "UP"
            : change < 0
              ? "DOWN"
              : "FLAT",

        timestamp:
          current?.timestamp ||
          0,

        history:
          parsed.slice(
            -10
          )
      });

    } catch (e) {
      rows.push({
        key:
          window.key,

        label:
          window.label,

        interval:
          window.interval,

        current: 0,
        previous: 0,
        change: 0,
        changePercent: 0,

        trend:
          "UNAVAILABLE",

        timestamp: 0,

        history: [],

        error:
          e.message
      });
    }
  }

  return {
    available: true,
    rows
  };
}


/* =====================================================
   FUNDING
===================================================== */

async function getFunding(
  category,
  symbol,
  ticker = null
) {
  if (
    category !==
      "linear" &&
    category !==
      "inverse"
  ) {
    return {
      available: false,
      currentRate: null,
      previousRate: null,
      rows: []
    };
  }

  let history = [];

  try {
    const data =
      await bybit(
        "/v5/market/funding/history",
        {
          category,
          symbol,
          limit: 10
        }
      );

    history =
      data?.result?.list ||
      [];
  } catch {}

  history =
    history
      .map(x => ({
        timestamp:
          num(
            x.fundingRateTimestamp
          ),

        rate:
          num(
            x.fundingRate
          )
      }))
      .sort(
        (a, b) =>
          a.timestamp -
          b.timestamp
      );

  const currentRate =
    ticker?.fundingRate !==
    undefined
      ? ticker.fundingRate
      : history.at(-1)?.rate ||
        0;

  const previousRate =
    history.length >= 2
      ? history.at(-2).rate
      : history.at(-1)?.rate ||
        0;

  const change =
    currentRate -
    previousRate;

  const changePercent =
    previousRate !== 0
      ? (
          change /
          Math.abs(
            previousRate
          )
        ) * 100
      : 0;

  return {
    available: true,

    currentRate,

    previousRate,

    change,

    changePercent,

    direction:
      currentRate > 0
        ? "POSITIVE"
        : currentRate < 0
          ? "NEGATIVE"
          : "FLAT",

    nextFundingTime:
      ticker?.nextFundingTime ||
      0,

    rows:
      history
        .slice(-8)
        .reverse()
        .map(
          (
            x,
            i,
            arr
          ) => {
            const prev =
              arr[i + 1];

            const ch =
              prev
                ? x.rate -
                  prev.rate
                : 0;

            return {
              timestamp:
                x.timestamp,

              rate:
                x.rate,

              change:
                ch,

              changePercent:
                prev &&
                prev.rate !== 0
                  ? (
                      ch /
                      Math.abs(
                        prev.rate
                      )
                    ) * 100
                  : 0
            };
          }
        )
  };
}


/* =====================================================
   TRADE RANGE FILTER — SERVER
===================================================== */

function filterTradesByRange(
  trades,
  options = {}
) {
  const now =
    num(
      options.now,
      Date.now()
    );

  let from =
    num(
      options.from,
      now -
        TRADE_HISTORY_MS
    );

  let to =
    num(
      options.to,
      now
    );

  if (
    from > to
  ) {
    const tmp =
      from;

    from = to;
    to = tmp;
  }

  const minPrice =
    options.minPrice !==
    undefined &&
    options.minPrice !==
    ""
      ? num(
          options.minPrice,
          NaN
        )
      : null;

  const maxPrice =
    options.maxPrice !==
    undefined &&
    options.maxPrice !==
    ""
      ? num(
          options.maxPrice,
          NaN
        )
      : null;

  return trades.filter(
    t => {
      if (
        t.time < from ||
        t.time > to
      ) {
        return false;
      }

      if (
        minPrice !==
          null &&
        Number.isFinite(
          minPrice
        ) &&
        t.price <
          minPrice
      ) {
        return false;
      }

      if (
        maxPrice !==
          null &&
        Number.isFinite(
          maxPrice
        ) &&
        t.price >
          maxPrice
      ) {
        return false;
      }

      return true;
    }
  );
}


/* =====================================================
   DEEP ANALYSIS
===================================================== */

async function deepAnalysis(
  category,
  symbol
) {
  const started =
    Date.now();

  const [
    ticker,
    candles,
    recentTrades,
    orderbook
  ] = await Promise.all([
    getTicker(
      category,
      symbol
    ),

    getKlines(
      category,
      symbol,
      TF,
      KLINE_LIMIT
    ),

    getRecentTrades(
      category,
      symbol
    ),

    getOrderbook(
      category,
      symbol
    )
  ]);

  /*
  معاملات جدید را وارد تاریخچه 24 ساعته می‌کنیم.
  */
  const trades =
    storeTrades(
      category,
      symbol,
      recentTrades
    );

  const pump =
    detectPump(
      candles
    );

  const setup =
    pump.candidate
      ? buildSetup(
          candles,
          pump
        )
      : null;

  const price =
    ticker?.lastPrice ||
    0;

  const state =
    pump.candidate
      ? evaluateSetup(
          setup,
          price
        )
      : {
          state:
            "INVALID",

          reason:
            pump.reason,

          distancePercent:
            0
        };

  const footprint =
    makeFootprint(
      trades,
      Date.now()
    );

  const [
    oi,
    funding
  ] = await Promise.all([
    getOI(
      category,
      symbol
    ),

    getFunding(
      category,
      symbol,
      ticker
    )
  ]);

  const now =
    Date.now();

  const oldestTrade =
    trades[0]?.time ||
    0;

  return {
    ok: true,

    version:
      VERSION,

    category,

    symbol,

    timestamp:
      now,

    price,

    pump:
      pump.candidate
        ? {
            candidate: true,

            pumpPercent:
              pump.pumpPercent,

            candles:
              pump.candles,

            greenRatio:
              pump.greenRatio,

            volumeRatio:
              pump.volumeRatio,

            volumeMultiplier:
              pump.volumeRatio,

            score:
              pump.score,

            startTime:
              pump.startTime,

            endTime:
              pump.endTime,

            pumpHigh:
              pump.pumpHigh,

            pumpLow:
              pump.pumpLow,

            pumpOpen:
              pump.pumpOpen,

            pumpClose:
              pump.pumpClose
          }
        : {
            candidate: false,

            reason:
              pump.reason,

            pumpPercent: 0,
            candles: 0,
            greenRatio: 0,
            volumeRatio: 0,
            volumeMultiplier: 0,
            score: 0
          },

    setup:
      setup
        ? {
            ...setup,

            pumpPercent:
              pump.pumpPercent,

            volumeMultiplier:
              pump.volumeRatio,

            state:
              state.state,

            stateReason:
              state.reason,

            distancePercent:
              state.distancePercent,

            distanceToZonePercent:
              state.distancePercent
          }
        : {
            redCandle: null,

            pullbackPercent:
              0,

            zoneLow: 0,
            zoneHigh: 0,
            zonePrice: 0,

            status:
              "INVALID",

            reason:
              pump.reason,

            state:
              "INVALID",

            stateReason:
              pump.reason,

            distancePercent:
              0,

            distanceToZonePercent:
              0
          },

    currentState:
      state,

    state:
      state.state,

    ticker,

    footprint,

    orderbook: {
      ...orderbook,

      bids:
        undefined,

      asks:
        undefined
    },

    walls: {
      buy:
        orderbook.buyWalls,

      sell:
        orderbook.sellWalls,

      buyWalls:
        orderbook.buyWalls,

      sellWalls:
        orderbook.sellWalls,

      threshold:
        orderbook.wallThreshold,

      median:
        orderbook.medianLevelNotional
    },

    openInterest:
      oi,

    funding,

    /*
    تاریخچه کامل موجود در Worker.
    فقط 100 مورد آخر برای جدول نمایش ارسال می‌شود.
    */

    recentTrades:
      trades
        .slice(-100)
        .reverse(),

    /*
    تعداد واقعی کل معاملات موجود
    */

    tradeHistory:
      {
        available:
          trades.length > 0,

        windowMs:
          TRADE_HISTORY_MS,

        windowHours:
          24,

        from:
          now -
          TRADE_HISTORY_MS,

        to:
          now,

        tradeCount:
          trades.length,

        oldestTradeTime:
          oldestTrade,

        newestTradeTime:
          trades.at(-1)
            ?.time ||
          0,

        coverageMs:
          trades.length
            ? Math.max(
                0,
                now -
                  oldestTrade
              )
            : 0,

        coverageHours:
          trades.length
            ? Math.max(
                0,
                (
                  now -
                  oldestTrade
                ) /
                3600000
              )
            : 0
      },

    diagnostics: {
      candleCount:
        candles.length,

      tradeCount:
        trades.length,

      recentTradeCount:
        recentTrades.length,

      oldestTradeTime:
        oldestTrade,

      newestTradeTime:
        trades.at(-1)
          ?.time ||
        0,

      tradeCoverageMs:
        trades.length
          ? Math.max(
              0,
              now -
                oldestTrade
            )
          : 0,

      tradeCoverageMinutes:
        trades.length
          ? Math.max(
              0,
              (
                now -
                oldestTrade
              ) /
                60000
            )
          : 0,

      tradeCoverageHours:
        trades.length
          ? Math.max(
              0,
              (
                now -
                oldestTrade
              ) /
                3600000
            )
          : 0,

      historyWindowHours:
        24,

      historyMode:
        "WORKER_ACCUMULATED_24H",

      hasPump:
        pump.candidate,

      hasRedCandle:
        !!setup?.redCandle,

      setupState:
        state.state
    },

    scanDurationMs:
      Date.now() -
      started
  };
}


/* =====================================================
   SCAN
===================================================== */

async function scanCategory(
  category,
  symbols
) {
  const results = [];

  for (
    let i = 0;

    i < symbols.length &&
    results.length <
      SCAN_BATCH;

    i++
  ) {
    const symbol =
      symbols[i];

    try {
      const candles =
        await getKlines(
          category,
          symbol,
          TF,
          KLINE_LIMIT
        );

      const pump =
        detectPump(
          candles
        );

      if (
        !pump.candidate
      ) {
        continue;
      }

      const setup =
        buildSetup(
          candles,
          pump
        );

      const ticker =
        await getTicker(
          category,
          symbol
        );

      const price =
        ticker?.lastPrice ||
        0;

      const state =
        evaluateSetup(
          setup,
          price
        );

      results.push({
        symbol,

        category,

        price,

        pump: {
          pumpPercent:
            pump.pumpPercent,

          candles:
            pump.candles,

          greenRatio:
            pump.greenRatio,

          volumeRatio:
            pump.volumeRatio,

          volumeMultiplier:
            pump.volumeRatio,

          score:
            pump.score
        },

        setup: {
          ...setup,

          pumpPercent:
            pump.pumpPercent,

          volumeMultiplier:
            pump.volumeRatio,

          state:
            state.state,

          stateReason:
            state.reason,

          distancePercent:
            state.distancePercent,

          distanceToZonePercent:
            state.distancePercent
        },

        state:
          state.state,

        reason:
          state.reason
      });

    } catch {}
  }

  return results;
}


async function scan() {
  const started =
    Date.now();

  const [
    linearSymbols,
    spotSymbols
  ] = await Promise.all([
    getInstruments(
      "linear"
    ),

    getInstruments(
      "spot"
    )
  ]);

  const shuffledLinear =
    linearSymbols.sort(
      () =>
        Math.random() -
        0.5
    );

  const shuffledSpot =
    spotSymbols.sort(
      () =>
        Math.random() -
        0.5
    );

  const [
    futures,
    spot
  ] = await Promise.all([
    scanCategory(
      "linear",
      shuffledLinear
    ),

    scanCategory(
      "spot",
      shuffledSpot
    )
  ]);

  const all =
    [
      ...futures,
      ...spot
    ].sort(
      (a, b) =>
        b.pump.score -
        a.pump.score
    );

  return {
    ok: true,

    version:
      VERSION,

    timestamp:
      Date.now(),

    timeframe:
      "15m",

    strategy:
      "PUMP → RED CANDLE → PULLBACK ZONE → RETEST",

    results:
      all,

    stats: {
      totalCandidates:
        all.length,

      pumpCandidates:
        all.filter(
          x =>
            x.state !==
            "INVALID"
        ).length,

      reached:
        all.filter(
          x =>
            x.state ===
            "REACHED"
        ).length,

      near:
        all.filter(
          x =>
            x.state ===
            "NEAR"
        ).length,

      approaching:
        all.filter(
          x =>
            x.state ===
            "APPROACHING"
        ).length,

      invalid:
        all.filter(
          x =>
            x.state ===
            "INVALID"
        ).length
    },

    scanDurationMs:
      Date.now() -
      started
  };
}


/* =====================================================
   ROUTER
===================================================== */

export default {
  async fetch(
    request,
    env
  ) {
    const url =
      new URL(
        request.url
      );

    const path =
      url.pathname;

    try {
      if (
        request.method ===
        "OPTIONS"
      ) {
        return new Response(
          null,
          {
            headers: {
              "access-control-allow-origin":
                "*",

              "access-control-allow-methods":
                "GET,OPTIONS",

              "access-control-allow-headers":
                "*"
            }
          }
        );
      }


      /* ===============================================
         ROOT
      =============================================== */

      if (
        path === "/" ||
        path === ""
      ) {
        if (
          env?.ASSETS
        ) {
          return env.ASSETS.fetch(
            request
          );
        }

        return text(
          "Pump Scanner"
        );
      }


      /* ===============================================
         HEALTH
      =============================================== */

      if (
        path ===
        "/health"
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

          liveData: {
            footprint:
              true,

            recentTrades:
              true,

            tradeNotional:
              true,

            orderbook:
              true,

            buyWalls:
              true,

            sellWalls:
              true,

            openInterest:
              true,

            funding:
              true,

            tradeHistory:
              true,

            exactPriceFilter:
              true,

            exactTimeFilter:
              true
          },

          tradeSource:
            "Bybit V5 recent-trade + Worker accumulation",

          tradeHistoryMode:
            "ACCUMULATED_24H",

          tradeHistoryWindowHours:
            24,

          tradeHistoryWarning:
            "24h history is accumulated while this Worker instance remains active.",

          endpoints: [
            "/health",
            "/scan",
            "/analyze?symbol=BTCUSDT",
            "/live?symbol=BTCUSDT",
            "/trades?symbol=BTCUSDT"
          ]
        });
      }


      /* ===============================================
         SCAN
      =============================================== */

      if (
        path === "/scan"
      ) {
        return json(
          await scan()
        );
      }


      /* ===============================================
         ANALYZE
      =============================================== */

      if (
        path ===
        "/analyze"
      ) {
        const symbol =
          url.searchParams.get(
            "symbol"
          );

        if (!symbol) {
          return json(
            {
              ok: false,

              error:
                "symbol required"
            },
            400
          );
        }

        const found =
          await findSymbol(
            symbol
          );

        if (!found) {
          return json(
            {
              ok: false,

              error:
                "Symbol not found"
            },
            404
          );
        }

        return json(
          await deepAnalysis(
            found.category,
            found.symbol
          )
        );
      }


      /* ===============================================
         TRADES
         
         endpoint مخصوص فیلتر دقیق زمان و قیمت
         
         مثال:
         /trades?symbol=BTCUSDT

         /trades?symbol=BTCUSDT&hours=24

         /trades?symbol=BTCUSDT
         &from=...
         &to=...
         &minPrice=...
         &maxPrice=...
      =============================================== */

      if (
        path === "/trades"
      ) {
        const symbol =
          url.searchParams.get(
            "symbol"
          );

        if (!symbol) {
          return json(
            {
              ok: false,

              error:
                "symbol required"
            },
            400
          );
        }

        const found =
          await findSymbol(
            symbol
          );

        if (!found) {
          return json(
            {
              ok: false,

              error:
                "Symbol not found"
            },
            404
          );
        }

        const now =
          Date.now();

        const stored =
          await getTradeHistory(
            found.category,
            found.symbol,
            now
          );

        const hoursParam =
          url.searchParams.get(
            "hours"
          );

        const hours =
          hoursParam !==
          null
            ? Math.max(
                0,
                Math.min(
                  24,
                  num(
                    hoursParam,
                    24
                  )
                )
              )
            : 24;

        const defaultFrom =
          now -
          hours *
            3600000;

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
            ? num(
                fromParam,
                defaultFrom
              )
            : defaultFrom;

        const to =
          toParam
            ? num(
                toParam,
                now
              )
            : now;

        const filtered =
          filterTradesByRange(
            stored,
            {
              from,
              to,

              minPrice:
                url.searchParams.get(
                  "minPrice"
                ),

              maxPrice:
                url.searchParams.get(
                  "maxPrice"
                ),

              now
            }
          );

        return json({
          ok: true,

          version:
            VERSION,

          category:
            found.category,

          symbol:
            found.symbol,

          timestamp:
            now,

          requestedRange: {
            from,
            to,

            hours:
              (
                to -
                from
              ) /
              3600000
          },

          availableHistory: {
            from:
              stored[0]
                ?.time ||
              0,

            to:
              stored.at(-1)
                ?.time ||
              0,

            tradeCount:
              stored.length,

            coverageHours:
              stored.length
                ? (
                    now -
                    stored[0]
                      .time
                  ) /
                  3600000
                : 0
          },

          filteredCount:
            filtered.length,

          trades:
            filtered
        });
      }


      /* ===============================================
         LIVE
      =============================================== */

      if (
        path === "/live"
      ) {
        const symbol =
          url.searchParams.get(
            "symbol"
          );

        if (!symbol) {
          return json(
            {
              ok: false,

              error:
                "symbol required"
            },
            400
          );
        }

        const found =
          await findSymbol(
            symbol
          );

        if (!found) {
          return json(
            {
              ok: false,

              error:
                "Symbol not found"
            },
            404
          );
        }

        const [
          ticker,
          candles,
          recentTrades,
          orderbook
        ] = await Promise.all([
          getTicker(
            found.category,
            found.symbol
          ),

          getKlines(
            found.category,
            found.symbol,
            TF,
            KLINE_LIMIT
          ),

          getRecentTrades(
            found.category,
            found.symbol
          ),

          getOrderbook(
            found.category,
            found.symbol
          )
        ]);

        /*
        هر بار /live صدا زده می‌شود،
        معاملات جدید وارد تاریخچه می‌شوند.
        */

        const now =
          Date.now();

        const trades =
          storeTrades(
            found.category,
            found.symbol,
            recentTrades,
            now
          );

        const pump =
          detectPump(
            candles
          );

        const setup =
          pump.candidate
            ? buildSetup(
                candles,
                pump
              )
            : null;

        const price =
          ticker?.lastPrice ||
          0;

        const state =
          pump.candidate
            ? evaluateSetup(
                setup,
                price
              )
            : {
                state:
                  "INVALID",

                reason:
                  pump.reason,

                distancePercent:
                  0
              };

        const footprint =
          makeFootprint(
            trades,
            now
          );

        const [
          oi,
          funding
        ] = await Promise.all([
          getOI(
            found.category,
            found.symbol
          ),

          getFunding(
            found.category,
            found.symbol,
            ticker
          )
        ]);

        const oldest =
          trades[0]?.time ||
          0;

        return json({
          ok: true,

          version:
            VERSION,

          category:
            found.category,

          symbol:
            found.symbol,

          timestamp:
            now,

          price,

          ticker,

          pump:
            pump.candidate
              ? {
                  candidate:
                    true,

                  pumpPercent:
                    pump.pumpPercent,

                  candles:
                    pump.candles,

                  greenRatio:
                    pump.greenRatio,

                  volumeRatio:
                    pump.volumeRatio,

                  volumeMultiplier:
                    pump.volumeRatio,

                  score:
                    pump.score,

                  startTime:
                    pump.startTime,

                  endTime:
                    pump.endTime,

                  pumpHigh:
                    pump.pumpHigh,

                  pumpLow:
                    pump.pumpLow
                }
              : {
                  candidate:
                    false,

                  reason:
                    pump.reason,

                  pumpPercent: 0,
                  candles: 0,
                  greenRatio: 0,
                  volumeRatio: 0,
                  volumeMultiplier: 0,
                  score: 0
                },

          setup:
            setup
              ? {
                  ...setup,

                  pumpPercent:
                    pump.pumpPercent,

                  volumeMultiplier:
                    pump.volumeRatio,

                  state:
                    state.state,

                  stateReason:
                    state.reason,

                  distancePercent:
                    state.distancePercent,

                  distanceToZonePercent:
                    state.distancePercent
                }
              : {
                  redCandle:
                    null,

                  pullbackPercent:
                    0,

                  zoneLow: 0,
                  zoneHigh: 0,
                  zonePrice: 0,

                  status:
                    "INVALID",

                  reason:
                    pump.reason,

                  state:
                    "INVALID",

                  stateReason:
                    pump.reason,

                  distancePercent:
                    0,

                  distanceToZonePercent:
                    0
                },

          currentState:
            state,

          state:
            state.state,

          footprint,

          orderbook: {
            ...orderbook,

            bids:
              undefined,

            asks:
              undefined
          },

          walls: {
            buy:
              orderbook.buyWalls,

            sell:
              orderbook.sellWalls,

            buyWalls:
              orderbook.buyWalls,

            sellWalls:
              orderbook.sellWalls,

            threshold:
              orderbook.wallThreshold,

            median:
              orderbook.medianLevelNotional
          },

          openInterest:
            oi,

          funding,

          recentTrades:
            trades
              .slice(-100)
              .reverse(),

          tradeHistory: {
            windowHours:
              24,

            from:
              now -
              TRADE_HISTORY_MS,

            to:
              now,

            tradeCount:
              trades.length,

            oldestTradeTime:
              oldest,

            newestTradeTime:
              trades.at(-1)
                ?.time ||
              0,

            coverageMs:
              trades.length
                ? Math.max(
                    0,
                    now -
                      oldest
                  )
                : 0,

            coverageHours:
              trades.length
                ? Math.max(
                    0,
                    (
                      now -
                      oldest
                    ) /
                      3600000
                  )
                : 0,

            mode:
              "ACCUMULATED_24H"
          },

          diagnostics: {
            tradeCount:
              trades.length,

            recentTradeCount:
              recentTrades.length,

            oldestTradeTime:
              oldest,

            newestTradeTime:
              trades.at(-1)
                ?.time ||
              0,

            tradeCoverageMs:
              trades.length
                ? Math.max(
                    0,
                    now -
                      oldest
                  )
                : 0,

            tradeCoverageMinutes:
              trades.length
                ? Math.max(
                    0,
                    (
                      now -
                      oldest
                    ) /
                      60000
                  )
                : 0,

            tradeCoverageHours:
              trades.length
                ? Math.max(
                    0,
                    (
                      now -
                      oldest
                    ) /
                      3600000
                  )
                : 0,

            historyWindowHours:
              24,

            historyMode:
              "WORKER_ACCUMULATED_24H"
          }
        });
      }


      /* ===============================================
         ASSETS / 404
      =============================================== */

      if (
        env?.ASSETS
      ) {
        return env.ASSETS.fetch(
          request
        );
      }

      return json(
        {
          ok: false,

          error:
            "Not found"
        },
        404
      );

    } catch (error) {
      return json(
        {
          ok: false,

          version:
            VERSION,

          error:
            error?.message ||
            String(error)
        },
        500
      );
    }
  }
};
```0
