const express = require("express");
const path = require("path");

const app = express();

app.use(express.static(__dirname));


app.get("/", (req,res)=>{
  res.sendFile(path.join(__dirname,"index.html"));
});


// Pump Scanner API
app.get("/api/pumps", async (req,res)=>{

try{

const response = await fetch(
"https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=percent_change_24h_desc&per_page=20&page=1&sparkline=false"
);


if(!response.ok){

return res.json({
error:"CoinGecko API Error",
status:response.status
});

}


const data = await response.json();


const list = data.map(c=>({

symbol:c.symbol.toUpperCase(),
name:c.name,

price:c.current_price,

change24h:
c.price_change_percentage_24h,

volume:
c.total_volume,

marketcap:
c.market_cap,

image:c.image

}));


res.json(list);


}catch(error){

res.status(500).json({

error:"Server Error",
message:error.message

});

}


});



const PORT = process.env.PORT || 8080;


app.listen(PORT,()=>{

console.log(
"Pump Scanner running on port "+PORT
);

});
