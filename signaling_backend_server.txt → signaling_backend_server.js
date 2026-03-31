const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

let rooms = {};

app.post("/join", (req, res) => {
  const { roomId, data } = req.body;

  if (!rooms[roomId]) {
    rooms[roomId] = [];
  }

  rooms[roomId].push(data);

  res.json({ success: true });
});

app.get("/poll/:roomId", (req, res) => {
  const roomId = req.params.roomId;

  if (!rooms[roomId]) {
    return res.json([]);
  }

  const messages = rooms[roomId];
  rooms[roomId] = [];

  res.json(messages);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
