const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));


app.get("/", (req,res)=>{
    res.send("Pump Scanner Server OK");
});


app.get("/api/pumps",(req,res)=>{

    res.json([
        {
            symbol:"TEST",
            price:100,
            change24h:"5",
            volume:1000000,
            pumpScore:50
        }
    ]);

});


app.listen(PORT,()=>{

console.log("Server running on port "+PORT);

});
