const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors({
  origin: true,
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json({ limit: "50mb" }));

const sessions = {};

app.get("/", (req,res)=>{
  res.send("FormForge ECHO backend online");
});

app.post("/api/signaling/session", (req,res)=>{
  const { code } = req.body;

  sessions[code] = {
    offer:null,
    answer:null,
    createdAt:Date.now()
  };

  res.json({ ok:true });
});

app.post("/api/signaling/offer", (req,res)=>{
  const { code, sdp } = req.body;

  if(!sessions[code]){
    sessions[code] = {};
  }

  sessions[code].offer = sdp;

  res.json({ ok:true });
});

app.get("/api/signaling/offer/:code", (req,res)=>{
  const session = sessions[req.params.code];

  res.json({
    sdp: session && session.offer
      ? session.offer
      : null
  });
});

app.post("/api/signaling/answer", (req,res)=>{
  const { code, sdp } = req.body;

  if(!sessions[code]){
    sessions[code] = {};
  }

  sessions[code].answer = sdp;

  res.json({ ok:true });
});

app.get("/api/signaling/answer/:code", (req,res)=>{
  const session = sessions[req.params.code];

  res.json({
    sdp: session && session.answer
      ? session.answer
      : null
  });
});

app.post("/api/signaling/clear", (req,res)=>{
  const { code } = req.body;

  delete sessions[code];

  res.json({ ok:true });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, ()=>{
  console.log("FormForge ECHO backend draait op poort " + PORT);
});
