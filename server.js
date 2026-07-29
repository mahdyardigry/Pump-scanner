const express = require("express");
const path = require("path");

const app = express();

app.use(express.static(__dirname));


app.get("/", (req,res)=>{
    res.sendFile(path.join(__dirname,"index.html"));
});



// LBank Pump Scanner
app.get("/api/pumps", async(req,res)=>{

try{


const response = await fetch(
"https://api.lbkex.com/v2/ticker.do"
);



const json = await response.json();



console.log("LBANK RESPONSE");
console.log(JSON.stringify(json));



// پیدا کردن لیست دیتا با هر ساختاری
let list = [];

if(Array.isArray(json)){
    list = json;
}

else if(Array.isArray(json.data)){
    list = json.data;
}

else if(Array.isArray(json.tickers)){
    list = json.tickers;
}

else if(json.data && typeof json.data === "object"){

    list = Object.values(json.data);

}



if(list.length === 0){

return res.json({

error:"No coin data from LBank",

raw:json

});

}




let coins = list.map(c=>{


return {


symbol:
(c.symbol || c.pair || "")
.toUpperCase(),


price:
Number(
c.latest ||
c.price ||
c.last ||
0
),


change24h:
Number(
c.change ||
c.change24h ||
c.rate ||
0
).toFixed(2),


volume:
Number(
c.vol ||
c.volume ||
0
)



};


})




.filter(c=>

c.symbol.includes("USDT")

)



.sort((a,b)=>

Number(b.change24h) -
Number(a.change24h)

)



.slice(0,50);



res.json(coins);



}catch(error){


console.log(error);


res.status(500).json({

error:"LBank API Error",

message:error.message

});


}


});





const PORT =
process.env.PORT || 8080;



app.listen(PORT,()=>{

console.log(
"Pump Scanner running on port "+PORT
);

});
