const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));


// صفحه اصلی
app.get("/", (req, res) => {
    res.sendFile(__dirname + "/index.html");
});


// موتور تحلیل Pump / Dump
function analyzeCoin(coin) {

    let change = Number(coin.change24h);
    let volume = Number(coin.volume);
    let marketcap = Number(coin.marketcap || 1);


    let volumeRatio = volume / marketcap;


    // امتیاز پامپ
    let pumpScore = 0;

    if(change > 5) pumpScore += 20;
    if(change > 15) pumpScore += 25;
    if(volumeRatio > 1) pumpScore += 25;
    if(volumeRatio > 3) pumpScore += 20;
    if(volume > 50000000) pumpScore += 10;


    if(pumpScore > 100)
        pumpScore = 100;



    // ریسک دامپ
    let dumpRisk = 0;

    if(change > 50)
        dumpRisk += 40;

    if(change > 100)
        dumpRisk += 30;

    if(volumeRatio < 0.5)
        dumpRisk += 20;


    if(dumpRisk > 100)
        dumpRisk = 100;



    let signal="👀 Watch";


    if(pumpScore >= 70 && dumpRisk < 50)
        signal="🚀 Pump";

    if(dumpRisk >= 60)
        signal="⚠️ Dump Risk";


    return {
        ...coin,
        volumeRatio: volumeRatio.toFixed(2),
        pumpScore,
        dumpRisk,
        signal
    };

}



// API
app.get("/api/pumps",(req,res)=>{


    let coins=[

        {
            symbol:"ON",
            name:"Orochi",
            price:0.259,
            change24h:"18.24",
            volume:54667120,
            marketcap:35000000
        },

        {
            symbol:"PIPEDOG",
            name:"Pipedog",
            price:0.0034,
            change24h:"313.66",
            volume:65595074,
            marketcap:20000000
        },

        {
            symbol:"EUL",
            name:"Euler",
            price:1.75,
            change24h:"6.25",
            volume:88078568,
            marketcap:49000000
        }

    ];


    let result = coins.map(analyzeCoin);


    res.json(result);


});



app.listen(PORT,()=>{
    console.log("Pump Dump Scanner running on "+PORT);
});
