const express = require("express");
const path = require("path");

const app = express();

app.use(express.static(__dirname));


app.get("/", (req,res)=>{
  res.sendFile(path.join(__dirname,"index.html"));
});


// Cache
let cacheData = null;
let cacheTime = 0;

const CACHE_DURATION = 60000; // 60 seconds



async function getCoins(){

    const now = Date.now();

    // اگر داده جدید داریم از کش بده
    if(cacheData && (now - cacheTime < CACHE_DURATION)){
        return cacheData;
    }


    const url =
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=100&page=1";


    const response = await fetch(url);


    if(!response.ok){

        throw new Error(
            "CoinGecko status "+response.status
        );

    }


    const data = await response.json();


    const result = data
    .filter(c=>c.symbol)
    .map(c=>({

        symbol:c.symbol.toUpperCase(),

        name:c.name,

        price:c.current_price,

        change24h:
        c.price_change_percentage_24h || 0,

        volume:
        c.total_volume || 0,

        marketcap:
        c.market_cap || 0,

        image:c.image

    }));


    cacheData = result;

    cacheTime = now;


    return result;

}




app.get("/api/pumps", async(req,res)=>{


try{


const coins = await getCoins();


// حذف استیبل کوین ها
const filtered = coins.filter(c=>

![
"USDT",
"USDC",
"USDS",
"DAI"
]
.includes(c.symbol)

);


// مرتب بر اساس رشد
const pumps = filtered
.sort((a,b)=>
b.change24h-a.change24h
)
.slice(0,20);



res.json(pumps);



}catch(error){


console.log(error.message);


// اگر قبلا داده داشتیم همان را بده
if(cacheData){

return res.json(cacheData.slice(0,20));

}


res.status(500).json({

error:"Data temporarily unavailable"

});


}



});



const PORT =
process.env.PORT || 8080;


app.listen(PORT,()=>{

console.log(
"Pump Scanner running on "+PORT
);

});
