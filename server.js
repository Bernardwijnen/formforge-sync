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



function todayAmsterdamDate(){
  const parts = new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const year = parts.find(p => p.type === "year").value;
  const month = parts.find(p => p.type === "month").value;
  const day = parts.find(p => p.type === "day").value;

  return year + "-" + month + "-" + day;
}

function normalizeFlightNumber(value){
  const raw = String(value || "").toUpperCase().replace(/\s+/g,"").trim();
  const match = raw.match(/^([A-Z]{2,3})0*([0-9]{1,5})$/);

  if(!match){
    return raw;
  }

  return match[1] + String(Number(match[2]));
}

function flightNamesFromObject(f){
  const values = [];

  if(f.flightName) values.push(f.flightName);
  if(f.flightNumber) values.push(f.flightNumber);
  if(f.mainFlight) values.push(f.mainFlight);

  if(f.codeshares && Array.isArray(f.codeshares.codeshares)){
    f.codeshares.codeshares.forEach(x => values.push(x));
  }

  if(Array.isArray(f.codeshares)){
    f.codeshares.forEach(x => values.push(x));
  }

  if(Array.isArray(f.codeshare)){
    f.codeshare.forEach(x => values.push(x));
  }

  return values
    .filter(Boolean)
    .map(normalizeFlightNumber);
}

function getFlightsArray(data){
  if(data && Array.isArray(data.flights)) return data.flights;
  if(data && data._embedded && Array.isArray(data._embedded.flights)) return data._embedded.flights;
  if(Array.isArray(data)) return data;
  return [];
}

async function fetchSchipholPage(scheduleDate,page){
  const url =
    "https://api.schiphol.nl/public-flights/flights" +
    "?scheduleDate=" + encodeURIComponent(scheduleDate) +
    "&page=" + encodeURIComponent(page) +
    "&sort=+scheduleTime";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try{
    const response = await fetch(url,{
      signal: controller.signal,
      headers:{
        "app_id": process.env.SCHIPHOL_APP_ID,
        "app_key": process.env.SCHIPHOL_APP_KEY,
        "ResourceVersion":"v4",
        "Accept":"application/json"
      }
    });

    clearTimeout(timeout);

    const raw = await response.text();

    let data;
    try{
      data = JSON.parse(raw);
    }catch(e){
      data = { raw: raw };
    }

    return {
      ok: response.ok,
      status: response.status,
      url,
      data,
      flights: getFlightsArray(data)
    };

  }catch(err){
    clearTimeout(timeout);
    throw err;
  }
}

app.get("/schiphol/flight/:flightNumber", async (req,res)=>{

  try{

    const requestedRaw = String(req.params.flightNumber || "").trim();
    const requested = normalizeFlightNumber(requestedRaw);
    const scheduleDate = String(req.query.date || todayAmsterdamDate()).trim();

    let searchedPages = 0;
    let found = null;

    for(let page=0; page<25; page++){

      const pageResult = await fetchSchipholPage(scheduleDate,page);
      searchedPages++;

      if(!pageResult.ok){
        return res.status(pageResult.status).json({
          ok:false,
          status:pageResult.status,
          flightNumber:requestedRaw,
          normalizedFlightNumber:requested,
          scheduleDate,
          searchedPages,
          schipholResponse:pageResult.data
        });
      }

      const flights = pageResult.flights;

      if(!flights.length){
        break;
      }

      found = flights.find(f => {
        const names = flightNamesFromObject(f);
        return names.includes(requested);
      });

      if(found){
        break;
      }
    }

    res.json({
      ok:true,
      flightNumber:requestedRaw,
      normalizedFlightNumber:requested,
      scheduleDate,
      found:!!found,
      searchedPages,
      flight:found,
      message:found ? "Vlucht gevonden" : "Vlucht niet gevonden in de opgehaalde Schiphol pagina's van deze datum"
    });

  }catch(err){

    res.status(500).json({
      ok:false,
      error:"Schiphol API fout",
      details:String(err.message || err),
      tip:"Controleer API toegang en probeer eventueel ?date=YYYY-MM-DD toe te voegen."
    });

  }

});

app.get("/schiphol/test", async (req,res)=>{

  res.json({
    ok:true,
    message:"Schiphol endpoint staat live",
    examples:[
      "/schiphol/flight/KL742",
      "/schiphol/flight/KL0843",
      "/schiphol/flight/KL843"
    ],
    today:todayAmsterdamDate()
  });

});


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("FormForge GPT backend draait op poort " + PORT);
});
