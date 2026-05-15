const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: true }));
app.use(express.json({ limit: "60mb" }));

const users = {};
const conversations = {};
const messages = {};

function makeId(prefix) {
  return prefix + "_" + crypto.randomBytes(12).toString("hex");
}

function now() {
  return new Date().toISOString();
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    code: user.code,
    lastSeen: user.lastSeen
  };
}

app.get("/", (req, res) => {
  res.send("ECHO Messenger backend online met tekst, foto, bestanden en spraak");
});

app.post("/api/register", (req, res) => {
  const name = String(req.body.name || "").trim();

  if (!name) {
    return res.status(400).json({ error: "Naam is verplicht" });
  }

  const userId = makeId("user");
  const userCode = Math.floor(100000 + Math.random() * 900000).toString();

  users[userId] = {
    id: userId,
    name,
    code: userCode,
    createdAt: now(),
    lastSeen: now()
  };

  res.json({
    ok: true,
    user: users[userId]
  });
});

app.post("/api/login", (req, res) => {
  const userCode = String(req.body.code || "").trim();
  const user = Object.values(users).find(u => u.code === userCode);

  if (!user) {
    return res.status(404).json({ error: "Gebruiker niet gevonden" });
  }

  user.lastSeen = now();

  res.json({
    ok: true,
    user
  });
});

app.get("/api/users/:code", (req, res) => {
  const userCode = String(req.params.code || "").trim();
  const user = Object.values(users).find(u => u.code === userCode);

  if (!user) {
    return res.status(404).json({ error: "Gebruiker niet gevonden" });
  }

  res.json({
    ok: true,
    user: publicUser(user)
  });
});

app.post("/api/conversations", (req, res) => {
  const userId = String(req.body.userId || "").trim();
  const otherCode = String(req.body.otherCode || "").trim();

  const me = users[userId];
  const other = Object.values(users).find(u => u.code === otherCode);

  if (!me) {
    return res.status(404).json({ error: "Eigen gebruiker niet gevonden" });
  }

  if (!other) {
    return res.status(404).json({ error: "Ontvanger niet gevonden" });
  }

  const existing = Object.values(conversations).find(c => {
    return c.members.includes(me.id) && c.members.includes(other.id);
  });

  if (existing) {
    return res.json({ ok: true, conversation: existing });
  }

  const conversationId = makeId("conv");

  conversations[conversationId] = {
    id: conversationId,
    members: [me.id, other.id],
    createdAt: now(),
    updatedAt: now()
  };

  messages[conversationId] = [];

  res.json({
    ok: true,
    conversation: conversations[conversationId]
  });
});

app.get("/api/conversations/:userId", (req, res) => {
  const userId = String(req.params.userId || "").trim();

  if (!users[userId]) {
    return res.status(404).json({ error: "Gebruiker niet gevonden" });
  }

  const list = Object.values(conversations)
    .filter(c => c.members.includes(userId))
    .map(c => {
      const otherId = c.members.find(id => id !== userId);
      const other = users[otherId];
      const allMessages = messages[c.id] || [];
      const lastMessage = allMessages[allMessages.length - 1] || null;
      const unread = allMessages.filter(m => m.receiverId === userId && !m.readAt).length;

      return {
        id: c.id,
        otherUser: publicUser(other),
        lastMessage,
        unread,
        updatedAt: c.updatedAt
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  res.json({
    ok: true,
    conversations: list
  });
});

app.post("/api/messages", (req, res) => {
  const conversationId = String(req.body.conversationId || "").trim();
  const senderId = String(req.body.senderId || "").trim();
  const type = String(req.body.type || "text").trim();
  const text = String(req.body.text || "").trim();
  const fileName = String(req.body.fileName || "").trim();
  const fileType = String(req.body.fileType || "").trim();
  const fileData = String(req.body.fileData || "").trim();
  const fileSize = Number(req.body.fileSize || 0);

  const allowedTypes = ["text", "image", "file", "audio"];

  if (!allowedTypes.includes(type)) {
    return res.status(400).json({ error: "Ongeldig berichttype" });
  }

  const conversation = conversations[conversationId];

  if (!conversation) {
    return res.status(404).json({ error: "Gesprek niet gevonden" });
  }

  if (!conversation.members.includes(senderId)) {
    return res.status(403).json({ error: "Geen toegang tot dit gesprek" });
  }

  if (type === "text" && !text) {
    return res.status(400).json({ error: "Bericht is leeg" });
  }

  if (type !== "text" && !fileData) {
    return res.status(400).json({ error: "Bestand ontbreekt" });
  }

  if (fileData && fileData.length > 45 * 1024 * 1024) {
    return res.status(413).json({ error: "Bestand is te groot" });
  }

  const receiverId = conversation.members.find(id => id !== senderId);

  const message = {
    id: makeId("msg"),
    conversationId,
    senderId,
    receiverId,
    type,
    text,
    fileName,
    fileType,
    fileData,
    fileSize,
    createdAt: now(),
    deliveredAt: now(),
    readAt: null
  };

  messages[conversationId].push(message);
  conversation.updatedAt = message.createdAt;

  res.json({
    ok: true,
    message
  });
});

app.get("/api/messages/:conversationId", (req, res) => {
  const conversationId = String(req.params.conversationId || "").trim();
  const userId = String(req.query.userId || "").trim();

  const conversation = conversations[conversationId];

  if (!conversation) {
    return res.status(404).json({ error: "Gesprek niet gevonden" });
  }

  if (!conversation.members.includes(userId)) {
    return res.status(403).json({ error: "Geen toegang tot dit gesprek" });
  }

  res.json({
    ok: true,
    messages: messages[conversationId] || []
  });
});

app.post("/api/messages/read", (req, res) => {
  const conversationId = String(req.body.conversationId || "").trim();
  const userId = String(req.body.userId || "").trim();

  const conversationMessages = messages[conversationId] || [];

  conversationMessages.forEach(m => {
    if (m.receiverId === userId && !m.readAt) {
      m.readAt = now();
    }
  });

  res.json({
    ok: true
  });
});

app.post("/api/presence", (req, res) => {
  const userId = String(req.body.userId || "").trim();

  if (users[userId]) {
    users[userId].lastSeen = now();
  }

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("ECHO Messenger backend draait op poort " + PORT);
});
