const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/index.html");
});

app.get("/api/pumps", async (req, res) => {
    try {

        const pages = await Promise.all([
            fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&sparkline=false"),
            fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=2&sparkline=false"),
            fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=3&sparkline=false")
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
            .sort((a, b) =>
                b.price_change_percentage_24h -
                a.price_change_percentage_24h
            )
            .slice(0, 20)
            .map(c => {

                const changeScore = Math.min(
                    Math.max(c.price_change_percentage_24h, 0),
                    100
                );

                const volumeScore = Math.min(
                    (c.total_volume / (c.market_cap || 1)) * 100,
                    100
                );

                const marketScore = Math.min(
                    Math.log10(c.total_volume + 1) * 10,
                    100

                    const capScore = Math.max(
    100 - Math.log10(c.market_cap || 1) * 8,
    0
);

const score = Math.round(
    changeScore * 0.40 +
    volumeScore * 0.30 +
    marketScore * 0.20 +
    capScore * 0.10
);

                return {
                    symbol: c.symbol.toUpperCase(),
                    name: c.name,
                    price: c.current_price,
                    change24h: c.price_change_percentage_24h.toFixed(2),
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
                        c.price_change_percentage_24h > 150
                            ? 90
                            : c.price_change_percentage_24h > 80
                                ? 70
                                : c.price_change_percentage_24h > 40
                                    ? 40
                                    : 10
                };

            });

        res.json(coins);

    } catch (e) {

        console.error(e);

        res.status(500).json({
            error: "CoinGecko Error"
        });

    }


});


// ===============================
// Health Check
// ===============================

app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        time: new Date()
    });
});


// ===============================
// Start Server
// ===============================

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
