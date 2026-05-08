const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const sessions = new Map();
const TTL_MS = 2 * 60 * 1000;

function cleanup() {
  const now = Date.now();

  for (const [code, session] of sessions.entries()) {
    if (!session || now - session.updatedAt > TTL_MS) {
      sessions.delete(code);
    }
  }
}

setInterval(cleanup, 15000);

function getSession(code) {
  cleanup();
  return sessions.get(code);
}

app.get("/", (req, res) => {
  res.send("FormForge GPT Translate Backend draait");
});

async function doTranslate(text, from, to) {
  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input:
`Je bent een professionele luchthaven tolk.

Vertaal professioneel, natuurlijk en kort.
Gebruik luchthaven terminologie.
Corrigeer kleine spraakfouten automatisch.
Geef alleen de vertaling terug.

Van taal: ${from}
Naar taal: ${to}

Tekst:
${text}`
  });

  return response.output_text || text;
}

app.post("/translate", async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    const from = String(req.body.from || "auto").trim();
    const to = String(req.body.to || "nl").trim();

    if (!text) {
      return res.json({
        translatedText: ""
      });
    }

    const translated = await doTranslate(text, from, to);

    res.json({
      translatedText: translated,
      translation: translated,
      text: translated,
      result: translated
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      translatedText: req.body.text || ""
    });
  }
});

app.get("/translate", async (req, res) => {
  try {

    const text = String(req.query.text || req.query.q || "").trim();
    const from = String(req.query.from || req.query.source || "auto").trim();
    const to = String(req.query.to || req.query.target || "nl").trim();

    if (!text) {
      return res.json({
        translatedText: ""
      });
    }

    const translated = await doTranslate(text, from, to);

    res.json({
      translatedText: translated,
      translation: translated,
      text: translated,
      result: translated
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      translatedText: req.query.text || ""
    });
  }
});

app.post("/api/signaling/session", (req, res) => {

  const code = String(req.body.code || "").trim();
  const ownerId = String(req.body.ownerId || "").trim();

  if (!/^\d{6}$/.test(code)) {
    return res.status(400).send("Ongeldige code");
  }

  if (!ownerId) {
    return res.status(400).send("ownerId ontbreekt");
  }

  sessions.set(code, {
    code,
    ownerId,
    offerSdp: "",
    answerSdp: "",
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  res.json({
    ok: true,
    code
  });
});

app.post("/api/signaling/offer", (req, res) => {

  const code = String(req.body.code || "").trim();
  const ownerId = String(req.body.ownerId || "").trim();
  const sdp = String(req.body.sdp || "").trim();

  const session = getSession(code);

  if (!session) {
    return res.status(404).send("Sessie niet gevonden");
  }

  if (session.ownerId !== ownerId) {
    return res.status(403).send("Niet toegestaan");
  }

  if (!sdp) {
    return res.status(400).send("sdp ontbreekt");
  }

  session.offerSdp = sdp;
  session.updatedAt = Date.now();

  res.json({
    ok: true
  });
});

app.get("/api/signaling/offer/:code", (req, res) => {

  const session = getSession(req.params.code);

  if (!session) {
    return res.status(404).send("Sessie niet gevonden");
  }

  res.json({
    sdp: session.offerSdp || ""
  });
});

app.post("/api/signaling/answer", (req, res) => {

  const code = String(req.body.code || "").trim();
  const sdp = String(req.body.sdp || "").trim();

  const session = getSession(code);

  if (!session) {
    return res.status(404).send("Sessie niet gevonden");
  }

  if (!sdp) {
    return res.status(400).send("sdp ontbreekt");
  }

  session.answerSdp = sdp;
  session.updatedAt = Date.now();

  res.json({
    ok: true
  });
});

app.get("/api/signaling/answer/:code", (req, res) => {

  const session = getSession(req.params.code);

  if (!session) {
    return res.status(404).send("Sessie niet gevonden");
  }

  res.json({
    sdp: session.answerSdp || ""
  });
});

app.post("/api/signaling/clear", (req, res) => {

  const code = String(req.body.code || "").trim();
  const ownerId = String(req.body.ownerId || "").trim();

  const session = getSession(code);

  if (session && (!ownerId || session.ownerId === ownerId)) {
    sessions.delete(code);
  }

  res.json({
    ok: true
  });
});



app.get("/schiphol/flight/:flightNumber", async (req,res)=>{

  try{

    const flightNumber = String(req.params.flightNumber || "").trim().toUpperCase();

    const url =
      "https://api.schiphol.nl/public-flights/flights" +
      "?flightName=" + encodeURIComponent(flightNumber);

    const response = await fetch(url,{
      headers:{
        "app_id": process.env.SCHIPHOL_APP_ID,
        "app_key": process.env.SCHIPHOL_APP_KEY,
        "ResourceVersion":"v4",
        "Accept":"application/json"
      }
    });

    const raw = await response.text();

    let data;
    try{
      data = JSON.parse(raw);
    }catch(e){
      data = {
        raw: raw
      };
    }

    res.status(response.status).json({
      ok: response.ok,
      status: response.status,
      flightNumber: flightNumber,
      requestUrl: url,
      schipholResponse: data
    });

  }catch(err){

    console.log(err);

    res.status(500).json({
      ok:false,
      error:"Schiphol API fout",
      details:String(err.message || err)
    });

  }

});

app.get("/schiphol/test", async (req,res)=>{

  res.json({
    ok:true,
    message:"Schiphol endpoint staat live",
    example:"/schiphol/flight/KL742"
  });

});


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("FormForge GPT backend draait op poort " + PORT);
});
