const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;


app.use(express.static(__dirname));


// ===============================
// Binance Futures Symbols
// ===============================

async function getFuturesSymbols(){

    try{

        const response = await fetch(
            "https://fapi.binance.com/fapi/v1/exchangeInfo"
        );

        const data = await response.json();


        return data.symbols

        .filter(s =>
            s.quoteAsset === "USDT" &&
            s.status === "TRADING"
        )

        .map(s =>
            s.baseAsset.toLowerCase()
        );


    }

    catch(error){

        console.log(
            "Futures symbols error:",
            error.message
        );

        return [];

    }

}


// ===============================
// OI History Memory
// ===============================

const oiHistory = {};


// ===============================
// Home
// ===============================

app.get("/", (req,res)=>{

    res.sendFile(
        __dirname + "/index.html"
    );

});



// ===============================
// Binance Futures Data
// ===============================

async function getBinanceData(symbol){

    try{


        const oiResponse = await fetch(

            `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}USDT`

        );


        const oiData =
        await oiResponse.json();



        const lsResponse = await fetch(

            `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}USDT&period=5m&limit=1`

        );


        const lsData =
        await lsResponse.json();



        const oi =
        Number(
            oiData.openInterest || 0
        );



        const ratio =

        lsData[0]

        ?

        Number(
            lsData[0].longShortRatio
        )

        :

        1;



        // ذخیره تاریخچه OI

        if(!oiHistory[symbol]){

            oiHistory[symbol]=[];

        }


        oiHistory[symbol].push({

            time:Date.now(),

            oi:oi

        });



        // فقط 12 رکورد آخر نگه دار

        if(oiHistory[symbol].length > 12){

            oiHistory[symbol].shift();

        }



        return {


            oi:oi,


            ratio:ratio,


            oldOi:

            oiHistory[symbol].length > 1

            ?

            oiHistory[symbol][0].oi

            :

            oi



        };


    }


    catch(error){


        return {

            oi:0,

            ratio:1,

            oldOi:0

        };


    }


}


// ===============================
// Pump + Squeeze Scanner
// ===============================


app.get("/api/pumps", async(req,res)=>{


try{


const response = await fetch(

"https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&sparkline=false"

);



if(!response.ok){

throw new Error(
"CoinGecko Error: " + response.status
);

}



let coins = await response.json();


const futuresSymbols =
await getFuturesSymbols();


coins = coins.filter(c =>
    futuresSymbols.includes(
        c.symbol.toLowerCase()
    )
);



const blacklist=[

"usdt",
"usdc",
"dai",
"busd",
"tusd",
"wbtc",
"steth"

];



coins = coins.filter(c =>

c.price_change_percentage_24h != null &&

!blacklist.includes(
c.symbol.toLowerCase()
)

);



coins = coins.slice(0,50);



let results=[];



for(const c of coins){



const symbol =
c.symbol.toUpperCase();



const futures =
await getBinanceData(symbol);



const priceChange =
Number(
c.price_change_percentage_24h
);



const oiChange =

futures.oldOi > 0

?

((futures.oi - futures.oldOi)
/
futures.oldOi) * 100

:

0;




let signal="➖ Normal";

let reason="";




// ===============================
// Short Squeeze Detection
// ===============================


if(

priceChange > 3 &&

oiChange < -3 &&

futures.ratio < 0.9

){


signal="🚀 Short Squeeze";


reason =
"Price ↑ + OI ↓ + Shorts trapped";


}




// ===============================
// Long Squeeze Detection
// ===============================


else if(

priceChange < -3 &&

oiChange < -3 &&

futures.ratio > 1.3

){


signal="🔻 Long Squeeze";


reason =
"Price ↓ + Longs closing";


}




// ===============================
// Smart Money
// ===============================


else if(

priceChange > 5 &&

oiChange > 5

){


signal="💰 Smart Money";


reason =
"Price ↑ + New Positions";


}




const volumeScore =

Math.min(

(c.total_volume /
(c.market_cap || 1))*100,

100

);



const squeezeScore =

Math.min(

Math.abs(oiChange)*5,

100

);



const score = Math.round(

Math.min(priceChange,100) *0.40 +

volumeScore *0.30 +

squeezeScore *0.30

);



results.push({


symbol:symbol,


name:c.name,


price:c.current_price,


change24h:
priceChange.toFixed(2),


volume:c.total_volume,


marketcap:c.market_cap,


openInterest:
Number(futures.oi || 0),


oiChange:
Number(oiChange).toFixed(2),


longShort:
Number(futures.ratio).toFixed(2),


score:score,


signal:signal,


reason:reason


});



}



results.sort((a,b)=>

b.score-a.score

);



res.json(results);



}



catch(error){


console.error(error.message);


res.status(500).json({

error:error.message

});


}


});

// ===============================
// Single Coin OI API
// ===============================

app.get("/api/oi/:symbol", async(req,res)=>{


try{


const symbol =
req.params.symbol.toUpperCase();



const data =
await getBinanceData(symbol);



res.json({

symbol:symbol,

openInterest:data.oi,

oiChange:
"محاسبه شده در اسکنر"


});


}


catch(error){


res.status(500).json({

error:"OI Error"

});


}


});




// ===============================
// Health Check
// ===============================

app.get("/health",(req,res)=>{


res.json({

status:"OK",

time:new Date()

});


});




// ===============================
// Start Server
// ===============================

app.listen(PORT,()=>{


console.log(

`Server running on port ${PORT}`

);


});

