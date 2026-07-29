const express = require("express");
const path = require("path");

const app = express();

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/pumps", async (req, res) => {
  try {
    const response = await fetch(
      "https://api.binance.com/api/v3/ticker/24hr"
    );

    const data = await response.json();

    const list = data
      .filter(c => c.symbol.endsWith("USDT"))
      .sort(
        (a, b) =>
          parseFloat(b.priceChangePercent) -
          parseFloat(a.priceChangePercent)
      )
      .slice(0, 20);

    res.json(list);

  } catch (error) {
    console.log(error);
    res.status(500).json({
      error: "Binance API failed"
    });
  }
});


const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(
    "Pump Scanner started on port " + PORT
  );
});
