const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const GROUP_ID = "familie_ben_001";
const OWNER_NAME = "Ben";

const GROUP_MEMBERS = [
  {
    id: "user_ben",
    name: "Ben",
    phone: "0618391659",
    email: "bernardwijnen@gmail.com",
    groupId: GROUP_ID,
    role: "owner",
    code: "725524"
  },
  {
    id: "user_linda",
    name: "Linda",
    phone: "0642741759",
    email: "curfslinda@gmail.com",
    groupId: GROUP_ID,
    role: "member",
    code: "100001"
  },
  {
    id: "user_branko",
    name: "Branko",
    phone: "0615474917",
    email: "brankowijnen2@gmail.com",
    groupId: GROUP_ID,
    role: "member",
    code: "100002"
  },
  {
    id: "user_romy",
    name: "Romy",
    phone: "0615637231",
    email: "romywijnen20062006@gmail.com",
    groupId: GROUP_ID,
    role: "member",
    code: "100003"
  },
  {
    id: "user_ron_bakkers",
    name: "Ron Bakkers",
    phone: "0653222539",
    email: "ron@bakkersgeleen.nl",
    groupId: GROUP_ID,
    role: "member",
    code: "100004"
  },
  {
    id: "user_harrie_veltman",
    name: "Harrie Veltman",
    phone: "0648936144",
    email: "hawveltman@home.nl",
    groupId: GROUP_ID,
    role: "member",
    code: "100005"
  },
  {
    id: "user_melvin",
    name: "Melvin",
    phone: "0637917415",
    email: "vertinosdesign@gmail.com",
    groupId: GROUP_ID,
    role: "member",
    code: "100006"
  }
];

const users = new Map();
const conversations = new Map();
const messages = new Map();

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    groupId: user.groupId,
    role: user.role,
    code: user.code,
    lastSeen: user.lastSeen || null
  };
}

function seedUsers() {
  GROUP_MEMBERS.forEach((member) => {
    users.set(member.id, {
      ...member,
      lastSeen: null
    });
  });
}

function findMember({ name, phone, email, code }) {
  const n = normalize(name);
  const p = normalizePhone(phone);
  const e = normalize(email);
  const c = String(code || "").trim();

  return Array.from(users.values()).find((user) => {
    const byCode = c && user.code === c;
    const byEmail = e && normalize(user.email) === e;
    const byPhone = p && normalizePhone(user.phone) === p;
    const byName = n && normalize(user.name) === n;
    return byCode || byEmail || byPhone || byName;
  }) || null;
}

function touchUser(userId) {
  const user = users.get(userId);
  if (user) {
    user.lastSeen = new Date().toISOString();
  }
  return user;
}

function conversationIdFor(userA, userB) {
  return [userA.id, userB.id].sort().join("__");
}

function ensureConversation(userA, userB) {
  if (!userA || !userB) {
    throw new Error("Gebruiker niet gevonden");
  }

  if (userA.groupId !== userB.groupId) {
    throw new Error("Deze gebruikers zitten niet in dezelfde gesloten groep");
  }

  const id = conversationIdFor(userA, userB);

  if (!conversations.has(id)) {
    conversations.set(id, {
      id,
      groupId: userA.groupId,
      participants: [userA.id, userB.id],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedFor: {}
    });
    messages.set(id, []);
  }

  return conversations.get(id);
}

function getOtherUser(conv, userId) {
  const otherId = conv.participants.find((id) => id !== userId);
  return users.get(otherId);
}

function getVisibleMessages(convId, userId) {
  return (messages.get(convId) || []).filter((msg) => {
    return !msg.deletedFor || !msg.deletedFor[userId];
  });
}

function getLastVisibleMessage(convId, userId) {
  const visible = getVisibleMessages(convId, userId);
  return visible[visible.length - 1] || null;
}

function getUnreadCount(convId, userId) {
  const list = messages.get(convId) || [];
  return list.filter((msg) => {
    return msg.senderId !== userId && !msg.readBy?.[userId] && (!msg.deletedFor || !msg.deletedFor[userId]);
  }).length;
}

function asConversationForUser(conv, userId) {
  const other = getOtherUser(conv, userId);

  return {
    id: conv.id,
    groupId: conv.groupId,
    updatedAt: conv.updatedAt,
    otherUser: other ? publicUser(other) : null,
    lastMessage: getLastVisibleMessage(conv.id, userId),
    unread: getUnreadCount(conv.id, userId)
  };
}

function cleanupOldMessages() {
  const now = Date.now();
  const maxAge = 1000 * 60 * 60 * 24;

  for (const [conversationId, list] of messages.entries()) {
    const fresh = list.filter((msg) => {
      return now - new Date(msg.createdAt).getTime() < maxAge;
    });
    messages.set(conversationId, fresh);
  }
}

seedUsers();
setInterval(cleanupOldMessages, 1000 * 60 * 15);

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "ECHO Closed Group Server",
    groupId: GROUP_ID,
    members: GROUP_MEMBERS.length,
    storage: "Contacten en groepsrechten in memory. Berichten tijdelijk in memory, zichtbaar voor beide deelnemers."
  });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/api/group/members", (req, res) => {
  res.json({
    groupId: GROUP_ID,
    members: Array.from(users.values()).map(publicUser)
  });
});

app.post("/api/register", (req, res) => {
  const { name, phone, email, code } = req.body || {};
  const user = findMember({ name, phone, email, code });

  if (!user) {
    return res.status(403).json({
      error: "Deze persoon staat niet in de gesloten ECHO groep"
    });
  }

  touchUser(user.id);

  res.json({
    user: publicUser(user)
  });
});

app.post("/api/login", (req, res) => {
  const { code, phone, email, name } = req.body || {};
  const user = findMember({ code, phone, email, name });

  if (!user) {
    return res.status(403).json({
      error: "Geen toegang tot deze gesloten ECHO groep"
    });
  }

  touchUser(user.id);

  res.json({
    user: publicUser(user)
  });
});

app.post("/api/presence", (req, res) => {
  const { userId } = req.body || {};
  const user = touchUser(userId);

  if (!user) {
    return res.status(404).json({ error: "Gebruiker niet gevonden" });
  }

  res.json({
    ok: true,
    user: publicUser(user)
  });
});

app.post("/api/conversations", (req, res) => {
  const { userId, otherCode, otherUserId, phone, email, name } = req.body || {};
  const user = users.get(userId);

  if (!user) {
    return res.status(404).json({ error: "Gebruiker niet gevonden" });
  }

  let other = null;

  if (otherUserId) {
    other = users.get(otherUserId);
  }

  if (!other) {
    other = findMember({
      code: otherCode,
      phone,
      email,
      name
    });
  }

  if (!other) {
    return res.status(404).json({ error: "Contact staat niet in de gesloten groep" });
  }

  if (other.id === user.id) {
    return res.status(400).json({ error: "Je kunt geen gesprek met jezelf starten" });
  }

  if (other.groupId !== user.groupId) {
    return res.status(403).json({ error: "Contact zit niet in jouw gesloten groep" });
  }

  const conv = ensureConversation(user, other);
  conv.deletedFor[user.id] = false;
  conv.deletedFor[other.id] = false;
  conv.updatedAt = new Date().toISOString();

  res.json({
    conversation: asConversationForUser(conv, user.id)
  });
});

app.get("/api/conversations/:userId", (req, res) => {
  const userId = req.params.userId;
  const user = users.get(userId);

  if (!user) {
    return res.status(404).json({ error: "Gebruiker niet gevonden" });
  }

  touchUser(userId);

  const list = Array.from(conversations.values())
    .filter((conv) => conv.participants.includes(userId))
    .filter((conv) => !conv.deletedFor || !conv.deletedFor[userId])
    .map((conv) => asConversationForUser(conv, userId))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  res.json({ conversations: list });
});

app.get("/api/messages/:conversationId", (req, res) => {
  const conversationId = req.params.conversationId;
  const userId = String(req.query.userId || "");
  const conv = conversations.get(conversationId);

  if (!conv) {
    return res.status(404).json({ error: "Gesprek niet gevonden" });
  }

  if (!conv.participants.includes(userId)) {
    return res.status(403).json({ error: "Geen toegang tot dit gesprek" });
  }

  touchUser(userId);

  res.json({
    messages: getVisibleMessages(conversationId, userId)
  });
});

app.post("/api/messages", (req, res) => {
  const {
    conversationId,
    senderId,
    type,
    text,
    fileName,
    fileType,
    fileData,
    fileSize
  } = req.body || {};

  const conv = conversations.get(conversationId);
  const sender = users.get(senderId);

  if (!conv) {
    return res.status(404).json({ error: "Gesprek niet gevonden" });
  }

  if (!sender || !conv.participants.includes(sender.id)) {
    return res.status(403).json({ error: "Geen toegang tot dit gesprek" });
  }

  const msg = {
    id: "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10),
    conversationId,
    senderId,
    type: type || "text",
    text: String(text || ""),
    fileName: fileName || "",
    fileType: fileType || "",
    fileData: fileData || "",
    fileSize: fileSize || 0,
    createdAt: new Date().toISOString(),
    readAt: null,
    readBy: {
      [sender.id]: true
    },
    deletedFor: {}
  };

  if (!msg.text && msg.type === "text") {
    return res.status(400).json({ error: "Leeg bericht" });
  }

  const list = messages.get(conversationId) || [];
  list.push(msg);
  messages.set(conversationId, list);

  conv.updatedAt = msg.createdAt;
  conv.deletedFor = {};

  touchUser(sender.id);

  res.json({ message: msg });
});

app.post("/api/messages/read", (req, res) => {
  const { conversationId, userId } = req.body || {};
  const conv = conversations.get(conversationId);

  if (!conv) {
    return res.status(404).json({ error: "Gesprek niet gevonden" });
  }

  if (!conv.participants.includes(userId)) {
    return res.status(403).json({ error: "Geen toegang tot dit gesprek" });
  }

  const now = new Date().toISOString();
  const list = messages.get(conversationId) || [];

  list.forEach((msg) => {
    if (msg.senderId !== userId) {
      msg.readAt = msg.readAt || now;
      msg.readBy = msg.readBy || {};
      msg.readBy[userId] = true;
    }
  });

  touchUser(userId);

  res.json({ ok: true });
});

app.post("/api/messages/purge-conversation", (req, res) => {
  const { conversationId, userId } = req.body || {};
  const conv = conversations.get(conversationId);

  if (!conv) {
    return res.status(404).json({ error: "Gesprek niet gevonden" });
  }

  if (!conv.participants.includes(userId)) {
    return res.status(403).json({ error: "Geen toegang tot dit gesprek" });
  }

  const list = messages.get(conversationId) || [];
  list.forEach((msg) => {
    msg.deletedFor = msg.deletedFor || {};
    msg.deletedFor[userId] = true;
  });

  res.json({ ok: true });
});

app.delete("/api/conversations/:conversationId", (req, res) => {
  const conversationId = req.params.conversationId;
  const userId = String(req.query.userId || "");
  const conv = conversations.get(conversationId);

  if (!conv) {
    return res.status(404).json({ error: "Gesprek niet gevonden" });
  }

  if (!conv.participants.includes(userId)) {
    return res.status(403).json({ error: "Geen toegang tot dit gesprek" });
  }

  conv.deletedFor = conv.deletedFor || {};
  conv.deletedFor[userId] = true;

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("ECHO Closed Group Server draait op poort " + PORT);
});
