const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
const OpenAI = require("openai");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.get("/", (req, res) => {
  res.send("FormForge WebSocket Server draait");
});

async function askOpenAI(text, lang) {
  const input = String(text || "").trim();

  if (!input) {
    return {
      clean_text: "",
      host_text_nl: ""
    };
  }

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Je bent I.R.I.S. Je maakt gesproken tekst schoon en vertaalt naar Nederlands als dat nodig is. Geef alleen geldige JSON terug met clean_text en host_text_nl."
      },
      {
        role: "user",
        content: JSON.stringify({
          text: input,
          lang: lang || "nl"
        })
      }
    ],
    temperature: 0.2
  });

  const raw = completion.choices[0].message.content || "{}";

  try {
    return JSON.parse(raw);
  } catch (e) {
    return {
      clean_text: input,
      host_text_nl: raw
    };
  }
}

app.post("/openai/analyze", async (req, res) => {
  try {
    const result = await askOpenAI(req.body.text, req.body.lang);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: "OpenAI analyse fout",
      details: err.message
    });
  }
});

app.post("/ai/analyze", async (req, res) => {
  try {
    const result = await askOpenAI(req.body.text, req.body.lang);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: "AI analyse fout",
      details: err.message
    });
  }
});

app.post("/analyze", async (req, res) => {
  try {
    const result = await askOpenAI(req.body.text, req.body.lang);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: "Analyse fout",
      details: err.message
    });
  }
});

async function translateText(text, from, to) {
  const input = String(text || "").trim();

  if (!input) return "";
  if (from === to) return input;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Vertaal de tekst zo natuurlijk mogelijk. Geef alleen de vertaling terug, zonder uitleg."
      },
      {
        role: "user",
        content: `Vertaal van ${from} naar ${to}: ${input}`
      }
    ],
    temperature: 0.2
  });

  return completion.choices[0].message.content || input;
}

app.post("/translate", async (req, res) => {
  try {
    const translatedText = await translateText(
      req.body.text || req.body.q,
      req.body.from || req.body.source,
      req.body.to || req.body.target
    );

    res.json({
      translatedText,
      translation: translatedText,
      text: translatedText,
      result: translatedText
    });
  } catch (err) {
    res.status(500).json({
      error: "Vertaal fout",
      details: err.message
    });
  }
});

app.post("/api/translate", async (req, res) => {
  try {
    const translatedText = await translateText(
      req.body.text || req.body.q,
      req.body.from || req.body.source,
      req.body.to || req.body.target
    );

    res.json({
      translatedText,
      translation: translatedText,
      text: translatedText,
      result: translatedText
    });
  } catch (err) {
    res.status(500).json({
      error: "Vertaal fout",
      details: err.message
    });
  }
});

app.get("/translate", async (req, res) => {
  try {
    const translatedText = await translateText(
      req.query.text || req.query.q,
      req.query.from || req.query.source,
      req.query.to || req.query.target
    );

    res.json({
      translatedText,
      translation: translatedText,
      text: translatedText,
      result: translatedText
    });
  } catch (err) {
    res.status(500).json({
      error: "Vertaal fout",
      details: err.message
    });
  }
});

const server = http.createServer(app);

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("Nieuwe websocket verbinding");

  ws.send("Verbonden met FormForge websocket server");

  ws.on("message", (message) => {
    const text = message.toString();

    console.log("Ontvangen:", text);

    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(text);
      }
    });
  });

  ws.on("close", () => {
    console.log("Websocket verbinding gesloten");
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("FormForge GPT backend draait op poort " + PORT);
  console.log("WebSocket draait live");
});
