const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const upload = multer({
  dest: path.join(__dirname, "uploads")
});

let webpush = null;
try{
  webpush = require("web-push");
}catch(err){
  console.warn("web-push niet geladen. Pushmeldingen blijven uitgeschakeld.");
}

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: true }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:bernardwijnen@gmail.com";

if(webpush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY){
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const pushSubscriptions = new Map();

function addPushSubscription(userId, subscription, pageUrl){
  if(!userId || !subscription || !subscription.endpoint) return;
  const existing = pushSubscriptions.get(userId) || [];
  const filtered = existing.filter((item) => item.subscription && item.subscription.endpoint !== subscription.endpoint);
  filtered.push({ subscription, pageUrl: pageUrl || "", addedAt: new Date().toISOString() });
  pushSubscriptions.set(userId, filtered);
}

async function sendPushToUser(userId, payload){
  if(!webpush || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const list = pushSubscriptions.get(userId) || [];
  if(!list.length) return;
  const valid = [];
  for(const item of list){
    try{
      await webpush.sendNotification(item.subscription, JSON.stringify(payload));
      valid.push(item);
    }catch(err){
      if(err.statusCode !== 404 && err.statusCode !== 410){
        valid.push(item);
      }
    }
  }
  pushSubscriptions.set(userId, valid);
}

function jsonError(res, status, message, details){
  return res.status(status).json({ error: message, details: details || "" });
}

async function callOpenAI(messages, temperature){
  if(!OPENAI_API_KEY){
    throw new Error("OPENAI_API_KEY ontbreekt in Render Environment Variables");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + OPENAI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: typeof temperature === "number" ? temperature : 0.2
    })
  });

  const data = await response.json().catch(() => ({}));
  if(!response.ok){
    const msg = data && data.error && data.error.message ? data.error.message : "OpenAI aanvraag mislukt";
    throw new Error(msg);
  }

  return String(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content ? data.choices[0].message.content : "").trim();
}

app.get("/api/openai/status", (req, res) => {
  res.json({
    ok: true,
    openaiConfigured: !!OPENAI_API_KEY,
    model: OPENAI_MODEL
  });
});

app.post("/api/openai/translate", async (req, res) => {
  try{
    const text = String(req.body && req.body.text ? req.body.text : "").trim();
    const from = String(req.body && req.body.from ? req.body.from : "auto").trim();
    const to = String(req.body && req.body.to ? req.body.to : "nl").trim();
    const context = String(req.body && req.body.context ? req.body.context : "").trim();

    if(!text){
      return jsonError(res, 400, "Tekst ontbreekt");
    }

    const translatedText = await callOpenAI([
      {
        role: "system",
        content: "Je bent de vertaalmotor van ECHO. Vertaal natuurlijk, volledig en professioneel. Geef alleen de vertaling terug. Geen uitleg. Behoud namen, plaatsen, getallen, links en technische termen zo goed mogelijk."
      },
      {
        role: "user",
        content: "Vertaal van " + from + " naar " + to + ".\nContext: " + context + "\nTekst:\n" + text
      }
    ], 0.1);

    res.json({ ok: true, translatedText, translation: translatedText, text: translatedText, result: translatedText });
  }catch(err){
    jsonError(res, 500, "Vertaal fout", err.message || String(err));
  }
});

app.post("/api/translate", async (req, res) => {
  try{
    const text = String(req.body && req.body.text ? req.body.text : "").trim();
    const source = String(req.body && (req.body.source || req.body.from) ? (req.body.source || req.body.from) : "auto").trim();
    const target = String(req.body && (req.body.target || req.body.to) ? (req.body.target || req.body.to) : "nl").trim();

    if(!text){
      return jsonError(res, 400, "Tekst ontbreekt");
    }

    const translatedText = await callOpenAI([
      {
        role: "system",
        content: "Je bent de vertaalmotor van ECHO. Vertaal natuurlijk en geef alleen de vertaling terug."
      },
      {
        role: "user",
        content: "Vertaal van " + source + " naar " + target + ":\n" + text
      }
    ], 0.1);

    res.json({ ok: true, translatedText, translation: translatedText, text: translatedText, result: translatedText });
  }catch(err){
    jsonError(res, 500, "Vertaal fout", err.message || String(err));
  }
});

app.post("/openai/translate", async (req, res) => {
  try{
    const text = String(req.body && req.body.text ? req.body.text : "").trim();
    const from = String(req.body && req.body.from ? req.body.from : "auto").trim();
    const to = String(req.body && req.body.to ? req.body.to : "nl").trim();

    if(!text){
      return jsonError(res, 400, "Tekst ontbreekt");
    }

    const translatedText = await callOpenAI([
      { role: "system", content: "Vertaal exact en natuurlijk. Geef alleen de vertaling terug." },
      { role: "user", content: "Van " + from + " naar " + to + ":\n" + text }
    ], 0.1);

    res.json({ ok: true, translatedText, translation: translatedText, text: translatedText, result: translatedText });
  }catch(err){
    jsonError(res, 500, "Vertaal fout", err.message || String(err));
  }
});

app.post("/api/openai/chat", async (req, res) => {
  try{
    const text = String(req.body && req.body.text ? req.body.text : "").trim();
    const instruction = String(req.body && req.body.instruction ? req.body.instruction : "Geef een kort, bruikbaar antwoord.").trim();

    if(!text){
      return jsonError(res, 400, "Tekst ontbreekt");
    }

    const answer = await callOpenAI([
      { role: "system", content: instruction },
      { role: "user", content: text }
    ], 0.3);

    res.json({ ok: true, answer, text: answer, result: answer });
  }catch(err){
    jsonError(res, 500, "OpenAI fout", err.message || String(err));
  }
});

const GROUP_ID = "familie_ben_001";
const OWNER_NAME = "Ben";

const GROUP_MEMBERS = [
  { id: "user_ben", name: "Ben", phone: "0618391659", email: "bernardwijnen@gmail.com", groupId: GROUP_ID, role: "owner", code: "725524" },
  { id: "user_linda", name: "Linda", phone: "0642741759", email: "curfslinda@gmail.com", groupId: GROUP_ID, role: "member", code: "100001" },
  { id: "user_branko", name: "Branko", phone: "0615474917", email: "brankowijnen2@gmail.com", groupId: GROUP_ID, role: "member", code: "100002" },
  { id: "user_romy", name: "Romy", phone: "0615637231", email: "romywijnen20062006@gmail.com", groupId: GROUP_ID, role: "member", code: "100003" },
  { id: "user_ron_bakkers", name: "Ron Bakkers", phone: "0653222539", email: "ron@bakkersgeleen.nl", groupId: GROUP_ID, role: "member", code: "100004" },
  { id: "user_harrie_veltman", name: "Harrie Veltman", phone: "0648936144", email: "hawveltman@home.nl", groupId: GROUP_ID, role: "member", code: "100005" },
  { id: "user_melvin", name: "Melvin", phone: "0637917415", email: "vertinosdesign@gmail.com", groupId: GROUP_ID, role: "member", code: "100006" }
];

const users = new Map();
const conversations = new Map();
const messages = new Map();
const dynamicMembers = new Map();

function normalize(value){
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizePhone(value){
  return String(value || "").replace(/\D/g, "");
}

function publicUser(user){
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

function seedUsers(){
  GROUP_MEMBERS.forEach((member) => {
    users.set(member.id, { ...member, lastSeen: null });
  });
}

function makeDynamicCode(){
  let code = "";
  do{
    code = "9" + Math.floor(10000 + Math.random() * 89999);
  }while(Array.from(users.values()).some((u) => u.code === code));
  return code;
}

function createDynamicMember({ name, phone, email }){
  const safeName = String(name || "").trim();
  const safePhone = String(phone || "").trim();
  const safeEmail = String(email || "").trim();

  if(!safeName || !safePhone){
    throw new Error("Naam en telefoonnummer zijn verplicht");
  }

  const existing = Array.from(users.values()).find((u) => normalizePhone(u.phone) === normalizePhone(safePhone));
  if(existing) return existing;

  const code = makeDynamicCode();
  const id = "user_dynamic_" + code;
  const member = { id, name: safeName, phone: safePhone, email: safeEmail, groupId: GROUP_ID, role: "member", code, dynamic: true, lastSeen: null };
  users.set(id, member);
  dynamicMembers.set(id, member);
  return member;
}

function findMember({ name, phone, email, code }){
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

function touchUser(userId){
  const user = users.get(userId);
  if(user){
    user.lastSeen = new Date().toISOString();
  }
  return user;
}

function conversationIdFor(userA, userB){
  return [userA.id, userB.id].sort().join("__");
}

function ensureConversation(userA, userB){
  if(!userA || !userB){
    throw new Error("Gebruiker niet gevonden");
  }

  if(userA.groupId !== userB.groupId){
    throw new Error("Deze gebruikers zitten niet in dezelfde gesloten groep");
  }

  const id = conversationIdFor(userA, userB);
  if(!conversations.has(id)){
    conversations.set(id, { id, groupId: userA.groupId, participants: [userA.id, userB.id], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedFor: {} });
    messages.set(id, []);
  }
  return conversations.get(id);
}

function getOtherUser(conv, userId){
  const otherId = conv.participants.find((id) => id !== userId);
  return users.get(otherId);
}

function getVisibleMessages(convId, userId){
  return (messages.get(convId) || []).filter((msg) => !msg.deletedFor || !msg.deletedFor[userId]);
}

function getLastVisibleMessage(convId, userId){
  const visible = getVisibleMessages(convId, userId);
  return visible[visible.length - 1] || null;
}

function getUnreadCount(convId, userId){
  const list = messages.get(convId) || [];
  return list.filter((msg) => msg.senderId !== userId && !msg.readBy?.[userId] && (!msg.deletedFor || !msg.deletedFor[userId])).length;
}

function asConversationForUser(conv, userId){
  const other = getOtherUser(conv, userId);
  return { id: conv.id, groupId: conv.groupId, updatedAt: conv.updatedAt, otherUser: other ? publicUser(other) : null, lastMessage: getLastVisibleMessage(conv.id, userId), unread: getUnreadCount(conv.id, userId) };
}

function cleanupOldMessages(){
  const now = Date.now();
  const maxAge = 1000 * 60 * 60 * 24;
  for(const [conversationId, list] of messages.entries()){
    const fresh = list.filter((msg) => now - new Date(msg.createdAt).getTime() < maxAge);
    messages.set(conversationId, fresh);
  }
}

seedUsers();
setInterval(cleanupOldMessages, 1000 * 60 * 15);

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "ECHO Central Server",
    services: ["private-chat", "echochat-5", "echoconnect", "openai-translate"],
    groupId: GROUP_ID,
    members: GROUP_MEMBERS.length,
    openaiConfigured: !!OPENAI_API_KEY,
    time: new Date().toISOString()
  });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "ECHO Central Server", openaiConfigured: !!OPENAI_API_KEY, time: new Date().toISOString() });
});

app.get("/api/push/public-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post("/api/push/subscribe", (req, res) => {
  const { userId, subscription, pageUrl } = req.body || {};
  if(!users.has(userId)){
    return jsonError(res, 404, "Gebruiker niet gevonden");
  }
  addPushSubscription(userId, subscription, pageUrl);
  res.json({ ok: true });
});

app.post("/api/dynamic-members", (req, res) => {
  const { ownerId, name, phone, email } = req.body || {};
  const owner = users.get(ownerId);
  if(!owner || owner.role !== "owner"){
    return jsonError(res, 403, "Alleen Ben kan nieuwe personen uitnodigen");
  }
  try{
    const member = createDynamicMember({ name, phone, email });
    res.json({ member: publicUser(member) });
  }catch(err){
    jsonError(res, 400, err.message || "Nieuw contact kon niet worden gemaakt");
  }
});

app.get("/api/group/members", (req, res) => {
  res.json({ groupId: GROUP_ID, members: Array.from(users.values()).map(publicUser) });
});

app.post("/api/register", (req, res) => {
  const { name, phone, email, code } = req.body || {};
  const user = findMember({ name, phone, email, code });
  if(!user){
    return jsonError(res, 403, "Deze persoon staat niet in de gesloten ECHO groep");
  }
  touchUser(user.id);
  res.json({ user: publicUser(user) });
});

app.post("/api/login", (req, res) => {
  const { code, phone, email, name } = req.body || {};
  const user = findMember({ code, phone, email, name });
  if(!user){
    return jsonError(res, 403, "Geen toegang tot deze gesloten ECHO groep");
  }
  touchUser(user.id);
  res.json({ user: publicUser(user) });
});

app.post("/api/presence", (req, res) => {
  const { userId } = req.body || {};
  const user = touchUser(userId);
  if(!user){
    return jsonError(res, 404, "Gebruiker niet gevonden");
  }
  res.json({ ok: true, user: publicUser(user) });
});

app.post("/api/conversations", (req, res) => {
  const { userId, otherCode, otherUserId, phone, email, name } = req.body || {};
  const user = users.get(userId);
  if(!user){
    return jsonError(res, 404, "Gebruiker niet gevonden");
  }

  let other = null;
  if(otherUserId){
    other = users.get(otherUserId);
  }
  if(!other){
    other = findMember({ code: otherCode, phone, email, name });
  }
  if(!other){
    return jsonError(res, 404, "Contact staat niet in de gesloten groep");
  }
  if(other.id === user.id){
    return jsonError(res, 400, "Je kunt geen gesprek met jezelf starten");
  }
  if(other.groupId !== user.groupId){
    return jsonError(res, 403, "Contact zit niet in jouw gesloten groep");
  }

  const conv = ensureConversation(user, other);
  conv.deletedFor[user.id] = false;
  conv.deletedFor[other.id] = false;
  conv.updatedAt = new Date().toISOString();
  res.json({ conversation: asConversationForUser(conv, user.id) });
});

app.get("/api/conversations/:userId", (req, res) => {
  const userId = req.params.userId;
  const user = users.get(userId);
  if(!user){
    return jsonError(res, 404, "Gebruiker niet gevonden");
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
  if(!conv){
    return jsonError(res, 404, "Gesprek niet gevonden");
  }
  if(!conv.participants.includes(userId)){
    return jsonError(res, 403, "Geen toegang tot dit gesprek");
  }
  touchUser(userId);
  res.json({ messages: getVisibleMessages(conversationId, userId) });
});

app.post("/api/messages", (req, res) => {
  const { conversationId, senderId, type, text, fileName, fileType, fileData, fileSize } = req.body || {};
  const conv = conversations.get(conversationId);
  const sender = users.get(senderId);
  if(!conv){
    return jsonError(res, 404, "Gesprek niet gevonden");
  }
  if(!sender || !conv.participants.includes(sender.id)){
    return jsonError(res, 403, "Geen toegang tot dit gesprek");
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
    readBy: { [sender.id]: true },
    deletedFor: {}
  };

  if(!msg.text && msg.type === "text"){
    return jsonError(res, 400, "Leeg bericht");
  }

  const list = messages.get(conversationId) || [];
  list.push(msg);
  messages.set(conversationId, list);

  conv.updatedAt = msg.createdAt;
  conv.deletedFor = {};
  touchUser(sender.id);

  const recipients = conv.participants.filter((id) => id !== sender.id);
  recipients.forEach((recipientId) => {
    sendPushToUser(recipientId, {
      title: "ECHO Messenger",
      body: sender.name + " stuurde een bericht",
      conversationId,
      senderId: sender.id,
      url: "/formforge/adminmode/pages/private-group-ben.html"
    });
  });

  res.json({ message: msg });
});

app.post("/api/messages/read", (req, res) => {
  const { conversationId, userId } = req.body || {};
  const conv = conversations.get(conversationId);
  if(!conv){
    return jsonError(res, 404, "Gesprek niet gevonden");
  }
  if(!conv.participants.includes(userId)){
    return jsonError(res, 403, "Geen toegang tot dit gesprek");
  }
  const now = new Date().toISOString();
  const list = messages.get(conversationId) || [];
  list.forEach((msg) => {
    if(msg.senderId !== userId){
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
  if(!conv){
    return jsonError(res, 404, "Gesprek niet gevonden");
  }
  if(!conv.participants.includes(userId)){
    return jsonError(res, 403, "Geen toegang tot dit gesprek");
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
  if(!conv){
    return jsonError(res, 404, "Gesprek niet gevonden");
  }
  if(!conv.participants.includes(userId)){
    return jsonError(res, 403, "Geen toegang tot dit gesprek");
  }
  conv.deletedFor = conv.deletedFor || {};
  conv.deletedFor[userId] = true;
  res.json({ ok: true });
});

const signalingSessions = new Map();
const SIGNALING_DEFAULT_TTL_MS = 1000 * 60 * 10;

function normalizeSignalingCode(value){
  return String(value || "").trim();
}

function getSignalingExpiry(expiresAt){
  const parsed = Number(expiresAt || 0);
  const fallback = Date.now() + SIGNALING_DEFAULT_TTL_MS;
  if(!Number.isFinite(parsed) || parsed <= Date.now()) return fallback;
  return parsed;
}

function cleanSignalingSessions(){
  const now = Date.now();
  for(const [code, session] of signalingSessions.entries()){
    if(!session || Number(session.expiresAt || 0) < now){
      signalingSessions.delete(code);
    }
  }
}

function getSignalingSession(code){
  cleanSignalingSessions();
  const safeCode = normalizeSignalingCode(code);
  if(!safeCode) return null;
  return signalingSessions.get(safeCode) || null;
}

setInterval(cleanSignalingSessions, 1000 * 30);

app.post("/api/signaling/session", (req, res) => {
  const { code, ownerId, expiresAt } = req.body || {};
  const safeCode = normalizeSignalingCode(code);
  if(!safeCode){
    return jsonError(res, 400, "Code ontbreekt");
  }
  const session = {
    code: safeCode,
    ownerId: String(ownerId || ""),
    offer: null,
    answer: null,
    candidates: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: getSignalingExpiry(expiresAt)
  };
  signalingSessions.set(safeCode, session);
  res.json({ ok: true, code: safeCode, expiresAt: session.expiresAt });
});

app.post("/api/signaling/offer", (req, res) => {
  const { code, ownerId, sdp, offer, expiresAt } = req.body || {};
  const safeCode = normalizeSignalingCode(code);
  const offerSdp = sdp || (offer && offer.sdp) || "";
  if(!safeCode){
    return jsonError(res, 400, "Code ontbreekt");
  }
  if(!offerSdp){
    return jsonError(res, 400, "SDP offer ontbreekt");
  }
  const existing = getSignalingSession(safeCode) || { code: safeCode, ownerId: String(ownerId || ""), answer: null, candidates: [], createdAt: new Date().toISOString() };
  existing.ownerId = String(ownerId || existing.ownerId || "");
  existing.offer = { type: "offer", sdp: String(offerSdp || "") };
  existing.updatedAt = new Date().toISOString();
  existing.expiresAt = getSignalingExpiry(expiresAt || existing.expiresAt);
  signalingSessions.set(safeCode, existing);
  res.json({ ok: true, code: safeCode, expiresAt: existing.expiresAt });
});

app.get("/api/signaling/offer/:code", (req, res) => {
  const session = getSignalingSession(req.params.code);
  if(!session || !session.offer){
    return jsonError(res, 404, "Nog geen offer beschikbaar");
  }
  res.json({ code: session.code, ownerId: session.ownerId || "", type: "offer", sdp: session.offer.sdp, offer: session.offer, expiresAt: session.expiresAt });
});

app.post("/api/signaling/answer", (req, res) => {
  const { code, ownerId, sdp, answer, expiresAt } = req.body || {};
  const safeCode = normalizeSignalingCode(code);
  const answerSdp = sdp || (answer && answer.sdp) || "";
  if(!safeCode){
    return jsonError(res, 400, "Code ontbreekt");
  }
  if(!answerSdp){
    return jsonError(res, 400, "SDP answer ontbreekt");
  }
  const existing = getSignalingSession(safeCode);
  if(!existing){
    return jsonError(res, 404, "Sessie niet gevonden");
  }
  existing.answer = { type: "answer", sdp: String(answerSdp || "") };
  existing.answerOwnerId = String(ownerId || "");
  existing.updatedAt = new Date().toISOString();
  existing.expiresAt = getSignalingExpiry(expiresAt || existing.expiresAt);
  signalingSessions.set(safeCode, existing);
  res.json({ ok: true, code: safeCode, expiresAt: existing.expiresAt });
});

app.get("/api/signaling/answer/:code", (req, res) => {
  const session = getSignalingSession(req.params.code);
  if(!session || !session.answer){
    return jsonError(res, 404, "Nog geen answer beschikbaar");
  }
  res.json({ code: session.code, ownerId: session.answerOwnerId || "", type: "answer", sdp: session.answer.sdp, answer: session.answer, expiresAt: session.expiresAt });
});

app.post("/api/signaling/candidate", (req, res) => {
  const { code, ownerId, candidate } = req.body || {};
  const safeCode = normalizeSignalingCode(code);
  if(!safeCode){
    return jsonError(res, 400, "Code ontbreekt");
  }
  const existing = getSignalingSession(safeCode) || { code: safeCode, ownerId: String(ownerId || ""), offer: null, answer: null, candidates: [], createdAt: new Date().toISOString(), expiresAt: getSignalingExpiry() };
  existing.candidates = existing.candidates || [];
  if(candidate){
    existing.candidates.push({ ownerId: String(ownerId || ""), candidate, createdAt: new Date().toISOString() });
  }
  existing.updatedAt = new Date().toISOString();
  signalingSessions.set(safeCode, existing);
  res.json({ ok: true, code: safeCode });
});

app.get("/api/signaling/candidates/:code", (req, res) => {
  const session = getSignalingSession(req.params.code);
  if(!session){
    return jsonError(res, 404, "Sessie niet gevonden");
  }
  res.json({ code: session.code, candidates: session.candidates || [] });
});

app.get("/api/signaling/session/:code", (req, res) => {
  const session = getSignalingSession(req.params.code);
  if(!session){
    return jsonError(res, 404, "Sessie niet gevonden");
  }
  res.json({
    code: session.code,
    ownerId: session.ownerId || "",
    hasOffer: !!session.offer,
    hasAnswer: !!session.answer,
    offer: session.offer || null,
    answer: session.answer || null,
    candidates: session.candidates || [],
    expiresAt: session.expiresAt,
    updatedAt: session.updatedAt
  });
});

app.post("/api/signaling/clear", (req, res) => {
  const { code } = req.body || {};
  const safeCode = normalizeSignalingCode(code);
  if(safeCode){
    signalingSessions.delete(safeCode);
  }
  res.json({ ok: true });
});


app.post("/api/speech/transcribe", upload.single("audio"), async (req, res) => {
  try{
    if(!OPENAI_API_KEY){
      return jsonError(res, 500, "OPENAI_API_KEY ontbreekt");
    }

    if(!req.file){
      return jsonError(res, 400, "Geen audio ontvangen");
    }

    const formData = new FormData();

    formData.append(
      "file",
      new Blob(
        [fs.readFileSync(req.file.path)],
        { type: req.file.mimetype || "audio/webm" }
      ),
      req.file.originalname || "audio.webm"
    );

    formData.append("model", "whisper-1");

    const forcedLanguage = String(req.body && req.body.language ? req.body.language : "").trim();
    const prompt = String(req.body && req.body.prompt ? req.body.prompt : "").trim();

    if(forcedLanguage){
      formData.append("language", forcedLanguage);
    }

    if(prompt){
      formData.append("prompt", prompt);
    }

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY
      },
      body: formData
    });

    const data = await response.json().catch(() => ({}));

    try{
      fs.unlinkSync(req.file.path);
    }catch(e){}

    if(!response.ok){
      return jsonError(
        res,
        500,
        "Transcriptie mislukt",
        data && data.error && data.error.message
          ? data.error.message
          : "Whisper fout"
      );
    }

    res.json({
      ok: true,
      text: String(data.text || "").trim()
    });

  }catch(err){
    if(req.file && req.file.path){
      try{
        fs.unlinkSync(req.file.path);
      }catch(e){}
    }

    jsonError(
      res,
      500,
      "Transcriptie mislukt",
      err.message || String(err)
    );
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Route niet gevonden", path: req.path });
});

app.listen(PORT, () => {
  console.log("ECHO Central Server draait op poort " + PORT);
  console.log("OpenAI actief: " + (OPENAI_API_KEY ? "ja" : "nee"));
});
