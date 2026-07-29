const express = require("express");
const path = require("path");

const app = express();

app.use(express.static(__dirname));

let cache = [];
let lastUpdate = 0;


// صفحه اصلی
app.get("/", (req,res)=>{
    res.sendFile(path.join(__dirname,"index.html"));
});


// دریافت پامپ ها
app.get("/api/pumps", async(req,res)=>{

    try {

        // هر 60 ثانیه فقط یک بار از CoinGecko بگیر
        if(cache.length > 0 && Date.now() - lastUpdate < 60000){
            return res.json(cache);
        }


        const url =
        "https://api.coingecko.com/api/v3/coins/markets"+
        "?vs_currency=usd"+
        "&order=percent_change_24h_desc"+
        "&per_page=50"+
        "&page=1"+
        "&sparkline=false";


        const response = await fetch(url,{
            headers:{
                "accept":"application/json",
                "user-agent":"PumpScanner"
            }
        });


        if(!response.ok){
            throw new Error(
                "CoinGecko status "+response.status
            );
        }


        const data = await response.json();


        const coins = data.map(c=>({

            symbol:c.symbol.toUpperCase(),

            name:c.name,

            price:c.current_price,

            change24h:
            Number(c.price_change_percentage_24h || 0)
            .toFixed(2),

            volume:c.total_volume,

            marketcap:c.market_cap,

            image:c.image

        }));


        cache = coins;

        lastUpdate = Date.now();


        res.json(coins);


    }catch(error){


        console.log(error.message);


        // اگر API خراب شد اطلاعات قبلی را بده
        if(cache.length){
            return res.json(cache);
        }


        res.status(500).json({

            error:"Data provider unavailable"

        });

    }

});



const PORT = process.env.PORT || 8080;


app.listen(PORT,()=>{

console.log(
"Pump Scanner running on "+PORT
);

});
