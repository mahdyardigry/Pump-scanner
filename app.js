const coins = document.getElementById("coins");
const whale = document.getElementById("whale");
const smart = document.getElementById("smart");

coins.innerHTML = "⏳ درحال دریافت اطلاعات...";

fetch("/api/pumps")
.then(res => res.json())
.then(data => {

    coins.innerHTML = "";

    data.forEach(c => {

        coins.innerHTML += `
        <div style="
        padding:10px;
        border-bottom:1px solid #333;
        ">
        <b>${c.symbol}</b><br>

        🚀 تغییر:
        ${parseFloat(c.priceChangePercent).toFixed(2)} %

        <br>

        💰 قیمت:
        ${parseFloat(c.lastPrice).toFixed(6)}

        <br>

        📊 حجم:
        ${Number(c.quoteVolume).toLocaleString()}

        </div>
        `;

    });

})
.catch(error => {

    console.log(error);

    coins.innerHTML =
    "❌ خطا در دریافت اطلاعات";

});


whale.innerHTML =
"🐋 Whale Scanner آماده شد";


smart.innerHTML =
"🧠 Smart Money در نسخه بعدی اضافه می‌شود";
