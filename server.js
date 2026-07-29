const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;


// LBank Futures ticker
app.get("/api/pumps", async (req,res)=>{

try{


const url =
"https://api.lbkex.com/v2/ticker.do";


const response = await axios.get(url,{
timeout:10000
});


let raw=response.data;


// بررسی جواب
if(!raw || !raw.data){

return res.json({
error:"No LBank data",
raw:raw
});

}


let coins=[];


Object.keys(raw.data).forEach(symbol=>{


let c=raw.data[symbol];


if(!c) return;


let price=Number(c.latest);


let change=Number(c.change24h || 0);


let volume=Number(c.vol || 0);



if(change>3 && volume>100000){


coins.push({

symbol:symbol.toUpperCase(),

price,

change24h:change.toFixed(2),

volume,

pumpScore:
Math.round(
(change*5)+(Math.log10(volume)*10)
)

});


}



});



// مرتب سازی پامپ

coins.sort((a,b)=>
b.pumpScore-a.pumpScore
);



res.json(coins.slice(0,50));



}catch(e){


console.log(e.message);


res.status(500).json({

error:"LBank connection failed",

message:e.message

});


}


});



app.listen(PORT,()=>{

console.log(
"Pump Scanner running on "+PORT
);

});
