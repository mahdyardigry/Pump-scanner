const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;


app.use(express.static(__dirname));


app.get("/", (req,res)=>{
    res.sendFile(__dirname + "/index.html");
});



// ===============================
// Binance Futures Helper
// ===============================

async function getBinanceData(symbol){

    try{

        const oiResponse = await fetch(
            `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}USDT`
        );

        const oiData = await oiResponse.json();



        const lsResponse = await fetch(
            `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}USDT&period=5m&limit=1`
        );


        const lsData = await lsResponse.json();



        return {

            oi:Number(oiData.openInterest || 0),

            ratio:
            lsData[0]
            ?
            Number(lsData[0].longShortRatio)
            :
            1

        };


    }


    catch(error){

        return {

            oi:0,

            ratio:1

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
"CoinGecko Status: "+response.status
);

}



let data = await response.json();



const blacklist=[

"usdt",
"usdc",
"dai",
"busd",
"tusd",
"wbtc",
"steth"

];



data=data.filter(c=>

c.price_change_percentage_24h != null &&

!blacklist.includes(
c.symbol.toLowerCase()
)

);



// فقط 50 تای اول برای جلوگیری از فشار API

data=data.slice(0,50);



let results=[];



for(const c of data){


const symbol =
c.symbol.toUpperCase();



const futures =
await getBinanceData(symbol);




const change =
Number(
c.price_change_percentage_24h
);



const volumeScore =
Math.min(

(c.total_volume /
(c.market_cap || 1))*100,

100

);



const changeScore =
Math.min(

Math.max(change,0),

100

);



let squeeze="Normal";



// تشخیص شورت اسکوئیز

if(

change > 5 &&

futures.ratio < 0.9

){

squeeze="🚀 Short Squeeze";

}



// تشخیص خطر لانگ اسکوئیز

else if(

change < -5 &&

futures.ratio > 1.4

){

squeeze="🔻 Long Squeeze Risk";

}




const score =
Math.round(

changeScore*0.45 +

volumeScore*0.35 +

(Math.min(futures.ratio*40,100))*0.20

);



results.push({

symbol,

name:c.name,

price:c.current_price,


change24h:
change.toFixed(2),


volume:c.total_volume,


marketcap:c.market_cap,


openInterest:
futures.oi,


longShort:
futures.ratio.toFixed(2),


pumpScore:score,


signal:squeeze,


dumpRisk:

change>100
?
80
:
change>50
?
50
:
10


});


}



results.sort((a,b)=>

b.pumpScore-a.pumpScore

);



res.json(results);



}


catch(error){


console.error(
error.message
);


res.status(500).json({

error:error.message

});


}


});
