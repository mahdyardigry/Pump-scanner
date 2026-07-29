const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));


app.get("/", (req,res)=>{
    res.sendFile(path.join(__dirname,"index.html"));
});


// Pump Scanner API
app.get("/api/pumps", async (req,res)=>{

try {

const url =
"https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=100&page=1&sparkline=false";


const response = await fetch(url);


if(!response.ok){
throw new Error("CoinGecko API Error");
}


const coins = await response.json();


const result = coins
.filter(c =>
c.price_change_percentage_24h > 3 &&
c.total_volume > 1000000
)
.map(c=>{


let score = 0;


// تغییر قیمت
score += Math.min(
c.price_change_percentage_24h * 2,
50
);


// حجم
let volumeRatio =
c.total_volume / c.market_cap;


if(volumeRatio > 0.2)
score += 30;
else if(volumeRatio > 0.05)
score += 15;


// محدود کردن امتیاز
score = Math.min(
Math.round(score),
100
);


return {

symbol:c.symbol.toUpperCase(),

name:c.name,

price:c.current_price,

change24h:
c.price_change_percentage_24h
?.toFixed(2),

volume:c.total_volume,

marketcap:c.market_cap,

pumpScore:score

};


});


res.json(result.slice(0,20));


}

catch(err){

console.log(err.message);

res.status(500).json({

error:"Market data unavailable",
message:err.message

});


}


});


app.listen(PORT,()=>{

console.log(
"Pump Scanner running on port "+PORT
);

});
