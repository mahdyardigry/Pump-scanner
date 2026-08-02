const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;


app.use(express.static(__dirname));


app.get("/", (req,res)=>{
    res.sendFile(__dirname + "/index.html");
});



// ===============================
// Pump Scanner API
// ===============================

app.get("/api/pumps", async (req,res)=>{

    try{


        const response = await fetch(
            "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&sparkline=false"
        );


        if(!response.ok){

            throw new Error(
                "CoinGecko Status: " + response.status
            );

        }


        const data = await response.json();



        const blacklist = [
            "usdt",
            "usdc",
            "dai",
            "busd",
            "tusd",
            "wbtc",
            "steth"
        ];



        const coins = data

        .filter(c =>

            c.price_change_percentage_24h != null &&

            !blacklist.includes(
                c.symbol.toLowerCase()
            )

        )


        .sort((a,b)=>

            b.price_change_percentage_24h -
            a.price_change_percentage_24h

        )


        .slice(0,20)



        .map(c=>{


            const changeScore =
            Math.min(
                Math.max(
                    c.price_change_percentage_24h,
                    0
                ),
                100
            );



            const volumeScore =
            Math.min(
                (c.total_volume /
                (c.market_cap || 1))*100,
                100
            );



            const marketScore =
            Math.min(
                Math.log10(
                    c.total_volume + 1
                ) * 10,
                100
            );



            const score = Math.round(

                changeScore * 0.45 +

                volumeScore * 0.35 +

                marketScore * 0.20

            );



            return {

                symbol:
                c.symbol.toUpperCase(),


                name:
                c.name,


                price:
                c.current_price,


                change24h:
                c.price_change_percentage_24h
                .toFixed(2),


                volume:
                c.total_volume,


                marketcap:
                c.market_cap,


                pumpScore:
                score,


                signal:

                score >=80
                ? "🚀 Pump"

                :

                score >=60
                ? "👀 Watch"

                :

                "➖ Normal",



                dumpRisk:

                c.price_change_percentage_24h >150
                ?90

                :

                c.price_change_percentage_24h >80
                ?70

                :

                c.price_change_percentage_24h >40
                ?40

                :

                10


            };


        });



        res.json(coins);



    }


    catch(error){


        console.error(
            "API ERROR:",
            error.message
        );


        res.status(500).json({

            error:error.message

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
