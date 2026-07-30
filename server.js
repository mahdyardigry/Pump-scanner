const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

app.get("/api/pumps", async (req, res) => {

    try {

        const response = await fetch(
            "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=100&page=1&sparkline=false"
        );

        const data = await response.json();

        const result = data
            .filter(c => c.price_change_percentage_24h !== null)
            .sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h)
            .slice(0, 20)
            .map(c => {

                let score = 0;

                score += Math.min(
                    Math.abs(c.price_change_percentage_24h) * 3,
                    60
                );

                score += Math.min(
                    (c.total_volume / c.market_cap) * 100,
                    40
                );

                score = Math.round(score);

                return {

                    symbol: c.symbol.toUpperCase(),

                    name: c.name,

                    price: c.current_price,

                    change24h: c.price_change_percentage_24h.toFixed(2),

                    volume: c.total_volume,

                    marketcap: c.market_cap,

                    pumpScore: score,

                    signal:
                        score > 80
                            ? "🚀 PUMP"
                            : score > 60
                            ? "👀 WATCH"
                            : "➖ NORMAL",

                    dumpRisk:
                        c.price_change_percentage_24h > 80
                            ? 80
                            : c.price_change_percentage_24h > 40
                            ? 50
                            : 10

                };

            });

        res.json(result);

    } catch (err) {

        console.log(err);

        res.status(500).json({
            error: "API Error"
        });

    }

});

app.get("/api/chart/:symbol", async (req, res) => {

    const symbol = req.params.symbol.toLowerCase();

    try {

        const list = await fetch(
            "https://api.coingecko.com/api/v3/coins/list"
        );

        const coins = await list.json();

        const coin = coins.find(c => c.symbol === symbol);

        if (!coin) {

            return res.json([]);

        }

        const chart = await fetch(
            `https://api.coingecko.com/api/v3/coins/${coin.id}/market_chart?vs_currency=usd&days=1`
        );

        const data = await chart.json();

        res.json(

            data.prices.map((p, i) => ({

                time: i + 1,

                price: p[1]

            }))

        );

    } catch (err) {

        res.json([]);

    }

});

app.listen(PORT, () => {

    console.log("Pump Scanner Started");

});
