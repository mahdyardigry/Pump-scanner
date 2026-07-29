const express = require("express");
const path = require("path");

const app = express();

app.use(express.static(__dirname));

app.get("/", (req,res)=>{
  res.sendFile(path.join(__dirname,"index.html"));
});


app.get("/api/pumps", async (req,res)=>{

try{

const url =
"https://api.binance.com/api/v3/ticker/24hr";

const response = await fetch(url,{
headers:{
"User-Agent":"Mozilla/5.0"
}
});


if(!response.ok){
return res.json({
error:"Binance blocked",
status:response.status
});
}


const data = await response.json();


const list = data
.filter(c=>c.symbol.endsWith("USDT"))
.filter(c=>Number(c.quoteVolume)>1000000)
.sort((a,b)=>
Number(b.priceChangePercent) -
Number(a.priceChangePercent)
)
.slice(0,20);


res.json(list);


}catch(err){

res.json({
error:"Server error",
message:err.message
});

}


});


const PORT = process.env.PORT || 8080;

app.listen(PORT,()=>{
console.log("Pump Scanner running "+PORT);
});
