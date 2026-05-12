const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();

app.get("/", (req, res) => {
  res.send("FormForge WebSocket Server draait");
});

const server = http.createServer(app);

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("Nieuwe websocket verbinding");

  ws.on("message", (message) => {
    console.log("Ontvangen:", message.toString());

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message.toString());
      }
    });
  });

  ws.send("Verbonden met FormForge websocket server");
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("FormForge GPT backend draait op poort " + PORT);
});
