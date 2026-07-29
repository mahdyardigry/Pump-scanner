
const stable = [
"USDT",
"USDC",
"DAI",
"USDS",
"USD1",
"USDE",
"USDD",
"RLUSD",
"PYUSD"
];


const coins = data

.filter(c => 
 !stable.includes(c.symbol.toUpperCase())
)

.filter(c =>
 Number(c.price_change_percentage_24h) > 3
)

.map(c=>({

symbol:c.symbol.toUpperCase(),

name:c.name,

price:c.current_price,

change24h:
Number(c.price_change_percentage_24h || 0)
.toFixed(2),

volume:c.total_volume,

marketcap:c.market_cap,

volumeRatio:
((c.total_volume / c.market_cap)*100)
.toFixed(2),

image:c.image

}))


.sort((a,b)=>
Number(b.change24h)-Number(a.change24h)
)

.slice(0,20);
