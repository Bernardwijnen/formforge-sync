const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const sessions = new Map();
const TTL_MS = 2 * 60 * 1000;

function cleanup() {
  const now = Date.now();
  for (const [code, session] of sessions.entries()) {
    if (!session || (now - session.updatedAt) > TTL_MS) {
      sessions.delete(code);
    }
  }
}

setInterval(cleanup, 15000);

function getSession(code) {
  cleanup();
  return sessions.get(code);
}

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

  res.json({ ok: true, code });
});

app.post("/api/signaling/offer", (req, res) => {
  const code = String(req.body.code || "").trim();
  const ownerId = String(req.body.ownerId || "").trim();
  const sdp = String(req.body.sdp || "").trim();

  const session = getSession(code);
  if (!session) return res.status(404).send("Sessie niet gevonden");
  if (session.ownerId !== ownerId) return res.status(403).send("Niet toegestaan");
  if (!sdp) return res.status(400).send("sdp ontbreekt");

  session.offerSdp = sdp;
  session.updatedAt = Date.now();
  res.json({ ok: true });
});

app.get("/api/signaling/offer/:code", (req, res) => {
  const session = getSession(req.params.code);
  if (!session) return res.status(404).send("Sessie niet gevonden");
  res.json({ sdp: session.offerSdp || "" });
});

app.post("/api/signaling/answer", (req, res) => {
  const code = String(req.body.code || "").trim();
  const sdp = String(req.body.sdp || "").trim();

  const session = getSession(code);
  if (!session) return res.status(404).send("Sessie niet gevonden");
  if (!sdp) return res.status(400).send("sdp ontbreekt");

  session.answerSdp = sdp;
  session.updatedAt = Date.now();
  res.json({ ok: true });
});

app.get("/api/signaling/answer/:code", (req, res) => {
  const session = getSession(req.params.code);
  if (!session) return res.status(404).send("Sessie niet gevonden");
  res.json({ sdp: session.answerSdp || "" });
});

app.post("/api/signaling/clear", (req, res) => {
  const code = String(req.body.code || "").trim();
  const ownerId = String(req.body.ownerId || "").trim();

  const session = getSession(code);
  if (session && (!ownerId || session.ownerId === ownerId)) {
    sessions.delete(code);
  }

  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Signaling backend draait op poort " + PORT);
});
