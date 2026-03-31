const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

let sessions = {};

app.post("/offer", (req, res) => {
  const { code, offer } = req.body;
  sessions[code] = sessions[code] || {};
  sessions[code].offer = offer;
  res.json({ status: "ok" });
});

app.get("/offer/:code", (req, res) => {
  const session = sessions[req.params.code];
  if (session && session.offer) {
    res.json({ offer: session.offer });
  } else {
    res.json({});
  }
});

app.post("/answer", (req, res) => {
  const { code, answer } = req.body;
  sessions[code] = sessions[code] || {};
  sessions[code].answer = answer;
  res.json({ status: "ok" });
});

app.get("/answer/:code", (req, res) => {
  const session = sessions[req.params.code];
  if (session && session.answer) {
    res.json({ answer: session.answer });
  } else {
    res.json({});
  }
});

app.post("/candidate", (req, res) => {
  const { code, candidate } = req.body;
  sessions[code] = sessions[code] || {};
  sessions[code].candidates = sessions[code].candidates || [];
  sessions[code].candidates.push(candidate);
  res.json({ status: "ok" });
});

app.get("/candidate/:code", (req, res) => {
  const session = sessions[req.params.code];
  if (session && session.candidates) {
    res.json({ candidates: session.candidates });
  } else {
    res.json({ candidates: [] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
