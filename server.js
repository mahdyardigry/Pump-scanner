const express = require("express");
const path = require("path");

const app = express();

app.use(express.static(__dirname));


let cache = [];
let lastUpdate = 0;


app.get("/", (req,res)=>{
    res.sendFile(path.join(__dirname,"index.html"));
});


app.get("/api/pumps", async(req,res)=>{

try{


if(cache.length && Date.now()-lastUpdate < 60000){
    return res.json(cache);
}



const response = await fetch(
"https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=100&page=1&sparkline=false"
);



if(!response.ok){
throw new Error("CoinGecko "+response.status);
}



const data = await response.json();



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
!stable.includes(
(c.symbol || "").toUpperCase()
)
)


.filter(c =>
Number(c.price_change_percentage_24h || 0) > 3
)


.map(c=>({

symbol:(c.symbol || "").toUpperCase(),

name:c.name,

price:c.current_price || 0,

change24h:
Number(c.price_change_percentage_24h || 0)
.toFixed(2),

volume:c.total_volume || 0,

marketcap:c.market_cap || 0,

volumeRatio:
c.market_cap ?
((c.total_volume/c.market_cap)*100).toFixed(2)
:
"0",

image:c.image || ""

}))


.sort((a,b)=>
Number(b.change24h)-Number(a.change24h)
)


.slice(0,20);



cache=coins;
lastUpdate=Date.now();


res.json(coins);



}catch(error){


console.log(error.message);



if(cache.length){
return res.json(cache);
}


res.status(500).json({
error:"Data error"
});


}


});



const PORT=process.env.PORT || 8080;


app.listen(PORT,()=>{
console.log(
"Pump Scanner running "+PORT
);
});
