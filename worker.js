const BYBIT = "https://api.bybit.com";

const VERSION = "PUMP-SCANNER-BYBIT-PPR-V7";

const TF = "15";
const TF_MS = 15 * 60 * 1000;

const KLINE_LIMIT = 120;

const SCAN_BATCH = 20;

// =========================
// قوانین اصلی
// =========================

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

// =========================
// Runtime
// =========================

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
timestamp: 0,
results: []
};

// =========================
// Helpers
// =========================

function json(data, status = 200) {

return new Response(
JSON.stringify(data),
{
status,

  headers: {
    "content-type":
      "application/json; charset=utf-8",

    "cache-control":
      "no-store"
  }
}

);
}

function sleep(ms) {

return new Promise(
resolve => setTimeout(resolve, ms)
);
}

async function bybit(path) {

const response =
await fetch(
BYBIT + path,
{
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

if (data.retCode !== 0) {

throw new Error(
  data.retMsg ||
  "Bybit API error"
);

}

return data.result;
}

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

function clamp(
value,
min,
max
) {

return Math.max(
min,
Math.min(
max,
value
)
);
}

// =========================
// Symbols
// =========================

async function getSymbols() {

const result =
await bybit(
"/v5/market/instruments-info" +
"?category=linear" +
"&status=Trading" +
"&limit=1000"
);

const list =
Array.isArray(result.list)
? result.list
: [];

return list
.filter(
item =>
item.status === "Trading" &&
item.quoteCoin === "USDT" &&
item.contractType ===
"LinearPerpetual"
)
.map(
item => item.symbol
)
.filter(Boolean);
}

// =========================
// Klines
// =========================

async function getKlines(symbol) {

const result =
await bybit(
"/v5/market/kline" +
"?category=linear" +
"&symbol=${encodeURIComponent(symbol)}" +
"&interval=${TF}" +
"&limit=${KLINE_LIMIT}"
);

const rows =
Array.isArray(result.list)
? result.list
: [];

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
.filter(
  c =>
    Number.isFinite(c.time) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    Number.isFinite(c.volume)
)
.sort(
  (a, b) =>
    a.time - b.time
);

}

// =========================
// All tickers
// =========================

async function getAllTickers() {

const result =
await bybit(
"/v5/market/tickers" +
"?category=linear"
);

const list =
Array.isArray(result.list)
? result.list
: [];

const map =
new Map();

for (
const item of list
) {

const symbol =
  item.symbol;

if (!symbol) {
  continue;
}

map.set(
  symbol,
  {

    lastPrice:
      Number(
        item.lastPrice
      ),

    volume24h:
      Number(
        item.volume24h
      ),

    turnover24h:
      Number(
        item.turnover24h
      ),

    price24hPcnt:
      Number(
        item.price24hPcnt
      ) * 100

  }
);

}

return map;
}

// =========================
// Closed candles
// =========================

function getClosedCandles(
candles
) {

const now =
Date.now();

return candles.filter(
candle =>
candle.time + TF_MS <= now
);
}

// =========================
// Pump sequence detection
// =========================

function detectPumpSequences(
candles
) {

const pumps = [];

if (
candles.length < 30
) {
return pumps;
}

const lastClosedIndex =
candles.length - 1;

const minimumTime =
Date.now() -
MAX_PUMP_AGE_MS -
TF_MS;

for (
let end = 1;
end <= lastClosedIndex;
end++
) {

const endCandle =
  candles[end];

const endTime =
  endCandle.time +
  TF_MS;

if (
  endTime < minimumTime
) {
  continue;
}

for (
  let length =
    MIN_PUMP_CANDLES;

  length <=
    MAX_PUMP_CANDLES;

  length++
) {

  const start =
    end - length + 1;

  if (
    start < 10
  ) {
    continue;
  }

  const sequence =
    candles.slice(
      start,
      end + 1
    );

  if (
    sequence.length !==
    length
  ) {
    continue;
  }

  const first =
    sequence[0];

  const last =
    sequence[
      sequence.length - 1
    ];

  const basePrice =
    first.open;

  if (
    !Number.isFinite(
      basePrice
    ) ||
    basePrice <= 0
  ) {
    continue;
  }

  const endPrice =
    last.close;

  const pumpPercent =
    percent(
      endPrice,
      basePrice
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

  const high =
    Math.max(
      ...sequence.map(
        c => c.high
      )
    );

  const low =
    Math.min(
      ...sequence.map(
        c => c.low
      )
    );

  const rangePercent =
    percent(
      high,
      low
    );

  const beforeStart =
    Math.max(
      0,
      start - 12
    );

  const beforeEnd =
    start;

  const beforeCandles =
    candles.slice(
      beforeStart,
      beforeEnd
    );

  if (
    beforeCandles.length < 6
  ) {
    continue;
  }

  const baselineVolume =
    average(
      beforeCandles.map(
        c => c.volume
      )
    );

  if (
    baselineVolume <= 0
  ) {
    continue;
  }

  const pumpVolume =
    average(
      sequence.map(
        c => c.volume
      )
    );

  const volumeRatio =
    pumpVolume /
    baselineVolume;

  if (
    volumeRatio <
    MIN_VOLUME_MULTIPLIER
  ) {
    continue;
  }

  let structuralBreak =
    false;

  for (
    let j = 1;
    j < sequence.length;
    j++
  ) {

    const previous =
      sequence[j - 1];

    const current =
      sequence[j];

    const drop =
      percent(
        current.close,
        previous.close
      );

    if (
      drop < -3.5
    ) {

      structuralBreak =
        true;

      break;
    }
  }

  if (
    structuralBreak
  ) {
    continue;
  }

  const pumpScore =
    clamp(
      pumpPercent * 5,
      0,
      40
    );

  const volumeScore =
    clamp(
      (volumeRatio - 1) * 15,
      0,
      25
    );

  const greenScore =
    clamp(
      greenRatio * 25,
      0,
      25
    );

  const candleScore =
    clamp(
      sequence.length * 2,
      0,
      10
    );

  const score =
    clamp(
      pumpScore +
      volumeScore +
      greenScore +
      candleScore,
      0,
      100
    );

  pumps.push({

    startIndex:
      start,

    endIndex:
      end,

    startTime:
      first.time,

    endTime,

    basePrice,

    price:
      endPrice,

    high,

    low,

    percent:
      Number(
        pumpPercent.toFixed(4)
      ),

    rangePercent:
      Number(
        rangePercent.toFixed(4)
      ),

    candles:
      sequence.length,

    greenRatio:
      Number(
        greenRatio.toFixed(4)
      ),

    volumeRatio:
      Number(
        volumeRatio.toFixed(4)
      ),

    score:
      Number(
        score.toFixed(2)
      )

  });
}

}

return pumps;
}

// =========================
// انتخاب بهترین پامپ
// =========================

function selectBestPump(
pumps
) {

if (!pumps.length) {
return null;
}

pumps.sort(
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

  if (
    b.score !==
    a.score
  ) {

    return (
      b.score -
      a.score
    );
  }

  return (
    b.percent -
    a.percent
  );
}

);

return pumps[0];
}

// =========================
// RED CANDLE
// =========================

function findPullbackCandle(
candles,
pump
) {

const start =
pump.endIndex + 1;

const end =
Math.min(
candles.length - 1,
start + 12
);

for (
let i = start;
i <= end;
i++
) {

const candle =
  candles[i];

if (
  candle.close >=
  candle.open
) {
  continue;
}

const bodyPercent =
  Math.abs(
    percent(
      candle.close,
      candle.open
    )
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
  Math.max(
    0,
    percent(
      pump.price,
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

  index:
    i,

  time:
    candle.time,

  open:
    candle.open,

  high:
    candle.high,

  low:
    candle.low,

  close:
    candle.close,

  bodyPercent:
    Number(
      bodyPercent.toFixed(4)
    ),

  retracePercent:
    Number(
      retracePercent.toFixed(4)
    ),

  zoneLow,

  zoneHigh
};

}

return null;
}

// =========================
// وضعیت فعلی
// =========================

function calculateState(
currentPrice,
pump,
pullback
) {

const zoneLow =
pullback.zoneLow;

const zoneHigh =
pullback.zoneHigh;

if (
currentPrice <
pump.basePrice
) {

return {

  state:
    "INVALID",

  distancePercent:
    Number(
      Math.abs(
        percent(
          currentPrice,
          zoneLow
        )
      ).toFixed(4)
    )

};

}

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

if (
currentPrice >
zoneHigh
) {

const distancePercent =
  percent(
    currentPrice,
    zoneHigh
  );

if (
  distancePercent <=
  NEAR_ZONE_PERCENT
) {

  return {

    state:
      "NEAR",

    distancePercent:
      Number(
        distancePercent.toFixed(4)
      )

  };
}

return {

  state:
    "APPROACHING",

  distancePercent:
    Number(
      distancePercent.toFixed(4)
    )

};

}

return {

state:
  "BELOW_ZONE",

distancePercent:
  Number(
    Math.abs(
      percent(
        currentPrice,
        zoneLow
      )
    ).toFixed(4)
  )

};
}

// =========================
// ساخت Setup
// =========================

function buildSetup(
symbol,
candles,
pump,
pullback,
ticker
) {

let currentPrice =
ticker &&
Number.isFinite(
ticker.lastPrice
)
? ticker.lastPrice
: candles[
candles.length - 1
].close;

if (
!Number.isFinite(
currentPrice
) ||
currentPrice <= 0
) {
return null;
}

const status =
calculateState(
currentPrice,
pump,
pullback
);

const id =
"${symbol}-" +
"${pump.startIndex}-" +
"${pump.endIndex}-" +
"${pullback.index}";

return {

id,

symbol,

timeframe:
  "15m",

state:
  status.state,

currentPrice,

distancePercent:
  status.distancePercent,

pump: {

  startTime:
    pump.startTime,

  endTime:
    pump.endTime,

  basePrice:
    pump.basePrice,

  price:
    pump.price,

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

  retracePercent:
    pullback.retracePercent,

  zoneLow:
    pullback.zoneLow,

  zoneHigh:
    pullback.zoneHigh

},

detectedAt:
  Date.now()

};
}

// =========================
// تحلیل یک ارز
// =========================

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
30
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

pumps.sort(
(a, b) =>
b.endTime -
a.endTime
);

for (
const pump of pumps
) {

if (
  now - pump.endTime >
  MAX_PUMP_AGE_MS
) {
  continue;
}

const pullback =
  findPullbackCandle(
    closedCandles,
    pump
  );

if (!pullback) {
  continue;
}

const setup =
  buildSetup(
    symbol,
    closedCandles,
    pump,
    pullback,
    tickerMap
      ? tickerMap.get(symbol)
      : null
  );

if (!setup) {
  continue;
}

if (
  setup.state ===
  "INVALID"
) {
  continue;
}

return setup;

}

return null;
}

// =========================
// Scan Market
// =========================

async function scanMarket() {

const startedAt =
Date.now();

const symbols =
await getSymbols();

const tickerMap =
await getAllTickers();

const results = [];

let candidates = 0;

const validSymbols =
symbols.filter(
symbol =>
tickerMap.has(symbol)
);

for (
let i = 0;
i < validSymbols.length;
i += SCAN_BATCH
) {

const batch =
  validSymbols.slice(
    i,
    i + SCAN_BATCH
  );

const analyzed =
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
            30
          ) {
            return null;
          }

          const pumps =
            detectPumpSequences(
              closedCandles
            );

          if (
            !pumps.length
          ) {
            return null;
          }

          candidates++;

          pumps.sort(
            (a, b) =>
              b.endTime -
              a.endTime
          );

          const now =
            Date.now();

          for (
            const pump of pumps
          ) {

            if (
              now - pump.endTime >
              MAX_PUMP_AGE_MS
            ) {
              continue;
            }

            const pullback =
              findPullbackCandle(
                closedCandles,
                pump
              );

            if (
              !pullback
            ) {
              continue;
            }

            const setup =
              buildSetup(
                symbol,
                closedCandles,
                pump,
                pullback,
                tickerMap
              );

            if (!setup) {
              continue;
            }

            if (
              setup.state ===
              "INVALID"
            ) {
              continue;
            }

            return setup;
          }

          return null;

        } catch (
          error
        ) {

          return null;
        }
      }
    )
  );

for (
  const item of analyzed
) {

  if (item) {
    results.push(item);
  }
}

if (
  i + SCAN_BATCH <
  validSymbols.length
) {

  await sleep(80);
}

}

// =========================
// مرتب‌سازی
// =========================

const stateOrder = {

REACHED: 0,

NEAR: 1,

APPROACHING: 2,

BELOW_ZONE: 3

};

results.sort(
(a, b) => {

  const sa =
    stateOrder[a.state] ??
    99;

  const sb =
    stateOrder[b.state] ??
    99;

  if (
    sa !== sb
  ) {

    return sa - sb;
  }

  return (
    b.pump.score -
    a.pump.score
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

const invalid =
results.filter(
x =>
x.state ===
"INVALID"
).length;

lastScan = {

ok:
  true,

version:
  VERSION,

source:
  "Bybit",

timeframe:
  "15m",

mode:
  "PUMP → RED CANDLE → PULLBACK ZONE → RETEST",

scannedSymbols:
  validSymbols.length,

candidates,

setups:
  results.length,

signals,

near,

approaching,

invalid,

timestamp:
  Date.now(),

durationMs:
  Date.now() -
  startedAt,

results

};

return lastScan;
}

// =========================
// Health
// =========================

function health() {

return {

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
    MAX_PUMP_AGE_HOURS

},

timestamp:
  Date.now()

};
}

// =========================
// Analyze endpoint
// =========================

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
    ok:
      false,

    error:
      "symbol is required"

  },
  400
);

}

symbol =
symbol
.toUpperCase()
.replace(
/[^A-Z0-9]/g,
""
);

try {

const tickerMap =
  await getAllTickers();

const result =
  await analyzeSymbol(
    symbol,
    tickerMap
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

  symbol,

  result

});

} catch (
error
) {

return json(
  {

    ok:
      false,

    error:
      error.message ||
      "Analyze failed"

  },
  500
);

}
}

// =========================
// CORS
// =========================

function withCors(
response
) {

const headers =
new Headers(
response.headers
);

headers.set(
"access-control-allow-origin",
"*"
);

headers.set(
"access-control-allow-methods",
"GET,OPTIONS"
);

headers.set(
"access-control-allow-headers",
"Content-Type"
);

return new Response(
response.body,
{
status:
response.status,

  headers
}

);
}

// =========================
// Worker
// =========================

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

  // =====================
  // HEALTH
  // =====================

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


  // =====================
  // SCAN
  // =====================

  if (
    path === "/scan" ||
    path === "/api/scan"
  ) {

    const result =
      await scanMarket();

    return withCors(
      json(result)
    );
  }


  // =====================
  // RESULTS
  // =====================

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


  // =====================
  // ANALYZE
  // =====================

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


  // =====================
  // WEBSITE / ASSETS
  // =====================

  if (
    env &&
    env.ASSETS
  ) {

    /*
     * مسیر اصلی سایت
     */
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


    /*
     * فایل‌های استاتیک:
     * CSS / JS / تصاویر / index.html
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


  // =====================
  // 404
  // =====================

  return withCors(
    json(
      {

        ok:
          false,

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

        ok:
          false,

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
