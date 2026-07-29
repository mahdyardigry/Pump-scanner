const express = require("express");
const path = require("path");

const app = express();

app.use(express.static(__dirname));

app.get("/", (req,res)=>{
    res.sendFile(path.join(__dirname,"index.html"));
});


let cache = {
    data:null,
    time:0
};


async function getCoins(){

    // استفاده از کش
    if(cache.data && Date.now()-cache.time < 30000){
        return cache.data;
    }


    const url =
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&sparkline=false";


    const response = await fetch(url);


    if(!response.ok){
        throw new Error("CoinGecko status "+response.status);
    }


    const data = await response.json();



    const result = data

    .filter(c=>c.volume > 1000000)

    .map(c=>{


        let volumeRatio =
        c.volume / c.market_cap;


        let pumpScore =
        (
          Number(c.price_change_percentage_24h || 0)
          * 0.5
          +
          volumeRatio * 100
          * 0.5
        ).toFixed(2);



        return {

            symbol:c.symbol.toUpperCase(),

            name:c.name,

            price:c.current_price,

            change24h:
            Number(
            c.price_change_percentage_24h || 0
            ).toFixed(2),

            volume:c.total_volume,

            marketcap:c.market_cap,

            volumeRatio:
            volumeRatio.toFixed(2),

            pumpScore:pumpScore,

            image:c.image
        };


    })



    .sort((a,b)=>
        b.pumpScore-a.pumpScore
    )


    .slice(0,50);



    cache.data=result;
    cache.time=Date.now();


    return result;

}




app.get("/api/pumps",async(req,res)=>{


try{


const coins=await getCoins();


res.json(coins);



}catch(error){


console.log(error.message);


res.status(500).json({

error:"Market data unavailable",

message:error.message

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
