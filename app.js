
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
        <div style="padding:8px;border-bottom:1px solid #333;">
            <b>${c.symbol}</b><br>
            🚀 تغییر قیمت:
            ${parseFloat(c.priceChangePercent).toFixed(2)}%
            <br>
            📈 Volume:
            ${Number(c.quoteVolume).toLocaleString()}
        </div>
        `;

    });

})
.catch(error => {

    console.log(error);
    coins.innerHTML = "❌ خطا در دریافت اطلاعات";

});


whale.innerHTML = "🐋 نسخه اول آماده شد";
smart.innerHTML = "🧠 در نسخه بعدی اضافه می‌شود";
