const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;

// فایل های سایت
app.use(express.static(path.join(__dirname, "public")));


app.get("/api/pumps", (req,res)=>{

res.json([
{
symbol:"BTC",
name:"Bitcoin",
price:64375,
change24h:"1.60",
volume:24639003402,
pumpScore:72
},
{
symbol:"EUL",
name:"Euler",
price:1.82,
change24h:"19.10",
volume:91203179,
pumpScore:95
},
{
symbol:"ON",
name:"Orochi",
price:0.247,
change24h:"37.30",
volume:44391994,
pumpScore:99
}
]);

});


app.get("*",(req,res)=>{
res.sendFile(path.join(__dirname,"public","index.html"));
});


app.listen(PORT,()=>{
console.log("Server running on "+PORT);
});
