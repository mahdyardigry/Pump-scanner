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
"https://api.lbkex.com/v2/ticker/24hr.do"
);


const text = await response.text();


console.log("LBANK RESPONSE:");
console.log(text);



res.json({

status: response.status,

data:text

});


}catch(e){


console.log("ERROR:",e.message);


res.status(500).json({

error:e.message

});


}

});



const PORT=process.env.PORT || 8080;


app.listen(PORT,()=>{

console.log("Scanner Started");

});
