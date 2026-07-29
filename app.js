const coins = document.getElementById("coins");

coins.innerHTML="⏳ دریافت اطلاعات...";

fetch("/api/pumps")
.then(res=>res.json())
.then(data=>{

coins.innerHTML="";

data.forEach(c=>{

coins.innerHTML += `
<div style="padding:10px;border-bottom:1px solid #444">
<b>${c.symbol}</b><br>
🚀 رشد: ${Number(c.priceChangePercent).toFixed(2)}%
<br>
💰 حجم: ${Number(c.quoteVolume).toLocaleString()}
</div>
`;

});

})
.catch(err=>{

coins.innerHTML="❌ خطا در دریافت اطلاعات";

});
