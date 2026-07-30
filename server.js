const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;

// فایل های html css js از ریشه پروژه
app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/index.html");
});


app.get("/api/pumps", async (req, res) => {

    try {

        const pages = await Promise.all([

            fetch(
                "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&sparkline=false"
            ),

            fetch(
                "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=2&sparkline=false"
            ),

            fetch(
                "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=3&sparkline=false"
            )

        ]);


        const data = [
            ...(await pages[0].json()),
            ...(await pages[1].json()),
            ...(await pages[2].json())
        ];


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
                !blacklist.includes(c.symbol.toLowerCase()) &&
                !c.name.toLowerCase().includes("tokenized") &&
                !c.name.toLowerCase().includes("stock") &&
                !c.name.toLowerCase().includes("etf")
            )


            .sort((a,b) =>
                b.price_change_percentage_24h -
                a.price_change_percentage_24h
            )


            .slice(0,20)


            .map(c => {


                let score = Math.round(

                    Math.min(

                        c.price_change_percentage_24h * 2 +
                        (c.total_volume / c.market_cap) * 100,

                        100

                    )

                );


                return {

                    symbol: c.symbol.toUpperCase(),

                    name: c.name,

                    price: c.current_price,

                    change24h:
                        c.price_change_percentage_24h.toFixed(2),

                    volume: c.total_volume,

                    marketcap: c.market_cap,

                    pumpScore: score,


                    signal:

                        score >= 80
                        ? "🚀 Pump"
                        : score >= 60
                        ? "👀 Watch"
                        : "➖ Normal",


                    dumpRisk:

                        c.price_change_percentage_24h > 80
                        ? 80
                        : c.price_change_percentage_24h > 40
                        ? 50
                        : 10

                };


            });


        res.json(coins);


    } catch (e) {


        console.log(e);


        res.status(500).json({

            error:"CoinGecko Error"

        });


    }


});



app.get("/api/chart/:symbol", async (req, res) => {


    const symbol = req.params.symbol.toLowerCase();


    try {


        const list = await fetch(

            "https://api.coingecko.com/api/v3/coins/list"

        );


        const all = await list.json();


        const coin = all.find(c => c.symbol === symbol);


        if (!coin) {

            return res.json([]);

        }



        const chart = await fetch(

            `https://api.coingecko.com/api/v3/coins/${coin.id}/market_chart?vs_currency=usd&days=1`

        );


        const json = await chart.json();


        const prices = json.prices.map((p,i)=>({

            time:i+1,

            price:p[1]

        }));


        res.json(prices);



    } catch(e) {


        console.log(e);


        res.json([]);


    }


});



app.listen(PORT, () => {

    console.log("Server Started On Port " + PORT);

});
