const coins = document.getElementById("coins");


fetch("/api/pumps")

.then(res=>res.json())

.then(data=>{

coins.innerHTML="";


data.forEach(c=>{

coins.innerHTML += `

<div style="
border:1px solid #444;
padding:10px;
margin:10px;
border-radius:10px;
">

<h3>${c.symbol}</h3>

قیمت: ${c.price}

<br>

تغییر 24h:
🚀 ${c.change24h}%

<br>

حجم:
📊 ${Number(c.volume).toLocaleString()}

<br>

امتیاز پامپ:
🔥 ${c.pumpScore}

</div>

`;

});


})

.catch(e=>{

coins.innerHTML="خطا در دریافت اطلاعات";

});
