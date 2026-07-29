const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));


const coins = [
{
symbol:"ON",
name:"Orochi",
price:0.259,
change24h:"18.24",
volume:54667120,
marketcap:35000000,
pumpScore:80,
dumpRisk:0,
signal:"🚀 Pump"
},

{
symbol:"PIPEDOG",
name:"Pipedog",
price:0.0034,
change24h:"313.66",
volume:65595074,
marketcap:20000000,
pumpScore:100,
dumpRisk:70,
signal:"⚠️ Dump Risk"
},

{
symbol:"EUL",
name:"Euler",
price:1.75,
change24h:"6.25",
volume:88078568,
marketcap:49000000,
pumpScore:55,
dumpRisk:0,
signal:"👀 Watch"
}

];



// لیست پامپ ها

app.get("/api/pumps",(req,res)=>{

res.json(coins);

});




// دیتای چارت

app.get("/api/chart/:symbol",(req,res)=>{


let symbol=req.params.symbol;


let coin=coins.find(
c=>c.symbol===symbol
);


if(!coin){

return res.json([]);

}



let data=[];


let price=coin.price;



for(let i=0;i<50;i++){

price += (Math.random()-0.45)*(price*0.03);


data.push({

time:i+1,

price:Number(price.toFixed(6))

});


}



res.json(data);


});





app.get("/",(req,res)=>{

res.sendFile(__dirname+"/public/index.html");

});




app.listen(PORT,()=>{

console.log("Server running "+PORT);

});
