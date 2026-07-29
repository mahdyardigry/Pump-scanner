const coins = document.getElementById("coins");

coins.innerHTML = "⏳ در حال دریافت اطلاعات...";

fetch("/api/pumps")
  .then(res => res.json())
  .then(data => {

    coins.innerHTML = "";

    data.forEach(c => {

      let color = "#00ff66";

      if (c.pumpScore >= 90) color = "#ff0000";
      else if (c.pumpScore >= 70) color = "#ff9800";
      else if (c.pumpScore >= 50) color = "#ffee00";

      coins.innerHTML += `
      <div style="
        background:#1b1b1b;
        border:1px solid #333;
        border-radius:12px;
        padding:15px;
        margin:12px 0;
      ">

        <h3 style="margin:0;color:white">
          ${c.symbol}
        </h3>

        <div style="color:#aaa">
          ${c.name || ""}
        </div>

        <br>

        💵 Price :
        <b>${c.price}</b>

        <br>

        🚀 24h :
        <span style="color:#00ff66">
        ${c.change24h}%
        </span>

        <br>

        📊 Volume :
        ${Number(c.volume).toLocaleString()}

        <br><br>

        Pump Score

        <div style="
          background:#333;
          border-radius:8px;
          overflow:hidden;
          height:20px;
        ">

          <div style="
            width:${c.pumpScore}%;
            background:${color};
            height:100%;
            text-align:center;
            color:white;
            font-size:12px;
          ">
            ${c.pumpScore}
          </div>

        </div>

        <br>

        <button onclick="window.open('https://www.tradingview.com/chart/?symbol=BINANCE:${c.symbol}USDT')">
        📈 Chart
        </button>

      </div>
      `;
    });

  })
  .catch(err => {

    console.log(err);

    coins.innerHTML = "❌ خطا در دریافت اطلاعات";

  });
