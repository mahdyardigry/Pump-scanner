const BYBIT = "https://api.bybit.com";

const SCAN_BATCH = 20;
const DEEP_LIMIT = 3;
const RADAR_LIMIT = 8;
const DEEP_1M_LIMIT = 1300;

const MIN_SIGNAL_SCORE = 75;
const WATCH_SCORE = 60;

const DEFAULT_STRICTNESS = 50;

const DEFAULT_METHODS = [
  "MA","MACD","RSI","ICHIMOKU","DIVERGENCE",
  "SMC","ICT","HUNT","FVG","BOS_CHOCH",
  "ORDER_BLOCK","VOLUME","FOOTPRINT","ORDERBOOK"
];

const CONVERTED_MAS = [
  {source:"1m", ma:20, period:20},
  {source:"3m", ma:7, period:21},
  {source:"3m", ma:20, period:60},
  {source:"5m", ma:7, period:35},
  {source:"5m", ma:20, period:100},
  {source:"15m", ma:7, period:105},
  {source:"15m", ma:20, period:300},
  {source:"1h", ma:7, period:420},
  {source:"1h", ma:20, period:1200}
];

const TF = [
  {key:"1", label:"1 دقیقه", interval:"1", priority:"MA20"},
  {key:"3", label:"3 دقیقه", interval:"3", priority:"MA7/20"},
  {key:"5", label:"5 دقیقه", interval:"5", priority:"MA7/20"},
  {key:"15", label:"15 دقیقه", interval:"15", priority:"MA7/20"},
  {key:"60", label:"1 ساعت", interval:"60", priority:"MA7/20"}
];

const json = (data,status=200) =>
  new Response(JSON.stringify(data),{
    status,
    headers:{
      "content-type":"application/json; charset=UTF-8",
      "cache-control":"no-store",
      "access-control-allow-origin":"*",
      "access-control-allow-methods":"GET,HEAD,OPTIONS",
      "access-control-allow-headers":"Content-Type,Authorization"
    }
  });

const n=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;

function pct(a,b){
  return !b?0:(a-b)/b*100;
}

function absPct(a,b){
  return !b?999:Math.abs((a-b)/b)*100;
}

async function bybit(path,params={}){
  const u=new URL(BYBIT+path);

  for(const [k,v] of Object.entries(params)){
    if(v!==undefined&&v!==null){
      u.searchParams.set(k,String(v));
    }
  }

  const r=await fetch(u,{
    headers:{
      accept:"application/json"
    }
  });

  if(!r.ok){
    throw new Error(`Bybit HTTP ${r.status}`);
  }

  const d=await r.json();

  if(d.retCode!==0){
    throw new Error(d.retMsg||`Bybit ${d.retCode}`);
  }

  return d;
}

async function klines(category,symbol,interval,limit=100){
  const d=
    await bybit(
      "/v5/market/kline",
      {
        category,
        symbol,
        interval,
        limit
      }
    );

  return (d?.result?.list||[])
    .reverse()
    .map(k=>({
      time:n(k[0]),
      open:n(k[1]),
      high:n(k[2]),
      low:n(k[3]),
      close:n(k[4]),
      volume:n(k[5]),
      turnover:n(k[6])
    }));
}

function sma(a,p){
  if(!a.length)return 0;
  return a.length<p?avg(a):avg(a.slice(-p));
}

function ema(a,p){
  if(!a.length)return 0;

  const k=2/(p+1);
  let x=a[0];

  for(let i=1;i<a.length;i++){
    x=a[i]*k+x*(1-k);
  }

  return x;
}

function atr(c,p=14){
  if(c.length<2)return 0;

  const tr=c.slice(1).map((x,i)=>{
    const prev=c[i].close;

    return Math.max(
      x.high-x.low,
      Math.abs(x.high-prev),
      Math.abs(x.low-prev)
    );
  });

  return sma(tr,p);
}

function adx(c,p=14){
  if(c.length<p*2+1)return 0;

  const trs=[];
  const plus=[];
  const minus=[];

  for(let i=1;i<c.length;i++){
    const x=c[i];
    const q=c[i-1];

    trs.push(
      Math.max(
        x.high-x.low,
        Math.abs(x.high-q.close),
        Math.abs(x.low-q.close)
      )
    );

    const up=x.high-q.high;
    const dn=q.low-x.low;

    plus.push(
      up>dn&&up>0?up:0
    );

    minus.push(
      dn>up&&dn>0?dn:0
    );
  }

  const out=[];

  for(let i=p;i<trs.length;i++){
    const tr=avg(trs.slice(i-p,i))||1;

    const diP=
      100*avg(plus.slice(i-p,i))/tr;

    const diM=
      100*avg(minus.slice(i-p,i))/tr;

    out.push(
      (diP+diM)
        ?100*Math.abs(diP-diM)/(diP+diM)
        :0
    );
  }

  return avg(out.slice(-p));
}

function bollWidth(c,p=20){
  const a=c.slice(-p).map(x=>x.close);

  if(!a.length)return 0;

  const m=avg(a);

  const sd=Math.sqrt(
    avg(a.map(x=>(x-m)**2))
  );

  return m?(4*sd/m)*100:0;
}

function rangeState(c,ma7,ma20,slope,volSpike){
  if(!c.length){
    return {
      state:"UNKNOWN",
      adx:0,
      atr:0,
      atrPct:0,
      bollWidth:0,
      maGap:0
    };
  }

  const price=c.at(-1).close;
  const a=atr(c);
  const atrPct=price?a/price*100:0;
  const adxV=adx(c);
  const bw=bollWidth(c);
  const maGap=ma20
    ?Math.abs(ma7-ma20)/ma20*100
    :0;

  const isRange=
    adxV<18&&
    bw<1.8&&
    Math.abs(slope)<0.0007;

  const waking=
    !isRange&&
    (
      adxV>=18||
      bw>=1.8||
      volSpike
    );

  return {
    state:
      isRange
        ?"RANGE"
        :waking
          ?"ACTIVE"
          :"TRANSITION",
    adx:adxV,
    atr:a,
    atrPct,
    bollWidth:bw,
    maGap
  };
}

function swingLevels(c,lookback=3){
  const highs=[];
  const lows=[];

  for(
    let i=lookback;
    i<c.length-lookback;
    i++
  ){
    let high=true;
    let low=true;

    for(let j=1;j<=lookback;j++){
      if(
        c[i].high<=c[i-j].high||
        c[i].high<c[i+j].high
      ){
        high=false;
      }

      if(
        c[i].low>=c[i-j].low||
        c[i].low>c[i+j].low
      ){
        low=false;
      }
    }

    if(high){
      highs.push({
        price:c[i].high,
        time:c[i].time,
        index:i
      });
    }

    if(low){
      lows.push({
        price:c[i].low,
        time:c[i].time,
        index:i
      });
    }
  }

  return {
    highs,
    lows
  };
}

function hunt(c){
  if(c.length<25){
    return {
      type:"NONE",
      side:"NONE",
      confirmed:false
    };
  }

  const x=c.at(-1);
  const prev=c.slice(-21,-1);

  const hi=Math.max(
    ...prev.map(z=>z.high)
  );

  const lo=Math.min(
    ...prev.map(z=>z.low)
  );

  const range=x.high-x.low||1;

  const lower=
    Math.min(x.open,x.close)-x.low;

  const upper=
    x.high-Math.max(x.open,x.close);

  const volAvg=
    sma(
      prev.map(z=>z.volume),
      20
    );

  const volumeConfirm=
    volAvg>0&&
    x.volume>=volAvg*1.15;

  const longSweep=
    x.low<lo&&
    x.close>lo&&
    lower/range>=.25;

  const shortSweep=
    x.high>hi&&
    x.close<hi&&
    upper/range>=.25;

  if(longSweep){
    return {
      type:"LIQUIDITY_SWEEP",
      side:"LONG",
      level:lo,
      wickPct:lower/range*100,
      volumeConfirmed:volumeConfirm,
      confirmed:
        volumeConfirm||
        lower/range>=.4
    };
  }

  if(shortSweep){
    return {
      type:"LIQUIDITY_SWEEP",
      side:"SHORT",
      level:hi,
      wickPct:upper/range*100,
      volumeConfirmed:volumeConfirm,
      confirmed:
        volumeConfirm||
        upper/range>=.4
    };
  }

  return {
    type:"NONE",
    side:"NONE",
    confirmed:false
  };
}

function detectFVG(c){
  if(c.length<3){
    return {
      type:"NONE",
      low:null,
      high:null
    };
  }

  const a=c.at(-3);
  const b=c.at(-2);
  const x=c.at(-1);

  if(x.low>a.high){
    return {
      type:"BULLISH",
      low:a.high,
      high:x.low,
      size:x.low-a.high,
      candle:b.time
    };
  }

  if(x.high<a.low){
    return {
      type:"BEARISH",
      low:x.high,
      high:a.low,
      size:a.low-x.high,
      candle:b.time
    };
  }

  return {
    type:"NONE",
    low:null,
    high:null
  };
}

function detectStructure(c){
  if(c.length<15){
    return {
      bos:"NONE",
      choch:"NONE",
      swingHigh:null,
      swingLow:null
    };
  }

  const s=swingLevels(c,2);
  const highs=s.highs;
  const lows=s.lows;

  const lastHigh=
    highs.length
      ?highs.at(-1).price
      :null;

  const prevHigh=
    highs.length>1
      ?highs.at(-2).price
      :null;

  const lastLow=
    lows.length
      ?lows.at(-1).price
      :null;

  const prevLow=
    lows.length>1
      ?lows.at(-2).price
      :null;

  const price=c.at(-1).close;

  let bos="NONE";
  let choch="NONE";

  if(lastHigh&&price>lastHigh){
    bos="BULLISH";
  }

  if(lastLow&&price<lastLow){
    bos="BEARISH";
  }

  if(
    prevHigh&&
    prevLow&&
    lastLow&&
    lastHigh&&
    lastLow>prevLow&&
    lastHigh>prevHigh&&
    price<lastLow
  ){
    choch="BEARISH";
  }

  if(
    prevHigh&&
    prevLow&&
    lastLow&&
    lastHigh&&
    lastLow<prevLow&&
    lastHigh<prevHigh&&
    price>lastHigh
  ){
    choch="BULLISH";
  }

  return {
    bos,
    choch,
    swingHigh:lastHigh,
    swingLow:lastLow,
    previousSwingHigh:prevHigh,
    previousSwingLow:prevLow
  };
}

function detectOrderBlock(c){
  if(c.length<8){
    return {
      type:"NONE"
    };
  }

  const x=c.at(-1);

  for(
    let i=c.length-4;
    i>=Math.max(0,c.length-12);
    i--
  ){
    const z=c[i];

    if(
      z.close<z.open&&
      x.close>z.high
    ){
      return {
        type:"BULLISH",
        low:z.low,
        high:z.high,
        time:z.time
      };
    }

    if(
      z.close>z.open&&
      x.close<z.low
    ){
      return {
        type:"BEARISH",
        low:z.low,
        high:z.high,
        time:z.time
      };
    }
  }

  return {
    type:"NONE"
  };
}

function candleAnalysis(c){
  if(c.length<3){
    return {
      type:"NONE",
      bullish:false,
      bearish:false
    };
  }

  const x=c.at(-1);
  const p=c.at(-2);

  const body=
    Math.abs(x.close-x.open);

  const range=
    x.high-x.low||1;

  const upper=
    x.high-Math.max(x.open,x.close);

  const lower=
    Math.min(x.open,x.close)-x.low;

  const bodyRatio=
    body/range;

  let type="NORMAL";

  if(
    lower>body*2&&
    lower/range>.45
  ){
    type="HAMMER";
  }

  if(
    upper>body*2&&
    upper/range>.45
  ){
    type="SHOOTING_STAR";
  }

  if(
    x.close>p.open&&
    x.open<p.close&&
    x.close>=p.close&&
    x.open<=p.open
  ){
    type="BULLISH_ENGULFING";
  }

  if(
    x.close<p.open&&
    x.open>p.close&&
    x.close<=p.close&&
    x.open>=p.open
  ){
    type="BEARISH_ENGULFING";
  }

  if(bodyRatio<.15){
    type="DOJI";
  }

  return {
    type,
    bullish:x.close>x.open,
    bearish:x.close<x.open,
    body,
    range,
    bodyRatio,
    upperWick:upper,
    lowerWick:lower
  };
}

function analyzeCandles(c){
  if(c.length<25){
    return {
      error:"کندل کافی نیست"
    };
  }

  const close=c.map(x=>x.close);
  const vol=c.map(x=>x.volume);
  const price=close.at(-1);

  const ma7=sma(close,7);
  const ma20=sma(close,20);
  const prev20=sma(close.slice(0,-1),20);

  const slope=
    prev20
      ?(ma20-prev20)/prev20
      :0;

  const prevPrice=close.at(-2);

  const high=c.at(-1).high;
  const low=c.at(-1).low;

  const touch20=
    Math.abs(price-ma20)/ma20<=.0015||
    low<=ma20&&high>=ma20||
    (prevPrice-ma20)*(price-ma20)<=0;

  const touch7=
    Math.abs(price-ma7)/ma7<=.0015||
    low<=ma7&&high>=ma7||
    (prevPrice-ma7)*(price-ma7)<=0;

  const vol7=sma(vol,7);
  const vol20=sma(vol,20);

  const spike=
    vol.at(-1)>vol20*1.5||
    vol.at(-1)>vol7*1.8;

  const market=
    rangeState(
      c,
      ma7,
      ma20,
      slope,
      spike
    );

  const trend=
    price>ma20&&ma7>ma20
      ?"BULLISH"
      :price<ma20&&ma7<ma20
        ?"BEARISH"
        :"RANGE";

  return {
    price,
    ma7,
    ma20,
    maSlope:
      slope>.00007
        ?"UP"
        :slope<-.00007
          ?"DOWN"
          :"FLAT",
    slopePct:slope*100,
    touchMA20:touch20,
    touchMA7:touch7,
    trend,
    volume:{
      current:vol.at(-1),
      ma7:vol7,
      ma20:vol20,
      spike,
      ratio20:
        vol20
          ?vol.at(-1)/vol20
          :0
    },
    market,
    hunt:hunt(c),
    candle:candleAnalysis(c).type,
    candleDetails:candleAnalysis(c),
    fvg:detectFVG(c),
    ...detectStructure(c),
    orderBlock:detectOrderBlock(c),
    timestamp:c.at(-1).time
  };
}

function maValueSeries(c,p,type="SMA"){
  const out=[];

  for(let i=0;i<c.length;i++){
    const a=
      c.slice(
        Math.max(0,i-p+1),
        i+1
      ).map(x=>x.close);

    out.push(
      a.length>=p
        ?(
          type==="EMA"
            ?ema(a,p)
            :avg(a)
        )
        :null
    );
  }

  return out;
}

function convertedMAEvents(c){
  const price=c.at(-1)?.close||0;
  const prev=c.at(-2)?.close||price;
  const events=[];

  for(const m of CONVERTED_MAS){
    const vals=
      maValueSeries(
        c,
        m.period,
        "SMA"
      );

    const ma=vals.at(-1);
    const prevMA=vals.at(-2);

    if(!ma||!prevMA)continue;

    const slopePct=
      (ma-prevMA)/prevMA*100;

    const prevDist=
      prev-prevMA;

    const dist=
      price-ma;

    const candle=c.at(-1);

    const range=
      candle.high-candle.low||1;

    const lower=
      Math.min(
        candle.open,
        candle.close
      )-candle.low;

    const upper=
      candle.high-
      Math.max(
        candle.open,
        candle.close
      );

    const touch=
      Math.abs(dist)/ma<=.0015||
      candle.low<=ma&&candle.high>=ma||
      prevDist*dist<=0;

    const crossUp=
      prev<=prevMA&&
      price>ma;

    const crossDown=
      prev>=prevMA&&
      price<ma;

    const bullishRejection=
      candle.low<=ma&&
      candle.close>ma&&
      candle.close>candle.open&&
      lower/range>=.25;

    const bearishRejection=
      candle.high>=ma&&
      candle.close<ma&&
      candle.close<candle.open&&
      upper/range>=.25;

    const rejection=
      bullishRejection||
      bearishRejection;

    const slope=
      Math.abs(slopePct)<.003
        ?"FLAT"
        :slopePct>0
          ?"UP"
          :"DOWN";

    const direction=
      bullishRejection||crossUp
        ?"LONG"
        :bearishRejection||crossDown
          ?"SHORT"
          :"NONE";

    const volumeAvg=
      sma(
        c.slice(-21,-1).map(x=>x.volume),
        20
      );

    const volumeConfirm=
      volumeAvg>0&&
      candle.volume>=volumeAvg*1.15;

    const trendConfirm=
      direction==="LONG"
        ?price>ma
        :direction==="SHORT"
          ?price<ma
          :false;

    const notFlat=
      slope!=="FLAT";

    const strictConfirmation=
      touch&&
      rejection&&
      notFlat&&
      trendConfirm&&
      volumeConfirm;

    const crossConfirmation=
      touch&&
      notFlat&&
      trendConfirm&&
      (crossUp||crossDown)&&
      volumeConfirm;

    const confirmation=
      direction==="LONG"&&
      (
        strictConfirmation||
        crossConfirmation
      )
        ?"CONFIRMED_LONG"
        :direction==="SHORT"&&
          (
            strictConfirmation||
            crossConfirmation
          )
          ?"CONFIRMED_SHORT"
          :"WAIT";

    const type=
      touch
        ?(
          rejection
            ?"REJECTION"
            :(crossUp||crossDown)
              ?"BREAK"
              :"TOUCH"
        )
        :"NONE";

    events.push({
      source:m.source,
      ma:`MA${m.ma}`,
      period1m:m.period,
      time:candle.time,
      price,
      maValue:ma,
      type,
      direction,
      rejection,
      bullishRejection,
      bearishRejection,
      crossUp,
      crossDown,
      slope,
      slopePct,
      volumeConfirmed:volumeConfirm,
      confirmation,
      distancePct:
        (price-ma)/ma*100
    });
  }

  const recent=
    events.filter(
      x=>x.type!=="NONE"
    );

  return {
    events,
    recent,
    confirmed:
      events.filter(
        x=>x.confirmation.startsWith("CONFIRMED_")
      ),
    latest:
      recent.at(-1)||null
  };
}

function rsi(c,p=14){
  if(c.length<p+1)return 50;

  let gain=0;
  let loss=0;

  for(let i=1;i<=p;i++){
    const d=
      c[i].close-c[i-1].close;

    if(d>=0)gain+=d;
    else loss-=d;
  }

  let avgGain=gain/p;
  let avgLoss=loss/p;

  for(let i=p+1;i<c.length;i++){
    const d=
      c[i].close-c[i-1].close;

    const g=d>0?d:0;
    const l=d<0?-d:0;

    avgGain=
      (avgGain*(p-1)+g)/p;

    avgLoss=
      (avgLoss*(p-1)+l)/p;
  }

  if(avgLoss===0)return 100;

  const rs=avgGain/avgLoss;

  return 100-(100/(1+rs));
}

function macd(c,fast=12,slow=26,signalPeriod=9){
  if(c.length<slow+signalPeriod){
    return {
      value:null,
      signal:null,
      histogram:null,
      direction:"NONE"
    };
  }

  const close=c.map(x=>x.close);

  const fastSeries=[];
  const slowSeries=[];

  for(let i=0;i<close.length;i++){
    const a=close.slice(0,i+1);

    fastSeries.push(
      a.length>=fast
        ?ema(a,fast)
        :null
    );

    slowSeries.push(
      a.length>=slow
        ?ema(a,slow)
        :null
    );
  }

  const macdSeries=[];

  for(let i=0;i<close.length;i++){
    if(
      fastSeries[i]!==null&&
      slowSeries[i]!==null
    ){
      macdSeries.push(
        fastSeries[i]-slowSeries[i]
      );
    }
  }

  const value=macdSeries.at(-1);

  const signal=
    macdSeries.length>=signalPeriod
      ?ema(macdSeries,signalPeriod)
      :null;

  const histogram=
    signal!==null
      ?value-signal
      :null;

  return {
    value,
    signal,
    histogram,
    direction:
      histogram>0
        ?"LONG"
        :histogram<0
          ?"SHORT"
          :"NONE"
  };
}

function ichimoku(c){
  if(c.length<52){
    return {
      available:false,
      direction:"NONE"
    };
  }

  const highLow=(period)=>{
    const a=c.slice(-period);

    return {
      high:Math.max(...a.map(x=>x.high)),
      low:Math.min(...a.map(x=>x.low))
    };
  };

  const a9=highLow(9);
  const a26=highLow(26);
  const a52=highLow(52);

  const conversion=
    (a9.high+a9.low)/2;

  const base=
    (a26.high+a26.low)/2;

  const spanA=
    (conversion+base)/2;

  const spanB=
    (a52.high+a52.low)/2;

  const price=c.at(-1).close;

  let direction="NONE";

  if(
    price>spanA&&
    price>spanB&&
    conversion>base
  ){
    direction="LONG";
  }

  if(
    price<spanA&&
    price<spanB&&
    conversion<base
  ){
    direction="SHORT";
  }

  return {
    available:true,
    conversion,
    base,
    spanA,
    spanB,
    price,
    direction
  };
}

function divergence(c){
  if(c.length<40){
    return {
      type:"NONE",
      side:"NONE"
    };
  }

  const price=c.at(-1).close;
  const r=rsi(c);

  const old=
    c.slice(-20,-5);

  const oldPrice=
    old.length
      ?old.at(-1).close
      :price;

  const oldR=
    rsi(c.slice(0,-15));

  if(
    price<oldPrice&&
    r>oldR+3
  ){
    return {
      type:"BULLISH_DIVERGENCE",
      side:"LONG"
    };
  }

  if(
    price>oldPrice&&
    r<oldR-3
  ){
    return {
      type:"BEARISH_DIVERGENCE",
      side:"SHORT"
    };
  }

  return {
    type:"NONE",
    side:"NONE"
  };
}

function extraSignals(c){
  const m=macd(c);
  const rs=rsi(c);
  const ic=ichimoku(c);
  const dv=divergence(c);

  return {
    MACD:m,
    RSI:{
      value:rs,
      direction:
        rs>55
          ?"LONG"
          :rs<45
            ?"SHORT"
            :"NONE"
    },
    ICHIMOKU:ic,
    DIVERGENCE:dv
  };
}

function normalizeMethods(methods){
  if(!Array.isArray(methods)){
    return DEFAULT_METHODS.slice();
  }

  const allowed=
    new Set(DEFAULT_METHODS);

  const out=
    methods
      .map(x=>String(x).trim().toUpperCase())
      .filter(x=>allowed.has(x));

  return out.length
    ?[...new Set(out)]
    :DEFAULT_METHODS.slice();
}

function signalScore(
  tf,
  converted,
  extra,
  fp,
  wall,
  strictness,
  methods
){
  let L=0;
  let S=0;

  const evidence=[];

  const add=(side,score,text)=>{
    if(side==="LONG"){
      L+=score;
    }

    if(side==="SHORT"){
      S+=score;
    }

    evidence.push({
      side,
      score,
      text
    });
  };

  const active=
    new Set(
      normalizeMethods(methods)
    );

  const t1=tf?.["1"];
  const t15=tf?.["15"];

  if(active.has("MA")){
    if(t1?.maSlope==="UP"){
      add("LONG",10,"MA شیب صعودی");
    }

    if(t1?.maSlope==="DOWN"){
      add("SHORT",10,"MA شیب نزولی");
    }

    if(t1?.price>t1?.ma20){
      add("LONG",7,"قیمت بالای MA20");
    }

    if(t1?.price<t1?.ma20){
      add("SHORT",7,"قیمت زیر MA20");
    }
  }

  if(active.has("MACD")){
    if(extra?.MACD?.direction==="LONG"){
      add("LONG",10,"MACD صعودی");
    }

    if(extra?.MACD?.direction==="SHORT"){
      add("SHORT",10,"MACD نزولی");
    }
  }

  if(active.has("RSI")){
    if(extra?.RSI?.direction==="LONG"){
      add("LONG",6,"RSI متمایل به خرید");
    }

    if(extra?.RSI?.direction==="SHORT"){
      add("SHORT",6,"RSI متمایل به فروش");
    }
  }

  if(active.has("ICHIMOKU")){
    if(extra?.ICHIMOKU?.direction==="LONG"){
      add("LONG",8,"Ichimoku صعودی");
    }

    if(extra?.ICHIMOKU?.direction==="SHORT"){
      add("SHORT",8,"Ichimoku نزولی");
    }
  }

  if(active.has("DIVERGENCE")){
    if(extra?.DIVERGENCE?.side==="LONG"){
      add("LONG",12,"واگرایی مثبت");
    }

    if(extra?.DIVERGENCE?.side==="SHORT"){
      add("SHORT",12,"واگرایی منفی");
    }
  }

  if(active.has("HUNT")){
    if(t1?.hunt?.confirmed&&t1.hunt.side==="LONG"){
      add("LONG",10,"Liquidity Sweep خرید");
    }

    if(t1?.hunt?.confirmed&&t1.hunt.side==="SHORT"){
      add("SHORT",10,"Liquidity Sweep فروش");
    }
  }

  if(active.has("FVG")){
    if(t1?.fvg?.type==="BULLISH"){
      add("LONG",6,"FVG صعودی");
    }

    if(t1?.fvg?.type==="BEARISH"){
      add("SHORT",6,"FVG نزولی");
    }
  }

  if(active.has("BOS_CHOCH")){
    if(t1?.bos==="BULLISH"){
      add("LONG",8,"BOS صعودی");
    }

    if(t1?.bos==="BEARISH"){
      add("SHORT",8,"BOS نزولی");
    }

    if(t1?.choch==="BULLISH"){
      add("LONG",10,"CHoCH صعودی");
    }

    if(t1?.choch==="BEARISH"){
      add("SHORT",10,"CHoCH نزولی");
    }

    if(t15?.bos==="BULLISH"){
      add("LONG",6,"تأیید ساختار 15 دقیقه صعودی");
    }

    if(t15?.bos==="BEARISH"){
      add("SHORT",6,"تأیید ساختار 15 دقیقه نزولی");
    }
  }

  if(active.has("ORDER_BLOCK")){
    if(t1?.orderBlock?.type==="BULLISH"){
      add("LONG",6,"Order Block صعودی");
    }

    if(t1?.orderBlock?.type==="BEARISH"){
      add("SHORT",6,"Order Block نزولی");
    }
  }

  if(active.has("VOLUME")){
    if(t1?.volume?.spike){
      if(t1.trend==="BULLISH"){
        add("LONG",10,"افزایش شدید حجم در روند صعودی");
      }

      if(t1.trend==="BEARISH"){
        add("SHORT",10,"افزایش شدید حجم در روند نزولی");
      }
    }
  }

  if(active.has("FOOTPRINT")){
    if(fp&&!fp.error){
      if(fp.deltaPercent>=8){
        add("LONG",12,"Delta مثبت Footprint");
      }

      if(fp.deltaPercent<=-8){
        add("SHORT",12,"Delta منفی Footprint");
      }
    }
  }

  if(active.has("ORDERBOOK")){
    if(wall?.buyNear){
      add("LONG",7,"Buy Wall نزدیک قیمت");
    }

    if(wall?.sellNear){
      add("SHORT",7,"Sell Wall نزدیک قیمت");
    }
  }

  if(active.has("SMC")){
    if(t1?.bos==="BULLISH"||t1?.choch==="BULLISH"){
      add("LONG",8,"ساختار SMC صعودی");
    }

    if(t1?.bos==="BEARISH"||t1?.choch==="BEARISH"){
      add("SHORT",8,"ساختار SMC نزولی");
    }
  }

  if(active.has("ICT")){
    if(t1?.fvg?.type==="BULLISH"&&t1?.hunt?.side==="LONG"){
      add("LONG",8,"هم‌جهتی ICT");
    }

    if(t1?.fvg?.type==="BEARISH"&&t1?.hunt?.side==="SHORT"){
      add("SHORT",8,"هم‌جهتی ICT");
    }
  }

  const total=L+S;

  const gap=
    total
      ?Math.abs(L-S)/total
      :0;

  const direction=
    L>=S
      ?"LONG"
      :"SHORT";

  const final=
    Math.round(
      clamp(
        Math.max(L,S)/
        Math.max(total,1)*100,
        0,
        100
      )
    );

  const threshold=
    clamp(
      60+n(strictness,50)*.4,
      60,
      100
    );

  const requiredMethods=
    Math.max(
      1,
      Math.ceil(
        normalizeMethods(methods).length*
        (
          .2+
          n(strictness,50)/100*.5
        )
      )
    );

  const confirmedMethods=
    direction==="LONG"
      ?[
        ...new Set(
          evidence
            .filter(x=>x.side==="LONG")
            .map(x=>x.text)
        )
      ]
      :[
        ...new Set(
          evidence
            .filter(x=>x.side==="SHORT")
            .map(x=>x.text)
        )
      ];

  return {
    longScore:
      Math.round(
        clamp(L,0,100)
      ),
    shortScore:
      Math.round(
        clamp(S,0,100)
      ),
    direction,
    score:final,
    threshold,
    requiredMethods,
    gap,
    confirmedMethods,
    evidence,
    selectedMethods:
      normalizeMethods(methods),
    strictness
  };
}

function movementAnalysis(
  c,
  market,
  tf,
  wall,
  sr,
  fp,
  extra
){
  const price=c.at(-1)?.close||0;

  const p5=
    c.length>=6
      ?c.at(-6).close
      :price;

  const p15=
    c.length>=16
      ?c.at(-16).close
      :price;

  const p30=
    c.length>=31
      ?c.at(-31).close
      :price;

  const p60=
    c.length>=61
      ?c.at(-61).close
      :price;

  const change5=pct(price,p5);
  const change15=pct(price,p15);
  const change30=pct(price,p30);
  const change60=pct(price,p60);

  const vol20=
    sma(
      c.slice(-21,-1).map(x=>x.volume),
      20
    );

  const currentVol=
    c.at(-1)?.volume||0;

  const volumeRatio=
    vol20
      ?currentVol/vol20
      :0;

  const h=hunt(c);
  const structure=detectStructure(c);
  const candle=candleAnalysis(c);
  const fvg=detectFVG(c);

  const ma1=tf?.["1"]?.ma20||0;

  const distMA20=
    ma1
      ?absPct(price,ma1)
      :0;

  const oiCh=
    market?.openInterestChange||0;

  const delta=
    fp&&!fp.error
      ?fp.deltaPercent
      :0;

  let pump=0;
  let dump=0;
  let pr=0;
  let dr=0;

  const pumpReasons=[];
  const dumpReasons=[];
  const prr=[];
  const drr=[];

  if(change5>=2)pump+=12;
  if(change15>=3)pump+=18;
  if(change30>=5)pump+=15;
  if(change60>=8)pump+=10;

  if(change5<=-2)dump+=12;
  if(change15<=-3)dump+=18;
  if(change30<=-5)dump+=15;
  if(change60<=-8)dump+=10;

  if(volumeRatio>=1.5){
    pump+=10;
    dump+=10;
  }

  if(volumeRatio>=2.5){
    pump+=8;
    dump+=8;
  }

  if(delta>=8)pump+=12;
  if(delta<=-8)dump+=12;

  if(oiCh>=3&&change15>0)pump+=10;
  if(oiCh>=3&&change15<0)dump+=10;
  if(oiCh<=-3&&change15>0)pump+=5;
  if(oiCh<=-3&&change15<0)dump+=5;

  if(
    h.confirmed&&
    h.side==="SHORT"
  ){
    pump+=10;
    pumpReasons.push("Buy-side Sweep");
  }

  if(
    h.confirmed&&
    h.side==="LONG"
  ){
    dump+=10;
    dumpReasons.push("Sell-side Sweep");
  }

  if(structure.bos==="BULLISH")pump+=8;
  if(structure.bos==="BEARISH")dump+=8;
  if(structure.choch==="BULLISH")pump+=10;
  if(structure.choch==="BEARISH")dump+=10;

  if(fvg.type==="BULLISH")pump+=4;
  if(fvg.type==="BEARISH")dump+=4;

  if(
    wall?.buyNear&&
    wall.buyStrength>=60
  )pump+=8;

  if(
    wall?.sellNear&&
    wall.sellStrength>=60
  )dump+=8;

  if(tf?.["1"]?.maSlope==="UP")pump+=5;
  if(tf?.["1"]?.maSlope==="DOWN")dump+=5;

  if(change15>=5){
    pr+=20;
    prr.push("Pump شدید");

    if(distMA20>=2){
      pr+=10;
      prr.push("فاصله زیاد از MA20");
    }

    if(
      h.confirmed&&
      h.side==="SHORT"
    ){
      pr+=20;
      prr.push("Sweep برگشتی");
    }

    if(candle.type==="SHOOTING_STAR"){
      pr+=10;
      prr.push("Shooting Star");
    }

    if(structure.choch==="BEARISH"){
      pr+=20;
      prr.push("CHoCH نزولی");
    }

    if(
      wall?.sellNear&&
      wall.sellStrength>=60
    ){
      pr+=10;
      prr.push("Sell Wall");
    }

    if(delta<0){
      pr+=5;
      prr.push("Delta منفی");
    }
  }

  if(change15<=-5){
    dr+=20;
    drr.push("Dump شدید");

    if(distMA20>=2){
      dr+=10;
      drr.push("فاصله زیاد از MA20");
    }

    if(
      h.confirmed&&
      h.side==="LONG"
    ){
      dr+=20;
      drr.push("Sweep برگشتی");
    }

    if(candle.type==="HAMMER"){
      dr+=10;
      drr.push("Hammer");
    }

    if(structure.choch==="BULLISH"){
      dr+=20;
      drr.push("CHoCH صعودی");
    }

    if(
      wall?.buyNear&&
      wall.buyStrength>=60
    ){
      dr+=10;
      drr.push("Buy Wall");
    }

    if(delta>0){
      dr+=5;
      drr.push("Delta مثبت");
    }
  }

  return {
    change5,
    change15,
    change30,
    change60,
    volumeRatio,

    pumpScore:
      Math.round(
        clamp(pump,0,100)
      ),

    dumpScore:
      Math.round(
        clamp(dump,0,100)
      ),

    pumpReasons,
    dumpReasons,

    pumpReversalScore:
      Math.round(
        clamp(pr,0,100)
      ),

    dumpReversalScore:
      Math.round(
        clamp(dr,0,100)
      ),

    pumpReversalReasons:prr,
    dumpReversalReasons:drr
  };
}

function styleAnalysis(
  tf,
  converted,
  movement,
  fp,
  wall
){
  const styles=[];

  if(movement.pumpScore>=75){
    styles.push("PUMP");
  }

  if(movement.dumpScore>=75){
    styles.push("DUMP");
  }

  if(movement.pumpReversalScore>=75){
    styles.push("PUMP_REVERSAL");
  }

  if(movement.dumpReversalScore>=75){
    styles.push("DUMP_REVERSAL");
  }

  if(tf?.["1"]?.trend==="BULLISH"){
    styles.push("TREND_LONG");
  }

  if(tf?.["1"]?.trend==="BEARISH"){
    styles.push("TREND_SHORT");
  }

  if(fp?.pressure==="BUY"){
    styles.push("BUY_PRESSURE");
  }

  if(fp?.pressure==="SELL"){
    styles.push("SELL_PRESSURE");
  }

  if(wall?.buyNear){
    styles.push("BUY_WALL");
  }

  if(wall?.sellNear){
    styles.push("SELL_WALL");
  }

  return [
    ...new Set(styles)
  ];
}

/* ---------------- FOOTPRINT ---------------- */

async function footprint(category,symbol){
  try{
    const d=
      await bybit(
        "/v5/market/recent-trade",
        {
          category,
          symbol,
          limit:200
        }
      );

    const t=
      d?.result?.list||[];

    let buy=0;
    let sell=0;
    let largest=0;
    let buyNotional=0;
    let sellNotional=0;

    for(const x of t){
      const q=n(x.size);
      const p=n(x.price);
      const no=q*p;

      largest=Math.max(largest,no);

      if(
        String(x.side).toLowerCase()==="buy"
      ){
        buy+=q;
        buyNotional+=no;
      }else{
        sell+=q;
        sellNotional+=no;
      }
    }

    const total=buy+sell;
    const delta=buy-sell;
    const totalNotional=
      buyNotional+sellNotional;

    return {
      buyVolume:buy,
      sellVolume:sell,
      delta,
      deltaPercent:
        total
          ?delta/total*100
          :0,

      buyNotional,
      sellNotional,

      buyNotionalShare:
        totalNotional
          ?buyNotional/totalNotional*100
          :0,

      sellNotionalShare:
        totalNotional
          ?sellNotional/totalNotional*100
          :0,

      trades:t.length,
      largeTradeNotional:largest,

      pressure:
        Math.abs(
          delta/
          Math.max(total,1)
        )*100>=8
          ?(
            delta>0
              ?"BUY"
              :"SELL"
          )
          :"NEUTRAL"
    };
  }catch(e){
    return {
      error:e.message
    };
  }
}

/* =========================================================
   LIVE TRADES
   ========================================================= */

async function recentTrades(
  category,
  symbol,
  limit=1000
){
  try{

    const safeLimit=
      clamp(
        n(limit,1000),
        1,
        1000
      );

    const d=
      await bybit(
        "/v5/market/recent-trade",
        {
          category,
          symbol,
          limit:safeLimit
        }
      );

    return (
      d?.result?.list||[]
    )
      .map(x=>({
        id:String(
          x.execId||
          x.id||
          ""
        ),

        time:n(
          x.time||
          x.TS||
          Date.now()
        ),

        side:String(
          x.side||""
        ).toUpperCase(),

        price:n(x.price),

        size:n(x.size),

        notional:
          n(x.price)*
          n(x.size),

        isBlockTrade:
          !!x.isBlockTrade
      }))
      .filter(
        x=>
          x.price>0&&
          x.size>0
      );

  }catch(e){

    return [];

  }
}

/* =========================================================
   PRICE RANGE SUMMARY
   ========================================================= */

function priceRangeSummary(
  trades,
  rangeCount=10
){
  const rows=
    Array.isArray(trades)
      ?trades.filter(
        x=>
          Number(x.price)>0&&
          Number(x.size)>0
      )
      :[];

  if(!rows.length){
    return {
      available:false,
      count:0,
      ranges:[],
      minPrice:null,
      maxPrice:null,
      totalBuyVolume:0,
      totalSellVolume:0,
      totalBuyTrades:0,
      totalSellTrades:0,
      totalBuyNotional:0,
      totalSellNotional:0,
      avgBuyPrice:null,
      avgSellPrice:null,
      buyShare:0,
      sellShare:0,
      deltaVolume:0,
      deltaTrades:0,
      deltaNotional:0
    };
  }

  const minPrice=
    Math.min(
      ...rows.map(x=>Number(x.price))
    );

  const maxPrice=
    Math.max(
      ...rows.map(x=>Number(x.price))
    );

  const count=
    Math.max(
      1,
      Math.min(
        20,
        Math.floor(
          Number(rangeCount)||10
        )
      )
    );

  const safeMax=
    maxPrice===minPrice
      ?minPrice*(1+0.001)
      :maxPrice;

  const step=
    (safeMax-minPrice)/count;

  const ranges=
    Array.from(
      {length:count},
      (_,i)=>({
        from:
          minPrice+
          step*i,

        to:
          i===count-1
            ?safeMax
            :minPrice+
             step*(i+1),

        buyVolume:0,
        sellVolume:0,

        buyTrades:0,
        sellTrades:0,

        buyNotional:0,
        sellNotional:0,

        buyPriceValue:0,
        sellPriceValue:0
      })
    );

  let totalBuyVolume=0;
  let totalSellVolume=0;

  let totalBuyTrades=0;
  let totalSellTrades=0;

  let totalBuyNotional=0;
  let totalSellNotional=0;

  let totalBuyPriceValue=0;
  let totalSellPriceValue=0;

  for(const t of rows){
    const price=Number(t.price);
    const size=Number(t.size);

    const notional=
      Number(t.notional)||
      price*size;

    let i=
      step>0
        ?Math.floor(
          (price-minPrice)/step
        )
        :0;

    i=
      clamp(
        i,
        0,
        count-1
      );

    const r=ranges[i];

    const side=
      String(
        t.side||""
      ).toUpperCase();

    if(side==="BUY"){
      r.buyVolume+=size;
      r.buyTrades++;
      r.buyNotional+=notional;
      r.buyPriceValue+=price*size;

      totalBuyVolume+=size;
      totalBuyTrades++;
      totalBuyNotional+=notional;
      totalBuyPriceValue+=price*size;
    }

    if(side==="SELL"){
      r.sellVolume+=size;
      r.sellTrades++;
      r.sellNotional+=notional;
      r.sellPriceValue+=price*size;

      totalSellVolume+=size;
      totalSellTrades++;
      totalSellNotional+=notional;
      totalSellPriceValue+=price*size;
    }
  }

  for(const r of ranges){

    r.avgBuyPrice=
      r.buyVolume
        ?r.buyPriceValue/r.buyVolume
        :null;

    r.avgSellPrice=
      r.sellVolume
        ?r.sellPriceValue/r.sellVolume
        :null;

    delete r.buyPriceValue;
    delete r.sellPriceValue;
  }

  const totalNotional=
    totalBuyNotional+
    totalSellNotional;

  return {
    available:true,
    count:rows.length,

    minPrice,
    maxPrice:safeMax,

    ranges,

    totalBuyVolume,
    totalSellVolume,

    totalBuyTrades,
    totalSellTrades,

    totalBuyNotional,
    totalSellNotional,

    avgBuyPrice:
      totalBuyVolume
        ?totalBuyPriceValue/
         totalBuyVolume
        :null,

    avgSellPrice:
      totalSellVolume
        ?totalSellPriceValue/
         totalSellVolume
        :null,

    buyShare:
      totalNotional
        ?totalBuyNotional/
         totalNotional*100
        :0,

    sellShare:
      totalNotional
        ?totalSellNotional/
         totalNotional*100
        :0,

    deltaVolume:
      totalBuyVolume-
      totalSellVolume,

    deltaTrades:
      totalBuyTrades-
      totalSellTrades,

    deltaNotional:
      totalBuyNotional-
      totalSellNotional,

    updatedAt:Date.now()
  };
}

/* =========================================================
   TRADE RANGE FILTER
   ========================================================= */

function parseTradeTime(
  value,
  baseDate=null
){
  if(
    value===undefined||
    value===null||
    value===""
  ){
    return null;
  }

  const raw=String(value).trim();

  if(/^\d+$/.test(raw)){
    const v=Number(raw);

    if(v<100000000000){
      return v*1000;
    }

    return v;
  }

  if(
    /^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)
  ){
    const base=
      baseDate
        ?new Date(baseDate)
        :new Date();

    const parts=raw.split(":");

    base.setHours(
      Number(parts[0]),
      Number(parts[1]),
      Number(parts[2]||0),
      0
    );

    return base.getTime();
  }

  const parsed=Date.parse(raw);

  return Number.isFinite(parsed)
    ?parsed
    :null;
}

function formatTradeTime(ts){
  if(!ts)return null;

  return new Date(ts).toISOString();
}

function filterTradeRange(
  trades,
  options={}
){
  const rows=
    Array.isArray(trades)
      ?trades.filter(
        x=>
          Number(x.price)>0&&
          Number(x.size)>0
      )
      :[];

  const fromPrice=
    options.fromPrice!==null&&
    options.fromPrice!==undefined&&
    options.fromPrice!==""
      ?Number(options.fromPrice)
      :null;

  const toPrice=
    options.toPrice!==null&&
    options.toPrice!==undefined&&
    options.toPrice!==""
      ?Number(options.toPrice)
      :null;

  const fromTime=
    parseTradeTime(
      options.fromTime,
      options.baseDate
    );

  const toTime=
    parseTradeTime(
      options.toTime,
      options.baseDate
    );

  const side=
    String(
      options.side||"ALL"
    ).toUpperCase();

  const filtered=
    rows.filter(t=>{

      const price=Number(t.price);
      const time=Number(t.time);

      if(
        fromPrice!==null&&
        Number.isFinite(fromPrice)&&
        price<fromPrice
      ){
        return false;
      }

      if(
        toPrice!==null&&
        Number.isFinite(toPrice)&&
        price>toPrice
      ){
        return false;
      }

      if(
        fromTime!==null&&
        time<fromTime
      ){
        return false;
      }

      if(
        toTime!==null&&
        time>toTime
      ){
        return false;
      }

      if(
        side!=="ALL"&&
        side!=="BUY"&&
        side!=="SELL"
      ){
        return true;
      }

      if(
        side!=="ALL"&&
        String(t.side).toUpperCase()!==side
      ){
        return false;
      }

      return true;
    });

  let buyVolume=0;
  let sellVolume=0;

  let buyTrades=0;
  let sellTrades=0;

  let buyNotional=0;
  let sellNotional=0;

  let buyPriceValue=0;
  let sellPriceValue=0;

  let firstTime=null;
  let lastTime=null;

  let minPrice=null;
  let maxPrice=null;

  for(const t of filtered){

    const price=Number(t.price);
    const size=Number(t.size);

    const notional=
      Number(t.notional)||
      price*size;

    const time=Number(t.time);

    if(
      firstTime===null||
      time<firstTime
    ){
      firstTime=time;
    }

    if(
      lastTime===null||
      time>lastTime
    ){
      lastTime=time;
    }

    if(
      minPrice===null||
      price<minPrice
    ){
      minPrice=price;
    }

    if(
      maxPrice===null||
      price>maxPrice
    ){
      maxPrice=price;
    }

    if(
      String(t.side).toUpperCase()==="BUY"
    ){
      buyVolume+=size;
      buyTrades++;
      buyNotional+=notional;
      buyPriceValue+=price*size;
    }

    if(
      String(t.side).toUpperCase()==="SELL"
    ){
      sellVolume+=size;
      sellTrades++;
      sellNotional+=notional;
      sellPriceValue+=price*size;
    }
  }

  const totalVolume=
    buyVolume+
    sellVolume;

  const totalTrades=
    buyTrades+
    sellTrades;

  const totalNotional=
    buyNotional+
    sellNotional;

  const deltaVolume=
    buyVolume-
    sellVolume;

  const deltaTrades=
    buyTrades-
    sellTrades;

  const deltaNotional=
    buyNotional-
    sellNotional;

  const buyShare=
    totalNotional
      ?buyNotional/
       totalNotional*100
      :0;

  const sellShare=
    totalNotional
      ?sellNotional/
       totalNotional*100
      :0;

  return {
    available:
      filtered.length>0,

    requested:{
      fromPrice,
      toPrice,

      fromTime:
        fromTime!==null
          ?formatTradeTime(fromTime)
          :null,

      toTime:
        toTime!==null
          ?formatTradeTime(toTime)
          :null,

      fromTimeMs:fromTime,
      toTimeMs:toTime,

      side
    },

    source:{
      receivedTrades:rows.length,
      matchedTrades:filtered.length
    },

    price:{
      requestedFrom:fromPrice,
      requestedTo:toPrice,
      actualMin:minPrice,
      actualMax:maxPrice
    },

    time:{
      requestedFrom:
        fromTime!==null
          ?formatTradeTime(fromTime)
          :null,

      requestedTo:
        toTime!==null
          ?formatTradeTime(toTime)
          :null,

      actualFirst:
        firstTime!==null
          ?formatTradeTime(firstTime)
          :null,

      actualLast:
        lastTime!==null
          ?formatTradeTime(lastTime)
          :null
    },

    buy:{
      volume:buyVolume,
      trades:buyTrades,
      notional:buyNotional,

      avgPrice:
        buyVolume
          ?buyPriceValue/
           buyVolume
          :null
    },

    sell:{
      volume:sellVolume,
      trades:sellTrades,
      notional:sellNotional,

      avgPrice:
        sellVolume
          ?sellPriceValue/
           sellVolume
          :null
    },

    total:{
      volume:totalVolume,
      trades:totalTrades,
      notional:totalNotional
    },

    delta:{
      volume:deltaVolume,
      trades:deltaTrades,
      notional:deltaNotional
    },

    share:{
      buy:buyShare,
      sell:sellShare
    },

    trades:filtered,

    generatedAt:Date.now()
  };
}

function buildTradePriceBuckets(
  trades,
  fromPrice,
  toPrice,
  bucketCount=10
){
  const rows=
    Array.isArray(trades)
      ?trades.filter(
        x=>
          Number(x.price)>0&&
          Number(x.size)>0
      )
      :[];

  const from=Number(fromPrice);
  const to=Number(toPrice);

  if(
    !Number.isFinite(from)||
    !Number.isFinite(to)||
    to<=from
  ){
    return [];
  }

  const count=
    Math.max(
      1,
      Math.min(
        100,
        Math.floor(
          Number(bucketCount)||10
        )
      )
    );

  const step=
    (to-from)/count;

  const buckets=
    Array.from(
      {length:count},
      (_,i)=>({
        from:
          from+
          step*i,

        to:
          i===count-1
            ?to
            :from+
             step*(i+1),

        buyVolume:0,
        sellVolume:0,

        buyTrades:0,
        sellTrades:0,

        buyNotional:0,
        sellNotional:0,

        buyPriceValue:0,
        sellPriceValue:0
      })
    );

  for(const t of rows){

    const price=Number(t.price);

    if(
      price<from||
      price>to
    ){
      continue;
    }

    let index=
      Math.floor(
        (price-from)/step
      );

    index=
      clamp(
        index,
        0,
        count-1
      );

    const b=buckets[index];

    const size=Number(t.size);

    const notional=
      Number(t.notional)||
      price*size;

    const side=
      String(t.side||"").toUpperCase();

    if(side==="BUY"){
      b.buyVolume+=size;
      b.buyTrades++;
      b.buyNotional+=notional;
      b.buyPriceValue+=price*size;
    }

    if(side==="SELL"){
      b.sellVolume+=size;
      b.sellTrades++;
      b.sellNotional+=notional;
      b.sellPriceValue+=price*size;
    }
  }

  for(const b of buckets){

    b.avgBuyPrice=
      b.buyVolume
        ?b.buyPriceValue/
         b.buyVolume
        :null;

    b.avgSellPrice=
      b.sellVolume
        ?b.sellPriceValue/
         b.sellVolume
        :null;

    delete b.buyPriceValue;
    delete b.sellPriceValue;
  }

  return buckets;
}

async function tradeRange(
  category,
  symbol,
  options={}
){
  const limit=
    clamp(
      n(
        options.limit,
        1000
      ),
      1,
      1000
    );

  const trades=
    await recentTrades(
      category,
      symbol,
      limit
    );

  const analysis=
    filterTradeRange(
      trades,
      options
    );

  let buckets=[];

  if(
    options.fromPrice!==undefined&&
    options.fromPrice!==""&&
    options.toPrice!==undefined&&
    options.toPrice!==""
  ){
    buckets=
      buildTradePriceBuckets(
        analysis.trades,
        Number(options.fromPrice),
        Number(options.toPrice),
        n(
          options.bucketCount,
          10
        )
      );
  }

  return {
    ok:true,
    symbol,
    category,
    limit,

    analysis,

    priceBuckets:buckets,

    note:
      "این تحلیل بر اساس معاملات عمومی اخیر دریافت‌شده از Bybit انجام می‌شود. برای بازه‌های زمانی قدیمی‌تر از معاملات موجود در recent-trade، داده تاریخی در این endpoint قابل بازیابی نیست.",

    generatedAt:Date.now()
  };
}

/* =========================================================
   LIVE
   ========================================================= */

async function live(category,symbol){

  const [t,trades]=
    await Promise.all([
      ticker(
        category,
        symbol
      ),

      recentTrades(
        category,
        symbol,
        1000
      )
    ]);

  const price=
    n(
      t.lastPrice||
      t.markPrice||
      t.indexPrice
    );

  const range=
    priceRangeSummary(
      trades,
      10
    );

  return {
    ok:true,
    symbol,
    category,

    price,

    markPrice:
      n(t.markPrice),

    indexPrice:
      n(t.indexPrice),

    price24hPcnt:
      n(t.price24hPcnt)*100,

    turnover24h:
      n(t.turnover24h),

    volume24h:
      n(t.volume24h),

    recentTrades:trades,

    priceRangeSummary:range,

    generatedAt:Date.now()
  };
}

/* =========================================================
   ORDER BOOK
   ========================================================= */

async function walls(
  category,
  symbol,
  price
){
  try{

    const d=
      await bybit(
        "/v5/market/orderbook",
        {
          category,
          symbol,
          limit:50
        }
      );

    const bids=
      d?.result?.b||[];

    const asks=
      d?.result?.a||[];

    const buyLevels=[];
    const sellLevels=[];

    for(const q of bids){

      const p=n(q[0]);
      const sz=n(q[1]);

      if(p<=0||sz<=0)continue;

      const notional=p*sz;

      const distance=
        absPct(p,price);

      if(distance<=3){
        buyLevels.push({
          price:p,
          size:sz,
          notional,
          distancePct:distance
        });
      }
    }

    for(const q of asks){

      const p=n(q[0]);
      const sz=n(q[1]);

      if(p<=0||sz<=0)continue;

      const notional=p*sz;

      const distance=
        absPct(p,price);

      if(distance<=3){
        sellLevels.push({
          price:p,
          size:sz,
          notional,
          distancePct:distance
        });
      }
    }

    buyLevels.sort(
      (a,b)=>b.notional-a.notional
    );

    sellLevels.sort(
      (a,b)=>b.notional-a.notional
    );

    const allNotional=[
      ...buyLevels.map(x=>x.notional),
      ...sellLevels.map(x=>x.notional)
    ];

    const med=
      allNotional.length
        ?[
          ...allNotional
        ].sort((a,b)=>a-b)[
          Math.floor(allNotional.length/2)
        ]
        :0;

    const threshold=
      med*4;

    const buyWalls=
      buyLevels
        .filter(x=>x.notional>=threshold)
        .slice(0,10);

    const sellWalls=
      sellLevels
        .filter(x=>x.notional>=threshold)
        .slice(0,10);

    const buyLiquidity=
      buyLevels.reduce(
        (a,x)=>a+x.notional,
        0
      );

    const sellLiquidity=
      sellLevels.reduce(
        (a,x)=>a+x.notional,
        0
      );

    const totalLiquidity=
      buyLiquidity+
      sellLiquidity;

    const buyShare=
      totalLiquidity
        ?buyLiquidity/
         totalLiquidity*100
        :0;

    const sellShare=
      totalLiquidity
        ?sellLiquidity/
         totalLiquidity*100
        :0;

    const buyWall=
      buyWalls[0]||null;

    const sellWall=
      sellWalls[0]||null;

    return {

      bestBid:
        bids.length
          ?n(bids[0][0])
          :null,

      bestAsk:
        asks.length
          ?n(asks[0][0])
          :null,

      buyLiquidity,
      sellLiquidity,
      totalLiquidity,

      buyShare,
      sellShare,

      buyNear:
        !!(
          buyWall&&
          buyWall.distancePct<=1
        ),

      sellNear:
        !!(
          sellWall&&
          sellWall.distancePct<=1
        ),

      buyStrength:
        totalLiquidity
          ?buyShare
          :0,

      sellStrength:
        totalLiquidity
          ?sellShare
          :0,

      buyWalls,
      sellWalls,

      buyLevels:
        buyLevels.slice(0,20),

      sellLevels:
        sellLevels.slice(0,20),

      wallThreshold:threshold,

      note:
        "Order Book نقدینگی لحظه‌ای است و ممکن است سفارش‌ها قبل از رسیدن قیمت حذف یا جابه‌جا شوند."
    };

  }catch(e){

    return {
      error:e.message,
      buyWalls:[],
      sellWalls:[]
    };
  }
}

function supportResistance(
  c,
  wall,
  price
){
  const s=
    swingLevels(c,3);

  const supports=[];
  const resistances=[];

  for(const x of s.lows){
    if(x.price<price){
      supports.push({
        price:x.price,
        type:"SWING_SUPPORT",
        distancePct:
          absPct(
            x.price,
            price
          )
      });
    }
  }

  for(const x of s.highs){
    if(x.price>price){
      resistances.push({
        price:x.price,
        type:"SWING_RESISTANCE",
        distancePct:
          absPct(
            x.price,
            price
          )
      });
    }
  }

  for(const x of wall?.buyLevels||[]){
    if(x.price<price){
      supports.push({
        price:x.price,
        type:"BUY_WALL",
        liquidity:x.notional,
        distancePct:x.distancePct
      });
    }
  }

  for(const x of wall?.sellLevels||[]){
    if(x.price>price){
      resistances.push({
        price:x.price,
        type:"SELL_WALL",
        liquidity:x.notional,
        distancePct:x.distancePct
      });
    }
  }

  supports.sort(
    (a,b)=>
      a.distancePct-
      b.distancePct
  );

  resistances.sort(
    (a,b)=>
      a.distancePct-
      b.distancePct
  );

  const liquid=(a)=>
    a
      .filter(x=>x.liquidity)
      .sort(
        (x,y)=>
          (y.liquidity||0)-
          (x.liquidity||0)
      )[0];

  return {
    nearestSupport:
      supports[0]||null,

    nearestResistance:
      resistances[0]||null,

    strongestSupport:
      liquid(supports)||
      supports[0]||
      null,

    strongestResistance:
      liquid(resistances)||
      resistances[0]||
      null,

    supports:
      supports.slice(0,10),

    resistances:
      resistances.slice(0,10)
  };
}

/* =========================================================
   TICKER / OI / FUNDING
   ========================================================= */

async function ticker(
  category,
  symbol
){
  const d=
    await bybit(
      "/v5/market/tickers",
      {
        category,
        symbol
      }
    );

  return d?.result?.list?.[0]||{};
}

async function oiFunding(symbol){
  try{

    const t=
      await ticker(
        "linear",
        symbol
      );

    let oiHistory=[];
    let fundHistory=[];

    try{

      const oi=
        await bybit(
          "/v5/market/open-interest",
          {
            category:"linear",
            symbol,
            intervalTime:"5min",
            limit:2
          }
        );

      oiHistory=
        oi?.result?.list||[];

    }catch(_){}

    try{

      const fr=
        await bybit(
          "/v5/market/funding/history",
          {
            category:"linear",
            symbol,
            limit:2
          }
        );

      fundHistory=
        fr?.result?.list||[];

    }catch(_){}

    const oiNow=
      n(t.openInterest);

    const oiPrev=
      oiHistory.length>1
        ?n(
          oiHistory[
            oiHistory.length-2
          ].openInterest
        )
        :oiHistory.length===1
          ?n(
            oiHistory[0].openInterest
          )
          :0;

    const fundingNow=
      n(t.fundingRate);

    const fundingPrev=
      fundHistory.length>1
        ?n(
          fundHistory[
            fundHistory.length-2
          ].fundingRate
        )
        :fundHistory.length===1
          ?n(
            fundHistory[0].fundingRate
          )
          :0;

    const oiChange=
      oiPrev
        ?(
          (oiNow-oiPrev)/
          oiPrev*100
        )
        :0;

    const fundingChange=
      fundingPrev
        ?(
          (fundingNow-fundingPrev)/
          Math.abs(fundingPrev)*100
        )
        :0;

    return {
      openInterest:oiNow,
      openInterestPrevious:oiPrev,
      openInterestChange:oiChange,

      fundingRate:fundingNow,
      fundingRatePrevious:fundingPrev,
      fundingRateChange:fundingChange,

      turnover24h:
        n(t.turnover24h),

      change24h:
        n(t.price24hPcnt)*100,

      markPrice:
        n(t.markPrice),

      indexPrice:
        n(t.indexPrice),

      nextFundingTime:
        n(t.nextFundingTime),

      openInterestHistory:
        oiHistory,

      fundingHistory:
        fundHistory
    };

  }catch(e){

    return {
      error:e.message,

      openInterest:null,
      openInterestPrevious:null,
      openInterestChange:null,

      fundingRate:null,
      fundingRatePrevious:null,
      fundingRateChange:null,

      turnover24h:null,
      change24h:null,
      markPrice:null,
      indexPrice:null
    };
  }
}

/* =========================================================
   SETTINGS
   ========================================================= */

function parseSettings(params){

  const strictness=
    clamp(
      n(
        params.get("strictness"),
        DEFAULT_STRICTNESS
      ),
      0,
      100
    );

  let methods=
    DEFAULT_METHODS.slice();

  const raw=
    params.get("methods");

  if(raw){

    try{

      methods=
        normalizeMethods(
          JSON.parse(raw)
        );

    }catch{

      methods=
        normalizeMethods(
          raw
            .split(",")
            .map(
              x=>x.trim()
            )
        );
    }
  }

  return {
    strictness,
    methods
  };
}

/* =========================================================
   DEEP ANALYSIS
   ========================================================= */

async function deepAnalyze(
  category,
  symbol,
  settings={}
){
  const tf={};
  let oneMinute=[];

  try{

    oneMinute=
      await klines(
        category,
        symbol,
        "1",
        DEEP_1M_LIMIT
      );

    tf["1"]=
      analyzeCandles(
        oneMinute.slice(-200)
      );

  }catch(e){

    tf["1"]={
      error:e.message
    };
  }

  for(
    const x of TF.filter(
      z=>z.interval!=="1"
    )
  ){

    try{

      tf[x.key]=
        analyzeCandles(
          await klines(
            category,
            symbol,
            x.interval,
            120
          )
        );

    }catch(e){

      tf[x.key]={
        error:e.message
      };
    }
  }

  const converted=
    oneMinute.length
      ?convertedMAEvents(oneMinute)
      :{
        events:[],
        recent:[],
        confirmed:[],
        latest:null
      };

  const valid=
    Object.values(tf)
      .filter(
        x=>!x.error
      );

  const price=
    valid.length
      ?valid[0].price
      :0;

  const fp=
    await footprint(
      category,
      symbol
    );

  const wall=
    await walls(
      category,
      symbol,
      price
    );

  const market=
    category==="linear"
      ?await oiFunding(symbol)
      :{
        openInterest:null,
        openInterestPrevious:null,
        openInterestChange:null,
        fundingRate:null,
        fundingRatePrevious:null,
        fundingRateChange:null,
        turnover24h:null,
        change24h:null,
        markPrice:null,
        indexPrice:null
      };

  const sr=
    supportResistance(
      oneMinute,
      wall,
      price
    );

  const extra=
    extraSignals(
      oneMinute
    );

  const signal=
    signalScore(
      tf,
      converted,
      extra,
      fp,
      wall,
      settings.strictness,
      settings.methods
    );

  const movement=
    movementAnalysis(
      oneMinute,
      market,
      tf,
      wall,
      sr,
      fp,
      extra
    );

  const styles=
    styleAnalysis(
      tf,
      converted,
      movement,
      fp,
      wall
    );

  let alert="NONE";

  if(
    movement.pumpReversalScore>=75
  ){
    alert="PUMP_REVERSAL_WATCH";
  }

  if(
    movement.dumpReversalScore>=75
  ){
    alert="DUMP_REVERSAL_WATCH";
  }

  if(
    movement.pumpReversalScore>=85&&
    (
      tf["1"]?.choch==="BEARISH"||
      signal.direction==="SHORT"
    )
  ){
    alert="PUMP_REVERSAL_CONFIRMED";
  }

  if(
    movement.dumpReversalScore>=85&&
    (
      tf["1"]?.choch==="BULLISH"||
      signal.direction==="LONG"
    )
  ){
    alert="DUMP_REVERSAL_CONFIRMED";
  }

  return {
    symbol,
    category,
    price,

    direction:
      signal.direction,

    score:
      signal.score,

    longScore:
      signal.longScore,

    shortScore:
      signal.shortScore,

    signalLevel:
      signal.direction!=="WAIT"
        ?(
          signal.score>=85
            ?"VERY_STRONG"
            :signal.score>=75
              ?"CONFIRMED"
              :"WATCH"
        )
        :signal.score>=60
          ?"WATCH"
          :"NONE",

    signalSettings:{
      strictness:
        settings.strictness,

      selectedMethods:
        settings.methods,

      threshold:
        signal.threshold,

      requiredMethods:
        signal.requiredMethods
    },

    signalEvidence:
      signal.evidence,

    timeframes:tf,

    convertedMA1m:
      converted,

    indicators:
      extra,

    footprint:fp,

    walls:wall,

    supportResistance:sr,

    market:market,

    movement:movement,

    styles:styles,

    pumpScore:
      movement.pumpScore,

    dumpScore:
      movement.dumpScore,

    pumpDumpStatus:
      movement.pumpScore>=75
        ?"PUMP"
        :movement.dumpScore>=75
          ?"DUMP"
          :"NORMAL",

    reversal:{
      pumpScore:
        movement.pumpReversalScore,

      dumpScore:
        movement.dumpReversalScore,

      pumpReasons:
        movement.pumpReversalReasons,

      dumpReasons:
        movement.dumpReversalReasons,

      alert
    },

    reasons:
      signal.evidence
        .filter(
          x=>x.side===signal.direction
        )
        .map(
          x=>x.text
        ),

    generatedAt:
      Date.now(),

    liquidation:{
      available:false,
      message:
        "داده لیکوئیدیشن تجمیعی از REST عمومی این اسکنر تولید نمی‌شود؛ عدد ساختگی نمایش داده نمی‌شود."
    }
  };
}

/* =========================================================
   INSTRUMENTS
   ========================================================= */

async function instruments(category){

  const all=[];
  let cursor="";

  for(let page=0;page<5;page++){

    const d=
      await bybit(
        "/v5/market/instruments-info",
        {
          category,
          limit:1000,
          ...(cursor?{cursor}:{})
        }
      );

    all.push(
      ...(d?.result?.list||[])
    );

    cursor=
      d?.result?.nextPageCursor||
      "";

    if(!cursor)break;
  }

  return all;
}

function validFutures(list){
  return list.filter(
    x=>
      x.status==="Trading"&&
      x.quoteCoin==="USDT"&&
      x.contractType==="LinearPerpetual"
  );
}

/* =========================================================
   SEARCH
   ========================================================= */

async function findSymbol(input){

  const raw=
    String(input||"")
      .trim()
      .toUpperCase();

  const bare=
    raw
      .replace(
        /[-_/:\s]/g,
        ""
      )
      .replace(
        /USDT$/,
        ""
      );

  const [lin,spot]=
    await Promise.all([
      instruments("linear"),
      instruments("spot")
    ]);

  const l=
    lin.find(
      x=>
        String(x.symbol).toUpperCase()===raw||
        String(x.symbol).toUpperCase()===bare+"USDT"
    );

  const s=
    spot.find(
      x=>
        String(x.symbol).toUpperCase()===raw||
        String(x.symbol).toUpperCase()===bare+"USDT"
    );

  return {
    input:raw,

    selected:
      l
        ?"FUTURES"
        :s
          ?"SPOT"
          :null,

    futures:
      l
        ?{
          symbol:l.symbol,
          status:l.status,
          baseCoin:l.baseCoin,
          quoteCoin:l.quoteCoin
        }
        :null,

    spot:
      s
        ?{
          symbol:s.symbol,
          status:s.status,
          baseCoin:s.baseCoin,
          quoteCoin:s.quoteCoin
        }
        :null
  };
}

/* =========================================================
   SCAN
   ========================================================= */

async function scan(
  offset=0,
  settings={}
){

  const ms=
    validFutures(
      await instruments("linear")
    ).sort(
      (a,b)=>
        String(a.symbol)
          .localeCompare(
            String(b.symbol)
          )
    );

  if(!ms.length){
    return {
      ok:false,
      error:
        "هیچ قرارداد USDT Perpetual فعال پیدا نشد."
    };
  }

  const safeOffset=
    Math.max(
      0,
      Math.min(
        offset,
        Math.max(
          0,
          ms.length-1
        )
      )
    );

  const batch=
    ms.slice(
      safeOffset,
      safeOffset+SCAN_BATCH
    );

  const light=[];

  for(const m of batch){

    try{

      const c=
        analyzeCandles(
          await klines(
            "linear",
            m.symbol,
            "1",
            80
          )
        );

      if(c.error)continue;

      let activity=0;

      if(c.touchMA20)activity+=20;
      if(c.touchMA7)activity+=10;
      if(c.volume.spike)activity+=20;
      if(c.market.state==="ACTIVE")activity+=15;
      if(c.hunt.confirmed)activity+=20;
      if(c.bos!=="NONE")activity+=10;
      if(c.choch!=="NONE")activity+=15;
      if(c.maSlope!=="FLAT")activity+=5;

      activity+=
        Math.abs(
          pct(
            c.price,
            c.price/
            (
              1+
              0.01*
              (
                c.volume.ratio20-1
              )
            )
          )
        )*.5;

      light.push({
        symbol:m.symbol,
        activity,
        tf1:c
      });

    }catch(_){}
  }

  light.sort(
    (a,b)=>
      b.activity-a.activity
  );

  const deep=
    await Promise.all(
      light
        .slice(0,DEEP_LIMIT)
        .map(
          x=>
            deepAnalyze(
              "linear",
              x.symbol,
              settings
            )
        )
    );

  deep.sort(
    (a,b)=>
      b.score-a.score
  );

  return {
    ok:true,
    totalMarkets:ms.length,
    offset:safeOffset,
    batchSize:batch.length,

    nextOffset:
      (
        safeOffset+
        SCAN_BATCH
      )%ms.length,

    results:deep,

    scannedSymbols:
      batch.map(
        x=>x.symbol
      ),

    settings,

    note:
      "اسکن چرخشی است و بازار بر اساس فعالیت برای تحلیل سنگین انتخاب می‌شود."
  };
}

/* =========================================================
   RADAR
   ========================================================= */

async function radar(
  offset=0,
  settings={}
){

  const ms=
    validFutures(
      await instruments("linear")
    ).sort(
      (a,b)=>
        String(a.symbol)
          .localeCompare(
            String(b.symbol)
          )
    );

  if(!ms.length){
    return {
      ok:false,
      error:
        "بازار Futures پیدا نشد."
    };
  }

  const safeOffset=
    Math.max(
      0,
      Math.min(
        offset,
        Math.max(
          0,
          ms.length-1
        )
      )
    );

  const batch=
    ms.slice(
      safeOffset,
      safeOffset+SCAN_BATCH
    );

  const candidates=[];

  for(const m of batch){

    try{

      const c=
        await klines(
          "linear",
          m.symbol,
          "1",
          100
        );

      if(c.length<61)continue;

      const price=
        c.at(-1).close;

      const ch5=
        Math.abs(
          pct(
            price,
            c.at(-6).close
          )
        );

      const ch15=
        Math.abs(
          pct(
            price,
            c.at(-16).close
          )
        );

      const ch30=
        Math.abs(
          pct(
            price,
            c.at(-31).close
          )
        );

      const ch60=
        Math.abs(
          pct(
            price,
            c.at(-61).close
          )
        );

      const avgVol=
        sma(
          c.slice(-21,-1).map(
            x=>x.volume
          ),
          20
        );

      const vr=
        avgVol
          ?c.at(-1).volume/
           avgVol
          :0;

      const h=hunt(c);
      const st=detectStructure(c);

      const oi=
        await oiFunding(
          m.symbol
        );

      const activity=
        ch5*2+
        ch15*4+
        ch30*2+
        ch60+
        Math.min(vr*12,35)+
        (h.confirmed?20:0)+
        (st.choch!=="NONE"?20:0)+
        Math.min(
          Math.abs(
            oi.openInterestChange||0
          )*2,
          15
        );

      candidates.push({
        symbol:m.symbol,
        activity
      });

    }catch(_){}
  }

  candidates.sort(
    (a,b)=>
      b.activity-a.activity
  );

  const deep=
    await Promise.all(
      candidates
        .slice(0,RADAR_LIMIT)
        .map(
          x=>
            deepAnalyze(
              "linear",
              x.symbol,
              settings
            )
        )
    );

  const pump=
    deep
      .filter(
        x=>x.pumpScore>=40
      )
      .sort(
        (a,b)=>
          b.pumpScore-
          a.pumpScore
      );

  const dump=
    deep
      .filter(
        x=>x.dumpScore>=40
      )
      .sort(
        (a,b)=>
          b.dumpScore-
          a.dumpScore
      );

  const reversal=
    deep
      .filter(
        x=>
          x.reversal.pumpScore>=40||
          x.reversal.dumpScore>=40
      )
      .sort(
        (a,b)=>
          Math.max(
            b.reversal.pumpScore,
            b.reversal.dumpScore
          )-
          Math.max(
            a.reversal.pumpScore,
            a.reversal.dumpScore
          )
      );

  return {
    ok:true,
    totalMarkets:ms.length,
    offset:safeOffset,

    nextOffset:
      (
        safeOffset+
        SCAN_BATCH
      )%ms.length,

    scannedSymbols:
      batch.map(
        x=>x.symbol
      ),

    pump,
    dump,
    reversal,
    results:deep,
    settings,

    note:
      "Radar تقویت‌شده با حرکت چندبازه‌ای، حجم، OI، Funding، Footprint/Delta، Sweep، BOS/CHoCH، MA، FVG، Walls و برگشت پس از Pump/Dump."
  };
}

/* =========================================================
   ROUTER
   ========================================================= */

export default {

  async fetch(request,env){

    if(request.method==="OPTIONS"){
      return new Response(
        null,
        {
          status:204,
          headers:{
            "access-control-allow-origin":"*",
            "access-control-allow-methods":"GET,HEAD,OPTIONS",
            "access-control-allow-headers":"Content-Type,Authorization",
            "access-control-max-age":"86400"
          }
        }
      );
    }

    const u=
      new URL(request.url);

    const p=
      u.pathname;

    try{

      const settings=
        parseSettings(
          u.searchParams
        );

      /* ---------------- SEARCH ---------------- */

      if(p==="/api/search"){

        const q=
          u.searchParams.get(
            "symbol"
          );

        if(!q){
          return json(
            {
              ok:false,
              error:
                "نماد وارد نشده است."
            },
            400
          );
        }

        const found=
          await findSymbol(q);

        return json({
          ok:true,
          ...found
        });
      }

      /* ---------------- ANALYZE ---------------- */

      if(p==="/api/analyze"){

        const symbol=
          u.searchParams.get(
            "symbol"
          );

        const category=
          (
            u.searchParams.get(
              "category"
            )||"auto"
          ).toLowerCase();

        if(!symbol){
          return json(
            {
              ok:false,
              error:
                "نماد وارد نشده است."
            },
            400
          );
        }

        const found=
          await findSymbol(symbol);

        const chosen=
          category==="spot"
            ?found.spot
            :category==="linear"
              ?found.futures
              :(found.futures||
                found.spot);

        if(!chosen){
          return json(
            {
              ok:false,
              error:
                `${symbol} در Spot یا Futures Bybit پیدا نشد.`,
              search:found
            },
            404
          );
        }

        const chosenCategory=
          chosen===found.futures
            ?"linear"
            :"spot";

        return json({
          ok:true,

          ...await deepAnalyze(
            chosenCategory,
            chosen.symbol,
            settings
          ),

          search:found
        });
      }

      /* ---------------- SCAN ---------------- */

      if(p==="/api/scan"){

        return json(
          await scan(
            n(
              u.searchParams.get(
                "offset"
              ),
              0
            ),
            settings
          )
        );
      }

      /* ---------------- RADAR ---------------- */

      if(p==="/api/radar"){

        return json(
          await radar(
            n(
              u.searchParams.get(
                "offset"
              ),
              0
            ),
            settings
          )
        );
      }

      /* =================================================
         TRADE RANGE API

         مثال:

         /api/trade-range?symbol=BTCUSDT
         &category=linear
         &fromPrice=100000
         &toPrice=105000
         &fromTime=10:00
         &toTime=12:00
         &side=ALL
         &bucketCount=10
         &limit=1000
      ================================================= */

      if(p==="/api/trade-range"){

        const symbol=
          u.searchParams.get(
            "symbol"
          );

        const category=
          (
            u.searchParams.get(
              "category"
            )||"linear"
          ).toLowerCase()==="spot"
            ?"spot"
            :"linear";

        if(!symbol){
          return json(
            {
              ok:false,
              error:
                "نماد وارد نشده است."
            },
            400
          );
        }

        const fromPrice=
          u.searchParams.get(
            "fromPrice"
          );

        const toPrice=
          u.searchParams.get(
            "toPrice"
          );

        const fromTime=
          u.searchParams.get(
            "fromTime"
          );

        const toTime=
          u.searchParams.get(
            "toTime"
          );

        const side=
          (
            u.searchParams.get(
              "side"
            )||"ALL"
          ).toUpperCase();

        const bucketCount=
          clamp(
            n(
              u.searchParams.get(
                "bucketCount"
              ),
              10
            ),
            1,
            100
          );

        const limit=
          clamp(
            n(
              u.searchParams.get(
                "limit"
              ),
              1000
            ),
            1,
            1000
          );

        return json(
          await tradeRange(
            category,
            symbol.toUpperCase(),
            {
              fromPrice,
              toPrice,
              fromTime,
              toTime,
              side,
              bucketCount,
              limit
            }
          )
        );
      }

      /* ---------------- LIVE ---------------- */

      if(p==="/api/live"){

        const symbol=
          u.searchParams.get(
            "symbol"
          );

        const category=
          (
            u.searchParams.get(
              "category"
            )||"linear"
          ).toLowerCase()==="spot"
            ?"spot"
            :"linear";

        if(!symbol){
          return json(
            {
              ok:false,
              error:
                "نماد وارد نشده است."
            },
            400
          );
        }

        return json(
          await live(
            category,
            symbol.toUpperCase()
          )
        );
      }

      /* ---------------- HEALTH ---------------- */

      if(p==="/api/health"){

        return json({

          ok:true,

          service:
            "Bybit Smart Money MA Radar",

          version:"V9",

          timeframes:
            TF.map(
              x=>x.interval
            ),

          scanBatch:
            SCAN_BATCH,

          deepLimit:
            DEEP_LIMIT,

          radarLimit:
            RADAR_LIMIT,

          minimumSignalScore:
            MIN_SIGNAL_SCORE,

          watchScore:
            WATCH_SCORE,

          defaultStrictness:
            DEFAULT_STRICTNESS,

          signalMethods:
            DEFAULT_METHODS,

          convertedMA:
            CONVERTED_MAS,

          features:[
            "MA",
            "MACD",
            "RSI",
            "Ichimoku",
            "Divergence",
            "Liquidity Hunt",
            "FVG",
            "BOS",
            "CHoCH",
            "Order Block",
            "Candle Analysis",
            "Volume Spike",
            "ADX",
            "ATR",
            "Bollinger Width",
            "Order Book",
            "Buy Wall",
            "Sell Wall",
            "Support",
            "Resistance",
            "OI Current/Previous/Change",
            "Funding Current/Previous/Change",
            "Footprint",
            "Delta",
            "Recent Trades",
            "Price Range Analysis",
            "Buy/Sell Volume",
            "Buy/Sell Trade Count",
            "Average Buy Price",
            "Average Sell Price",
            "Buy/Sell Notional",
            "Trade Range Filter",
            "Trade Time Filter",
            "Price Buckets",
            "Pump Radar",
            "Dump Radar",
            "Reversal Radar",
            "SMC",
            "ICT"
          ],

          endpoints:[
            "/api/search",
            "/api/analyze",
            "/api/scan",
            "/api/radar",
            "/api/live",
            "/api/trade-range",
            "/api/health"
          ]
        });
      }

      /* ---------------- STATIC ASSETS ---------------- */

      if(env?.ASSETS){
        return env.ASSETS.fetch(request);
      }

      return json(
        {
          ok:false,
          error:
            "ASSETS binding در Worker موجود نیست."
        },
        500
      );

    }catch(e){

      return json(
        {
          ok:false,
          error:e.message,
          detail:
            String(
              e.stack||""
            ).slice(
              0,
              1500
            )
        },
        500
      );
    }
  }
};
