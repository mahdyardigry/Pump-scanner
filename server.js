const express = require("express");
const path = require("path");

const app = express();

app.use(express.static(__dirname));


app.get("/",(req,res)=>{
    res.sendFile(path.join(__dirname,"index.html"));
});


app.get("/api/pumps", async(req,res)=>{

try{

const response = await fetch(
"https://api.lbkex.com/v2/ticker.do"
);


const json = await response.json();


let coins = json.data.map(c=>{

return {

symbol:c.symbol,
price:Number(c.latest),
change24h:Number(c.change).toFixed(2),
volume:Number(c.vol)

};

})


.filter(c=>c.symbol.includes("usdt"))


.sort((a,b)=>
b.change24h-a.change24h
)


.slice(0,50);



res.json(coins);



}catch(e){

console.log(e.message);

res.status(500).json({

error:"LBank API Error",
message:e.message

});

}


});


const PORT=process.env.PORT || 8080;


app.listen(PORT,()=>{

console.log("Pump Scanner Started");

});
