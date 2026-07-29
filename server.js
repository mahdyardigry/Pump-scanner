const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// فایل‌های استاتیک از پوشه اصلی
app.use(express.static(__dirname));

const coins = [
  {
    symbol: "ON",
    name: "Orochi",
    price: 0.259,
    change24h: "18.24",
    volume: 54667120,
    marketcap: 35000000,
    pumpScore: 80,
    dumpRisk: 0,
    signal: "🚀 Pump"
  },
  {
    symbol: "PIPEDOG",
    name: "Pipedog",
    price: 0.0034,
    change24h: "313.66",
    volume: 65595074,
    marketcap: 20000000,
    pumpScore: 100,
    dumpRisk: 70,
    signal: "⚠️ Dump Risk"
  },
  {
    symbol: "EUL",
    name: "Euler",
    price: 1.75,
    change24h: "6.25",
    volume: 88078568,
    marketcap: 49000000,
    pumpScore: 55,
    dumpRisk: 0,
    signal: "👀 Watch"
  }
];

// لیست ارزها
app.get("/api/pumps", (req, res) => {
  res.json(coins);
});

// چارت هر ارز
app.get("/api/chart/:symbol", (req, res) => {

  const symbol = req.params.symbol.toUpperCase();

  const coin = coins.find(c => c.symbol === symbol);

  if (!coin) {
    return res.status(404).json({
      error: "Symbol not found"
    });
  }

  let data = [];
  let price = Number(coin.price);

  for (let i = 1; i <= 50; i++) {

    price = price + (Math.random() - 0.45) * (price * 0.02);

    data.push({
      time: i,
      price: Number(price.toFixed(6))
    });
  }

  res.json(data);
});

// صفحه اصلی
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log("Pump Scanner running on port " + PORT);
});
