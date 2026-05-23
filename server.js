const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_DEFAULT_PRICE_ID = process.env.STRIPE_PRICE_ID || "";
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL || "https://www.benwijnen.nl/echo-premium-gelukt";
const STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL || "https://www.benwijnen.nl/echo-premium-geannuleerd";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "info@formforge.nl";

let stripeClient = null;
try{
  if(STRIPE_SECRET_KEY){
    stripeClient = require("stripe")(STRIPE_SECRET_KEY);
  }
}catch(err){
  console.warn("stripe package niet geladen. Stripe webhook verificatie blijft beperkt.");
}

const STARTER_FREE_CREDITS = Number(process.env.ECHO_STARTER_FREE_CREDITS || 10);
const UNLIMITED_FAIR_USE_CREDITS = Number(process.env.ECHO_UNLIMITED_FAIR_USE_CREDITS || 999999);

const STRIPE_CREDITS_100_PRICE_ID = process.env.STRIPE_CREDITS_100_PRICE_ID || "price_1TaHrD5s8MDSsy0eV1krtPFL";
const STRIPE_CREDITS_500_PRICE_ID = process.env.STRIPE_CREDITS_500_PRICE_ID || "price_1TaHxD5s8MDSsy0eVrOvmYPM";
const STRIPE_CREDITS_1500_PRICE_ID = process.env.STRIPE_CREDITS_1500_PRICE_ID || "price_1TaHz15s8MDSsy0eMKRMDbxN";
const STRIPE_UNLIMITED_PRICE_ID = process.env.STRIPE_UNLIMITED_PRICE_ID || "price_1TaI0q5s8MDSsy0eL2NZqIpD";

const CREDIT_PACKAGES = {
  "100": { credits: 100, priceId: STRIPE_CREDITS_100_PRICE_ID, label: "ECHO 100 AI credits" },
  "500": { credits: 500, priceId: STRIPE_CREDITS_500_PRICE_ID, label: "ECHO 500 AI credits" },
  "1500": { credits: 1500, priceId: STRIPE_CREDITS_1500_PRICE_ID, label: "ECHO 1500 AI credits" }
};

function getCreditPackageByPriceId(priceId){
  const safePriceId = String(priceId || "").trim();
  return Object.values(CREDIT_PACKAGES).find((pkg) => pkg.priceId === safePriceId) || null;
}

const DATA_DIR = process.env.ECHO_DATA_DIR || "/opt/render/project/src/data";

try{
  if(!fs.existsSync(DATA_DIR)){
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}catch(err){
  console.warn("Data map kon niet worden aangemaakt:", err.message || String(err));
}

const PREMIUM_STORE_FILE = path.join(DATA_DIR, "echo_premium_accounts.json");
const premiumAccounts = new Map();

function currentPremiumMonth(){
  return new Date().toISOString().slice(0, 7);
}

function loadPremiumAccounts(){
  try{
    if(!fs.existsSync(PREMIUM_STORE_FILE)) return;
    const raw = fs.readFileSync(PREMIUM_STORE_FILE, "utf8");
    const data = JSON.parse(raw || "{}");
    Object.keys(data || {}).forEach((key) => {
      if(key && data[key]){
        premiumAccounts.set(key, data[key]);
      }
    });
  }catch(err){
    console.warn("Premium accounts konden niet worden geladen:", err.message || String(err));
  }
}

function savePremiumAccounts(){
  try{
    const data = {};
    for(const [key, value] of premiumAccounts.entries()){
      data[key] = value;
    }
    fs.writeFileSync(PREMIUM_STORE_FILE, JSON.stringify(data, null, 2));
  }catch(err){
    console.warn("Premium accounts konden niet worden opgeslagen:", err.message || String(err));
  }
}

function normalizePremiumKey(value){
  return String(value || "").trim().toLowerCase();
}

function normalizePremiumPin(value){
  return String(value || "").trim().replace(/\D/g, "");
}

function makePremiumPin(){
  try{
    return String(crypto.randomInt(100000, 1000000));
  }catch(err){
    return String(Math.floor(100000 + Math.random() * 900000));
  }
}

function verifyPremiumPin(account, pin){
  if(!account || !account.premiumPin) return false;
  return normalizePremiumPin(pin) === normalizePremiumPin(account.premiumPin);
}

function setPremiumAccount(key, data){
  const safeKey = normalizePremiumKey(key);
  if(!safeKey) return null;
  const existing = premiumAccounts.get(safeKey) || {};
  const nowMonth = currentPremiumMonth();
  const shouldActivate = data && data.active === true;
  const incomingPlan = data && data.plan ? String(data.plan) : "";
  const existingPlan = existing.plan ? String(existing.plan) : "";
  const finalPlan = incomingPlan || existingPlan || (data && data.source === "stripe" ? "unlimited" : (existing.source === "stripe" || existing.subscriptionId ? "unlimited" : "credits"));
  const planCreditsTotal = finalPlan === "starter" ? STARTER_FREE_CREDITS : (finalPlan === "unlimited" ? UNLIMITED_FAIR_USE_CREDITS : 0);
  const previousMonth = existing.creditMonth || nowMonth;
  const previousCredits = Number.isFinite(Number(existing.creditsRemaining)) ? Number(existing.creditsRemaining) : planCreditsTotal;

  let creditsRemaining = previousCredits;
  let creditMonth = previousMonth;
  let creditsTotal = Number.isFinite(Number(existing.creditsTotal)) ? Number(existing.creditsTotal) : planCreditsTotal;

  if(shouldActivate && finalPlan !== "starter" && (!existing.active || previousMonth !== nowMonth)){
    creditsRemaining = UNLIMITED_FAIR_USE_CREDITS;
    creditsTotal = UNLIMITED_FAIR_USE_CREDITS;
    creditMonth = nowMonth;
  }

  if(finalPlan === "starter"){
    creditsTotal = STARTER_FREE_CREDITS;
  }

  if(data && typeof data.creditsRemaining !== "undefined"){
    creditsRemaining = Number(data.creditsRemaining);
  }

  if(data && typeof data.creditsTotal !== "undefined"){
    creditsTotal = Number(data.creditsTotal);
  }

  let premiumPin = existing.premiumPin || "";
  if(shouldActivate && !premiumPin){
    premiumPin = makePremiumPin();
  }
  if(data && typeof data.premiumPin !== "undefined"){
    premiumPin = normalizePremiumPin(data.premiumPin);
  }

  const merged = {
    ...existing,
    ...data,
    key: safeKey,
    plan: finalPlan,
    premiumPin,
    creditsRemaining: Math.max(0, Math.floor(Number(creditsRemaining) || 0)),
    creditsTotal: Math.max(0, Math.floor(Number(creditsTotal) || 0)),
    creditMonth,
    updatedAt: new Date().toISOString()
  };
  premiumAccounts.set(safeKey, merged);
  savePremiumAccounts();
  return merged;
}

function unixToIso(value){
  const n = Number(value || 0);
  if(!Number.isFinite(n) || n <= 0) return "";
  try{
    return new Date(n * 1000).toISOString();
  }catch(err){
    return "";
  }
}

function extractStripeSubscriptionPeriod(subscription){
  const sub = subscription || {};
  const firstItem = sub.items && sub.items.data && sub.items.data[0] ? sub.items.data[0] : {};

  const periodStart = sub.current_period_start || firstItem.current_period_start || 0;
  const periodEnd = sub.current_period_end || firstItem.current_period_end || 0;

  return {
    subscriptionStatus: String(sub.status || ""),
    currentPeriodStart: unixToIso(periodStart),
    currentPeriodEnd: unixToIso(periodEnd),
    periodStart: unixToIso(periodStart),
    periodEnd: unixToIso(periodEnd),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    cancelAt: unixToIso(sub.cancel_at),
    canceledAt: unixToIso(sub.canceled_at),
    trialEnd: unixToIso(sub.trial_end)
  };
}

async function refreshPremiumAccountFromStripe(value){
  const account = getPremiumAccount(value);
  if(!account || !account.subscriptionId || !STRIPE_SECRET_KEY){
    return account;
  }

  try{
    const subscription = await callStripeGet("/subscriptions/" + encodeURIComponent(account.subscriptionId));
    const periodData = extractStripeSubscriptionPeriod(subscription);
    const active = ["active","trialing","past_due"].includes(String(subscription.status || ""));
    return setPremiumAccount(account.email || value, {
      ...periodData,
      subscriptionId: subscription.id || account.subscriptionId,
      customerId: subscription.customer || account.customerId || "",
      active,
      reason: "stripe.subscription.refreshed"
    });
  }catch(err){
    console.warn("Stripe abonnement kon niet worden ververst:", err.message || String(err));
    return account;
  }
}

function setPremiumForStripeData({ email, clientReferenceId, customerId, subscriptionId, active, reason, subscriptionStatus, currentPeriodStart, currentPeriodEnd, periodStart, periodEnd, cancelAtPeriodEnd, cancelAt, canceledAt, trialEnd }){
  const data = {
    active: !!active,
    email: normalizePremiumKey(email),
    clientReferenceId: normalizePremiumKey(clientReferenceId),
    customerId: customerId || "",
    subscriptionId: subscriptionId || "",
    subscriptionStatus: subscriptionStatus || "",
    currentPeriodStart: currentPeriodStart || periodStart || "",
    currentPeriodEnd: currentPeriodEnd || periodEnd || "",
    periodStart: periodStart || currentPeriodStart || "",
    periodEnd: periodEnd || currentPeriodEnd || "",
    cancelAtPeriodEnd: !!cancelAtPeriodEnd,
    cancelAt: cancelAt || "",
    canceledAt: canceledAt || "",
    trialEnd: trialEnd || "",
    reason: reason || "",
    source: "stripe",
    plan: "unlimited"
  };

  const keys = [
    data.email,
    data.clientReferenceId,
    data.customerId,
    data.subscriptionId
  ].filter(Boolean);

  keys.forEach((key) => activateUnlimitedAccount(key, data));
  return data;
}

function getPremiumAccount(value){
  const safeKey = normalizePremiumKey(value);
  if(!safeKey) return null;
  const account = premiumAccounts.get(safeKey) || null;
  const plan = account && account.plan ? String(account.plan) : "premium";
  if(account && account.active && plan !== "starter" && account.creditMonth !== currentPremiumMonth()){
    return setPremiumAccount(safeKey, { creditsRemaining: UNLIMITED_FAIR_USE_CREDITS, creditsTotal: UNLIMITED_FAIR_USE_CREDITS, creditMonth: currentPremiumMonth(), plan: "unlimited" });
  }
  return account;
}

function getPremiumStatus(value, pin, options){
  const account = getPremiumAccount(value);
  const allowWithoutPin = !!(options && options.allowWithoutPin);
  const pinOk = account && account.active && (allowWithoutPin || verifyPremiumPin(account, pin));

  return {
    premium: !!pinOk,
    active: !!pinOk,
    pinRequired: !!(account && account.active && !pinOk),
    pinOk: !!pinOk,
    creditsRemaining: account ? Number(account.creditsRemaining || 0) : 0,
    creditsTotal: account ? Number(account.creditsTotal || 0) : 0,
    creditMonth: account ? String(account.creditMonth || currentPremiumMonth()) : currentPremiumMonth(),
    plan: account ? String(account.plan || "premium") : "",
    starterCreditsGranted: account ? !!account.starterCreditsGranted : false,
    email: account ? String(account.email || "") : "",
    subscriptionId: account ? String(account.subscriptionId || "") : "",
    subscriptionStatus: account ? String(account.subscriptionStatus || "") : "",
    periodStart: account ? String(account.periodStart || account.currentPeriodStart || "") : "",
    periodEnd: account ? String(account.periodEnd || account.currentPeriodEnd || "") : "",
    currentPeriodStart: account ? String(account.currentPeriodStart || account.periodStart || "") : "",
    currentPeriodEnd: account ? String(account.currentPeriodEnd || account.periodEnd || "") : "",
    nextPaymentDate: account && !account.cancelAtPeriodEnd ? String(account.periodEnd || account.currentPeriodEnd || "") : "",
    cancelAtPeriodEnd: account ? !!account.cancelAtPeriodEnd : false,
    cancelAt: account ? String(account.cancelAt || "") : "",
    canceledAt: account ? String(account.canceledAt || "") : "",
    trialEnd: account ? String(account.trialEnd || "") : "",
    reason: account ? String(account.reason || "") : "",
    updatedAt: account ? String(account.updatedAt || "") : ""
  };
}

function consumePremiumCredit(value, pin, deviceId){
  const safeKey = normalizePremiumKey(value);
  const safeDeviceId = String(deviceId || "").trim();

  if(!safeKey){
    return { ok: false, status: 401, error: "Premium e-mailadres ontbreekt" };
  }

  const account = getPremiumAccount(safeKey);

  if(!account || !account.active){
    return { ok: false, status: 402, error: "AI Premium is niet actief voor dit account" };
  }

  if(!verifyPremiumPin(account, pin)){
    return { ok: false, status: 403, error: "Premium pincode is ongeldig" };
  }

  if(String(account.plan || "") === "unlimited"){
    if(!safeDeviceId){
      return { ok: false, status: 403, error: "Unlimited Premium vereist apparaatcontrole" };
    }

    const registeredDeviceId = String(account.unlimitedDeviceId || "").trim();

    if(registeredDeviceId && registeredDeviceId !== safeDeviceId){
      return {
        ok: false,
        status: 403,
        error: "Unlimited Premium is al actief op een ander apparaat. Dit abonnement werkt op één toestel tegelijk."
      };
    }

    if(!registeredDeviceId){
      setPremiumAccount(safeKey, {
        unlimitedDeviceId: safeDeviceId,
        unlimitedDeviceActivatedAt: new Date().toISOString(),
        reason: "unlimited_device_registered"
      });
    }
  }

  if(Number(account.creditsRemaining || 0) <= 0){
    return { ok: false, status: 402, error: "AI credits zijn op voor deze maand" };
  }

  const updated = setPremiumAccount(safeKey, {
    creditsRemaining: Number(account.creditsRemaining || 0) - 1,
    lastCreditUsedAt: new Date().toISOString(),
    lastDeviceId: safeDeviceId || account.lastDeviceId || ""
  });

  return { ok: true, account: updated, status: getPremiumStatus(safeKey, pin) };
}


function addCreditsToAccount(email, credits, reason, stripeSessionId){
  const safeEmail = normalizePremiumKey(email);
  const amount = Math.max(0, Math.floor(Number(credits) || 0));
  const safeSessionId = String(stripeSessionId || "").trim();

  if(!safeEmail || amount <= 0) return null;

  const existing = getPremiumAccount(safeEmail) || {};
  const processedSessions = Array.isArray(existing.processedStripeSessions) ? existing.processedStripeSessions : [];

  if(safeSessionId && processedSessions.includes(safeSessionId)){
    return {
      ...existing,
      duplicateStripeSession: true,
      duplicateStripeSessionId: safeSessionId
    };
  }

  const existingCredits = Number(existing.creditsRemaining || 0);
  const existingTotal = Number(existing.creditsTotal || 0);
  const pin = existing.premiumPin || makePremiumPin();

  const nextProcessedSessions = safeSessionId
    ? processedSessions.concat([safeSessionId]).slice(-100)
    : processedSessions;

  return setPremiumAccount(safeEmail, {
    active: true,
    email: safeEmail,
    premiumPin: pin,
    creditsRemaining: existingCredits + amount,
    creditsTotal: existingTotal + amount,
    plan: existing.plan === "unlimited" ? "unlimited" : "credits",
    source: "stripe_credits",
    processedStripeSessions: nextProcessedSessions,
    lastStripeSessionId: safeSessionId,
    lastCreditPurchaseAt: new Date().toISOString(),
    lastCreditPurchaseAmount: amount,
    reason: reason || "stripe_credit_purchase"
  });
}

function activateUnlimitedAccount(email, data){
  const safeEmail = normalizePremiumKey(email);
  if(!safeEmail) return null;
  const existing = getPremiumAccount(safeEmail) || {};
  const pin = existing.premiumPin || makePremiumPin();
  return setPremiumAccount(safeEmail, {
    ...(data || {}),
    active: true,
    email: safeEmail,
    premiumPin: pin,
    creditsRemaining: UNLIMITED_FAIR_USE_CREDITS,
    creditsTotal: UNLIMITED_FAIR_USE_CREDITS,
    creditMonth: currentPremiumMonth(),
    plan: "unlimited",
    source: "stripe_unlimited",
    reason: (data && data.reason) || "stripe_unlimited_active"
  });
}

loadPremiumAccounts();

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event = null;

  try{
    if(STRIPE_WEBHOOK_SECRET && stripeClient){
      const signature = req.headers["stripe-signature"];
      event = stripeClient.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
    }else{
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "{}");
      event = JSON.parse(rawBody || "{}");
    }
  }catch(err){
    console.error("Stripe webhook verificatie fout:", err.message || String(err));
    return res.status(400).json({ error: "Webhook verificatie mislukt" });
  }

  try{
    const object = event && event.data && event.data.object ? event.data.object : {};
    const type = String(event && event.type ? event.type : "");

    if(type === "checkout.session.completed"){
      const email = object.customer_email || object.customer_details?.email || object.metadata?.email || "";
      const mode = String(object.mode || "");
      const metadata = object.metadata || {};
      const packageCredits = Number(metadata.credits || 0);
      const packageType = String(metadata.packageType || "");

      if(mode === "payment" && packageType === "credits" && packageCredits > 0){
        addCreditsToAccount(email, packageCredits, "checkout.session.completed.credit_pack", object.id || "");
      }else{
        setPremiumForStripeData({
          email,
          clientReferenceId: object.client_reference_id || metadata.clientReferenceId || "",
          customerId: object.customer || "",
          subscriptionId: object.subscription || "",
          active: true,
          reason: "checkout.session.completed"
        });
      }
    }

    if(type === "invoice.payment.paid"){
      setPremiumForStripeData({
        email: object.customer_email || object.metadata?.email || "",
        clientReferenceId: object.metadata?.clientReferenceId || "",
        customerId: object.customer || "",
        subscriptionId: object.subscription || "",
        active: true,
        reason: "invoice.payment.paid"
      });
    }

    if(type === "invoice.payment_failed"){
      setPremiumForStripeData({
        email: object.customer_email || object.metadata?.email || "",
        clientReferenceId: object.metadata?.clientReferenceId || "",
        customerId: object.customer || "",
        subscriptionId: object.subscription || "",
        active: false,
        reason: "invoice.payment_failed"
      });
    }

    if(type === "customer.subscription.deleted"){
      setPremiumForStripeData({
        email: object.customer_email || object.metadata?.email || "",
        clientReferenceId: object.metadata?.clientReferenceId || "",
        customerId: object.customer || "",
        subscriptionId: object.id || "",
        active: false,
        reason: "customer.subscription.deleted",
        ...extractStripeSubscriptionPeriod(object)
      });
    }

    res.json({ received: true });
  }catch(err){
    console.error("Stripe webhook verwerking fout:", err.message || String(err));
    res.status(500).json({ error: "Webhook verwerking mislukt" });
  }
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

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


function buildFormBody(data, prefix){
  const params = new URLSearchParams();
  function add(value, key){
    if(value === undefined || value === null) return;
    if(Array.isArray(value)){
      value.forEach((item, index) => add(item, key + "[" + index + "]"));
      return;
    }
    if(typeof value === "object"){
      Object.keys(value).forEach((childKey) => add(value[childKey], key ? key + "[" + childKey + "]" : childKey));
      return;
    }
    params.append(key, String(value));
  }
  add(data, prefix || "");
  return params;
}

async function callStripe(pathName, payload){
  if(!STRIPE_SECRET_KEY){
    throw new Error("STRIPE_SECRET_KEY ontbreekt in Render Environment Variables");
  }

  const response = await fetch("https://api.stripe.com/v1" + pathName, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + STRIPE_SECRET_KEY,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: buildFormBody(payload).toString()
  });

  const data = await response.json().catch(() => ({}));
  if(!response.ok){
    const msg = data && data.error && data.error.message ? data.error.message : "Stripe aanvraag mislukt";
    throw new Error(msg);
  }
  return data;
}

async function callStripeGet(pathName){
  if(!STRIPE_SECRET_KEY){
    throw new Error("STRIPE_SECRET_KEY ontbreekt in Render Environment Variables");
  }

  const response = await fetch("https://api.stripe.com/v1" + pathName, {
    method: "GET",
    headers: {
      "Authorization": "Bearer " + STRIPE_SECRET_KEY
    }
  });

  const data = await response.json().catch(() => ({}));
  if(!response.ok){
    const msg = data && data.error && data.error.message ? data.error.message : "Stripe aanvraag mislukt";
    throw new Error(msg);
  }
  return data;
}

function successUrlWithCheckoutSession(url){
  const safeUrl = String(url || STRIPE_SUCCESS_URL || "").trim();
  if(!safeUrl) return STRIPE_SUCCESS_URL;
  if(safeUrl.includes("checkout_session_id=") || safeUrl.includes("session_id=")) return safeUrl;
  const separator = safeUrl.includes("?") ? "&" : "?";
  return safeUrl + separator + "checkout_session_id={CHECKOUT_SESSION_ID}";
}

async function sendResendEmail({ to, subject, text, html }){
  if(!RESEND_API_KEY){
    throw new Error("RESEND_API_KEY ontbreekt in Render Environment Variables");
  }

  if(!FROM_EMAIL){
    throw new Error("FROM_EMAIL ontbreekt in Render Environment Variables");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + RESEND_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject: subject,
      text: text,
      html: html
    })
  });

  const data = await response.json().catch(() => ({}));
  if(!response.ok){
    const msg = data && data.message ? data.message : (data && data.error ? data.error : "Resend mail aanvraag mislukt");
    throw new Error(msg);
  }

  return data;
}

function premiumPinEmailText(pin){
  return "Beste ECHO AI Premium gebruiker,\n\nJe nieuwe 6 cijferige pincode is: " + pin + "\n\nGebruik deze pincode samen met je e-mailadres om AI Premium te activeren.\n\nAls jij deze reset niet hebt aangevraagd, neem dan contact op met FormForge.\n\nFormForge ECHO";
}

function premiumPinEmailHtml(pin){
  return "<div style=\"font-family:Arial,sans-serif;line-height:1.5;color:#111\">" +
    "<h2>Je nieuwe ECHO AI Premium pincode</h2>" +
    "<p>Je nieuwe 6 cijferige pincode is:</p>" +
    "<p style=\"font-size:28px;font-weight:800;letter-spacing:4px\">" + pin + "</p>" +
    "<p>Gebruik deze pincode samen met je e-mailadres om AI Premium te activeren.</p>" +
    "<p>Als jij deze reset niet hebt aangevraagd, neem dan contact op met FormForge.</p>" +
    "<p>FormForge ECHO</p>" +
  "</div>";
}


function starterCreditsEmailText(pin, credits){
  return "Beste ECHO gebruiker,\n\nJe ECHO account is aangemaakt.\n\nJe 6 cijferige pincode is: " + pin + "\nJe hebt " + credits + " gratis AI credits ontvangen.\n\nGebruik deze pincode samen met je e-mailadres om ECHO AI te activeren.\n\nFormForge ECHO";
}

function starterCreditsEmailHtml(pin, credits){
  return "<div style=\"font-family:Arial,sans-serif;line-height:1.5;color:#111\">" +
    "<h2>Je ECHO startercredits</h2>" +
    "<p>Je ECHO account is aangemaakt.</p>" +
    "<p>Je 6 cijferige pincode is:</p>" +
    "<p style=\"font-size:28px;font-weight:800;letter-spacing:4px\">" + pin + "</p>" +
    "<p>Je hebt <strong>" + credits + " gratis AI credits</strong> ontvangen.</p>" +
    "<p>Gebruik deze pincode samen met je e-mailadres om ECHO AI te activeren.</p>" +
    "<p>FormForge ECHO</p>" +
  "</div>";
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


function normalizeTtsVoice(value){
  const requested = String(value || "").trim().toLowerCase();
  const allowed = ["alloy","ash","ballad","coral","echo","fable","nova","onyx","sage","shimmer","verse","marin","cedar"];
  if(allowed.includes(requested)) return requested;
  return "nova";
}

function normalizeTtsModel(value){
  const requested = String(value || "").trim();
  if(requested === "tts-1" || requested === "tts-1-hd" || requested === "gpt-4o-mini-tts"){
    return requested;
  }
  return process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
}

function buildTtsInstructions(language){
  const lang = String(language || "").trim().toLowerCase();
  if(lang === "ar" || lang === "ar-sa"){
    return "Spreek de tekst duidelijk en natuurlijk uit in modern Arabisch. Gebruik een warme, rustige professionele stem. Spreek niet te snel.";
  }
  if(lang === "nl" || lang === "nl-nl"){
    return "Spreek de tekst duidelijk en natuurlijk uit in Nederlands. Gebruik een warme, rustige professionele stem. Spreek niet te snel.";
  }
  if(lang === "en" || lang === "en-gb" || lang === "en-us"){
    return "Speak clearly and naturally in English. Use a warm, calm professional voice. Do not speak too fast.";
  }
  if(lang === "de" || lang === "de-de"){
    return "Sprich den Text klar und natürlich auf Deutsch. Verwende eine warme, ruhige professionelle Stimme. Sprich nicht zu schnell.";
  }
  if(lang === "fr" || lang === "fr-fr"){
    return "Prononce le texte clairement et naturellement en français. Utilise une voix chaleureuse, calme et professionnelle. Ne parle pas trop vite.";
  }
  if(lang === "es" || lang === "es-es"){
    return "Lee el texto con claridad y naturalidad en español. Usa una voz cálida, tranquila y profesional. No hables demasiado rápido.";
  }
  return "Spreek de tekst duidelijk, natuurlijk en professioneel uit in de gevraagde taal. Spreek niet te snel.";
}

app.post("/api/openai/tts", async (req, res) => {
  try{
    if(!OPENAI_API_KEY){
      return jsonError(res, 500, "OPENAI_API_KEY ontbreekt");
    }

    const text = String(req.body && req.body.text ? req.body.text : "").trim();
    const language = String(req.body && (req.body.language || req.body.lang) ? (req.body.language || req.body.lang) : "").trim();
    const premiumKey = String(req.body && (req.body.email || req.body.premiumEmail || req.body.userId || req.body.premiumKey) ? (req.body.email || req.body.premiumEmail || req.body.userId || req.body.premiumKey) : "").trim();
    const premiumPin = String(req.body && (req.body.pin || req.body.pincode || req.body.premiumPin) ? (req.body.pin || req.body.pincode || req.body.premiumPin) : "").trim();

    if(!text){
      return jsonError(res, 400, "Tekst ontbreekt");
    }

    if(text.length > 1800){
      return jsonError(res, 400, "Tekst is te lang voor AI stem");
    }

    const premiumStatus = getPremiumStatus(premiumKey, premiumPin);
    if(!premiumStatus.premium){
      return jsonError(res, premiumStatus.pinRequired ? 403 : 402, premiumStatus.pinRequired ? "Premium pincode is ongeldig" : "AI Premium is niet actief voor dit account");
    }

    const deviceId = String(req.body && (req.body.deviceId || req.body.device_id || req.body.clientDeviceId) ? (req.body.deviceId || req.body.device_id || req.body.clientDeviceId) : "").trim();
    const account = getPremiumAccount(premiumKey);
    if(account && String(account.plan || "") === "unlimited"){
      const registeredDeviceId = String(account.unlimitedDeviceId || "").trim();
      if(!deviceId){
        return jsonError(res, 403, "Unlimited Premium vereist apparaatcontrole");
      }
      if(registeredDeviceId && registeredDeviceId !== deviceId){
        return jsonError(res, 403, "Unlimited Premium is al actief op een ander apparaat. Dit abonnement werkt op één toestel tegelijk.");
      }
      if(!registeredDeviceId){
        setPremiumAccount(premiumKey, {
          unlimitedDeviceId: deviceId,
          unlimitedDeviceActivatedAt: new Date().toISOString(),
          reason: "unlimited_device_registered_tts"
        });
      }
    }

    const voice = normalizeTtsVoice(req.body && req.body.voice ? req.body.voice : process.env.OPENAI_TTS_VOICE || "nova");
    const model = normalizeTtsModel(req.body && req.body.model ? req.body.model : process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts");
    const instructions = String(req.body && req.body.instructions ? req.body.instructions : buildTtsInstructions(language)).trim();

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        instructions,
        response_format: "mp3"
      })
    });

    if(!response.ok){
      const errorText = await response.text().catch(() => "");
      return jsonError(res, 500, "AI stem kon niet worden gemaakt", errorText || "OpenAI TTS fout");
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audioBuffer.length);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-ECHO-TTS-Voice", voice);
    res.setHeader("X-ECHO-TTS-Model", model);
    res.send(audioBuffer);

  }catch(err){
    jsonError(res, 500, "AI stem fout", err.message || String(err));
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
    services: ["private-chat", "echochat-5", "echoconnect", "openai-translate", "openai-tts", "stripe-checkout", "stripe-webhook"],
    groupId: GROUP_ID,
    members: GROUP_MEMBERS.length,
    openaiConfigured: !!OPENAI_API_KEY,
    stripeConfigured: !!STRIPE_SECRET_KEY,
    time: new Date().toISOString()
  });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "ECHO Central Server", openaiConfigured: !!OPENAI_API_KEY, stripeConfigured: !!STRIPE_SECRET_KEY, time: new Date().toISOString() });
});


app.get("/api/stripe/status", (req, res) => {
  res.json({
    ok: true,
    stripeConfigured: !!STRIPE_SECRET_KEY,
    defaultPriceConfigured: !!STRIPE_DEFAULT_PRICE_ID,
    webhookSecretConfigured: !!STRIPE_WEBHOOK_SECRET,
    resendConfigured: !!RESEND_API_KEY,
    fromEmail: FROM_EMAIL,
    premiumAccountsInMemory: premiumAccounts.size,
    unlimitedFairUseCredits: UNLIMITED_FAIR_USE_CREDITS,
    starterFreeCredits: STARTER_FREE_CREDITS,
    creditPackages: {
      credits100: !!STRIPE_CREDITS_100_PRICE_ID,
      credits500: !!STRIPE_CREDITS_500_PRICE_ID,
      credits1500: !!STRIPE_CREDITS_1500_PRICE_ID,
      unlimited: !!STRIPE_UNLIMITED_PRICE_ID
    },
    premiumStoreFile: PREMIUM_STORE_FILE,
    mode: STRIPE_SECRET_KEY.startsWith("sk_live_") ? "live" : (STRIPE_SECRET_KEY.startsWith("sk_test_") ? "test" : "unknown")
  });
});

app.get("/api/stripe/premium-status", async (req, res) => {
  const key = String(req.query.email || req.query.userId || req.query.customerId || req.query.subscriptionId || "").trim();
  const pin = String(req.query.pin || req.query.pincode || req.query.premiumPin || "").trim();
  await refreshPremiumAccountFromStripe(key);
  const status = getPremiumStatus(key, pin);
  res.json({
    ok: true,
    premium: status.premium,
    pinRequired: status.pinRequired,
    creditsRemaining: status.creditsRemaining,
    creditsTotal: status.creditsTotal,
    creditMonth: status.creditMonth,
    plan: status.plan,
    starterCreditsGranted: status.starterCreditsGranted,
    subscriptionStatus: status.subscriptionStatus,
    periodStart: status.periodStart,
    periodEnd: status.periodEnd,
    currentPeriodStart: status.currentPeriodStart,
    currentPeriodEnd: status.currentPeriodEnd,
    nextPaymentDate: status.nextPaymentDate,
    cancelAtPeriodEnd: status.cancelAtPeriodEnd,
    cancelAt: status.cancelAt,
    canceledAt: status.canceledAt,
    account: status
  });
});

app.post("/api/stripe/premium-status", async (req, res) => {
  const key = String(req.body && (req.body.email || req.body.userId || req.body.customerId || req.body.subscriptionId) ? (req.body.email || req.body.userId || req.body.customerId || req.body.subscriptionId) : "").trim();
  const pin = String(req.body && (req.body.pin || req.body.pincode || req.body.premiumPin) ? (req.body.pin || req.body.pincode || req.body.premiumPin) : "").trim();
  await refreshPremiumAccountFromStripe(key);
  const status = getPremiumStatus(key, pin);
  res.json({
    ok: true,
    premium: status.premium,
    pinRequired: status.pinRequired,
    creditsRemaining: status.creditsRemaining,
    creditsTotal: status.creditsTotal,
    creditMonth: status.creditMonth,
    plan: status.plan,
    starterCreditsGranted: status.starterCreditsGranted,
    subscriptionStatus: status.subscriptionStatus,
    periodStart: status.periodStart,
    periodEnd: status.periodEnd,
    currentPeriodStart: status.currentPeriodStart,
    currentPeriodEnd: status.currentPeriodEnd,
    nextPaymentDate: status.nextPaymentDate,
    cancelAtPeriodEnd: status.cancelAtPeriodEnd,
    cancelAt: status.cancelAt,
    canceledAt: status.canceledAt,
    account: status
  });
});

app.post("/api/stripe/confirm-session", async (req, res) => {
  try{
    const sessionId = String(req.body && (req.body.sessionId || req.body.checkout_session_id || req.body.session_id) ? (req.body.sessionId || req.body.checkout_session_id || req.body.session_id) : "").trim();
    if(!sessionId || !sessionId.startsWith("cs_")){
      return jsonError(res, 400, "Stripe checkout sessie ontbreekt");
    }

    const session = await callStripeGet("/checkout/sessions/" + encodeURIComponent(sessionId));
    const email = normalizePremiumKey(session.customer_email || (session.customer_details && session.customer_details.email) || (session.metadata && session.metadata.email) || "");
    const clientReferenceId = normalizePremiumKey(session.client_reference_id || (session.metadata && session.metadata.clientReferenceId) || email);
    const subscriptionId = session.subscription || "";
    const customerId = session.customer || "";
    const mode = String(session.mode || "");
    const metadata = session.metadata || {};
    const packageCredits = Number(metadata.credits || 0);
    const packageType = String(metadata.packageType || "");
    let subscriptionData = null;
    let periodData = {};
    if(subscriptionId){
      try{
        subscriptionData = await callStripeGet("/subscriptions/" + encodeURIComponent(subscriptionId));
        periodData = extractStripeSubscriptionPeriod(subscriptionData);
      }catch(e){
        console.warn("Stripe abonnement details konden niet worden opgehaald:", e.message || String(e));
      }
    }
    const sessionOk = session.status === "complete" || session.payment_status === "paid" || !!subscriptionId;

    if(!sessionOk || !email){
      return jsonError(res, 402, "Stripe betaling is nog niet bevestigd");
    }

    if(mode === "payment" && packageType === "credits" && packageCredits > 0){
      const creditAccount = addCreditsToAccount(email, packageCredits, "checkout.session.confirmed.credit_pack", session.id || "");
      return res.json({
        ok: true,
        premium: true,
        email,
        premiumPin: creditAccount && creditAccount.premiumPin ? creditAccount.premiumPin : "",
        pin: creditAccount && creditAccount.premiumPin ? creditAccount.premiumPin : "",
        creditsRemaining: creditAccount ? Number(creditAccount.creditsRemaining || 0) : 0,
        creditsTotal: creditAccount ? Number(creditAccount.creditsTotal || 0) : 0,
        creditMonth: creditAccount ? String(creditAccount.creditMonth || currentPremiumMonth()) : currentPremiumMonth(),
        plan: creditAccount ? String(creditAccount.plan || "credits") : "credits",
        addedCredits: packageCredits,
        message: creditAccount && creditAccount.duplicateStripeSession ? "Deze betaling was al verwerkt. Credits zijn niet dubbel toegevoegd." : packageCredits + " AI credits zijn toegevoegd."
      });
    }

    setPremiumForStripeData({
      email,
      clientReferenceId,
      customerId,
      subscriptionId,
      active: true,
      reason: "checkout.session.confirmed",
      ...periodData
    });

    const account = getPremiumAccount(email);
    res.json({
      ok: true,
      premium: true,
      email,
      premiumPin: account && account.premiumPin ? account.premiumPin : "",
      pin: account && account.premiumPin ? account.premiumPin : "",
      creditsRemaining: account ? Number(account.creditsRemaining || 0) : 0,
      creditsTotal: account ? Number(account.creditsTotal || 0) : 0,
      creditMonth: account ? String(account.creditMonth || currentPremiumMonth()) : currentPremiumMonth(),
      subscriptionStatus: account ? String(account.subscriptionStatus || "") : "",
      periodStart: account ? String(account.periodStart || account.currentPeriodStart || "") : "",
      periodEnd: account ? String(account.periodEnd || account.currentPeriodEnd || "") : "",
      currentPeriodStart: account ? String(account.currentPeriodStart || account.periodStart || "") : "",
      currentPeriodEnd: account ? String(account.currentPeriodEnd || account.periodEnd || "") : "",
      nextPaymentDate: account && !account.cancelAtPeriodEnd ? String(account.periodEnd || account.currentPeriodEnd || "") : "",
      cancelAtPeriodEnd: account ? !!account.cancelAtPeriodEnd : false,
      cancelAt: account ? String(account.cancelAt || "") : "",
      canceledAt: account ? String(account.canceledAt || "") : ""
    });
  }catch(err){
    jsonError(res, 500, "Stripe sessie kon niet worden bevestigd", err.message || String(err));
  }
});

app.post("/api/stripe/use-credit", (req, res) => {
  const key = String(req.body && (req.body.email || req.body.userId || req.body.customerId || req.body.subscriptionId) ? (req.body.email || req.body.userId || req.body.customerId || req.body.subscriptionId) : "").trim();
  const pin = String(req.body && (req.body.pin || req.body.pincode || req.body.premiumPin) ? (req.body.pin || req.body.pincode || req.body.premiumPin) : "").trim();
  const deviceId = String(req.body && (req.body.deviceId || req.body.device_id || req.body.clientDeviceId) ? (req.body.deviceId || req.body.device_id || req.body.clientDeviceId) : "").trim();
  const result = consumePremiumCredit(key, pin, deviceId);
  if(!result.ok){
    return jsonError(res, result.status || 400, result.error || "Credit kon niet worden verwerkt");
  }
  res.json({
    ok: true,
    premium: true,
    creditsRemaining: result.status.creditsRemaining,
    creditsTotal: result.status.creditsTotal,
    creditMonth: result.status.creditMonth,
    account: result.status
  });
});



app.post("/api/stripe/reset-unlimited-device", (req, res) => {
  try{
    const email = normalizePremiumKey(req.body && req.body.email ? req.body.email : "");
    const pin = normalizePremiumPin(req.body && (req.body.pin || req.body.pincode || req.body.premiumPin) ? (req.body.pin || req.body.pincode || req.body.premiumPin) : "");

    if(!email){
      return jsonError(res, 400, "E-mailadres ontbreekt");
    }

    if(!pin){
      return jsonError(res, 400, "Pincode ontbreekt");
    }

    const account = getPremiumAccount(email);

    if(!account || !account.active){
      return jsonError(res, 404, "Geen actief account gevonden");
    }

    if(!verifyPremiumPin(account, pin)){
      return jsonError(res, 403, "Pincode is ongeldig");
    }

    if(String(account.plan || "") !== "unlimited"){
      return jsonError(res, 400, "Dit is geen Unlimited Premium account");
    }

    const updated = setPremiumAccount(email, {
      unlimitedDeviceId: "",
      unlimitedDeviceResetAt: new Date().toISOString(),
      reason: "unlimited_device_reset_by_user"
    });

    res.json({
      ok: true,
      reset: true,
      premium: true,
      plan: "unlimited",
      creditsRemaining: Number(updated.creditsRemaining || 0),
      creditsTotal: Number(updated.creditsTotal || 0),
      message: "Apparaatkoppeling is gereset. Het volgende toestel dat vertaalt wordt het actieve Unlimited toestel."
    });
  }catch(err){
    jsonError(res, 500, "Apparaatkoppeling kon niet worden gereset", err.message || String(err));
  }
});

app.post("/api/stripe/cancel-subscription", async (req, res) => {
  try{
    const email = normalizePremiumKey(req.body && req.body.email ? req.body.email : "");
    const pin = String(req.body && (req.body.pin || req.body.pincode || req.body.premiumPin) ? (req.body.pin || req.body.pincode || req.body.premiumPin) : "").trim();

    if(!email){
      return jsonError(res, 400, "E-mailadres ontbreekt");
    }

    if(!pin){
      return jsonError(res, 400, "Pincode ontbreekt");
    }

    const account = getPremiumAccount(email);

    if(!account || !account.active){
      return jsonError(res, 404, "Geen actief Premium abonnement gevonden");
    }

    if(!verifyPremiumPin(account, pin)){
      return jsonError(res, 403, "Pincode is ongeldig");
    }

    if(!account.subscriptionId){
      return jsonError(res, 400, "Geen Stripe abonnement gevonden bij dit account");
    }

    const cancelledSubscription = await callStripe("/subscriptions/" + encodeURIComponent(account.subscriptionId), {
      cancel_at_period_end: true
    });
    const periodData = extractStripeSubscriptionPeriod(cancelledSubscription);

    setPremiumAccount(email, {
      ...periodData,
      cancelAtPeriodEnd: true,
      cancelRequestedAt: new Date().toISOString(),
      reason: "cancel_requested_by_user"
    });

    res.json({
      ok: true,
      cancelled: true,
      cancelAtPeriodEnd: true,
      periodStart: periodData.periodStart || periodData.currentPeriodStart || "",
      periodEnd: periodData.periodEnd || periodData.currentPeriodEnd || "",
      currentPeriodStart: periodData.currentPeriodStart || periodData.periodStart || "",
      currentPeriodEnd: periodData.currentPeriodEnd || periodData.periodEnd || "",
      subscriptionStatus: periodData.subscriptionStatus || "",
      message: "Je abonnement is opgezegd en blijft actief tot het einde van de betaalde periode."
    });

  }catch(err){
    jsonError(res, 500, "Abonnement kon niet worden opgezegd", err.message || String(err));
  }
});

app.post("/api/stripe/request-pin-reset", async (req, res) => {
  try{
    const email = normalizePremiumKey(req.body && req.body.email ? req.body.email : "");

    if(!email){
      return jsonError(res, 400, "E-mailadres ontbreekt");
    }

    const account = getPremiumAccount(email);

    if(!account || !account.active){
      return res.json({
        ok: true,
        sent: false,
        message: "Als dit e-mailadres een actief Premium account heeft, wordt er een nieuwe pincode verstuurd."
      });
    }

    const newPin = makePremiumPin();
    setPremiumAccount(email, {
      premiumPin: newPin,
      lastPinResetAt: new Date().toISOString(),
      reason: "pin_reset_requested"
    });

    await sendResendEmail({
      to: email,
      subject: "Je nieuwe ECHO AI Premium pincode",
      text: premiumPinEmailText(newPin),
      html: premiumPinEmailHtml(newPin)
    });

    res.json({
      ok: true,
      sent: true,
      message: "Nieuwe pincode is verstuurd naar het Premium e-mailadres."
    });
  }catch(err){
    jsonError(res, 500, "Pincode reset mail kon niet worden verstuurd", err.message || String(err));
  }
});

app.post("/api/stripe/activate-starter", async (req, res) => {
  try{
    const email = normalizePremiumKey(req.body && req.body.email ? req.body.email : "");
    const suppliedPin = normalizePremiumPin(req.body && (req.body.pin || req.body.pincode || req.body.premiumPin) ? (req.body.pin || req.body.pincode || req.body.premiumPin) : "");

    if(!email){
      return jsonError(res, 400, "E-mailadres ontbreekt");
    }

    let account = getPremiumAccount(email);

    if(account && account.premiumPin && suppliedPin && !verifyPremiumPin(account, suppliedPin)){
      return jsonError(res, 403, "Pincode is ongeldig voor dit e-mailadres");
    }

    if(account && account.active && account.plan !== "starter"){
      const status = getPremiumStatus(email, suppliedPin || account.premiumPin, { allowWithoutPin: !suppliedPin });
      return res.json({
        ok: true,
        alreadyActive: true,
        premium: status.premium || !!account.active,
        active: !!account.active,
        email,
        premiumPin: account.premiumPin || "",
        pin: account.premiumPin || "",
        creditsRemaining: Number(account.creditsRemaining || 0),
        creditsTotal: Number(account.creditsTotal || UNLIMITED_FAIR_USE_CREDITS),
        creditMonth: String(account.creditMonth || currentPremiumMonth()),
        plan: String(account.plan || "premium"),
        starterCreditsGranted: !!account.starterCreditsGranted,
        message: "Dit e-mailadres heeft al een actief AI account."
      });
    }

    if(account && account.starterCreditsGranted){
      return res.json({
        ok: true,
        alreadyActive: true,
        premium: true,
        active: true,
        email,
        premiumPin: account.premiumPin || "",
        pin: account.premiumPin || "",
        creditsRemaining: Number(account.creditsRemaining || 0),
        creditsTotal: Number(account.creditsTotal || STARTER_FREE_CREDITS),
        creditMonth: String(account.creditMonth || currentPremiumMonth()),
        plan: "starter",
        starterCreditsGranted: true,
        message: "Startercredits waren al geactiveerd voor dit e-mailadres."
      });
    }

    const pin = suppliedPin && suppliedPin.length === 6 ? suppliedPin : (account && account.premiumPin ? account.premiumPin : makePremiumPin());

    account = setPremiumAccount(email, {
      active: true,
      email,
      premiumPin: pin,
      creditsRemaining: STARTER_FREE_CREDITS,
      creditsTotal: STARTER_FREE_CREDITS,
      creditMonth: currentPremiumMonth(),
      plan: "starter",
      source: "starter",
      starterCreditsGranted: true,
      starterCreditsGrantedAt: new Date().toISOString(),
      reason: "starter_credits_activated"
    });

    let emailSent = false;
    if(RESEND_API_KEY){
      try{
        await sendResendEmail({
          to: email,
          subject: "Je ECHO startercredits en pincode",
          text: starterCreditsEmailText(pin, STARTER_FREE_CREDITS),
          html: starterCreditsEmailHtml(pin, STARTER_FREE_CREDITS)
        });
        emailSent = true;
      }catch(mailErr){
        console.warn("Startercredits mail kon niet worden verstuurd:", mailErr.message || String(mailErr));
      }
    }

    res.json({
      ok: true,
      premium: true,
      active: true,
      email,
      premiumPin: pin,
      pin,
      creditsRemaining: Number(account.creditsRemaining || 0),
      creditsTotal: Number(account.creditsTotal || STARTER_FREE_CREDITS),
      creditMonth: String(account.creditMonth || currentPremiumMonth()),
      plan: "starter",
      starterCreditsGranted: true,
      emailSent,
      message: STARTER_FREE_CREDITS + " gratis AI credits zijn geactiveerd."
    });
  }catch(err){
    jsonError(res, 500, "Startercredits konden niet worden geactiveerd", err.message || String(err));
  }
});


app.post("/api/stripe/create-credit-checkout", async (req, res) => {
  try{
    const email = normalizePremiumKey(req.body && req.body.email ? req.body.email : "");
    const packageKey = String(req.body && (req.body.package || req.body.packageKey || req.body.credits) ? (req.body.package || req.body.packageKey || req.body.credits) : "").trim();
    const pkg = CREDIT_PACKAGES[packageKey];

    if(!email){
      return jsonError(res, 400, "E-mailadres ontbreekt");
    }

    if(!pkg || !pkg.priceId){
      return jsonError(res, 400, "Ongeldig creditpakket");
    }

    const successUrl = String(req.body && req.body.successUrl ? req.body.successUrl : STRIPE_SUCCESS_URL).trim();
    const cancelUrl = String(req.body && req.body.cancelUrl ? req.body.cancelUrl : STRIPE_CANCEL_URL).trim();

    const payload = {
      mode: "payment",
      line_items: [
        {
          price: pkg.priceId,
          quantity: 1
        }
      ],
      success_url: successUrlWithCheckoutSession(successUrl),
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      customer_email: email,
      client_reference_id: email,
      metadata: {
        product: pkg.label,
        source: "formforge-echo",
        packageType: "credits",
        packageKey,
        credits: String(pkg.credits),
        email
      }
    };

    const session = await callStripe("/checkout/sessions", payload);

    res.json({
      ok: true,
      id: session.id,
      url: session.url,
      packageKey,
      credits: pkg.credits
    });
  }catch(err){
    jsonError(res, 500, "Credit checkout fout", err.message || String(err));
  }
});

app.post("/api/stripe/create-checkout", async (req, res) => {
  try{
    const priceId = String(req.body && (req.body.priceId || req.body.price_id) ? (req.body.priceId || req.body.price_id) : (STRIPE_UNLIMITED_PRICE_ID || STRIPE_DEFAULT_PRICE_ID)).trim();
    const customerEmail = String(req.body && req.body.email ? req.body.email : "").trim();
    const clientReferenceId = String(req.body && (req.body.userId || req.body.clientReferenceId) ? (req.body.userId || req.body.clientReferenceId) : "").trim();
    const successUrl = String(req.body && req.body.successUrl ? req.body.successUrl : STRIPE_SUCCESS_URL).trim();
    const cancelUrl = String(req.body && req.body.cancelUrl ? req.body.cancelUrl : STRIPE_CANCEL_URL).trim();

    if(!priceId){
      return jsonError(res, 400, "Stripe priceId ontbreekt. Zet STRIPE_PRICE_ID in Render of stuur priceId mee vanuit de app.");
    }

    const payload = {
      mode: "subscription",
      "line_items": [
        {
          price: priceId,
          quantity: 1
        }
      ],
      success_url: successUrlWithCheckoutSession(successUrl),
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      metadata: {
        product: "ECHO Unlimited Premium",
        source: "formforge-echo",
        email: customerEmail
      },
      subscription_data: {
        metadata: {
          product: "ECHO Unlimited Premium",
          source: "formforge-echo",
          email: customerEmail
        }
      }
    };

    if(customerEmail){
      payload.customer_email = customerEmail;
    }
    if(clientReferenceId){
      payload.client_reference_id = clientReferenceId;
      payload.metadata.clientReferenceId = clientReferenceId;
      payload.subscription_data.metadata.clientReferenceId = clientReferenceId;
    }

    const session = await callStripe("/checkout/sessions", payload);

    res.json({
      ok: true,
      id: session.id,
      url: session.url
    });
  }catch(err){
    jsonError(res, 500, "Stripe checkout fout", err.message || String(err));
  }
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




function normalizeEchoLanguageName(value){
  const raw = String(value || "").trim();
  const key = raw.toLowerCase();
  const map = {
    "nl":"Nederlands","nl-nl":"Nederlands","dutch":"Nederlands","nederlands":"Nederlands",
    "en":"Engels","en-gb":"Engels","en-us":"Engels","english":"Engels","engels":"Engels",
    "de":"Duits","de-de":"Duits","german":"Duits","duits":"Duits",
    "fr":"Frans","fr-fr":"Frans","french":"Frans","frans":"Frans",
    "es":"Spaans","es-es":"Spaans","spanish":"Spaans","spaans":"Spaans",
    "it":"Italiaans","it-it":"Italiaans","italian":"Italiaans","italiaans":"Italiaans",
    "pt":"Portugees","pt-pt":"Portugees","portuguese":"Portugees","portugees":"Portugees",
    "pl":"Pools","pl-pl":"Pools","polish":"Pools","pools":"Pools",
    "tr":"Turks","tr-tr":"Turks","turkish":"Turks","turks":"Turks",
    "ar":"Arabisch","ar-sa":"Arabisch","arabic":"Arabisch","arabisch":"Arabisch",
    "uk":"Oekraïens","uk-ua":"Oekraïens","ukrainian":"Oekraïens","oekraiens":"Oekraïens","oekraïens":"Oekraïens",
    "ru":"Russisch","ru-ru":"Russisch","russian":"Russisch","russisch":"Russisch",
    "zh":"Chinees","zh-cn":"Chinees","chinese":"Chinees","chinees":"Chinees",
    "ja":"Japans","ja-jp":"Japans","japanese":"Japans","japans":"Japans",
    "ko":"Koreaans","ko-kr":"Koreaans","korean":"Koreaans","koreaans":"Koreaans",
    "hi":"Hindi","hi-in":"Hindi","hindi":"Hindi",
    "id":"Indonesisch","id-id":"Indonesisch","indonesian":"Indonesisch","indonesisch":"Indonesisch",
    "th":"Thais","th-th":"Thais","thai":"Thais","thais":"Thais",
    "vi":"Vietnamees","vi-vn":"Vietnamees","vietnamese":"Vietnamees","vietnamees":"Vietnamees",
    "ro":"Roemeens","ro-ro":"Roemeens","romanian":"Roemeens","roemeens":"Roemeens",
    "cs":"Tsjechisch","cs-cz":"Tsjechisch","czech":"Tsjechisch","tsjechisch":"Tsjechisch",
    "sv":"Zweeds","sv-se":"Zweeds","swedish":"Zweeds","zweeds":"Zweeds"
  };
  return map[key] || raw || "de doeltaal";
}

function normalizeWhisperLanguageCode(value){
  const raw = String(value || "").trim().toLowerCase();
  const map = {
    "dutch":"nl","nederlands":"nl","nl-nl":"nl","nl":"nl",
    "english":"en","engels":"en","en-gb":"en","en-us":"en","en":"en",
    "german":"de","duits":"de","de-de":"de","de":"de",
    "french":"fr","frans":"fr","fr-fr":"fr","fr":"fr",
    "spanish":"es","spaans":"es","es-es":"es","es":"es",
    "italian":"it","italiaans":"it","it-it":"it","it":"it",
    "portuguese":"pt","portugees":"pt","pt-pt":"pt","pt":"pt",
    "polish":"pl","pools":"pl","pl-pl":"pl","pl":"pl",
    "turkish":"tr","turks":"tr","tr-tr":"tr","tr":"tr",
    "arabic":"ar","arabisch":"ar","ar-sa":"ar","ar":"ar",
    "ukrainian":"uk","oekraiens":"uk","oekraïens":"uk","uk-ua":"uk","uk":"uk",
    "russian":"ru","russisch":"ru","ru-ru":"ru","ru":"ru",
    "chinese":"zh","chinees":"zh","zh-cn":"zh","zh":"zh",
    "japanese":"ja","japans":"ja","ja-jp":"ja","ja":"ja",
    "korean":"ko","koreaans":"ko","ko-kr":"ko","ko":"ko",
    "hindi":"hi","hi-in":"hi","hi":"hi",
    "indonesian":"id","indonesisch":"id","id-id":"id","id":"id",
    "thai":"th","thais":"th","th-th":"th","th":"th",
    "vietnamese":"vi","vietnamees":"vi","vi-vn":"vi","vi":"vi",
    "romanian":"ro","roemeens":"ro","ro-ro":"ro","ro":"ro",
    "czech":"cs","tsjechisch":"cs","cs-cz":"cs","cs":"cs",
    "swedish":"sv","zweeds":"sv","sv-se":"sv","sv":"sv"
  };
  return map[raw] || raw.split("-")[0] || "";
}

app.post("/api/speech/translate-direct", upload.single("audio"), async (req, res) => {
  try{
    if(!OPENAI_API_KEY){
      return jsonError(res, 500, "OPENAI_API_KEY ontbreekt");
    }

    if(!req.file){
      return jsonError(res, 400, "Geen audio ontvangen");
    }

    const sourceLanguageRaw = String(req.body && (req.body.sourceLanguage || req.body.from || req.body.language) ? (req.body.sourceLanguage || req.body.from || req.body.language) : "").trim();
    const targetLanguageRaw = String(req.body && (req.body.targetLanguage || req.body.to) ? (req.body.targetLanguage || req.body.to) : "").trim();
    const sourceLanguage = normalizeWhisperLanguageCode(sourceLanguageRaw);
    const sourceLanguageName = normalizeEchoLanguageName(sourceLanguageRaw || sourceLanguage);
    const targetLanguageName = normalizeEchoLanguageName(targetLanguageRaw);
    const premiumKey = String(req.body && (req.body.email || req.body.premiumEmail || req.body.userId || req.body.premiumKey) ? (req.body.email || req.body.premiumEmail || req.body.userId || req.body.premiumKey) : "").trim();
    const premiumPin = String(req.body && (req.body.pin || req.body.pincode || req.body.premiumPin) ? (req.body.pin || req.body.pincode || req.body.premiumPin) : "").trim();

    const prompt = String(req.body && req.body.prompt ? req.body.prompt : "").trim() || (
      "De spreker spreekt " + sourceLanguageName + ". Dit is een live gesprek. " +
      "Verwacht gewone spreektaal, korte zinnen, namen, plaatsnamen, bedrijfsnamen, bedragen, aantallen en normale vragen. " +
      "Schrijf alleen op wat er echt gezegd wordt."
    );

    if(!sourceLanguage || !targetLanguageName){
      try{ fs.unlinkSync(req.file.path); }catch(e){}
      return jsonError(res, 400, "sourceLanguage en targetLanguage zijn verplicht");
    }

    const premiumStatusBefore = getPremiumStatus(premiumKey, premiumPin);
    if(!premiumStatusBefore.premium){
      try{ fs.unlinkSync(req.file.path); }catch(e){}
      return jsonError(
        res,
        premiumStatusBefore.pinRequired ? 403 : 402,
        premiumStatusBefore.pinRequired ? "Premium pincode is ongeldig" : "AI Premium is niet actief voor dit account"
      );
    }

    if(Number(premiumStatusBefore.creditsRemaining || 0) <= 0){
      try{ fs.unlinkSync(req.file.path); }catch(e){}
      return jsonError(res, 402, "AI credits zijn op voor deze maand");
    }

    const audioBuffer = fs.readFileSync(req.file.path);
    const formData = new FormData();
    formData.append(
      "file",
      new Blob(
        [audioBuffer],
        { type: req.file.mimetype || "audio/webm" }
      ),
      req.file.originalname || "audio.webm"
    );
    formData.append("model", "whisper-1");
    formData.append("language", sourceLanguage);
    formData.append("response_format", "json");
    if(prompt){
      formData.append("prompt", prompt);
    }

    const transcriptionResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY
      },
      body: formData
    });

    const transcriptionData = await transcriptionResponse.json().catch(() => ({}));

    try{ fs.unlinkSync(req.file.path); }catch(e){}

    if(!transcriptionResponse.ok){
      return jsonError(
        res,
        500,
        "Transcriptie mislukt",
        transcriptionData && transcriptionData.error && transcriptionData.error.message
          ? transcriptionData.error.message
          : "Whisper fout"
      );
    }

    const transcript = String(transcriptionData.text || "").trim();

    if(!transcript){
      return res.json({
        ok: true,
        transcript: "",
        translation: "",
        translatedText: "",
        text: "",
        result: "",
        sourceLanguage,
        sourceLanguageName,
        targetLanguage: targetLanguageName,
        targetLanguageName
      });
    }

    const translatedText = await callOpenAI([
      {
        role: "system",
        content:
          "Je bent ECHO, een professionele universele live tolk. Je vertaalt gesproken tekst voor een echt gesprek tussen twee mensen. " +
          "Vertaal altijd exact van " + sourceLanguageName + " naar " + targetLanguageName + ". " +
          "Dit geldt voor Nederlands naar elke andere taal en voor elke andere taal terug naar Nederlands. " +
          "Geef uitsluitend de vertaling in " + targetLanguageName + ". " +
          "Geen uitleg, geen opmerkingen, geen aanhalingstekens, geen bronzin en geen extra tekst. " +
          "Gebruik natuurlijke spreektaal zoals een menselijke tolk. " +
          "Vertaal nooit woord voor woord als dat onnatuurlijk klinkt. Vertaal de bedoeling, toon, vraagvorm en emotie correct. " +
          "Behoud namen, plaatsnamen, bedrijfsnamen, bedragen, getallen, datums, tijden, telefoonnummers en e-mailadressen exact. " +
          "Als de zin informeel is, vertaal informeel. Als de zin zakelijk is, vertaal zakelijk. " +
          "Corrigeer alleen duidelijke transcriptiefouten wanneer de bedoeling overduidelijk is."
      },
      {
        role: "user",
        content:
          "Brontaal: " + sourceLanguageName + "\n" +
          "Doeltaal: " + targetLanguageName + "\n\n" +
          "Gesproken transcript:\n" + transcript + "\n\n" +
          "Vertaling in " + targetLanguageName + ":"
      }
    ], 0);

    const cleanTranslation = String(translatedText || "")
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .trim();

    const creditResult = consumePremiumCredit(premiumKey, premiumPin, deviceId);
    if(!creditResult.ok){
      return jsonError(
        res,
        creditResult.status || 402,
        creditResult.error || "AI Premium credit ontbreekt"
      );
    }

    res.json({
      ok: true,
      transcript,
      translation: cleanTranslation,
      translatedText: cleanTranslation,
      text: cleanTranslation,
      result: cleanTranslation,
      sourceLanguage,
      sourceLanguageName,
      targetLanguage: targetLanguageName,
      targetLanguageName,
      creditsRemaining: creditResult.status.creditsRemaining,
      creditsTotal: creditResult.status.creditsTotal,
      creditMonth: creditResult.status.creditMonth
    });

  }catch(err){
    if(req.file && req.file.path){
      try{ fs.unlinkSync(req.file.path); }catch(e){}
    }
    jsonError(res, 500, "Directe spraakvertaling mislukt", err.message || String(err));
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Route niet gevonden", path: req.path });
});

app.listen(PORT, () => {
  console.log("ECHO Central Server draait op poort " + PORT);
  console.log("OpenAI actief: " + (OPENAI_API_KEY ? "ja" : "nee"));
  console.log("Stripe actief: " + (STRIPE_SECRET_KEY ? "ja" : "nee"));
  console.log("Stripe webhook secret actief: " + (STRIPE_WEBHOOK_SECRET ? "ja" : "nee"));
  console.log("Resend actief: " + (RESEND_API_KEY ? "ja" : "nee"));
  console.log("From email: " + FROM_EMAIL);
  console.log("ECHO Premium credits per maand: " + UNLIMITED_FAIR_USE_CREDITS);
  console.log("Premium accounts geladen: " + premiumAccounts.size);
});
