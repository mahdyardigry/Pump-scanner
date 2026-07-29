const coins = document.getElementById("coins");
const whale = document.getElementById("whale");
const smart = document.getElementById("smart");


coins.innerHTML = "⏳ دریافت اطلاعات...";


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

<b>${c.symbol}</b> - ${c.name}

<br>

💵 قیمت:
${c.price}

<br>

🚀 تغییر 24h:
${c.change24h}%

<br>

📊 حجم:
${Number(c.volume).toLocaleString()}

<br>

🏦 Market Cap:
${Number(c.marketcap).toLocaleString()}

</div>

`;

});


})
.catch(err=>{

coins.innerHTML="❌ خطا در نمایش اطلاعات";

console.log(err);

});


whale.innerHTML="🐋 Whale Scanner آماده شد";

smart.innerHTML="🧠 Smart Money در نسخه بعدی اضافه می‌شود";
