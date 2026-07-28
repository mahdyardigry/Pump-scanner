
const coins = document.getElementById("coins");
const whale = document.getElementById("whale");
const smart = document.getElementById("smart");

coins.innerHTML = "⏳ درحال دریافت اطلاعات...";

fetch("https://api.binance.com/api/v3/ticker/24hr")
.then(res => res.json())
.then(data => {

const list = data
.filter(c => c.symbol.endsWith("USDT"))
.sort((a,b)=>parseFloat(b.priceChangePercent)-parseFloat(a.priceChangePercent))
.slice(0,20);

coins.innerHTML="";

list.forEach(c=>{

coins.innerHTML+=`
<div style="padding:8px;border-bottom:1px solid #333;">
<b>${c.symbol}</b><br>
🚀 ${parseFloat(c.priceChangePercent).toFixed(2)}%
<br>
📈 Volume :
${Number(c.quoteVolume).toLocaleString()}
</div>
`;

});

})
.catch(()=>{

coins.innerHTML="❌ خطا در دریافت اطلاعات";

});

whale.innerHTML="🐋 نسخه اول آماده شد";
smart.innerHTML="🧠 در نسخه بعدی اضافه می‌شود";
