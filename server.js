const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const upload = multer({
  dest: path.join(__dirname, "uploads")
});

// Aparte multer voor kamer-media: in GEHEUGEN (vluchtig, verdwijnt vanzelf),
// met een groottelimiet zodat de server niet volloopt.
const ROOM_MEDIA_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const roomMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ROOM_MEDIA_MAX_BYTES }
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
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL || "https://formforge.nl/e-c-h-o-connect/?paid=1";
const STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL || "https://formforge.nl/e-c-h-o-connect/?canceled=1";
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

const ECHO_STARTER_FREE_CREDITS = Number(process.env.ECHO_STARTER_FREE_CREDITS || 10);
const FORMFORGE_FREE_DAILY_LIMIT = Number(process.env.FORMFORGE_FREE_DAILY_LIMIT || 1);
const STARTER_FREE_CREDITS = FORMFORGE_FREE_DAILY_LIMIT;
const UNLIMITED_FAIR_USE_CREDITS = Number(process.env.FORMFORGE_PRO_DAILY_LIMIT || process.env.ECHO_UNLIMITED_FAIR_USE_CREDITS || 999999);

const FORMFORGE_AI_PLUS_DAILY_LIMIT = Number(process.env.FORMFORGE_AI_PLUS_DAILY_LIMIT || 25);
const FORMFORGE_AI_PRO_DAILY_LIMIT = Number(process.env.FORMFORGE_AI_PRO_DAILY_LIMIT || 999999);

const STRIPE_FORMFORGE_AI_PLUS_PRICE_ID = process.env.STRIPE_FORMFORGE_AI_PLUS_PRICE_ID || "price_1TcRWw5s8MDSsy0eIJ0cB63N";
const STRIPE_FORMFORGE_AI_PRO_PRICE_ID = process.env.STRIPE_FORMFORGE_AI_PRO_PRICE_ID || "price_1TcRZk5s8MDSsy0ehhdgwvs2";
const STRIPE_UNLIMITED_PRICE_ID = process.env.STRIPE_UNLIMITED_PRICE_ID || "price_1TaI0q5s8MDSsy0eL2NZqIpD";
const STRIPE_MERCHANT_PRICE_ID = process.env.STRIPE_MERCHANT_PRICE_ID || "price_1TixHV5s8MDSsy0eVXyFZsz1";

const STRIPE_CREDITS_100_PRICE_ID = process.env.STRIPE_CREDITS_100_PRICE_ID || "price_1TaHrD5s8MDSsy0eV1krtPFL";
const STRIPE_CREDITS_500_PRICE_ID = process.env.STRIPE_CREDITS_500_PRICE_ID || "price_1TaHxD5s8MDSsy0eVrOvmYPM";
const STRIPE_CREDITS_1500_PRICE_ID = process.env.STRIPE_CREDITS_1500_PRICE_ID || "price_1TaHz15s8MDSsy0eMKRMDbxN";

const CREDIT_PACKAGES = {
  "100": { credits: 100, priceId: STRIPE_CREDITS_100_PRICE_ID, label: "FormForge ECHO 100 AI credits" },
  "500": { credits: 500, priceId: STRIPE_CREDITS_500_PRICE_ID, label: "FormForge ECHO 500 AI credits" },
  "1500": { credits: 1500, priceId: STRIPE_CREDITS_1500_PRICE_ID, label: "FormForge ECHO 1500 AI credits" }
};

function getCreditPackageByPriceId(priceId){
  const safePriceId = String(priceId || "").trim();
  return Object.values(CREDIT_PACKAGES).find((pkg) => pkg.priceId === safePriceId) || null;
}

function currentPremiumDay(){
  return new Date().toISOString().slice(0, 10);
}

function normalizeAiPlan(value){
  const plan = String(value || "").trim().toLowerCase();
  if(plan === "ai_plus" || plan === "plus" || plan === "formforge_ai_plus") return "plus";
  if(plan === "ai_pro" || plan === "pro" || plan === "unlimited" || plan === "formforge_ai_pro") return "pro";
  if(plan === "credits" || plan === "credit" || plan === "losse_credits" || plan === "credit_pack") return "credits";
  if(plan === "starter" || plan === "free" || plan === "gratis") return "starter";
  return plan || "starter";
}

function getAiPlanByPriceId(priceId){
  const id = String(priceId || "").trim();
  if(id && id === STRIPE_FORMFORGE_AI_PLUS_PRICE_ID) return "plus";
  if(id && id === STRIPE_FORMFORGE_AI_PRO_PRICE_ID) return "pro";
  if(id && id === STRIPE_UNLIMITED_PRICE_ID) return "pro";
  if(getCreditPackageByPriceId(id)) return "credits";
  return "";
}

function getAiPlanDailyLimit(plan){
  const normalized = normalizeAiPlan(plan);
  if(normalized === "plus") return FORMFORGE_AI_PLUS_DAILY_LIMIT;
  if(normalized === "pro") return FORMFORGE_AI_PRO_DAILY_LIMIT;
  return FORMFORGE_FREE_DAILY_LIMIT;
}

function getAiPlanLabel(plan){
  const normalized = normalizeAiPlan(plan);
  if(normalized === "plus") return "FormForge AI Plus";
  if(normalized === "pro") return "FormForge AI Pro";
  if(normalized === "credits") return "Losse AI credits";
  return "Gratis";
}

function getDailyUsage(account){
  const day = currentPremiumDay();
  const savedDay = String(account && account.aiUsageDate ? account.aiUsageDate : "");
  const used = savedDay === day ? Number(account && account.aiUsedToday ? account.aiUsedToday : 0) : 0;
  const plan = normalizeAiPlan(account && account.plan ? account.plan : "starter");

  if(plan === "credits"){
    const creditRemaining = Math.max(0, Math.floor(Number(account && account.creditsRemaining ? account.creditsRemaining : 0)));
    const creditTotal = Math.max(creditRemaining, Math.floor(Number(account && account.creditsTotal ? account.creditsTotal : creditRemaining)));
    return { day, used, limit: creditTotal, remaining: creditRemaining };
  }

  const limit = getAiPlanDailyLimit(plan);
  const remaining = plan === "pro" ? limit : Math.max(0, limit - used);
  return { day, used, limit, remaining };
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

function normalizeAppSource(value){
  const source = String(value || "").trim().toLowerCase();
  if(source === "echo" || source === "translator" || source === "vertaler" || source === "echo_live" || source === "echo-live") return "echo";
  if(source === "formforge" || source === "offerte" || source === "offertes" || source === "factuur" || source === "facturen" || source === "quote" || source === "invoice") return "formforge";
  return "formforge";
}

function detectAppSourceFromReq(req){
  const body = req && req.body ? req.body : {};
  const query = req && req.query ? req.query : {};
  const direct = body.source || body.appSource || body.app || body.product || body.module || query.source || query.appSource || query.app || query.product || query.module || "";
  if(direct) return normalizeAppSource(direct);
  const ref = String((req && req.headers && (req.headers.referer || req.headers.referrer)) || "").toLowerCase();
  if(ref.includes("offerte") || ref.includes("factuur") || ref.includes("invoice") || ref.includes("quote")) return "formforge";
  if(ref.includes("translator") || ref.includes("vertaler") || ref.includes("echo")) return "echo";
  return "formforge";
}

function buildPremiumAccountKey(email, source){
  const safeEmail = normalizePremiumKey(email);
  if(!safeEmail) return "";
  if(isOwnerPremiumEmail(safeEmail)) return safeEmail;
  return normalizeAppSource(source) + ":" + safeEmail;
}

const OWNER_PREMIUM_EMAIL = "info@generaalprojecten.nl";
const OWNER_PREMIUM_PIN = "654321";

function isOwnerPremiumEmail(value){
  return normalizePremiumKey(value) === OWNER_PREMIUM_EMAIL;
}

function buildOwnerPremiumAccount(){
  return {
    active: true,
    email: OWNER_PREMIUM_EMAIL,
    key: OWNER_PREMIUM_EMAIL,
    plan: "pro",
    planLabel: "FormForge AI Pro",
    premiumPin: OWNER_PREMIUM_PIN,
    subscriptionStatus: "active",
    source: "owner",
    reason: "owner-account-always-active",
    aiUsageDate: currentPremiumDay(),
    aiUsedToday: 0,
    aiDailyLimit: FORMFORGE_AI_PRO_DAILY_LIMIT,
    aiRemainingToday: FORMFORGE_AI_PRO_DAILY_LIMIT,
    creditsRemaining: FORMFORGE_AI_PRO_DAILY_LIMIT,
    creditsTotal: FORMFORGE_AI_PRO_DAILY_LIMIT,
    creditMonth: currentPremiumDay(),
    starterCreditsGranted: true,
    deviceId: "",
    activeDeviceId: "",
    deviceBoundAt: "",
    deviceLastSeenAt: "",
    updatedAt: new Date().toISOString()
  };
}

function ensureOwnerPremiumAccount(){
  return setPremiumAccount(OWNER_PREMIUM_EMAIL, buildOwnerPremiumAccount());
}

function getOwnerPremiumStatus(){
  const account = ensureOwnerPremiumAccount();
  const usage = getDailyUsage(account);
  return {
    premium: true,
    active: true,
    pinRequired: false,
    pinOk: true,
    deviceRequired: false,
    deviceConflict: false,
    deviceMessage: "",
    deviceId: "",
    activeDeviceId: "",
    activeDeviceLabel: "Eigenaar",
    creditsRemaining: FORMFORGE_AI_PRO_DAILY_LIMIT,
    creditsTotal: FORMFORGE_AI_PRO_DAILY_LIMIT,
    creditMonth: usage.day,
    aiUsedToday: 0,
    aiDailyLimit: FORMFORGE_AI_PRO_DAILY_LIMIT,
    aiRemainingToday: FORMFORGE_AI_PRO_DAILY_LIMIT,
    plan: "pro",
    planLabel: "FormForge AI Pro",
    starterCreditsGranted: true,
    email: OWNER_PREMIUM_EMAIL,
    subscriptionId: "",
    subscriptionStatus: "active",
    periodStart: "",
    periodEnd: "",
    currentPeriodStart: "",
    currentPeriodEnd: "",
    nextPaymentDate: "",
    cancelAtPeriodEnd: false,
    cancelAt: "",
    canceledAt: "",
    trialEnd: "",
    reason: "owner-account-always-active",
    updatedAt: account ? String(account.updatedAt || "") : new Date().toISOString()
  };
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

function normalizeDeviceId(value){
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, "")
    .slice(0, 120);
}

function deviceLabel(deviceId){
  const safe = normalizeDeviceId(deviceId);
  if(!safe) return "";
  if(safe.length <= 12) return safe;
  return safe.slice(0, 6) + "..." + safe.slice(-6);
}

function getRequestDeviceId(req){
  const body = req && req.body ? req.body : {};
  const query = req && req.query ? req.query : {};
  return normalizeDeviceId(
    body.deviceId ||
    body.device_id ||
    body.formforgeDeviceId ||
    query.deviceId ||
    query.device_id ||
    query.formforgeDeviceId ||
    ""
  );
}

function checkAccountDevice(account, deviceId, options){
  const opts = options || {};
  const safeDeviceId = normalizeDeviceId(deviceId);
  const accountDeviceId = normalizeDeviceId(account && (account.deviceId || account.activeDeviceId) ? (account.deviceId || account.activeDeviceId) : "");
  const requireDevice = opts.requireDevice !== false;

  if(!account || !account.active){
    return { ok: true, deviceId: safeDeviceId, accountDeviceId };
  }

  const lockedPlan = normalizeAiPlan(account.plan || "starter");
  if(lockedPlan === "starter" || lockedPlan === "credits"){
    return { ok: true, deviceId: safeDeviceId, accountDeviceId };
  }

  if(requireDevice && !safeDeviceId){
    return {
      ok: false,
      status: 428,
      code: "DEVICE_REQUIRED",
      deviceRequired: true,
      message: "Apparaatcontrole is actief. Open FormForge opnieuw of ververs de pagina zodat dit toestel gekoppeld kan worden."
    };
  }

  if(accountDeviceId && safeDeviceId && accountDeviceId !== safeDeviceId){
    return {
      ok: false,
      status: 409,
      code: "DEVICE_CONFLICT",
      deviceConflict: true,
      deviceId: safeDeviceId,
      accountDeviceId,
      message: "Dit FormForge AI abonnement is al actief op een ander toestel."
    };
  }

  return { ok: true, deviceId: safeDeviceId, accountDeviceId };
}

function bindAccountDeviceIfNeeded(key, account, deviceId){
  const safeKey = normalizePremiumKey(key || (account && account.email) || "");
  const safeDeviceId = normalizeDeviceId(deviceId);
  if(!safeKey || !account || !account.active || !safeDeviceId) return account;
  const plan = normalizeAiPlan(account.plan || "starter");
  if(plan === "starter" || plan === "credits") return account;

  const existingDeviceId = normalizeDeviceId(account.deviceId || account.activeDeviceId || "");
  if(existingDeviceId) return account;

  return setPremiumAccount(safeKey, {
    deviceId: safeDeviceId,
    activeDeviceId: safeDeviceId,
    deviceBoundAt: new Date().toISOString(),
    deviceLastSeenAt: new Date().toISOString()
  });
}

function touchAccountDevice(key, account, deviceId){
  const safeKey = normalizePremiumKey(key || (account && account.email) || "");
  const safeDeviceId = normalizeDeviceId(deviceId);
  if(!safeKey || !account || !account.active || !safeDeviceId) return account;
  const plan = normalizeAiPlan(account.plan || "starter");
  if(plan === "starter" || plan === "credits") return account;
  const existingDeviceId = normalizeDeviceId(account.deviceId || account.activeDeviceId || "");
  if(existingDeviceId !== safeDeviceId) return account;
  return setPremiumAccount(safeKey, {
    deviceLastSeenAt: new Date().toISOString()
  });
}

function setPremiumAccount(key, data){
  const safeKey = normalizePremiumKey(key);
  if(!safeKey) return null;
  const existing = premiumAccounts.get(safeKey) || {};
  const shouldActivate = data && data.active === true;
  const incomingPlan = data && data.plan ? normalizeAiPlan(data.plan) : "";
  const existingPlan = existing.plan ? normalizeAiPlan(existing.plan) : "";
  const finalPlan = incomingPlan || existingPlan || "starter";
  const dailyLimit = getAiPlanDailyLimit(finalPlan);
  const day = currentPremiumDay();
  const existingUsage = getDailyUsage(existing);
  const incomingUsageDate = data && typeof data.aiUsageDate !== "undefined" ? String(data.aiUsageDate || "") : existingUsage.day;
  const incomingUsedToday = data && typeof data.aiUsedToday !== "undefined" ? Number(data.aiUsedToday || 0) : existingUsage.used;
  const usedToday = incomingUsageDate === day ? Math.max(0, Math.floor(incomingUsedToday || 0)) : 0;
  const creditRemaining = finalPlan === "credits" ? Math.max(0, Math.floor(Number(data && typeof data.creditsRemaining !== "undefined" ? data.creditsRemaining : existing.creditsRemaining || 0))) : 0;
  const creditTotal = finalPlan === "credits" ? Math.max(creditRemaining, Math.floor(Number(data && typeof data.creditsTotal !== "undefined" ? data.creditsTotal : existing.creditsTotal || creditRemaining))) : 0;
  const remainingToday = finalPlan === "credits" ? creditRemaining : (finalPlan === "pro" ? dailyLimit : Math.max(0, dailyLimit - usedToday));
  const totalCredits = finalPlan === "credits" ? creditTotal : dailyLimit;

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
    planLabel: getAiPlanLabel(finalPlan),
    premiumPin,
    aiUsageDate: day,
    aiUsedToday: usedToday,
    aiDailyLimit: finalPlan === "credits" ? totalCredits : dailyLimit,
    aiRemainingToday: remainingToday,
    creditsRemaining: remainingToday,
    creditsTotal: totalCredits,
    creditMonth: day,
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
    const firstItem = subscription.items && subscription.items.data && subscription.items.data[0] ? subscription.items.data[0] : {};
    const priceId = firstItem.price && firstItem.price.id ? firstItem.price.id : "";
    const plan = getAiPlanByPriceId(priceId) || account.plan || "pro";
    return setPremiumAccount(account.email || value, {
      ...periodData,
      subscriptionId: subscription.id || account.subscriptionId,
      customerId: subscription.customer || account.customerId || "",
      active,
      plan,
      priceId,
      reason: "stripe.subscription.refreshed"
    });
  }catch(err){
    console.warn("Stripe abonnement kon niet worden ververst:", err.message || String(err));
    return account;
  }
}

function setPremiumForStripeData({ email, clientReferenceId, customerId, subscriptionId, active, reason, subscriptionStatus, currentPeriodStart, currentPeriodEnd, periodStart, periodEnd, cancelAtPeriodEnd, cancelAt, canceledAt, trialEnd, plan, priceId, deviceId, activeDeviceId, deviceBoundAt, deviceLastSeenAt }){
  const finalPlan = normalizeAiPlan(plan || getAiPlanByPriceId(priceId) || "pro");
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
    plan: finalPlan,
    priceId: priceId || "",
    deviceId: normalizeDeviceId(deviceId || activeDeviceId || ""),
    activeDeviceId: normalizeDeviceId(activeDeviceId || deviceId || ""),
    deviceBoundAt: deviceBoundAt || "",
    deviceLastSeenAt: deviceLastSeenAt || ""
  };

  const keys = [
    data.email,
    data.clientReferenceId,
    data.customerId,
    data.subscriptionId
  ].filter(Boolean);

  keys.forEach((key) => activateSubscriptionAccount(key, data));
  return data;
}

function getPremiumAccount(value){
  const safeKey = normalizePremiumKey(value);
  if(!safeKey) return null;
  const account = premiumAccounts.get(safeKey) || null;
  if(account && account.active){
    const usage = getDailyUsage(account);
    if(String(account.aiUsageDate || "") !== usage.day || Number(account.aiUsedToday || 0) !== usage.used || Number(account.aiDailyLimit || 0) !== usage.limit){
      return setPremiumAccount(safeKey, {
        aiUsageDate: usage.day,
        aiUsedToday: usage.used,
        aiDailyLimit: usage.limit,
        aiRemainingToday: usage.remaining,
        creditsRemaining: usage.remaining,
        creditsTotal: usage.limit,
        creditMonth: usage.day,
        plan: normalizeAiPlan(account.plan || "starter")
      });
    }
  }
  return account;
}

function getPremiumStatus(value, pin, options){
  if(isOwnerPremiumEmail(value)){
    return getOwnerPremiumStatus();
  }
  let account = getPremiumAccount(value);
  const allowWithoutPin = !!(options && options.allowWithoutPin);
  const deviceId = normalizeDeviceId(options && options.deviceId ? options.deviceId : "");
  const requireDevice = !(options && options.requireDevice === false);
  const pinOkBeforeDevice = account && account.active && (allowWithoutPin || verifyPremiumPin(account, pin));

  let deviceCheck = { ok: true };
  if(pinOkBeforeDevice){
    account = bindAccountDeviceIfNeeded(value, account, deviceId);
    deviceCheck = checkAccountDevice(account, deviceId, { requireDevice });
    if(deviceCheck.ok){
      account = touchAccountDevice(value, account, deviceId);
    }
  }

  const pinOk = !!(pinOkBeforeDevice && deviceCheck.ok);
  const usage = account ? getDailyUsage(account) : { day: currentPremiumDay(), used: 0, limit: STARTER_FREE_CREDITS, remaining: 0 };
  const plan = account ? normalizeAiPlan(account.plan || "starter") : "";
  const accountDeviceId = account ? normalizeDeviceId(account.deviceId || account.activeDeviceId || "") : "";

  return {
    premium: !!pinOk,
    active: !!pinOk,
    pinRequired: !!(account && account.active && !pinOkBeforeDevice),
    pinOk: !!pinOk,
    deviceRequired: !!(pinOkBeforeDevice && deviceCheck.deviceRequired),
    deviceConflict: !!(pinOkBeforeDevice && deviceCheck.deviceConflict),
    deviceMessage: deviceCheck.message || "",
    deviceId: deviceId,
    activeDeviceId: accountDeviceId,
    activeDeviceLabel: deviceLabel(accountDeviceId),
    creditsRemaining: account ? usage.remaining : 0,
    creditsTotal: account ? usage.limit : STARTER_FREE_CREDITS,
    creditMonth: usage.day,
    aiUsedToday: account ? usage.used : 0,
    aiDailyLimit: account ? usage.limit : STARTER_FREE_CREDITS,
    aiRemainingToday: account ? usage.remaining : 0,
    plan,
    planLabel: account ? getAiPlanLabel(plan) : "",
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
  const safeDeviceId = normalizeDeviceId(deviceId);
  if(isOwnerPremiumEmail(safeKey)){
    const account = ensureOwnerPremiumAccount();
    return { ok: true, account, status: getOwnerPremiumStatus() };
  }

  if(!safeKey){
    return { ok: false, status: 401, error: "E-mailadres ontbreekt" };
  }
  let account = getPremiumAccount(safeKey);
  if(!account || !account.active){
    return { ok: false, status: 402, error: "FormForge AI is niet actief voor dit account" };
  }
  if(!verifyPremiumPin(account, pin)){
    return { ok: false, status: 403, error: "Pincode is ongeldig" };
  }

  account = bindAccountDeviceIfNeeded(safeKey, account, safeDeviceId);
  const deviceCheck = checkAccountDevice(account, safeDeviceId, { requireDevice: true });
  if(!deviceCheck.ok){
    return { ok: false, status: deviceCheck.status || 409, error: deviceCheck.message || "Dit abonnement kan maar op één toestel actief zijn", code: deviceCheck.code || "DEVICE_ERROR" };
  }
  account = touchAccountDevice(safeKey, account, safeDeviceId);

  const usage = getDailyUsage(account);
  const plan = normalizeAiPlan(account.plan || "starter");
  let nextUsed = usage.used + 1;
  let updatePayload = {
    aiUsageDate: usage.day,
    aiUsedToday: nextUsed,
    lastCreditUsedAt: new Date().toISOString(),
    plan
  };

  if(plan !== "starter" && plan !== "credits"){
    updatePayload.deviceId = safeDeviceId;
    updatePayload.activeDeviceId = safeDeviceId;
    updatePayload.deviceLastSeenAt = new Date().toISOString();
  }

  if(plan === "credits"){
    if(usage.remaining <= 0){
      return { ok: false, status: 402, error: "Je losse AI credits zijn op. Koop nieuwe credits of neem Unlimited." };
    }
    updatePayload.creditsRemaining = Math.max(0, usage.remaining - 1);
    updatePayload.creditsTotal = usage.limit;
    updatePayload.aiRemainingToday = Math.max(0, usage.remaining - 1);
    updatePayload.aiDailyLimit = usage.limit;
  }else if(plan !== "pro" && usage.used >= usage.limit){
    return { ok: false, status: 402, error: "Je dagelijkse AI opdrachten zijn op. Upgrade naar AI Plus of AI Pro." };
  }

  const updated = setPremiumAccount(safeKey, updatePayload);

  return { ok: true, account: updated, status: getPremiumStatus(safeKey, pin, { deviceId: safeDeviceId }) };
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
    plan: normalizeAiPlan(existing.plan) === "pro" ? "pro" : "credits",
    source: "stripe_credits",
    processedStripeSessions: nextProcessedSessions,
    lastStripeSessionId: safeSessionId,
    lastCreditPurchaseAt: new Date().toISOString(),
    lastCreditPurchaseAmount: amount,
    reason: reason || "stripe_credit_purchase"
  });
}

function activateSubscriptionAccount(email, data){
  const safeEmail = normalizePremiumKey(email);
  if(!safeEmail) return null;
  const existing = getPremiumAccount(safeEmail) || {};
  const pin = existing.premiumPin || makePremiumPin();
  const plan = normalizeAiPlan((data && data.plan) || "pro");
  const limit = getAiPlanDailyLimit(plan);
  const usage = getDailyUsage({ ...(existing || {}), plan });
  return setPremiumAccount(safeEmail, {
    ...(data || {}),
    active: true,
    email: safeEmail,
    premiumPin: pin,
    aiUsageDate: usage.day,
    aiUsedToday: usage.used,
    aiDailyLimit: limit,
    aiRemainingToday: plan === "pro" ? limit : Math.max(0, limit - usage.used),
    creditsRemaining: plan === "pro" ? limit : Math.max(0, limit - usage.used),
    creditsTotal: limit,
    creditMonth: usage.day,
    plan,
    source: "stripe_subscription",
    reason: (data && data.reason) || "stripe_subscription_active"
  });
}

function activateUnlimitedAccount(email, data){
  return activateSubscriptionAccount(email, { ...(data || {}), plan: (data && data.plan) || "pro" });
}

loadPremiumAccounts();
ensureOwnerPremiumAccount();

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

      // Ondernemer-abonnement (stadsgids): zet de onderneming automatisch online
      if(metadata.kind === "merchant"){
        setMerchantActiveFromMeta(metadata, true, object.customer || "");
      }else if(mode === "payment" && packageType === "credits" && packageCredits > 0){
        addCreditsToAccount(email, packageCredits, "checkout.session.completed.credit_pack", object.id || "");
      }else{
        setPremiumForStripeData({
          email,
          clientReferenceId: object.client_reference_id || metadata.clientReferenceId || "",
          customerId: object.customer || "",
          subscriptionId: object.subscription || "",
          active: true,
          plan: metadata.plan || metadata.aiPlan || "",
          priceId: metadata.priceId || "",
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
        plan: object.metadata?.plan || object.metadata?.aiPlan || "",
        priceId: object.metadata?.priceId || "",
        reason: "invoice.payment.paid"
      });
    }

    if(type === "invoice.payment_failed"){
      if(object.metadata?.kind === "merchant" || object.subscription_details?.metadata?.kind === "merchant"){
        setMerchantActiveFromMeta(object.metadata || object.subscription_details?.metadata, false, object.customer || "");
      }
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
      // Ondernemer-abonnement opgezegd: zet de onderneming automatisch offline
      if(object.metadata?.kind === "merchant"){
        setMerchantActiveFromMeta(object.metadata, false, object.customer || "");
      }
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


function starterCreditsEmailText(pin, credits, source){
  const appSource = normalizeAppSource(source);
  if(appSource === "echo"){
    return "Beste ECHO gebruiker,\n\nJe ECHO account is aangemaakt.\n\nJe 6 cijferige pincode is: " + pin + "\nJe hebt eenmalig " + credits + " gratis AI credits ontvangen.\n\nGebruik deze pincode samen met je e-mailadres om ECHO AI te activeren.\n\nFormForge ECHO";
  }
  return "Beste FormForge gebruiker,\n\nJe FormForge AI account is aangemaakt.\n\nJe 6 cijferige pincode is: " + pin + "\nJe hebt iedere dag " + credits + " gratis AI opdracht.\n\nGebruik deze pincode samen met je e-mailadres om FormForge AI te activeren.\n\nFormForge";
}

function starterCreditsEmailHtml(pin, credits, source){
  const appSource = normalizeAppSource(source);
  const title = appSource === "echo" ? "Je ECHO startercredits" : "Je FormForge AI pincode";
  const intro = appSource === "echo" ? "Je ECHO account is aangemaakt." : "Je FormForge AI account is aangemaakt.";
  const creditText = appSource === "echo" ? ("Je hebt <strong>eenmalig " + credits + " gratis AI credits</strong> ontvangen.") : ("Je hebt <strong>iedere dag " + credits + " gratis AI opdracht</strong>.");
  const activateText = appSource === "echo" ? "Gebruik deze pincode samen met je e-mailadres om ECHO AI te activeren." : "Gebruik deze pincode samen met je e-mailadres om FormForge AI te activeren.";
  return "<div style=\"font-family:Arial,sans-serif;line-height:1.5;color:#111\">" +
    "<h2>" + title + "</h2>" +
    "<p>" + intro + "</p>" +
    "<p>Je 6 cijferige pincode is:</p>" +
    "<p style=\"font-size:28px;font-weight:800;letter-spacing:4px\">" + pin + "</p>" +
    "<p>" + creditText + "</p>" +
    "<p>" + activateText + "</p>" +
    "<p>FormForge</p>" +
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

    const premiumStatus = getPremiumStatus(premiumKey, premiumPin, { deviceId: getRequestDeviceId(req) });
    if(!premiumStatus.premium){
      return jsonError(res, premiumStatus.pinRequired ? 403 : 402, premiumStatus.pinRequired ? "Premium pincode is ongeldig" : "AI Premium is niet actief voor dit account");
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
    echoStarterFreeCredits: ECHO_STARTER_FREE_CREDITS,
    formforgeFreeDailyLimit: FORMFORGE_FREE_DAILY_LIMIT,
    creditPackages: {
      aiPlus: !!STRIPE_FORMFORGE_AI_PLUS_PRICE_ID,
      aiPro: !!STRIPE_FORMFORGE_AI_PRO_PRICE_ID,
      unlimited: !!STRIPE_UNLIMITED_PRICE_ID
    },
    premiumStoreFile: PREMIUM_STORE_FILE,
    mode: STRIPE_SECRET_KEY.startsWith("sk_live_") ? "live" : (STRIPE_SECRET_KEY.startsWith("sk_test_") ? "test" : "unknown")
  });
});

app.get("/api/stripe/premium-status", async (req, res) => {
  const key = String(req.query.email || req.query.userId || req.query.customerId || req.query.subscriptionId || "").trim();
  const pin = String(req.query.pin || req.query.pincode || req.query.premiumPin || "").trim();
  const deviceId = getRequestDeviceId(req);
  const appSource = detectAppSourceFromReq(req);
  const accountKey = buildPremiumAccountKey(key, appSource);
  await refreshPremiumAccountFromStripe(accountKey);
  const status = getPremiumStatus(accountKey, pin, { deviceId });
  res.json({
    ok: true,
    premium: status.premium,
    pinRequired: status.pinRequired,
    deviceRequired: status.deviceRequired,
    deviceConflict: status.deviceConflict,
    deviceMessage: status.deviceMessage,
    activeDeviceId: status.activeDeviceId,
    activeDeviceLabel: status.activeDeviceLabel,
    creditsRemaining: status.creditsRemaining,
    creditsTotal: status.creditsTotal,
    creditMonth: status.creditMonth,
    aiUsedToday: status.aiUsedToday,
    aiDailyLimit: status.aiDailyLimit,
    aiRemainingToday: status.aiRemainingToday,
    plan: status.plan,
    planLabel: status.planLabel,
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
  const deviceId = getRequestDeviceId(req);
  const appSource = detectAppSourceFromReq(req);
  const accountKey = buildPremiumAccountKey(key, appSource);
  await refreshPremiumAccountFromStripe(accountKey);
  const status = getPremiumStatus(accountKey, pin, { deviceId });
  res.json({
    ok: true,
    premium: status.premium,
    pinRequired: status.pinRequired,
    deviceRequired: status.deviceRequired,
    deviceConflict: status.deviceConflict,
    deviceMessage: status.deviceMessage,
    activeDeviceId: status.activeDeviceId,
    activeDeviceLabel: status.activeDeviceLabel,
    creditsRemaining: status.creditsRemaining,
    creditsTotal: status.creditsTotal,
    creditMonth: status.creditMonth,
    aiUsedToday: status.aiUsedToday,
    aiDailyLimit: status.aiDailyLimit,
    aiRemainingToday: status.aiRemainingToday,
    plan: status.plan,
    planLabel: status.planLabel,
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
    const deviceId = getRequestDeviceId(req);
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
    const plan = normalizeAiPlan(metadata.plan || metadata.aiPlan || "");
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
      plan: plan || "pro",
      priceId: metadata.priceId || "",
      deviceId: deviceId,
      activeDeviceId: deviceId,
      deviceBoundAt: deviceId ? new Date().toISOString() : "",
      deviceLastSeenAt: deviceId ? new Date().toISOString() : "",
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
  const deviceId = getRequestDeviceId(req);
  const appSource = detectAppSourceFromReq(req);
  const accountKey = buildPremiumAccountKey(key, appSource);
  const result = consumePremiumCredit(accountKey, pin, deviceId);
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



app.post("/api/stripe/transfer-device", async (req, res) => {
  try{
    const email = normalizePremiumKey(req.body && req.body.email ? req.body.email : "");
    const pin = String(req.body && (req.body.pin || req.body.pincode || req.body.premiumPin) ? (req.body.pin || req.body.pincode || req.body.premiumPin) : "").trim();
    const deviceId = getRequestDeviceId(req);

    if(!email){
      return jsonError(res, 400, "E-mailadres ontbreekt");
    }
    if(!pin){
      return jsonError(res, 400, "Pincode ontbreekt");
    }
    if(!deviceId){
      return jsonError(res, 428, "Apparaat ID ontbreekt");
    }

    let account = getPremiumAccount(email);
    if(!account || !account.active){
      return jsonError(res, 404, "Geen actief FormForge AI account gevonden");
    }
    if(!verifyPremiumPin(account, pin)){
      return jsonError(res, 403, "Pincode is ongeldig");
    }

    account = setPremiumAccount(email, {
      deviceId,
      activeDeviceId: deviceId,
      deviceBoundAt: new Date().toISOString(),
      deviceLastSeenAt: new Date().toISOString(),
      deviceTransferredAt: new Date().toISOString()
    });

    res.json({
      ok: true,
      transferred: true,
      message: "Dit toestel is nu gekoppeld aan jouw FormForge AI account.",
      account: getPremiumStatus(email, pin, { deviceId })
    });
  }catch(err){
    jsonError(res, 500, "Toestel overzetten mislukt", err.message || String(err));
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

    const account = getPremiumAccount(accountKey);

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
    const appSource = detectAppSourceFromReq(req);
    const accountKey = buildPremiumAccountKey(email, appSource);

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
    setPremiumAccount(accountKey, {
      email,
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

// Een bestaand (al betaald) Stripe-abonnement koppelen aan dit account.
// Robuust: zet het account onder ALLE mogelijke sleutels op "pro" met EEN
// vaste pincode, zodat het inloggen het altijd vindt (los van app-source).
app.post("/api/stripe/link-subscription", async (req, res) => {
  try{
    const email = normalizePremiumKey(req.body && req.body.email ? req.body.email : "");
    let subscriptionId = String(req.body && req.body.subscriptionId ? req.body.subscriptionId : "").trim();
    const deviceId = getRequestDeviceId(req);
    if(!email) return jsonError(res, 400, "E-mailadres ontbreekt");
    if(!STRIPE_SECRET_KEY) return jsonError(res, 500, "Stripe niet geconfigureerd");

    // 1) Als er geen subscriptionId is meegegeven, zoek het actieve abonnement op e-mail
    let subscription = null;
    if(subscriptionId && subscriptionId.startsWith("sub_")){
      try{ subscription = await callStripeGet("/subscriptions/" + encodeURIComponent(subscriptionId)); }
      catch(e){ return jsonError(res, 404, "Abonnement niet gevonden in Stripe"); }
    }else{
      // zoek klant op e-mail, dan diens actieve abonnement
      try{
        const customers = await callStripeGet("/customers?email=" + encodeURIComponent(email) + "&limit=10");
        const list = (customers && customers.data) ? customers.data : [];
        for(const cust of list){
          const subs = await callStripeGet("/subscriptions?customer=" + encodeURIComponent(cust.id) + "&status=active&limit=10");
          const sd = (subs && subs.data) ? subs.data : [];
          // kies een abonnement met de Unlimited price-ID, anders het eerste actieve
          let chosen = sd.find(s => {
            const it = s.items && s.items.data && s.items.data[0];
            const pid = it && it.price && it.price.id;
            return pid === STRIPE_UNLIMITED_PRICE_ID || getAiPlanByPriceId(pid) === "pro";
          }) || sd[0];
          if(chosen){ subscription = chosen; break; }
        }
      }catch(e){
        return jsonError(res, 500, "Kon Stripe-klant niet opzoeken: " + (e.message || String(e)));
      }
    }

    if(!subscription) return jsonError(res, 404, "Geen actief abonnement gevonden voor dit e-mailadres.");

    // 2) Veiligheid: controleer dat het abonnement bij dit e-mailadres hoort
    let custEmail = "";
    try{
      const customerId = subscription.customer || "";
      if(customerId){
        const customer = await callStripeGet("/customers/" + encodeURIComponent(customerId));
        custEmail = normalizePremiumKey(customer.email || "");
      }
    }catch(e){ /* doorgaan */ }
    if(custEmail && custEmail !== email){
      return jsonError(res, 403, "Dit abonnement hoort bij een ander e-mailadres.");
    }

    const status = String(subscription.status || "");
    if(!["active","trialing","past_due"].includes(status)){
      return jsonError(res, 400, "Dit abonnement is niet actief (status: " + (status || "onbekend") + ").");
    }

    const firstItem = subscription.items && subscription.items.data && subscription.items.data[0] ? subscription.items.data[0] : {};
    const priceId = firstItem.price && firstItem.price.id ? firstItem.price.id : "";
    const plan = getAiPlanByPriceId(priceId) || "pro";
    const periodData = extractStripeSubscriptionPeriod(subscription);

    // 3) EEN vaste pincode bepalen (hergebruik bestaande als die er is)
    const existing = getPremiumAccount(email)
      || getPremiumAccount("formforge:" + email)
      || getPremiumAccount("echo:" + email);
    const pin = (existing && existing.premiumPin) ? existing.premiumPin : makePremiumPin();

    // 4) Onder ALLE mogelijke sleutels wegschrijven, met dezelfde pincode
    const keys = [email, "formforge:" + email, "echo:" + email];
    const payload = {
      email,
      customerId: subscription.customer || "",
      subscriptionId: subscription.id || subscriptionId,
      active: true,
      plan,
      priceId,
      premiumPin: pin,
      reason: "manual.link_subscription",
      deviceId,
      activeDeviceId: deviceId,
      deviceBoundAt: deviceId ? new Date().toISOString() : "",
      deviceLastSeenAt: deviceId ? new Date().toISOString() : "",
      ...periodData
    };
    keys.forEach(k => setPremiumAccount(k, payload));

    res.json({
      ok: true,
      linked: true,
      plan,
      premium: true,
      email,
      premiumPin: pin,
      pin,
      subscriptionId: subscription.id || subscriptionId,
      subscriptionStatus: status,
      message: "Je abonnement is gekoppeld. Log in met dit e-mailadres en deze pincode."
    });
  }catch(err){
    jsonError(res, 500, "Koppelen mislukt", err.message || String(err));
  }
});

app.post("/api/stripe/activate-starter", async (req, res) => {
  try{
    const email = normalizePremiumKey(req.body && req.body.email ? req.body.email : "");
    const suppliedPin = normalizePremiumPin(req.body && (req.body.pin || req.body.pincode || req.body.premiumPin) ? (req.body.pin || req.body.pincode || req.body.premiumPin) : "");
    const deviceId = getRequestDeviceId(req);
    const appSource = detectAppSourceFromReq(req);
    const accountKey = buildPremiumAccountKey(email, appSource);
    const isEchoStarter = appSource === "echo";
    const freeCredits = isEchoStarter ? ECHO_STARTER_FREE_CREDITS : FORMFORGE_FREE_DAILY_LIMIT;
    const freePlan = isEchoStarter ? "credits" : "starter";
    const appLabel = isEchoStarter ? "ECHO" : "FormForge AI";

    if(!email){
      return jsonError(res, 400, "E-mailadres ontbreekt");
    }

    let account = getPremiumAccount(accountKey);

    if(account && account.active){
      const deviceCheck = checkAccountDevice(account, deviceId, { requireDevice: true });
      if(!deviceCheck.ok){
        return jsonError(res, deviceCheck.status || 409, deviceCheck.message || "Dit FormForge AI account is al actief op een ander toestel", deviceCheck.code || "DEVICE_ERROR");
      }
      account = bindAccountDeviceIfNeeded(accountKey, account, deviceId);
      account = touchAccountDevice(accountKey, account, deviceId);
    }

    if(account && account.premiumPin && suppliedPin && !verifyPremiumPin(account, suppliedPin)){
      return jsonError(res, 403, "Pincode is ongeldig voor dit e-mailadres");
    }

    if(account && account.active && account.plan !== "starter" && account.plan !== "credits"){
      const status = getPremiumStatus(accountKey, suppliedPin || account.premiumPin, { allowWithoutPin: !suppliedPin, deviceId });
      return res.json({
        ok: true,
        alreadyActive: true,
        premium: status.premium || !!account.active,
        active: !!account.active,
        email,
        creditsRemaining: Number(account.creditsRemaining || 0),
        creditsTotal: Number(account.creditsTotal || UNLIMITED_FAIR_USE_CREDITS),
        creditMonth: String(account.creditMonth || currentPremiumDay()),
        plan: String(account.plan || "premium"),
        starterCreditsGranted: !!account.starterCreditsGranted,
        emailSent: false,
        message: "Dit e-mailadres heeft al een actief AI account. Gebruik je pincode of vraag een nieuwe pincode aan."
      });
    }

    if(account && account.starterCreditsGranted){
      return res.json({
        ok: true,
        alreadyActive: true,
        premium: true,
        active: true,
        email,
        creditsRemaining: Number(account.creditsRemaining || 0),
        creditsTotal: Number(account.creditsTotal || freeCredits),
        creditMonth: String(account.creditMonth || currentPremiumDay()),
        plan: String(account.plan || freePlan),
        starterCreditsGranted: true,
        emailSent: false,
        message: "Gratis credits waren al geactiveerd voor dit e-mailadres. Gebruik de pincode uit je e-mail of vraag een nieuwe pincode aan."
      });
    }

    const pin = suppliedPin && suppliedPin.length === 6 ? suppliedPin : (account && account.premiumPin ? account.premiumPin : makePremiumPin());

    const accountPayload = {
      active: true,
      email,
      premiumPin: pin,
      creditMonth: currentPremiumDay(),
      aiUsageDate: currentPremiumDay(),
      aiUsedToday: 0,
      deviceId: deviceId,
      activeDeviceId: deviceId,
      deviceBoundAt: deviceId ? new Date().toISOString() : "",
      deviceLastSeenAt: deviceId ? new Date().toISOString() : "",
      plan: freePlan,
      source: appSource,
      appSource,
      starterCreditsGranted: true,
      starterCreditsGrantedAt: new Date().toISOString(),
      reason: isEchoStarter ? "echo_starter_credits_activated" : "formforge_daily_free_activated"
    };

    if(isEchoStarter){
      accountPayload.creditsRemaining = freeCredits;
      accountPayload.creditsTotal = freeCredits;
      accountPayload.aiDailyLimit = freeCredits;
      accountPayload.aiRemainingToday = freeCredits;
    }else{
      accountPayload.creditsRemaining = freeCredits;
      accountPayload.creditsTotal = freeCredits;
      accountPayload.aiDailyLimit = freeCredits;
      accountPayload.aiRemainingToday = freeCredits;
    }

    account = setPremiumAccount(accountKey, accountPayload);

    let emailSent = false;
    if(RESEND_API_KEY){
      try{
        await sendResendEmail({
          to: email,
          subject: isEchoStarter ? "Je ECHO pincode" : "Je FormForge AI pincode",
          text: starterCreditsEmailText(pin, freeCredits, appSource),
          html: starterCreditsEmailHtml(pin, freeCredits, appSource)
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
      creditsRemaining: Number(account.creditsRemaining || 0),
      creditsTotal: Number(account.creditsTotal || freeCredits),
      creditMonth: String(account.creditMonth || currentPremiumDay()),
      plan: String(account.plan || freePlan),
      starterCreditsGranted: true,
      emailSent,
      message: emailSent ? "Je gratis credits zijn geactiveerd. De pincode is naar je e-mailadres verzonden." : "Je gratis credits zijn geactiveerd, maar de pincode mail kon niet worden verzonden. Controleer RESEND_API_KEY en FROM_EMAIL in Render."
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
    const requestedPlan = normalizeAiPlan(req.body && (req.body.plan || req.body.aiPlan) ? (req.body.plan || req.body.aiPlan) : "");
    const defaultPlanPriceId = requestedPlan === "plus" ? STRIPE_FORMFORGE_AI_PLUS_PRICE_ID : STRIPE_FORMFORGE_AI_PRO_PRICE_ID;
    const priceId = String(req.body && (req.body.priceId || req.body.price_id) ? (req.body.priceId || req.body.price_id) : (defaultPlanPriceId || STRIPE_UNLIMITED_PRICE_ID || STRIPE_DEFAULT_PRICE_ID)).trim();
    const deviceId = getRequestDeviceId(req);
    const plan = requestedPlan || getAiPlanByPriceId(priceId) || "pro";
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
        product: getAiPlanLabel(plan),
        source: "formforge-offerte-factuur",
        email: customerEmail,
        plan,
        aiPlan: plan,
        priceId,
        deviceId
      },
      subscription_data: {
        metadata: {
          product: getAiPlanLabel(plan),
          source: "formforge-offerte-factuur",
          email: customerEmail,
          plan,
          aiPlan: plan,
          priceId,
          deviceId
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

    const premiumStatusBefore = getPremiumStatus(premiumKey, premiumPin, { deviceId: getRequestDeviceId(req) });
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

    const creditResult = consumePremiumCredit(premiumKey, premiumPin, getRequestDeviceId(req));
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




// ============================================================
// FORMFORGE PDF STUDIO BACKEND
// Extra routes voor offerte en factuurmaker.
// Bestaande ECHO, Stripe, OpenAI, push en formulieren blijven ongemoeid.
// ============================================================

const PDF_STUDIO_STORE_FILE = path.join(DATA_DIR, "formforge_pdf_studio_documents.json");
const pdfStudioDocuments = new Map();

function loadPdfStudioDocuments(){
  try{
    if(!fs.existsSync(PDF_STUDIO_STORE_FILE)) return;
    const raw = fs.readFileSync(PDF_STUDIO_STORE_FILE, "utf8");
    const data = JSON.parse(raw || "{}");
    Object.keys(data || {}).forEach((key) => {
      if(key && data[key]){
        pdfStudioDocuments.set(key, data[key]);
      }
    });
  }catch(err){
    console.warn("PDF Studio documenten konden niet worden geladen:", err.message || String(err));
  }
}

function savePdfStudioDocuments(){
  try{
    const data = {};
    for(const [key, value] of pdfStudioDocuments.entries()){
      data[key] = value;
    }
    fs.writeFileSync(PDF_STUDIO_STORE_FILE, JSON.stringify(data, null, 2));
  }catch(err){
    console.warn("PDF Studio documenten konden niet worden opgeslagen:", err.message || String(err));
  }
}

function normalizePdfStudioEmail(value){
  return String(value || "").trim().toLowerCase();
}

function makePdfStudioId(prefix){
  const safePrefix = String(prefix || "doc").replace(/[^a-z0-9_]/gi, "").toLowerCase() || "doc";
  return safePrefix + "_" + crypto.randomBytes(16).toString("hex");
}

function makePdfStudioToken(){
  return crypto.randomBytes(32).toString("hex");
}

function safePdfStudioText(value, maxLength){
  const text = String(value || "").trim();
  const max = Number(maxLength || 0);
  if(max > 0 && text.length > max) return text.slice(0, max);
  return text;
}

function publicPdfStudioDocument(rec){
  if(!rec) return null;
  return {
    id: rec.id,
    type: rec.type,
    number: rec.number,
    date: rec.date,
    clientName: rec.clientName,
    clientEmail: rec.clientEmail,
    projectName: rec.projectName,
    total: rec.total,
    status: rec.status,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    signedAt: rec.signedAt || "",
    signerName: rec.signerName || "",
    expiresAt: rec.expiresAt || ""
  };
}

function getPdfStudioOwnerKey(req){
  return normalizePdfStudioEmail(
    (req.body && (req.body.ownerEmail || req.body.email || req.body.companyEmail)) ||
    (req.query && (req.query.ownerEmail || req.query.email || req.query.companyEmail)) ||
    ""
  );
}

function cleanOldPdfStudioDocuments(){
  const now = Date.now();
  let changed = false;
  for(const [id, rec] of pdfStudioDocuments.entries()){
    if(rec && rec.expiresAt){
      const expires = new Date(rec.expiresAt).getTime();
      if(Number.isFinite(expires) && expires > 0 && now > expires + 1000 * 60 * 60 * 24 * 30){
        pdfStudioDocuments.delete(id);
        changed = true;
      }
    }
  }
  if(changed) savePdfStudioDocuments();
}

function buildPdfStudioSignEmailText({ clientName, companyName, link, number, typeText }){
  return "Beste " + (clientName || "klant") + ",\n\n" +
    "Er staat een " + (typeText || "document") + " voor je klaar van " + (companyName || "de ondernemer") + ".\n\n" +
    "Documentnummer: " + (number || "") + "\n\n" +
    "Open de link om het document te bekijken en digitaal akkoord te geven:\n" +
    link + "\n\n" +
    "FormForge PDF Studio";
}

function buildPdfStudioSignEmailHtml({ clientName, companyName, link, number, typeText }){
  return "<div style=\"font-family:Arial,sans-serif;line-height:1.5;color:#12344d\">" +
    "<h2>Document klaar voor akkoord</h2>" +
    "<p>Beste " + escapeHtml(clientName || "klant") + ",</p>" +
    "<p>Er staat een " + escapeHtml(typeText || "document") + " voor je klaar van <strong>" + escapeHtml(companyName || "de ondernemer") + "</strong>.</p>" +
    "<p><strong>Documentnummer:</strong> " + escapeHtml(number || "") + "</p>" +
    "<p><a href=\"" + escapeHtml(link) + "\" style=\"display:inline-block;background:#21a9d8;color:#fff;padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:bold\">Bekijk en onderteken</a></p>" +
    "<p style=\"font-size:13px;color:#557083\">Werkt de knop niet? Kopieer deze link:<br>" + escapeHtml(link) + "</p>" +
    "<p>FormForge PDF Studio</p>" +
  "</div>";
}

loadPdfStudioDocuments();
setInterval(cleanOldPdfStudioDocuments, 1000 * 60 * 60);

app.get("/api/pdf-studio/status", (req, res) => {
  res.json({
    ok: true,
    service: "FormForge PDF Studio Backend",
    documents: pdfStudioDocuments.size,
    resendConfigured: !!RESEND_API_KEY,
    storeFile: PDF_STUDIO_STORE_FILE,
    time: new Date().toISOString()
  });
});

app.post("/api/pdf-studio/documents", (req, res) => {
  try{
    const body = req.body || {};
    const documentData = body.document || body.data || body;
    const type = String(documentData.type || body.type || "quote").trim() === "invoice" ? "invoice" : "quote";
    const typeText = type === "invoice" ? "factuur" : "offerte";
    const number = safePdfStudioText(documentData.number || body.number, 80);
    const ownerEmail = normalizePdfStudioEmail(
      body.ownerEmail ||
      documentData.ownerEmail ||
      (documentData.company && documentData.company.companyEmail) ||
      documentData.companyEmail
    );
    const clientEmail = normalizePdfStudioEmail(
      body.clientEmail ||
      documentData.clientEmail ||
      (documentData.client && documentData.client.email) ||
      ""
    );
    const clientName = safePdfStudioText(
      body.clientName ||
      documentData.clientName ||
      (documentData.client && documentData.client.name) ||
      "",
      180
    );
    const projectName = safePdfStudioText(documentData.projectName || body.projectName, 240);
    const total = Number(
      body.total ||
      documentData.total ||
      (documentData.totals && documentData.totals.total) ||
      0
    );

    if(!number){
      return jsonError(res, 400, "Documentnummer ontbreekt");
    }
    if(!ownerEmail){
      return jsonError(res, 400, "E-mailadres ondernemer ontbreekt");
    }
    if(!clientName && !clientEmail){
      return jsonError(res, 400, "Klantnaam of klantmail ontbreekt");
    }

    const id = makePdfStudioId(type);
    const now = new Date().toISOString();
    const rec = {
      id,
      token: makePdfStudioToken(),
      ownerEmail,
      clientEmail,
      clientName,
      type,
      typeText,
      number,
      date: safePdfStudioText(documentData.date || body.date || now.slice(0, 10), 40),
      projectName,
      total: Number.isFinite(total) ? total : 0,
      status: "draft",
      document: documentData,
      pdfHtml: String(body.pdfHtml || documentData.pdfHtml || ""),
      createdAt: now,
      updatedAt: now,
      expiresAt: body.expiresAt || new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString()
    };

    pdfStudioDocuments.set(id, rec);
    savePdfStudioDocuments();

    res.json({
      ok: true,
      document: publicPdfStudioDocument(rec),
      id: rec.id
    });
  }catch(err){
    jsonError(res, 500, "PDF Studio document kon niet worden opgeslagen", err.message || String(err));
  }
});

app.get("/api/pdf-studio/documents", (req, res) => {
  const ownerEmail = getPdfStudioOwnerKey(req);
  if(!ownerEmail){
    return jsonError(res, 400, "E-mailadres ondernemer ontbreekt");
  }

  const list = Array.from(pdfStudioDocuments.values())
    .filter((rec) => rec.ownerEmail === ownerEmail)
    .map(publicPdfStudioDocument)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  res.json({ ok: true, documents: list });
});

app.get("/api/pdf-studio/documents/:id", (req, res) => {
  const ownerEmail = getPdfStudioOwnerKey(req);
  const rec = pdfStudioDocuments.get(String(req.params.id || ""));
  if(!rec){
    return jsonError(res, 404, "Document niet gevonden");
  }
  if(ownerEmail && rec.ownerEmail !== ownerEmail){
    return jsonError(res, 403, "Geen toegang tot dit document");
  }
  res.json({ ok: true, document: publicPdfStudioDocument(rec), data: rec.document, pdfHtml: rec.pdfHtml || "" });
});

app.post("/api/pdf-studio/documents/:id/sign-link", async (req, res) => {
  try{
    const id = String(req.params.id || "");
    const rec = pdfStudioDocuments.get(id);
    if(!rec){
      return jsonError(res, 404, "Document niet gevonden");
    }

    const ownerEmail = getPdfStudioOwnerKey(req);
    if(ownerEmail && rec.ownerEmail !== ownerEmail){
      return jsonError(res, 403, "Geen toegang tot dit document");
    }

    rec.token = rec.token || makePdfStudioToken();
    rec.status = rec.status === "signed" ? "signed" : "sent";
    rec.updatedAt = new Date().toISOString();
    rec.expiresAt = req.body && req.body.expiresAt ? req.body.expiresAt : (rec.expiresAt || new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString());
    pdfStudioDocuments.set(id, rec);
    savePdfStudioDocuments();

    const baseUrl = safePdfStudioText((req.body && (req.body.frontendUrl || req.body.baseUrl)) || "", 500);
    const signUrl = baseUrl
      ? baseUrl.replace(/[#?]$/, "") + "#sign=" + rec.token
      : (req.protocol + "://" + req.get("host") + "/api/pdf-studio/sign/" + rec.token);

    let emailSent = false;
    if(req.body && req.body.sendEmail === true && rec.clientEmail){
      await sendResendEmail({
        to: rec.clientEmail,
        subject: "Document klaar voor akkoord: " + rec.number,
        text: buildPdfStudioSignEmailText({
          clientName: rec.clientName,
          companyName: rec.document && rec.document.company ? rec.document.company.companyName : "",
          link: signUrl,
          number: rec.number,
          typeText: rec.typeText
        }),
        html: buildPdfStudioSignEmailHtml({
          clientName: rec.clientName,
          companyName: rec.document && rec.document.company ? rec.document.company.companyName : "",
          link: signUrl,
          number: rec.number,
          typeText: rec.typeText
        })
      });
      emailSent = true;
    }

    res.json({
      ok: true,
      document: publicPdfStudioDocument(rec),
      signUrl,
      token: rec.token,
      emailSent
    });
  }catch(err){
    jsonError(res, 500, "Ondertekenlink kon niet worden gemaakt", err.message || String(err));
  }
});

app.get("/api/pdf-studio/sign/:token", (req, res) => {
  const token = String(req.params.token || "").trim();
  const rec = Array.from(pdfStudioDocuments.values()).find((doc) => doc.token === token);
  if(!rec){
    return jsonError(res, 404, "Ondertekenlink niet gevonden");
  }
  if(rec.expiresAt && Date.now() > new Date(rec.expiresAt).getTime()){
    return jsonError(res, 410, "Ondertekenlink is verlopen");
  }

  res.json({
    ok: true,
    document: publicPdfStudioDocument(rec),
    data: rec.document,
    pdfHtml: rec.pdfHtml || "",
    alreadySigned: rec.status === "signed",
    signedAt: rec.signedAt || "",
    signerName: rec.signerName || ""
  });
});

app.post("/api/pdf-studio/sign/:token/approve", (req, res) => {
  try{
    const token = String(req.params.token || "").trim();
    const rec = Array.from(pdfStudioDocuments.values()).find((doc) => doc.token === token);
    if(!rec){
      return jsonError(res, 404, "Ondertekenlink niet gevonden");
    }
    if(rec.expiresAt && Date.now() > new Date(rec.expiresAt).getTime()){
      return jsonError(res, 410, "Ondertekenlink is verlopen");
    }
    if(rec.status === "signed"){
      return res.json({ ok: true, alreadySigned: true, document: publicPdfStudioDocument(rec) });
    }

    const signerName = safePdfStudioText(req.body && req.body.signerName, 180);
    const signature = String(req.body && (req.body.signature || req.body.signatureData) ? (req.body.signature || req.body.signatureData) : "");
    const signedPdfHtml = String(req.body && req.body.pdfHtml ? req.body.pdfHtml : "");

    if(!signerName){
      return jsonError(res, 400, "Naam ondertekenaar ontbreekt");
    }
    if(!signature || !signature.startsWith("data:image/")){
      return jsonError(res, 400, "Handtekening ontbreekt");
    }

    rec.status = "signed";
    rec.signerName = signerName;
    rec.clientSignature = signature;
    rec.signedPdfHtml = signedPdfHtml;
    rec.signedAt = new Date().toISOString();
    rec.updatedAt = rec.signedAt;
    rec.audit = rec.audit || [];
    rec.audit.push({
      action: "signed",
      signerName,
      ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || "",
      userAgent: req.headers["user-agent"] || "",
      at: rec.signedAt
    });

    pdfStudioDocuments.set(rec.id, rec);
    savePdfStudioDocuments();

    res.json({
      ok: true,
      signed: true,
      document: publicPdfStudioDocument(rec)
    });
  }catch(err){
    jsonError(res, 500, "Document kon niet worden ondertekend", err.message || String(err));
  }
});

app.get("/api/pdf-studio/documents/:id/status", (req, res) => {
  const rec = pdfStudioDocuments.get(String(req.params.id || ""));
  if(!rec){
    return jsonError(res, 404, "Document niet gevonden");
  }
  const ownerEmail = getPdfStudioOwnerKey(req);
  if(ownerEmail && rec.ownerEmail !== ownerEmail){
    return jsonError(res, 403, "Geen toegang tot dit document");
  }
  res.json({
    ok: true,
    status: rec.status,
    signed: rec.status === "signed",
    signedAt: rec.signedAt || "",
    signerName: rec.signerName || "",
    document: publicPdfStudioDocument(rec)
  });
});

app.delete("/api/pdf-studio/documents/:id", (req, res) => {
  const rec = pdfStudioDocuments.get(String(req.params.id || ""));
  if(!rec){
    return jsonError(res, 404, "Document niet gevonden");
  }
  const ownerEmail = getPdfStudioOwnerKey(req);
  if(ownerEmail && rec.ownerEmail !== ownerEmail){
    return jsonError(res, 403, "Geen toegang tot dit document");
  }
  pdfStudioDocuments.delete(rec.id);
  savePdfStudioDocuments();
  res.json({ ok: true, deleted: true });
});









/* =========================
   UNIVERSELE PDF STUDIO OPENAI ROUTES
   Voor ieder beroep, iedere vraag, offerte, factuur, advies, calculatie en vertaling.
========================= */

function extractJsonObjectFromText(value){
  const text = String(value || "").trim();
  if(!text) return {};
  try{
    return JSON.parse(text);
  }catch(err){}
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if(first >= 0 && last > first){
    try{
      return JSON.parse(text.slice(first, last + 1));
    }catch(err){}
  }
  return {};
}

app.post("/api/pdfstudio/ai/workorder", async (req, res) => {
  try{
    const rawText = String(req.body && (req.body.text || req.body.note || req.body.input || req.body.question) ? (req.body.text || req.body.note || req.body.input || req.body.question) : "").trim();
    const documentType = String(req.body && req.body.type ? req.body.type : "offerte").trim();

    if(!rawText){
      return jsonError(res, 400, "Tekst ontbreekt");
    }

    const premiumKey = String(req.body && (req.body.email || req.body.premiumEmail || req.body.userId || req.body.premiumKey) ? (req.body.email || req.body.premiumEmail || req.body.userId || req.body.premiumKey) : "").trim();
    const premiumPin = String(req.body && (req.body.pin || req.body.pincode || req.body.premiumPin) ? (req.body.pin || req.body.pincode || req.body.premiumPin) : "").trim();
    const creditResult = consumePremiumCredit(premiumKey, premiumPin, getRequestDeviceId(req));
    if(!creditResult.ok){
      return jsonError(res, creditResult.status || 402, creditResult.error || "FormForge AI is niet actief");
    }

    const answer = await callOpenAI([
      {
        role: "system",
        content:
          "Je bent de universele AI assistent van FormForge PDF Studio. " +
          "Dit systeem is een offerte en factuur formulier voor iedereen, ongeacht beroep of branche. " +
          "Je helpt schilders, kappers, schoonheidsspecialisten, tandartsen, coaches, juristen, hoveniers, monteurs, installateurs, intercedenten, fotografen, consultants, freelancers, zzp'ers, mkb bedrijven en iedere andere beroepsgroep. " +
          "Je taak is: begrijp de vrije tekst van de gebruiker, herken de branche, herken of het advies, calculatie, offerte, factuur, intake of vertaling is, en geef bruikbare output terug. " +
          "Zet vrije, rommelige of korte werkomschrijvingen altijd om naar professionele offerte of factuurtekst in het veld description. " +
          "Ook als je berekeningen en items maakt, moet description gevuld worden met een nette zakelijke werkomschrijving op basis van de ingevoerde tekst. " +
          "Schrijf description alsof een professionele ondernemer dit aan een klant aanbiedt: helder, netjes, concreet en zonder overdreven verkooppraat. " +
          "Als de gebruiker een vraag stelt, geef professioneel advies dat past bij de branche. " +
          "Als er aantallen, uren, stuks, m2, m1, behandelingen, sessies, producten, tarieven of prijzen staan, maak offerte of factuurregels. " +
          "Als er onvoldoende gegevens zijn voor een harde calculatie, geef advies en benoem helder welke gegevens ontbreken. " +
          "Je mag aannames doen als dat nuttig is, maar zet die aannames in warnings. " +
          "Reken bedragen exclusief btw, tenzij de gebruiker expliciet inclusief btw zegt. " +
          "Gebruik voor btw in Nederland standaard 21 procent, behalve wanneer de tekst duidelijk wijst op een verlaagd tarief of 0 procent. Bij twijfel zet 21 procent en vermeld twijfel in warnings. " +
          "Voor schilderwerk, stukadoorswerk, kappersdiensten, schoonheidsbehandelingen, consulten, uren, producten, tandartsbehandelingen en zakelijke diensten moet je professioneel en neutraal blijven. " +
          "Voor medische of juridische onderwerpen geef je geen definitieve diagnose of juridisch bindend advies, maar wel veilige algemene uitleg en verwijs bij risico naar een bevoegde professional. " +
          "Geef uitsluitend geldig JSON terug. Geen markdown. Geen tekst buiten JSON. " +
          "Bedragen en aantallen moeten numeriek zijn. Rond geld af op 2 decimalen. Rond m2 of uren logisch af op maximaal 2 decimalen."
      },
      {
        role: "user",
        content:
          "Documenttype: " + documentType + "\n\n" +
          "Vrije tekst van gebruiker:\n" + rawText + "\n\n" +
          "Geef JSON terug met exact deze structuur:\n" +
          "{\n" +
          "  \"detectedSector\":\"\",\n" +
          "  \"detectedIntent\":\"advies | calculatie | offerte | factuur | intake | vertaling | combinatie\",\n" +
          "  \"projectName\":\"\",\n" +
          "  \"description\":\"\",\n" +
          "  \"advice\":\"\",\n" +
          "  \"calculationExplanation\":[\"\"],\n" +
          "  \"client\":{\"name\":\"\",\"contact\":\"\",\"address\":\"\",\"city\":\"\",\"email\":\"\",\"phone\":\"\"},\n" +
          "  \"items\":[{\"description\":\"\",\"qty\":0,\"unit\":\"stuks\",\"price\":0,\"vat\":21,\"lineTotalExVat\":0}],\n" +
          "  \"totals\":{\"subtotalExVat\":0,\"vatTotal\":0,\"totalIncVat\":0},\n" +
          "  \"warnings\":[\"\"]\n" +
          "}\n\n" +
          "Belangrijk: vul description altijd met een professionele werkomschrijving, ook wanneer er calculatieregels worden gemaakt. " +
          "Als de gebruiker bijvoorbeeld schrijft: houtwerk schuren, afwassen, kitten en lakken, schrijf dan in description netjes uit dat het houtwerk wordt gereinigd, ontvet, geschuurd, waar nodig gekit en afgewerkt met lak voor een duurzame en verzorgde afwerking. " +
          "Gebruik geen opsomming met symbolen in description, maar gewone zakelijke tekst. " +
          "Als het alleen een adviesvraag is zonder prijs of aantal, laat items leeg en vul advice goed in. " +
          "Als het wel een offerte of factuur kan worden, vul items met duidelijke regels. " +
          "Voorbeelden: '10 deuren per stuk 153' wordt qty 10, unit stuks, price 153. " +
          "'36 uur per week tarief 38 per uur' wordt qty 36, unit uur, price 38. " +
          "'hydrafacial 95 euro' wordt qty 1, unit behandeling, price 95. " +
          "'balayage inclusief knippen 185 euro' wordt qty 1, unit behandeling, price 185. " +
          "'kamer 6 x 4 hoogte 2.40 texwerk 18 per m2' mag je voor schilderwerk berekenen als wanden = 2 x 6 x 2.40 + 2 x 4 x 2.40 = 48 m2."
      }
    ], 0.15);

    const parsed = extractJsonObjectFromText(answer);

    const safeItems = Array.isArray(parsed.items) ? parsed.items.map((item) => {
      const qty = Number(item.qty || 0);
      const price = Number(item.price || 0);
      const vat = Number(item.vat === 0 ? 0 : (item.vat || 21));
      return {
        description: String(item.description || "").trim(),
        qty,
        unit: String(item.unit || "stuks").trim(),
        price,
        vat,
        lineTotalExVat: Number(item.lineTotalExVat || (qty * price))
      };
    }).filter((item) => item.description || item.qty || item.price) : [];

    let subtotalExVat = Number(parsed.totals && parsed.totals.subtotalExVat ? parsed.totals.subtotalExVat : 0);
    let vatTotal = Number(parsed.totals && parsed.totals.vatTotal ? parsed.totals.vatTotal : 0);

    if(!subtotalExVat && safeItems.length){
      subtotalExVat = safeItems.reduce((sum,item) => sum + (Number(item.qty || 0) * Number(item.price || 0)), 0);
      vatTotal = safeItems.reduce((sum,item) => sum + ((Number(item.qty || 0) * Number(item.price || 0)) * (Number(item.vat || 0) / 100)), 0);
    }

    res.json({
      ok: true,
      detectedSector: String(parsed.detectedSector || "").trim(),
      detectedIntent: String(parsed.detectedIntent || "").trim(),
      projectName: String(parsed.projectName || "").trim(),
      description: String(parsed.description || "").trim(),
      advice: String(parsed.advice || "").trim(),
      calculationExplanation: Array.isArray(parsed.calculationExplanation) ? parsed.calculationExplanation : [],
      client: parsed.client || {},
      items: safeItems,
      totals: {
        subtotalExVat: Number(subtotalExVat.toFixed ? subtotalExVat.toFixed(2) : subtotalExVat),
        vatTotal: Number(vatTotal.toFixed ? vatTotal.toFixed(2) : vatTotal),
        totalIncVat: Number((subtotalExVat + vatTotal).toFixed ? (subtotalExVat + vatTotal).toFixed(2) : (subtotalExVat + vatTotal))
      },
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      premium: true,
      plan: creditResult.status.plan,
      planLabel: creditResult.status.planLabel,
      creditsRemaining: creditResult.status.creditsRemaining,
      creditsTotal: creditResult.status.creditsTotal,
      aiUsedToday: creditResult.status.aiUsedToday,
      aiDailyLimit: creditResult.status.aiDailyLimit,
      aiRemainingToday: creditResult.status.aiRemainingToday,
      account: creditResult.status,
      raw: parsed
    });

  }catch(err){
    jsonError(res, 500, "Universele PDF Studio AI fout", err.message || String(err));
  }
});

app.post("/api/pdfstudio/ai/translate-document", async (req, res) => {
  try{
    const documentData = req.body && req.body.document ? req.body.document : req.body;
    const targetLanguage = String(req.body && req.body.targetLanguage ? req.body.targetLanguage : "English").trim();

    if(!documentData){
      return jsonError(res, 400, "Document ontbreekt");
    }

    const answer = await callOpenAI([
      {
        role: "system",
        content:
          "Je bent een professionele zakelijke vertaler voor offertes en facturen. " +
          "Vertaal alle tekstvelden naar de gevraagde taal. " +
          "Behoud alle bedragen, aantallen, btw percentages, datums, documentnummers, e-mailadressen, telefoonnummers, IBAN, KVK en btw nummers exact hetzelfde. " +
          "Vertaal geen merknamen, bedrijfsnamen of persoonsnamen. " +
          "Geef uitsluitend geldig JSON terug met dezelfde structuur als de invoer."
      },
      {
        role: "user",
        content:
          "Doeltaal: " + targetLanguage + "\n\n" +
          "Vertaal dit document volledig naar de doeltaal maar behoud getallen en bedragen exact:\n" +
          JSON.stringify(documentData, null, 2)
      }
    ], 0.05);

    const parsed = extractJsonObjectFromText(answer);

    res.json({
      ok: true,
      targetLanguage,
      document: parsed,
      raw: parsed
    });

  }catch(err){
    jsonError(res, 500, "Document vertalen mislukt", err.message || String(err));
  }
});

app.post("/api/pdfstudio/ai/ask", async (req, res) => {
  try{
    const question = String(req.body && (req.body.question || req.body.text || req.body.input) ? (req.body.question || req.body.text || req.body.input) : "").trim();

    if(!question){
      return jsonError(res, 400, "Vraag ontbreekt");
    }

    const answer = await callOpenAI([
      {
        role: "system",
        content:
          "Je bent een universele zakelijke AI assistent voor ieder beroep en iedere branche. " +
          "Help met advies, offerte voorbereiding, factuurregels, prijsopbouw, klantcommunicatie, vertaling, intake, planning en calculatie. " +
          "Blijf praktisch, professioneel en duidelijk. " +
          "Als iets branche specifiek is, pas je advies aan die branche aan. " +
          "Als informatie ontbreekt, zeg wat ontbreekt. " +
          "Bij medische, juridische of financiële risico's geef je veilige algemene informatie en verwijs je naar een bevoegde professional."
      },
      {
        role: "user",
        content: question
      }
    ], 0.3);

    res.json({
      ok: true,
      answer,
      text: answer,
      result: answer
    });

  }catch(err){
    jsonError(res, 500, "AI vraag mislukt", err.message || String(err));
  }
});

/* =========================
   EINDE UNIVERSELE PDF STUDIO OPENAI ROUTES
========================= */




/* =========================
   PDF STUDIO RENDER KLANTLINK OPSLAG
   Externe klantlinks werken via Render, niet via localStorage.
========================= */

const PDFSTUDIO_RENDER_STORE_FILE = path.join(DATA_DIR, "pdfstudio_render_links.json");
const pdfStudioRenderDocs = new Map();
const pdfStudioRenderTokens = new Map();

function loadPdfStudioRenderStore(){
  try{
    if(!fs.existsSync(PDFSTUDIO_RENDER_STORE_FILE)) return;
    const raw = fs.readFileSync(PDFSTUDIO_RENDER_STORE_FILE, "utf8");
    const data = JSON.parse(raw || "{}");

    Object.values(data.documents || {}).forEach((doc) => {
      if(doc && doc.id) pdfStudioRenderDocs.set(doc.id, doc);
    });

    Object.values(data.tokens || {}).forEach((tok) => {
      if(tok && tok.token) pdfStudioRenderTokens.set(tok.token, tok);
    });

  }catch(err){
    console.warn("PDF Studio Render opslag kon niet worden geladen:", err.message || String(err));
  }
}

function savePdfStudioRenderStore(){
  try{
    const documents = {};
    const tokens = {};

    for(const [id, doc] of pdfStudioRenderDocs.entries()){
      documents[id] = doc;
    }

    for(const [token, tok] of pdfStudioRenderTokens.entries()){
      tokens[token] = tok;
    }

    fs.writeFileSync(PDFSTUDIO_RENDER_STORE_FILE, JSON.stringify({ documents, tokens }, null, 2));
  }catch(err){
    console.warn("PDF Studio Render opslag kon niet worden opgeslagen:", err.message || String(err));
  }
}

function makePdfStudioRenderId(){
  return "doc_" + Date.now() + "_" + crypto.randomBytes(8).toString("hex");
}

function makePdfStudioRenderToken(){
  return crypto.randomBytes(24).toString("hex");
}

loadPdfStudioRenderStore();

app.post("/api/pdfstudio/documents/save", (req, res) => {
  try{
    const body = req.body || {};
    const documentData = body.document || body.data || body;

    const id = body.id && String(body.id).trim().startsWith("doc_")
      ? String(body.id).trim()
      : makePdfStudioRenderId();

    const now = new Date().toISOString();

    const doc = {
      id,
      ownerKey: String(body.ownerKey || body.ownerEmail || body.companyEmail || "").trim(),
      type: String(body.type || documentData.type || "quote"),
      status: String(body.status || "draft"),
      document: documentData,
      createdAt: body.createdAt || now,
      updatedAt: now
    };

    pdfStudioRenderDocs.set(id, doc);
    savePdfStudioRenderStore();

    res.json({
      ok:true,
      saved:true,
      id,
      document:doc
    });

  }catch(err){
    jsonError(res, 500, "PDF Studio document opslaan mislukt", err.message || String(err));
  }
});

app.get("/api/pdfstudio/documents/:id", (req, res) => {
  const id = String(req.params.id || "").trim();
  const doc = pdfStudioRenderDocs.get(id);

  if(!doc){
    return jsonError(res, 404, "Document niet gevonden");
  }

  res.json({
    ok:true,
    document:doc.document,
    record:doc
  });
});

app.post("/api/pdfstudio/signing/create-link", (req, res) => {
  try{
    const documentId = String(req.body && req.body.documentId ? req.body.documentId : "").trim();

    if(!documentId){
      return jsonError(res, 400, "documentId ontbreekt");
    }

    const doc = pdfStudioRenderDocs.get(documentId);

    if(!doc){
      return jsonError(res, 404, "Document niet gevonden");
    }

    const token = makePdfStudioRenderToken();

    const signing = {
      token,
      documentId,
      status:"open",
      createdAt:new Date().toISOString(),
      expiresAt:req.body && req.body.expiresAt ? req.body.expiresAt : new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
      clientSignature:"",
      clientSigner:"",
      signedAt:""
    };

    pdfStudioRenderTokens.set(token, signing);

    doc.status = "sent";
    doc.updatedAt = new Date().toISOString();
    pdfStudioRenderDocs.set(documentId, doc);

    savePdfStudioRenderStore();

    res.json({
      ok:true,
      token,
      signingUrl:"/api/pdfstudio/sign/" + token,
      documentId
    });

  }catch(err){
    jsonError(res, 500, "Klantlink maken mislukt", err.message || String(err));
  }
});

app.get("/api/pdfstudio/sign/:token", (req, res) => {
  const token = String(req.params.token || "").trim();
  const signing = pdfStudioRenderTokens.get(token);

  if(!signing){
    return jsonError(res, 404, "Token niet gevonden");
  }

  if(signing.expiresAt && new Date(signing.expiresAt).getTime() < Date.now()){
    return jsonError(res, 410, "Klantlink verlopen");
  }

  const doc = pdfStudioRenderDocs.get(signing.documentId);

  if(!doc){
    return jsonError(res, 404, "Document niet gevonden");
  }

  res.json({
    ok:true,
    signing,
    document:doc.document,
    record:doc
  });
});

app.post("/api/pdfstudio/sign/:token/approve", (req, res) => {
  try{
    const token = String(req.params.token || "").trim();
    const signing = pdfStudioRenderTokens.get(token);

    if(!signing){
      return jsonError(res, 404, "Token niet gevonden");
    }

    const doc = pdfStudioRenderDocs.get(signing.documentId);

    if(!doc){
      return jsonError(res, 404, "Document niet gevonden");
    }

    signing.status = "signed";
    signing.clientSignature = req.body && req.body.signature ? req.body.signature : "";
    signing.clientSigner = req.body && req.body.name ? req.body.name : "";
    signing.signedAt = new Date().toISOString();

    doc.status = "signed";
    doc.updatedAt = new Date().toISOString();
    doc.clientSignature = signing.clientSignature;
    doc.clientSigner = signing.clientSigner;
    doc.signedAt = signing.signedAt;

    pdfStudioRenderTokens.set(token, signing);
    pdfStudioRenderDocs.set(doc.id, doc);
    savePdfStudioRenderStore();

    res.json({
      ok:true,
      signed:true,
      signing,
      document:doc.document,
      record:doc
    });

  }catch(err){
    jsonError(res, 500, "Ondertekenen mislukt", err.message || String(err));
  }
});

/* =========================
   EINDE PDF STUDIO RENDER KLANTLINK OPSLAG
========================= */


/* =========================
   FORMFORGE MARKETPLACE BOD FORMULIER
   Losstaande route. Raakt geen bestaande functies.
========================= */

app.post("/api/marketplace-bod", async (req, res) => {
  try{
    const body = req.body || {};

    const project = String(body.project || "").trim();
    const name = String(body.name || "").trim();
    const company = String(body.company || "").trim();
    const email = String(body.email || "").trim();
    const phone = String(body.phone || "").trim();
    const amount = String(body.amount || "").trim();
    const message = String(body.message || "").trim();

    if(!project || !name || !email || !amount){
      return res.status(400).json({
        ok: false,
        error: "Niet alle verplichte velden zijn ingevuld."
      });
    }

    const subject = "Nieuw bod via FormForge Marketplace: " + project;

    const text =
      "Nieuw bod via FormForge Marketplace\n\n" +
      "Project:\n" + project + "\n\n" +
      "Naam:\n" + name + "\n\n" +
      "Bedrijf:\n" + (company || "Niet ingevuld") + "\n\n" +
      "E-mailadres:\n" + email + "\n\n" +
      "Telefoonnummer:\n" + (phone || "Niet ingevuld") + "\n\n" +
      "Bodbedrag:\nEUR " + amount + "\n\n" +
      "Toelichting:\n" + (message || "Geen toelichting ingevuld");

    const html =
      "<div style=\"font-family:Arial,sans-serif;line-height:1.6;color:#111\">" +
      "<h2>Nieuw bod via FormForge Marketplace</h2>" +
      "<p><strong>Project:</strong><br>" + project + "</p>" +
      "<p><strong>Naam:</strong><br>" + name + "</p>" +
      "<p><strong>Bedrijf:</strong><br>" + (company || "Niet ingevuld") + "</p>" +
      "<p><strong>E-mailadres:</strong><br>" + email + "</p>" +
      "<p><strong>Telefoonnummer:</strong><br>" + (phone || "Niet ingevuld") + "</p>" +
      "<p><strong>Bodbedrag:</strong><br>EUR " + amount + "</p>" +
      "<p><strong>Toelichting:</strong><br>" + (message || "Geen toelichting ingevuld") + "</p>" +
      "</div>";

    await sendResendEmail({
      to: "info@formforge.nl",
      subject,
      text,
      html
    });

    res.json({
      ok: true,
      message: "Bod verzonden"
    });
  }catch(err){
    console.error("FormForge Marketplace bod fout:", err.message || String(err));
    res.status(500).json({
      ok: false,
      error: "Bod verzenden is mislukt."
    });
  }
});

/* =========================
   EINDE FORMFORGE MARKETPLACE BOD FORMULIER
========================= */


/* ===== UNIVERSELE VERTAALCHAT (kamers, vluchtig) =====
   Iedereen kan een kamer maken met een 6-cijferige code en die delen.
   Deelnemers kiezen hun eigen taal. Berichten leven max ROOM_TTL_MS en
   worden daarna automatisch gewist (niets blijft permanent bewaard).
   Vertaling gebeurt per lezer-taal en wordt kort gecachet om kosten te sparen. */
const ROOM_TTL_MS = 15 * 1000;
const ROOM_MEDIA_TTL_MS = 60 * 1000; // foto's/video's/bestanden blijven 1 minuut zichtbaar
const ROOM_IDLE_MS = 1000 * 60 * 30; // lege/stille kamers na 30 min opruimen
const ROOM_DAILY_TRANSLATION_LIMIT = 100; // max ECHTE vertalingen per kamer per dag (cache-treffers tellen niet mee)
const rooms = new Map(); // code -> { code, createdAt, lastActive, members:Map(id->member), messages:[] }

// ===== KAMERS BEWAREN OP SCHIJF (overleeft serverherstart) =====
const ROOMS_STORE_FILE = path.join(DATA_DIR, "echo_rooms.json");

function saveRooms(){
  try{
    const data = {};
    for(const [code, room] of rooms.entries()){
      data[code] = {
        code: room.code,
        createdAt: room.createdAt,
        hostName: room.hostName || "",
        hostLang: room.hostLang || "en",
        freeMode: !!room.freeMode,
        roomLang: room.roomLang || "",
        msgTtlMs: room.msgTtlMs || 0,
        hostKey: room.hostKey || "",
        hostEmail: room.hostEmail || "",
        translationsToday: room.translationsToday || 0,
        translationDay: room.translationDay || roomToday()
      };
    }
    fs.writeFileSync(ROOMS_STORE_FILE, JSON.stringify(data, null, 2));
  }catch(err){
    console.warn("Kamers konden niet worden opgeslagen:", err.message || String(err));
  }
}

function loadRooms(){
  try{
    if(!fs.existsSync(ROOMS_STORE_FILE)) return;
    const raw = fs.readFileSync(ROOMS_STORE_FILE, "utf8");
    const data = JSON.parse(raw || "{}");
    Object.keys(data || {}).forEach((code) => {
      const r = data[code];
      if(!code || !r) return;
      rooms.set(code, {
        code: r.code || code,
        createdAt: r.createdAt || Date.now(),
        lastActive: Date.now(),
        hostName: r.hostName || "",
        hostLang: r.hostLang || "en",
        freeMode: !!r.freeMode,
        roomLang: r.roomLang || "",
        msgTtlMs: r.msgTtlMs || 0,
        hostKey: r.hostKey || "",
        hostEmail: r.hostEmail || "",
        banned: new Set(),
        banAt: new Map(),
        members: new Map(),
        messages: [],
        translationsToday: r.translationsToday || 0,
        translationDay: r.translationDay || roomToday(),
        persistent: true
      });
    });
    console.log("Kamers geladen: " + rooms.size);
  }catch(err){
    console.warn("Kamers konden niet worden geladen:", err.message || String(err));
  }
}
loadRooms();

// ===== PUSH-AANMELDINGEN PER KAMER =====
const roomPushSubs = new Map(); // code -> Map(memberId -> subscription)

function addRoomPush(code, memberId, subscription){
  if(!code || !memberId || !subscription || !subscription.endpoint) return;
  let m = roomPushSubs.get(code);
  if(!m){ m = new Map(); roomPushSubs.set(code, m); }
  m.set(memberId, subscription);
}

function removeRoomPush(code, memberId){
  const m = roomPushSubs.get(code);
  if(m) m.delete(memberId);
}

async function notifyRoom(code, exceptMemberId, payload){
  if(!webpush || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const m = roomPushSubs.get(code);
  if(!m || m.size === 0) return;
  for(const [memberId, sub] of Array.from(m.entries())){
    if(memberId === exceptMemberId) continue;
    try{
      await webpush.sendNotification(sub, JSON.stringify(payload));
    }catch(err){
      if(err.statusCode === 404 || err.statusCode === 410){
        m.delete(memberId);
      }
    }
  }
}

// Controleer of een e-mail + pincode een ACTIEF Unlimited (pro) abonnement is.
function requireUnlimited(req){
  const email = String((req.body && (req.body.email || req.body.premiumEmail)) || "").trim();
  const pin = String((req.body && (req.body.pin || req.body.pincode || req.body.premiumPin)) || "").trim();
  if(!email) return { ok:false, status:400, error:"Vul je Premium e-mailadres in." };
  if(!pin) return { ok:false, status:400, error:"Vul je 6-cijferige pincode in." };
  const deviceId = getRequestDeviceId(req);
  const appSource = detectAppSourceFromReq(req);
  const accountKey = buildPremiumAccountKey(email, appSource);

  // Probeer eerst de gewone sleutel (appSource:email). Vindt die niets,
  // val dan terug op de kale e-mail, want sommige activaties (Stripe-webhook,
  // confirm-session, handmatige koppeling) slaan op onder de kale e-mail.
  const candidateKeys = [accountKey];
  const bareEmail = normalizePremiumKey(email);
  if(bareEmail && !candidateKeys.includes(bareEmail)) candidateKeys.push(bareEmail);

  let status = null;
  let usedKey = accountKey;
  for(const key of candidateKeys){
    try{
      const s = getPremiumStatus(key, pin, { deviceId });
      if(s && s.premium){ status = s; usedKey = key; break; }
      if(!status) status = s; // bewaar eerste resultaat voor de foutmelding
    }catch(e){
      return { ok:false, status:500, error:"Kon abonnement niet controleren." };
    }
  }

  if(!status || !status.premium){
    return { ok:false, status:403, error:"Geen actief Premium account gevonden. Controleer e-mail en pincode." };
  }
  const plan = String(status.plan || "");
  if(plan !== "pro"){
    return { ok:false, status:403, error:"Hiervoor is een Unlimited abonnement nodig. Je huidige plan: " + (status.planLabel || plan || "geen") + "." };
  }
  return { ok:true, accountKey: usedKey, email };
}

function roomToday(){
  // datum als YYYY-MM-DD in lokale tijd, voor dagelijkse reset
  const d = new Date();
  return d.getFullYear() + "-" + (d.getMonth()+1) + "-" + d.getDate();
}

// Hoeveel ECHTE vertalingen mag deze kamer vandaag nog doen? (reset per dag)
function roomTranslationsLeft(room){
  const today = roomToday();
  if(room.translationDay !== today){
    room.translationDay = today;
    room.translationsToday = 0;
  }
  return Math.max(0, ROOM_DAILY_TRANSLATION_LIMIT - room.translationsToday);
}

function makeRoomCode(){
  let code="";
  do{ code=String(Math.floor(100000 + Math.random()*900000)); }while(rooms.has(code));
  return code;
}

// Verwijderde personen blijven 5 minuten geweerd; daarna mogen ze weer joinen.
const ROOM_BAN_MS = 5 * 60 * 1000;

// ===== UITNODIGINGEN =====
// invites: token -> { code, maxUses, uses, expiresAt, kind }
//   kind "single"  : voor 1 persoon, vervalt zodra hij gebruikt is (geen tijdslimiet)
//   kind "company" : blijvend + herbruikbaar (voor gedrukte brief met QR)
const roomInvites = new Map();
const INVITE_DEFAULT_TTL_MS = 10 * 60 * 1000;       // standaard 10 minuten
const INVITE_MAX_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000; // tot 10 jaar (bedrijf)
const INVITE_MAX_USES_CAP = 100000;                 // bedrijf: effectief onbeperkt
const INVITE_STORE_FILE = path.join(DATA_DIR, "echo_invites.json");

function saveInvites(){
  try{
    const data = {};
    for(const [t, inv] of roomInvites.entries()){ data[t] = inv; }
    fs.writeFileSync(INVITE_STORE_FILE, JSON.stringify(data));
  }catch(e){}
}
function loadInvites(){
  try{
    if(!fs.existsSync(INVITE_STORE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(INVITE_STORE_FILE, "utf8") || "{}");
    Object.keys(data || {}).forEach((t) => { if(t && data[t]) roomInvites.set(t, data[t]); });
    console.log("Uitnodigingen geladen: " + roomInvites.size);
  }catch(e){}
}

function makeInviteToken(){
  let t;
  do{
    t = "inv_" + Math.random().toString(36).slice(2,10) + Math.random().toString(36).slice(2,10);
  }while(roomInvites.has(t));
  return t;
}

function pruneInvites(){
  const now = Date.now();
  let changed = false;
  for(const [t, inv] of Array.from(roomInvites.entries())){
    if(inv.expiresAt <= now || inv.uses >= inv.maxUses || !rooms.has(inv.code)){
      roomInvites.delete(t); changed = true;
    }
  }
  if(changed) saveInvites();
}
setInterval(pruneInvites, 30000);
loadInvites();

// Reconnect-tokens: laten een AL toegelaten persoon stilletjes herverbinden
// (bv. na korte stilte, serverherstart, of dagen later via de webapp) ZONDER
// een nieuwe uitnodiging. Worden op schijf bewaard zodat ze een herstart overleven.
// reconnectTokens: token -> { code, name, lang, isHost, expiresAt }
const reconnectTokens = new Map();
const RECONNECT_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 jaar
const RECONNECT_STORE_FILE = path.join(DATA_DIR, "echo_reconnect.json");

function saveReconnect(){
  try{
    const data = {};
    for(const [t, r] of reconnectTokens.entries()){ data[t] = r; }
    fs.writeFileSync(RECONNECT_STORE_FILE, JSON.stringify(data));
  }catch(e){ /* niet kritiek */ }
}
function loadReconnect(){
  try{
    if(!fs.existsSync(RECONNECT_STORE_FILE)) return;
    const raw = fs.readFileSync(RECONNECT_STORE_FILE, "utf8");
    const data = JSON.parse(raw || "{}");
    Object.keys(data || {}).forEach((t) => { if(t && data[t]) reconnectTokens.set(t, data[t]); });
    console.log("Reconnect-tokens geladen: " + reconnectTokens.size);
  }catch(e){ /* niet kritiek */ }
}

function issueReconnectToken(code, name, lang, isHost){
  const t = "rc_" + Math.random().toString(36).slice(2,10) + Math.random().toString(36).slice(2,10);
  reconnectTokens.set(t, { code, name, lang, isHost: !!isHost, expiresAt: Date.now() + RECONNECT_TTL_MS });
  saveReconnect();
  return t;
}
function pruneReconnect(){
  const now = Date.now();
  let changed = false;
  for(const [t, r] of Array.from(reconnectTokens.entries())){
    // alleen verwijderen bij echte verlooptijd of als de kamer niet meer bestaat
    if(r.expiresAt <= now || !rooms.has(r.code)){ reconnectTokens.delete(t); changed = true; }
  }
  if(changed) saveReconnect();
}
setInterval(pruneReconnect, 60000);
loadReconnect();

// ===== GAST-ACCOUNTS =====
// Een gast kiest eenmalig naam + pincode. De server onthoudt zijn kamers, zodat
// hij op elk toestel (browser of webapp) zijn kamers terugziet. Geen abonnement nodig.
// guestAccounts: guestKey ("g:" + naam-lowercase + ":" + pin) -> { name, pin, rooms:[{code,reconnect,label,ts}], createdAt }
const guestAccounts = new Map();
const GUEST_STORE_FILE = path.join(DATA_DIR, "echo_guests.json");

function guestKeyOf(name, pin){
  return "g:" + String(name||"").trim().toLowerCase() + ":" + String(pin||"").trim();
}
function saveGuests(){
  try{
    const data = {};
    for(const [k, v] of guestAccounts.entries()){ data[k] = v; }
    fs.writeFileSync(GUEST_STORE_FILE, JSON.stringify(data));
  }catch(e){}
}
function loadGuests(){
  try{
    if(!fs.existsSync(GUEST_STORE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(GUEST_STORE_FILE, "utf8") || "{}");
    Object.keys(data || {}).forEach((k) => { if(k && data[k]) guestAccounts.set(k, data[k]); });
    console.log("Gast-accounts geladen: " + guestAccounts.size);
  }catch(e){}
}
function getGuestAccount(name, pin){
  return guestAccounts.get(guestKeyOf(name, pin)) || null;
}
function upsertGuestRoom(name, pin, roomInfo){
  const key = guestKeyOf(name, pin);
  let acc = guestAccounts.get(key);
  if(!acc){ acc = { name:String(name||"").trim(), pin:String(pin||"").trim(), rooms:[], createdAt:Date.now() }; guestAccounts.set(key, acc); }
  if(roomInfo && roomInfo.code){
    acc.rooms = (acc.rooms || []).filter(r => r.code !== roomInfo.code);
    acc.rooms.unshift(roomInfo);
    if(acc.rooms.length > 30) acc.rooms = acc.rooms.slice(0,30);
  }
  saveGuests();
  return acc;
}
// kamers die niet meer bestaan opschonen uit een gast-account
function cleanGuestRooms(acc){
  if(!acc || !acc.rooms) return acc;
  const before = acc.rooms.length;
  acc.rooms = acc.rooms.filter(r => rooms.has(r.code));
  if(acc.rooms.length !== before) saveGuests();
  return acc;
}
loadGuests();

// ===== MERKEN (white-label per bedrijf) =====
// Per merk-code: bedrijfsnaam + logo-adres. De frontend toont dit bovenaan
// in plaats van "World Chat" wanneer de link ?brand=CODE bevat.
// NIEUWE KLANT TOEVOEGEN? Voeg hieronder simpelweg een regel toe:
//   "code": { name: "Bedrijfsnaam", logo: "https://.../logo.png", tag: "optionele ondertitel" },
const BRANDS = {
  // voorbeeld (verwijder of pas aan):
  "demo":   { name: "Demo Company", logo: "", tag: "Everyone in their own language" },
  // "jansen": { name: "Schoonmaakbedrijf Jansen", logo: "https://formforge.nl/logos/jansen.png", tag: "" },
};

app.get("/api/brand", (req, res) => {
  const code = String(req.query && req.query.code ? req.query.code : "").trim().toLowerCase();
  if(!code || !BRANDS[code]) return res.json({ ok:true, found:false });
  const b = BRANDS[code];
  res.json({ ok:true, found:true, name: b.name || "", logo: b.logo || "", tag: (b.tag || "") });
});

// ===== STADSGIDS (toeristen) =====
// Per stad: naam + categorieen, elk met ondernemers (naam, beschrijving, adres).
// Jij beheert dit hier. NIEUWE STAD of ONDERNEMER? Voeg een regel toe.
// De teksten schrijf je in EEN taal (sourceLang); de gids vertaalt automatisch
// naar de taal van de bezoeker.
const CITIES = {
  "valkenburg": {
    name: "Valkenburg",
    sourceLang: "nl",
    categories: [
      {
        id: "sights", icon: "&#127963;", title: "Bezienswaardigheden",
        items: []
      },
      {
        id: "attractions", icon: "&#127906;", title: "Attracties",
        items: []
      },
      {
        id: "kids", icon: "&#129528;", title: "Voor kinderen",
        items: []
      },
      {
        id: "food", icon: "&#127869;", title: "Restaurants",
        items: []
      },
      {
        id: "coffee", icon: "&#9749;", title: "Koffie & cafés",
        items: []
      },
      {
        id: "bars", icon: "&#127867;", title: "Uitgaan & terrassen",
        items: []
      },
      {
        id: "shopping", icon: "&#128717;", title: "Winkelen",
        items: []
      },
      {
        id: "hotels", icon: "&#127976;", title: "Hotels & overnachten",
        items: []
      },
      {
        id: "wellness", icon: "&#9832;", title: "Wellness & thermen",
        items: []
      },
      {
        id: "boat", icon: "&#128676;", title: "Rondvaart",
        items: []
      },
      {
        id: "bikes", icon: "&#128692;", title: "Fietsverhuur",
        items: []
      },
      {
        id: "train", icon: "&#128642;", title: "Treinstation",
        items: []
      },
      {
        id: "parking", icon: "&#127359;", title: "Parkeren",
        items: []
      },
      {
        id: "info", icon: "&#8505;", title: "Toeristeninfo (VVV)",
        items: []
      },
      {
        id: "pharmacy", icon: "&#128138;", title: "Apotheek",
        items: []
      },
      {
        id: "atm", icon: "&#128179;", title: "Geldautomaat",
        items: []
      },
      {
        id: "tattoo", icon: "&#128132;", title: "Tattoo & piercing",
        items: []
      }
    ]
  },

  "demo": {
    name: "Demo City",
    sourceLang: "en",
    categories: [
      {
        id: "food", icon: "&#127869;", title: "Where to eat",
        items: [
          { name: "Trattoria Bella", desc: "Cozy Italian spot with fresh homemade pasta and wood-fired pizza.", address: "Damrak 12, Amsterdam" },
          { name: "Green Garden", desc: "Vegetarian and vegan dishes with a sunny terrace.", address: "Leidseplein 5, Amsterdam" }
        ]
      },
      {
        id: "coffee", icon: "&#9749;", title: "Coffee & cafes",
        items: [
          { name: "The Roastery", desc: "Specialty coffee roasted on site, great pastries too.", address: "Prinsengracht 200, Amsterdam" }
        ]
      },
      {
        id: "bars", icon: "&#127867;", title: "Bars & nightlife",
        items: [
          { name: "Brown Cafe De Hoek", desc: "Traditional Dutch pub with local beers on tap.", address: "Spui 8, Amsterdam" }
        ]
      },
      {
        id: "hotels", icon: "&#127976;", title: "Hotels & stay",
        items: [
          { name: "Canal View Hotel", desc: "Comfortable rooms with a view over the canals.", address: "Herengracht 100, Amsterdam" }
        ]
      },
      {
        id: "sights", icon: "&#127963;", title: "Sights & landmarks",
        items: [
          { name: "Old Church", desc: "Beautiful historic church in the city centre.", address: "Oudekerksplein 23, Amsterdam" }
        ]
      },
      {
        id: "museums", icon: "&#127960;", title: "Museums",
        items: [
          { name: "City Museum", desc: "Art and history from the region, open daily.", address: "Museumplein 6, Amsterdam" }
        ]
      },
      {
        id: "churches", icon: "&#9962;", title: "Churches",
        items: [
          { name: "St. Nicholas Basilica", desc: "Impressive 19th-century basilica near the station.", address: "Prins Hendrikkade 73, Amsterdam" }
        ]
      },
      {
        id: "shopping", icon: "&#128717;", title: "Shopping",
        items: [
          { name: "Market Street", desc: "Boutiques, souvenirs and local shops.", address: "Kalverstraat 1, Amsterdam" }
        ]
      },
      {
        id: "boat", icon: "&#128676;", title: "Canal tours",
        items: [
          { name: "City Canal Cruise", desc: "One-hour guided boat tour through the historic canals.", address: "Stadhouderskade 30, Amsterdam" }
        ]
      },
      {
        id: "bikes", icon: "&#128692;", title: "Bike rental",
        items: [
          { name: "Rent-a-Bike Centraal", desc: "Rent city bikes by the hour or day.", address: "Damstraat 20, Amsterdam" }
        ]
      },
      {
        id: "train", icon: "&#128642;", title: "Train station",
        items: [
          { name: "Central Station", desc: "Main railway station for national and international trains.", address: "Stationsplein, Amsterdam" }
        ]
      },
      {
        id: "transit", icon: "&#128652;", title: "Public transport",
        items: [
          { name: "Tram & Metro Info", desc: "Tram, bus and metro information point.", address: "Stationsplein 10, Amsterdam" }
        ]
      },
      {
        id: "taxi", icon: "&#128661;", title: "Taxi",
        items: [
          { name: "City Taxi Stand", desc: "Official taxi rank, available 24/7.", address: "Stationsplein 15, Amsterdam" }
        ]
      },
      {
        id: "airport", icon: "&#9992;", title: "Airport",
        items: [
          { name: "Schiphol Airport", desc: "International airport, about 20 minutes by train.", address: "Schiphol, Amsterdam" }
        ]
      },
      {
        id: "parking", icon: "&#127359;", title: "Parking",
        items: [
          { name: "Centre Parking Garage", desc: "Covered parking garage in the city centre.", address: "Marnixstraat 250, Amsterdam" }
        ]
      },
      {
        id: "police", icon: "&#128110;", title: "Police",
        items: [
          { name: "Central Police Station", desc: "Police station. Emergency number: 112.", address: "Elandsgracht 117, Amsterdam" }
        ]
      },
      {
        id: "hospital", icon: "&#127973;", title: "Hospital & A&E",
        items: [
          { name: "City Hospital", desc: "Emergency department open 24/7. Emergency number: 112.", address: "Oosterpark 9, Amsterdam" }
        ]
      },
      {
        id: "pharmacy", icon: "&#128138;", title: "Pharmacy",
        items: [
          { name: "Central Pharmacy", desc: "Prescriptions and over-the-counter medicine.", address: "Damrak 50, Amsterdam" }
        ]
      },
      {
        id: "atm", icon: "&#128179;", title: "ATM / cash",
        items: [
          { name: "Bank ATM", desc: "Cash machine, multiple cards accepted.", address: "Rokin 80, Amsterdam" }
        ]
      },
      {
        id: "toilets", icon: "&#128701;", title: "Public toilets",
        items: [
          { name: "Public Restroom", desc: "Public toilet, small fee may apply.", address: "Dam Square, Amsterdam" }
        ]
      },
      {
        id: "info", icon: "&#8505;", title: "Tourist info",
        items: [
          { name: "Tourist Information Centre", desc: "Maps, tickets and local advice for visitors.", address: "Stationsplein 18, Amsterdam" }
        ]
      }
    ]
  }
};

// Stadsgids ophalen, vertaald naar de taal van de bezoeker
// Vertaalgeheugen voor de stadsgids: per stad+taal bewaren we de volledig
// vertaalde gids, zodat alleen de EERSTE bezoeker in een taal hoeft te wachten.
const cityCache = new Map(); // sleutel "code:lang" -> { name, categories }

app.get("/api/city", async (req, res) => {
  const code = String(req.query && req.query.code ? req.query.code : "").trim().toLowerCase();
  const lang = String(req.query && req.query.lang ? req.query.lang : "en").trim() || "en";
  const city = CITIES[code];
  if(!city) return res.json({ ok:true, found:false });
  const src = city.sourceLang || "en";

  // Al eerder vertaald? Geef meteen terug (supersnel).
  const cacheKey = code + ":" + lang;
  if(cityCache.has(cacheKey)){
    const hit = cityCache.get(cacheKey);
    return res.json({ ok:true, found:true, name: hit.name, categories: hit.categories });
  }

  // helper: vertaal alleen als nodig (andere taal), met stille fallback naar origineel
  async function tr(text){
    if(!text || lang === src) return text;
    try{ return await translateText(text, src, lang); }catch(e){ return text; }
  }

  const cats = [];
  for(const c of (city.categories || [])){
    // vertaal titel en alle beschrijvingen van deze categorie tegelijk (parallel)
    const [title, descs] = await Promise.all([
      tr(c.title || ""),
      Promise.all((c.items || []).map(it => tr(it.desc || "")))
    ]);
    const items = (c.items || []).map((it, i) => ({
      name: it.name,
      desc: descs[i],
      address: it.address || "",
    }));
    cats.push({ id: c.id, icon: c.icon || "", title, items });
  }
  // bewaar in het geheugen zodat volgende bezoekers in deze taal het direct krijgen
  // Voeg de ACTIEVE ondernemers toe. Eerst groeperen per categorie, dan
  // ALLE beschrijvingen in een keer parallel vertalen (veel sneller).
  const cityMerchants = (merchants.get(code) || []).filter(m => m.active);
  const translatedDescs = await Promise.all(
    cityMerchants.map(m => tr(m.desc || ""))
  );
  const translatedPromos = await Promise.all(
    cityMerchants.map(m => (m.promo && m.promoUntil && Date.now() < m.promoUntil) ? tr(m.promo) : Promise.resolve(""))
  );
  for(let mi = 0; mi < cityMerchants.length; mi++){
    const m = cityMerchants[mi];
    let cat = cats.find(c => c.id === m.categoryId);
    if(!cat){
      const def = (city.categories || []).find(c => c.id === m.categoryId);
      cat = { id: m.categoryId, icon: def ? def.icon : "&#128205;", title: def ? await tr(def.title) : m.categoryId, items: [] };
      cats.push(cat);
    }
    cat.items.push({
      name: m.name,
      desc: translatedDescs[mi],
      address: m.address || "",
      promo: translatedPromos[mi]
    });
  }

  cityCache.set(cacheKey, { name: city.name || "", categories: cats });
  res.json({ ok:true, found:true, name: city.name || "", categories: cats });
});


// ===== ONDERNEMERS (stadsgids) =====
// Per stad een lijst ondernemers. Bewaard op schijf, blijft staan na herstart.
// Een ondernemer is alleen zichtbaar in de gids als active = true.
const merchants = new Map(); // stadcode -> [ {merchant}, ... ]
const MERCHANTS_FILE = path.join(DATA_DIR, "echo_merchants.json");
const ADMIN_PASSWORD = process.env.ECHO_ADMIN_PASSWORD || "verander-dit-wachtwoord";

function loadMerchants(){
  try{
    if(!fs.existsSync(MERCHANTS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(MERCHANTS_FILE, "utf8") || "{}");
    Object.keys(data || {}).forEach(city => {
      if(Array.isArray(data[city])) merchants.set(city, data[city]);
    });
    let total = 0; for(const v of merchants.values()) total += v.length;
    console.log("Ondernemers geladen: " + total);
  }catch(e){}
}
function saveMerchants(){
  try{
    const data = {};
    for(const [city, list] of merchants.entries()) data[city] = list;
    fs.writeFileSync(MERCHANTS_FILE, JSON.stringify(data, null, 2));
  }catch(e){}
  cityCache.clear(); // gids opnieuw opbouwen zodat wijzigingen meteen zichtbaar zijn
}
function adminOk(req){
  const pass = (req.body && req.body.adminPass) || (req.query && req.query.adminPass) || "";
  return String(pass) === ADMIN_PASSWORD;
}
function newMerchantId(){
  return "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}
loadMerchants();

// --- BEHEER (alleen voor jou, met wachtwoord) ---

app.post("/api/admin/merchants", (req, res) => {
  if(!adminOk(req)) return jsonError(res, 401, "Onjuist wachtwoord");
  const city = String(req.body.city || "").trim().toLowerCase();
  const list = merchants.get(city) || [];
  res.json({ ok:true, merchants: list });
});

app.post("/api/admin/merchant-save", (req, res) => {
  if(!adminOk(req)) return jsonError(res, 401, "Onjuist wachtwoord");
  const city = String(req.body.city || "").trim().toLowerCase();
  if(!city || !CITIES[city]) return jsonError(res, 400, "Onbekende stad");
  const m = req.body.merchant || {};
  const name = String(m.name || "").trim();
  if(!name) return jsonError(res, 400, "Naam ontbreekt");
  const list = merchants.get(city) || [];
  let existing = m.id ? list.find(x => x.id === m.id) : null;
  // Geen id meegegeven? Kijk of er al een ondernemer met dezelfde naam bestaat
  // (hoofdletter-ongevoelig), zodat we geen dubbele toevoegen.
  if(!existing && !m.id){
    const norm = name.toLowerCase().replace(/\s+/g, " ").trim();
    existing = list.find(x => (x.name || "").toLowerCase().replace(/\s+/g, " ").trim() === norm);
  }
  let wasDuplicate = false;
  if(existing){
    if(!m.id) wasDuplicate = true; // bestond al op naam
    existing.categoryId = String(m.categoryId || existing.categoryId || "");
    existing.name = name;
    existing.desc = String(m.desc || existing.desc || "");
    existing.address = String(m.address || existing.address || "");
    existing.email = String(m.email || existing.email || "");
    if(typeof m.active === "boolean") existing.active = m.active;
  }else{
    list.push({
      id: newMerchantId(),
      city,
      categoryId: String(m.categoryId || ""),
      name,
      desc: String(m.desc || ""),
      address: String(m.address || ""),
      email: String(m.email || ""),
      active: !!m.active,
      promo: "", promoUntil: 0,
      pin: "",
      stripeCustomerId: ""
    });
  }
  merchants.set(city, list);
  saveMerchants();
  res.json({ ok:true, merchants: list, duplicate: wasDuplicate });
});

app.post("/api/admin/merchant-toggle", (req, res) => {
  if(!adminOk(req)) return jsonError(res, 401, "Onjuist wachtwoord");
  const city = String(req.body.city || "").trim().toLowerCase();
  const id = String(req.body.id || "");
  const list = merchants.get(city) || [];
  const m = list.find(x => x.id === id);
  if(!m) return jsonError(res, 404, "Niet gevonden");
  const wasActive = m.active;
  m.active = !m.active;
  // Bij handmatig AANZETTEN met e-mail: pincode maken en mailen (zelfde als bij betaling)
  if(m.active && !wasActive && m.email){
    if(!m.pin) m.pin = makePremiumPin();
    sendMerchantPinEmail(m).catch(e => console.log("Ondernemer-pinmail mislukt: " + (e.message||e)));
  }
  saveMerchants();
  res.json({ ok:true, active: m.active, merchants: list });
});

app.post("/api/admin/merchant-delete", (req, res) => {
  if(!adminOk(req)) return jsonError(res, 401, "Onjuist wachtwoord");
  const city = String(req.body.city || "").trim().toLowerCase();
  const id = String(req.body.id || "");
  let list = merchants.get(city) || [];
  list = list.filter(x => x.id !== id);
  merchants.set(city, list);
  saveMerchants();
  res.json({ ok:true, merchants: list });
});

app.get("/api/admin/categories", (req, res) => {
  const city = String(req.query.city || "").trim().toLowerCase();
  const c = CITIES[city];
  if(!c) return res.json({ ok:true, categories: [] });
  res.json({ ok:true, categories: (c.categories || []).map(x => ({ id: x.id, title: x.title })) });
});

// --- ZOEKEN (voor de ondernemer zelf, openbaar) ---
app.get("/api/merchant-search", (req, res) => {
  const city = String(req.query.city || "").trim().toLowerCase();
  const q = String(req.query.q || "").trim().toLowerCase();
  if(!city || q.length < 2) return res.json({ ok:true, results: [] });
  const list = merchants.get(city) || [];
  const results = list
    .filter(m => m.name.toLowerCase().includes(q))
    .map(m => ({ id: m.id, name: m.name, address: m.address, active: m.active }));
  res.json({ ok:true, results });
});

// --- ABONNEMENT AFSLUITEN (ondernemer betaalt -> komt automatisch online) ---
app.post("/api/merchant-subscribe", async (req, res) => {
  try{
    const city = String(req.body.city || "").trim().toLowerCase();
    const merchantId = String(req.body.merchantId || "").trim();
    const email = String(req.body.email || "").trim();
    const list = merchants.get(city) || [];
    const m = list.find(x => x.id === merchantId);
    if(!m) return jsonError(res, 404, "Onderneming niet gevonden");

    const base = (req.body.baseUrl && String(req.body.baseUrl)) || "";
    const successUrl = (base || STRIPE_SUCCESS_URL);
    const cancelUrl = (base || STRIPE_CANCEL_URL);

    const meta = { kind: "merchant", city, merchantId, merchantName: m.name, email };
    const payload = {
      mode: "subscription",
      "line_items": [ { price: STRIPE_MERCHANT_PRICE_ID, quantity: 1 } ],
      success_url: successUrlWithCheckoutSession(successUrl),
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      metadata: meta,
      subscription_data: { metadata: meta }
    };
    if(email) payload.customer_email = email;

    const session = await callStripe("/checkout/sessions", payload);
    // koppel alvast de (toekomstige) klant zodat we later kunnen uitzetten
    res.json({ ok:true, id: session.id, url: session.url });
  }catch(err){
    jsonError(res, 500, "Stripe checkout fout", err.message || String(err));
  }
});

// Hulp voor de webhook: zet een onderneming aan/uit op basis van Stripe-metadata
function setMerchantActiveFromMeta(meta, active, stripeCustomerId){
  if(!meta || meta.kind !== "merchant") return false;
  const city = String(meta.city || "").toLowerCase();
  const merchantId = String(meta.merchantId || "");
  const list = merchants.get(city) || [];
  const m = list.find(x => x.id === merchantId);
  if(!m) return false;
  const wasActive = m.active;
  m.active = active;
  if(stripeCustomerId) m.stripeCustomerId = stripeCustomerId;
  // E-mail uit metadata bewaren als die er nog niet is
  if(meta.email && !m.email) m.email = String(meta.email);
  // Bij ACTIVEREN (en alleen als nog geen pincode): pincode maken en mailen
  if(active && !wasActive){
    if(!m.pin) m.pin = makePremiumPin();
    if(m.email){
      sendMerchantPinEmail(m).catch(e => console.log("Ondernemer-pinmail mislukt: " + (e.message||e)));
    }
  }
  saveMerchants();
  console.log("Ondernemer " + (active ? "AAN" : "UIT") + " via Stripe: " + m.name + " (" + city + ")");
  return true;
}

// Pincode-mail voor de ondernemer (om in te loggen op het ondernemer-portaal)
async function sendMerchantPinEmail(m){
  const subject = "Uw Salve-vermelding is actief - uw pincode";
  const text =
    "Beste ondernemer,\n\n" +
    "Bedankt! Uw vermelding \"" + m.name + "\" staat nu online in de Salve stadsgids.\n\n" +
    "Uw persoonlijke pincode is: " + m.pin + "\n\n" +
    "Met uw e-mailadres (" + m.email + ") en deze pincode kunt u inloggen om uw\n" +
    "gegevens te wijzigen (zoals uw adres) en acties te plaatsen.\n\n" +
    "Bewaar deze pincode goed en deel hem met niemand.\n\n" +
    "Met vriendelijke groet,\nSalve - powered by FormForge";
  const html =
    "<p>Beste ondernemer,</p>" +
    "<p>Bedankt! Uw vermelding <strong>" + m.name + "</strong> staat nu online in de Salve stadsgids.</p>" +
    "<p>Uw persoonlijke pincode is: <strong style='font-size:20px'>" + m.pin + "</strong></p>" +
    "<p>Met uw e-mailadres (" + m.email + ") en deze pincode kunt u inloggen om uw gegevens te wijzigen (zoals uw adres) en acties te plaatsen.</p>" +
    "<p>Bewaar deze pincode goed en deel hem met niemand.</p>" +
    "<p>Met vriendelijke groet,<br>Salve - powered by FormForge</p>";
  await sendResendEmail({ to: m.email, subject, text, html });
}

// Gast registreert/voegt huidige kamer toe aan zijn gast-account
app.post("/api/guest/save-room", (req, res) => {
  const name = String(req.body && req.body.name ? req.body.name : "").trim();
  const pin = String(req.body && req.body.pin ? req.body.pin : "").trim();
  const code = String(req.body && req.body.code ? req.body.code : "").trim();
  const reconnect = String(req.body && req.body.reconnect ? req.body.reconnect : "").trim();
  const label = String(req.body && req.body.label ? req.body.label : "").trim();
  const lang = String(req.body && req.body.lang ? req.body.lang : "").trim();
  if(!name || !pin) return jsonError(res, 400, "Naam en pincode zijn nodig.");
  if(pin.length < 4) return jsonError(res, 400, "Kies een pincode van minstens 4 cijfers.");
  if(!code) return jsonError(res, 400, "Kamercode ontbreekt.");
  const acc = upsertGuestRoom(name, pin, { code, reconnect, label, lang, ts: Date.now() });
  res.json({ ok:true, rooms: acc.rooms });
});

// Gast haalt zijn kamers op met naam + pincode (werkt op elk toestel)
app.post("/api/guest/my-rooms", (req, res) => {
  const name = String(req.body && req.body.name ? req.body.name : "").trim();
  const pin = String(req.body && req.body.pin ? req.body.pin : "").trim();
  if(!name || !pin) return jsonError(res, 400, "Naam en pincode zijn nodig.");
  let acc = getGuestAccount(name, pin);
  if(!acc) return res.json({ ok:true, found:false, rooms:[] });
  acc = cleanGuestRooms(acc);
  res.json({ ok:true, found:true, rooms: acc.rooms || [] });
});


function pruneBans(room){
  if(!room || !room.banAt) return;
  const now = Date.now();
  for(const [key, ts] of Array.from(room.banAt.entries())){
    if(now - ts > ROOM_BAN_MS){
      room.banAt.delete(key);
      if(room.banned) room.banned.delete(key);
    }
  }
}

function pruneRoom(room){
  // Als de host een bewaartijd heeft ingesteld (msgTtlMs > 0): verwijder berichten
  // die ouder zijn dan die tijd. Media telt vanaf het moment van ophalen (firstSeenAt),
  // tekst vanaf verzendtijd. msgTtlMs = 0 betekent permanent (blijft staan).
  if(room.msgTtlMs && room.msgTtlMs > 0){
    const now = Date.now();
    room.messages = room.messages.filter((m) => {
      if(m.media){
        if(!m.media.firstSeenAt) return (now - m.ts) < Math.max(room.msgTtlMs, 120000);
        return (now - m.media.firstSeenAt) < room.msgTtlMs;
      }
      return (now - m.ts) < room.msgTtlMs;
    });
  }
  // Veiligheidsklep: bij extreem veel berichten bewaren we alleen de laatste 5000,
  // zodat de server nooit volloopt. In normaal gebruik merkt niemand dit.
  const MAX_MESSAGES = 5000;
  if(room.messages.length > MAX_MESSAGES){
    room.messages = room.messages.slice(room.messages.length - MAX_MESSAGES);
  }
  // Deelnemers blijven in de kamer staan (ook als hun scherm uit staat of de app
  // op de achtergrond draait). Ze verdwijnen alleen als ze zelf weggaan of worden
  // verwijderd door de host. Geen automatische opruiming op stilte.
}

function cleanupRooms(){
  for(const [code,room] of rooms.entries()){
    pruneRoom(room);
    // Permanente kamers NIET verwijderen, ook niet als ze leeg/stil zijn.
  }
}
setInterval(cleanupRooms, 5000);

// Eenvoudige vertaalcache: sleutel = van|naar|tekst  -> { text, ts }
const roomTransCache = new Map();
function transCacheKey(from,to,text){ return from+"|"+to+"|"+text; }
function getCachedTranslation(from,to,text){
  const k=transCacheKey(from,to,text);
  const hit=roomTransCache.get(k);
  if(hit && (Date.now()-hit.ts) < 60000) return hit.text;
  return null;
}
function setCachedTranslation(from,to,text,translated){
  roomTransCache.set(transCacheKey(from,to,text), { text: translated, ts: Date.now() });
  if(roomTransCache.size > 500){
    // simpele opschoning
    const firstKey = roomTransCache.keys().next().value;
    roomTransCache.delete(firstKey);
  }
}

// Volledige taalnamen zodat het AI-model precies weet naar welke taal vertaald moet worden
// (kale codes als "de"/"nl" leidden tot verkeerde of Engelse vertalingen)
const LANG_NAMES = {
  en: "English", nl: "Dutch", de: "German", fr: "French", es: "Spanish",
  it: "Italian", pt: "Portuguese", pl: "Polish", tr: "Turkish", ar: "Arabic",
  uk: "Ukrainian", ru: "Russian", zh: "Chinese", ja: "Japanese", ko: "Korean",
  hi: "Hindi", id: "Indonesian", th: "Thai", vi: "Vietnamese", ro: "Romanian",
  cs: "Czech", sv: "Swedish"
};
function langName(code){
  return LANG_NAMES[String(code || "").toLowerCase()] || String(code || "");
}

async function translateText(text, from, to){
  if(!text) return "";
  if(from === to) return text;
  const cached = getCachedTranslation(from,to,text);
  if(cached !== null) return cached;
  const fromName = langName(from);
  const toName = langName(to);
  const out = await callOpenAI([
    { role:"system", content:"You are a translation engine for a live chat. Translate the user's message into " + toName + " only. Output ONLY the translation in " + toName + ", with no explanation, no quotes, and no other languages. Keep names, numbers, emoji and links unchanged." },
    { role:"user", content:"Translate this message from " + fromName + " to " + toName + ":\n" + text }
  ], 0.1);
  setCachedTranslation(from,to,text,out);
  return out;
}

// Kamer maken
app.post("/api/room/create", (req, res) => {
  const wantFree = !!(req.body && (req.body.freeRoom === true || req.body.freeRoom === "true"));

  let gate = { ok:true, accountKey:"", email:"" };
  if(!wantFree){
    // Vertaalkamer (meerdere talen) vereist een Unlimited-abonnement.
    gate = requireUnlimited(req);
    if(!gate.ok) return jsonError(res, gate.status, gate.error);
  }
  // Gratis kamer: iedereen mag er een aanmaken, geen abonnement nodig.

  const name = String(req.body && req.body.name ? req.body.name : "").trim().slice(0,40);
  const lang = String(req.body && req.body.lang ? req.body.lang : "").trim() || "en";
  if(!name) return jsonError(res, 400, "Naam ontbreekt");
  const code = makeRoomCode();
  const memberId = "m_" + Date.now() + "_" + Math.random().toString(36).slice(2,8);
  // Bewaartijd voor berichten: 0 = permanent, anders milliseconden tot verdwijnen.
  let msgTtlMs = 0;
  const rawTtl = req.body && req.body.msgTtlSec;
  if(rawTtl !== undefined && rawTtl !== null && rawTtl !== ""){
    const sec = parseInt(rawTtl, 10);
    if(!isNaN(sec) && sec > 0){ msgTtlMs = Math.min(sec, 30*24*60*60) * 1000; } // max 30 dagen
  }
  const room = { code, createdAt: Date.now(), lastActive: Date.now(), members: new Map(), messages: [], translationsToday: 0, translationDay: roomToday(), hostName: name, hostLang: lang, hostKey: gate.accountKey || "", hostEmail: gate.email || "", banned: new Set(), banAt: new Map(), persistent: true, freeMode: wantFree, roomLang: wantFree ? lang : "", msgTtlMs: msgTtlMs };
  room.members.set(memberId, { id: memberId, name, lang, lastSeen: Date.now(), isHost: true });
  rooms.set(code, room);
  saveRooms();
  const reconnect = issueReconnectToken(code, name, lang, true);
  res.json({ ok:true, code, memberId, name, lang, isHost:true, reconnect });
});

// Kamer joinen
app.post("/api/room/join", (req, res) => {
  const code = String(req.body && req.body.code ? req.body.code : "").trim();
  const name = String(req.body && req.body.name ? req.body.name : "").trim().slice(0,40);
  const lang = String(req.body && req.body.lang ? req.body.lang : "").trim() || "en";
  const token = String(req.body && req.body.token ? req.body.token : "").trim();
  if(!name) return jsonError(res, 400, "Naam ontbreekt");
  const room = rooms.get(code);
  if(!room) return jsonError(res, 404, "Kamer niet gevonden. Controleer de code.");
  // Verwijderde personen even buiten houden
  pruneBans(room);
  const banKey = name.toLowerCase();
  if(room.banned && room.banned.has(banKey)){
    return jsonError(res, 403, "Je bent uit deze kamer verwijderd.");
  }

  // Gasten hebben een geldige, eenmalige uitnodiging nodig.
  // (Dit voorkomt dat een doorgestuurde link of kale code werkt.)
  const inv = token ? roomInvites.get(token) : null;
  const now = Date.now();
  if(!inv || inv.code !== code || inv.expiresAt <= now || inv.uses >= inv.maxUses){
    return jsonError(res, 403, "Deze uitnodiging is ongeldig of verlopen. Vraag de host om een nieuwe link.");
  }
  // Token verbruiken
  inv.uses += 1;
  if(inv.uses >= inv.maxUses) roomInvites.delete(token);
  saveInvites();

  // Verwijder oude versies van dezelfde gast (zelfde naam, niet-host) zodat er
  // geen dubbele leden ontstaan bij opnieuw joinen.
  const joinName = String(name || "").trim().toLowerCase();
  for(const [mid, mem] of Array.from(room.members.entries())){
    if(!mem.isHost && String(mem.name || "").trim().toLowerCase() === joinName){
      room.members.delete(mid);
      removeRoomPush(code, mid);
    }
  }

  // In een gratis kamer (één taal) krijgt de gast automatisch de kamertaal.
  let useLang = lang;
  if(room.freeMode && room.roomLang){ useLang = room.roomLang; }

  const memberId = "m_" + Date.now() + "_" + Math.random().toString(36).slice(2,8);
  room.members.set(memberId, { id: memberId, name, lang: useLang, lastSeen: Date.now() });
  room.lastActive = Date.now();
  const reconnect = issueReconnectToken(code, name, useLang, false);
  res.json({ ok:true, code, memberId, name, lang: useLang, reconnect, freeMode: !!room.freeMode });
});

// Bestaand lid herverbindt (na korte stilte of herstart) zonder nieuwe uitnodiging
app.post("/api/room/rejoin", (req, res) => {
  const rcToken = String(req.body && req.body.reconnect ? req.body.reconnect : "").trim();
  const r = rcToken ? reconnectTokens.get(rcToken) : null;
  if(!r || r.expiresAt <= Date.now()) return jsonError(res, 403, "Sessie verlopen. Vraag de host om een nieuwe link.");
  const room = rooms.get(r.code);
  if(!room) return jsonError(res, 404, "Kamer niet gevonden.");
  // geband? dan ook geen reconnect
  pruneBans(room);
  if(room.banned && room.banned.has(String(r.name||"").toLowerCase())){
    reconnectTokens.delete(rcToken);
    return jsonError(res, 403, "Je bent uit deze kamer verwijderd.");
  }
  // Verwijder eerst eventuele oude versies van DEZELFDE persoon (zelfde naam +
  // host-status). Anders stapelen oude "geesten" zich op nu leden niet meer
  // automatisch op stilte worden opgeruimd.
  const sameName = String(r.name || "").trim().toLowerCase();
  const wantHost = !!r.isHost;
  for(const [mid, mem] of Array.from(room.members.entries())){
    if(String(mem.name || "").trim().toLowerCase() === sameName && !!mem.isHost === wantHost){
      room.members.delete(mid);
      removeRoomPush(r.code, mid);
    }
  }

  const memberId = "m_" + Date.now() + "_" + Math.random().toString(36).slice(2,8);
  const isHost = !!r.isHost;
  room.members.set(memberId, { id: memberId, name: r.name, lang: r.lang, lastSeen: Date.now(), isHost });
  room.lastActive = Date.now();
  res.json({ ok:true, code: r.code, memberId, name: r.name, lang: r.lang, isHost });
});

// Host maakt een eenmalige / verlopende uitnodiging aan
app.post("/api/room/invite", (req, res) => {
  const code = String(req.body && req.body.code ? req.body.code : "").trim();
  const memberId = String(req.body && req.body.memberId ? req.body.memberId : "").trim();
  const room = rooms.get(code);
  if(!room) return jsonError(res, 404, "Kamer niet gevonden");
  const me = room.members.get(memberId);
  if(!me || !me.isHost) return jsonError(res, 403, "Alleen de host kan een uitnodiging maken.");

  const kind = String(req.body && req.body.kind ? req.body.kind : "single").toLowerCase();

  let maxUses, ttlMs;
  if(kind === "company"){
    // Blijvende, herbruikbare bedrijfscode voor een gedrukte brief/QR.
    maxUses = INVITE_MAX_USES_CAP;      // effectief onbeperkt aantal mensen
    ttlMs = INVITE_MAX_TTL_MS;          // jarenlang geldig
  }else{
    // Eén persoon: geen tijdsdruk, vervalt zodra hij gebruikt is.
    maxUses = 1;
    ttlMs = INVITE_MAX_TTL_MS;          // geen 10-minuten-limiet meer; vervalt op gebruik
  }

  // host mag desgewenst zelf maxUses/ttl meegeven (binnen de caps)
  const reqUses = parseInt(req.body && req.body.maxUses, 10);
  if(Number.isFinite(reqUses) && reqUses >= 1) maxUses = Math.min(reqUses, INVITE_MAX_USES_CAP);
  const reqTtl = parseInt(req.body && req.body.ttlMs, 10);
  if(Number.isFinite(reqTtl) && reqTtl >= 30000) ttlMs = Math.min(reqTtl, INVITE_MAX_TTL_MS);

  const token = makeInviteToken();
  const expiresAt = Date.now() + ttlMs;
  roomInvites.set(token, { code, maxUses, uses: 0, expiresAt, kind });
  saveInvites();
  res.json({ ok:true, token, maxUses, expiresAt, ttlMs, kind });
});

// Bericht sturen
app.post("/api/room/send", (req, res) => {
  const code = String(req.body && req.body.code ? req.body.code : "").trim();
  const memberId = String(req.body && req.body.memberId ? req.body.memberId : "").trim();
  const text = String(req.body && req.body.text ? req.body.text : "").trim().slice(0,2000);
  const room = rooms.get(code);
  if(!room) return jsonError(res, 404, "Kamer niet gevonden");
  const member = room.members.get(memberId);
  if(!member) return jsonError(res, 403, "Je zit niet (meer) in deze kamer. Join opnieuw.");
  if(!text) return jsonError(res, 400, "Leeg bericht");
  member.lastSeen = Date.now();
  room.lastActive = Date.now();
  const msg = {
    id: "rm_" + Date.now() + "_" + Math.random().toString(36).slice(2,8),
    senderId: member.id,
    senderName: member.name,
    srcLang: member.lang,
    text,
    ts: Date.now(),
    translations: {} // wordt gevuld bij ophalen per lezer-taal
  };
  room.messages.push(msg);

  // Stuur een pushmelding naar alle ANDERE leden van de kamer
  notifyRoom(code, member.id, {
    title: member.name + " in kamer " + code,
    body: text.slice(0, 120),
    code: code,
    tag: "room-" + code
  }).catch(()=>{});

  res.json({ ok:true, id: msg.id });
});

// Berichten ophalen, vertaald naar de taal van de lezer
app.post("/api/room/poll", async (req, res) => {
  const code = String(req.body && req.body.code ? req.body.code : "").trim();
  const memberId = String(req.body && req.body.memberId ? req.body.memberId : "").trim();
  const room = rooms.get(code);
  if(!room) return jsonError(res, 404, "Kamer niet gevonden");
  const member = room.members.get(memberId);
  if(!member) return jsonError(res, 403, "Je zit niet (meer) in deze kamer. Join opnieuw.");
  member.lastSeen = Date.now();
  pruneRoom(room);
  const now = Date.now();
  const myLang = member.lang;
  let limitReached = false;

  // Vertaal elk bericht naar de taal van deze lezer (met cache)
  const out = [];
  for(const m of room.messages){
    let shown = m.text;
    let translated = false;
    if(!room.freeMode && m.srcLang !== myLang){
      if(m.translations[myLang]){
        // Al eerder vertaald: gratis uit cache, telt niet mee
        shown = m.translations[myLang];
        translated = true;
      }else if(roomTranslationsLeft(room) > 0){
        try{
          shown = await translateText(m.text, m.srcLang, myLang);
          m.translations[myLang] = shown;
          room.translationsToday += 1; // alleen ECHTE vertalingen tellen mee
          translated = true;
        }catch(e){
          shown = m.text; // bij fout: toon origineel
          translated = false;
        }
      }else{
        // Dagelijkse vertaallimiet bereikt: toon origineel, blijf chatten
        shown = m.text;
        translated = false;
        limitReached = true;
      }
    }
    // Verloop-tijd op basis van de door de host ingestelde bewaartijd.
    // msgTtlMs = 0 betekent permanent: dan sturen we geen expiresAt (0).
    let expiresAt = 0;
    if(room.msgTtlMs && room.msgTtlMs > 0){
      if(m.media){
        expiresAt = m.media.firstSeenAt ? (m.media.firstSeenAt + room.msgTtlMs) : (now + room.msgTtlMs);
      }else{
        expiresAt = m.ts + room.msgTtlMs;
      }
    }
    out.push({
      id: m.id,
      senderId: m.senderId,
      senderName: m.senderName,
      srcLang: m.srcLang,
      mine: m.senderId === member.id,
      text: shown,
      original: m.text,
      translated,
      ts: m.ts,
      media: m.media ? {
        kind: m.media.kind,
        mime: m.media.mime,
        name: m.media.name,
        size: m.media.size,
        url: "/api/room/media/" + code + "/" + m.id
      } : null,
      expiresAt,
      remainingMs: Math.max(0, expiresAt - now)
    });
  }

  const members = Array.from(room.members.values()).map((x) => ({ id: x.id, name: x.name, lang: x.lang, isHost: !!x.isHost }));
  const iAmHost = !!(member && member.isHost);
  res.json({
    ok:true,
    ttl: ROOM_TTL_MS,
    serverTime: now,
    messages: out,
    members,
    iAmHost,
    myId: member.id,
    freeMode: !!room.freeMode,
    msgTtlMs: room.msgTtlMs || 0,
    limitReached,
    translationsToday: room.translationsToday,
    dailyLimit: ROOM_DAILY_TRANSLATION_LIMIT,
    translationsLeft: roomTranslationsLeft(room)
  });
});

// Host verwijdert een ander lid uit de kamer
app.post("/api/room/kick", (req, res) => {
  const code = String(req.body && req.body.code ? req.body.code : "").trim();
  const memberId = String(req.body && req.body.memberId ? req.body.memberId : "").trim();
  const targetId = String(req.body && req.body.targetId ? req.body.targetId : "").trim();
  const room = rooms.get(code);
  if(!room) return jsonError(res, 404, "Kamer niet gevonden");
  const me = room.members.get(memberId);
  if(!me || !me.isHost) return jsonError(res, 403, "Alleen de host kan iemand verwijderen.");
  if(targetId === memberId) return jsonError(res, 400, "Je kunt jezelf niet verwijderen; gebruik 'verlaten'.");
  const target = room.members.get(targetId);
  if(!target) return jsonError(res, 404, "Persoon zit niet (meer) in de kamer.");

  // verwijderen + kort weren zodat de persoon niet meteen terug polt
  room.members.delete(targetId);
  removeRoomPush(code, targetId);
  if(!room.banned) room.banned = new Set();
  if(!room.banAt) room.banAt = new Map();
  const banKey = String(target.name || "").toLowerCase();
  if(banKey){ room.banned.add(banKey); room.banAt.set(banKey, Date.now()); }
  room.lastActive = Date.now();
  res.json({ ok:true, removed: target.name });
});

// App meldt zich aan voor pushmeldingen in deze kamer
app.post("/api/room/push-subscribe", (req, res) => {
  const code = String(req.body && req.body.code ? req.body.code : "").trim();
  const memberId = String(req.body && req.body.memberId ? req.body.memberId : "").trim();
  const subscription = req.body && req.body.subscription;
  const room = rooms.get(code);
  if(!room) return jsonError(res, 404, "Kamer niet gevonden");
  if(!room.members.get(memberId)) return jsonError(res, 403, "Je zit niet in deze kamer");
  if(!subscription || !subscription.endpoint) return jsonError(res, 400, "Ongeldige aanmelding");
  addRoomPush(code, memberId, subscription);
  res.json({ ok:true });
});

// Publieke VAPID-sleutel ophalen (heeft de app nodig om zich aan te melden)
app.get("/api/room/push-key", (req, res) => {
  res.json({ ok:true, publicKey: VAPID_PUBLIC_KEY });
});

// Media versturen (foto/video/bestand). Blijft in geheugen, verdwijnt na 15s.
app.post("/api/room/send-media", roomMediaUpload.single("file"), (req, res) => {
  const code = String(req.body && req.body.code ? req.body.code : "").trim();
  const memberId = String(req.body && req.body.memberId ? req.body.memberId : "").trim();
  const room = rooms.get(code);
  if(!room) return jsonError(res, 404, "Kamer niet gevonden");
  const member = room.members.get(memberId);
  if(!member) return jsonError(res, 403, "Je zit niet (meer) in deze kamer. Join opnieuw.");
  if(!req.file || !req.file.buffer) return jsonError(res, 400, "Geen bestand ontvangen");

  member.lastSeen = Date.now();
  room.lastActive = Date.now();

  const mime = req.file.mimetype || "application/octet-stream";
  let kind = "file";
  if(mime.startsWith("image/")) kind = "image";
  else if(mime.startsWith("video/")) kind = "video";

  const caption = String(req.body && req.body.caption ? req.body.caption : "").trim().slice(0,500);

  const msg = {
    id: "rm_" + Date.now() + "_" + Math.random().toString(36).slice(2,8),
    senderId: member.id,
    senderName: member.name,
    srcLang: member.lang,
    text: caption,            // optioneel bijschrift (wordt vertaald zoals gewone tekst)
    ts: Date.now(),
    translations: {},
    media: {
      kind,                                  // "image" | "video" | "file"
      mime,
      name: String(req.file.originalname || "bestand").slice(0,120),
      size: req.file.size || (req.file.buffer ? req.file.buffer.length : 0),
      buffer: req.file.buffer,               // ruwe bytes in geheugen
      firstSeenAt: 0                         // 15s-klok start bij eerste ophalen
    }
  };
  room.messages.push(msg);

  notifyRoom(code, member.id, {
    title: member.name + " in kamer " + code,
    body: kind === "image" ? "Foto" : (kind === "video" ? "Video" : "Bestand"),
    code: code,
    tag: "room-" + code
  }).catch(()=>{});

  res.json({ ok:true, id: msg.id });
});

// Media-bytes serveren zolang het bericht leeft. Start de 15s-klok bij eerste ophalen.
app.get("/api/room/media/:code/:id", (req, res) => {
  const code = String(req.params.code || "").trim();
  const id = String(req.params.id || "").trim();
  const room = rooms.get(code);
  if(!room) return res.status(404).end();
  const msg = room.messages.find((m) => m.id === id && m.media);
  if(!msg) return res.status(404).end();

  // start de vluchtige klok bij de eerste echte aflevering
  if(!msg.media.firstSeenAt) msg.media.firstSeenAt = Date.now();

  res.setHeader("Content-Type", msg.media.mime || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  if(msg.media.kind === "file"){
    res.setHeader("Content-Disposition", "attachment; filename=\"" + encodeURIComponent(msg.media.name) + "\"");
  }
  res.end(msg.media.buffer);
});

// Kamer verlaten
app.post("/api/room/leave", (req, res) => {
  const code = String(req.body && req.body.code ? req.body.code : "").trim();
  const memberId = String(req.body && req.body.memberId ? req.body.memberId : "").trim();
  const room = rooms.get(code);
  if(room){ room.members.delete(memberId); }
  removeRoomPush(code, memberId);
  res.json({ ok:true });
});

// Taal van een lid wijzigen (kan op elk moment, ook midden in de chat)
app.post("/api/room/set-lang", (req, res) => {
  const code = String(req.body && req.body.code ? req.body.code : "").trim();
  const memberId = String(req.body && req.body.memberId ? req.body.memberId : "").trim();
  const lang = String(req.body && req.body.lang ? req.body.lang : "").trim();
  const room = rooms.get(code);
  if(!room) return jsonError(res, 404, "Kamer niet gevonden");
  const mem = room.members.get(memberId);
  if(!mem) return jsonError(res, 403, "Je zit niet meer in deze kamer");
  if(!lang) return jsonError(res, 400, "Taal ontbreekt");
  mem.lang = lang;
  mem.lastSeen = Date.now();
  // bestaande vertaalcache mag blijven; nieuwe berichten worden in de nieuwe taal vertaald
  res.json({ ok:true, lang });
});


/* ============================================================
   DIRECTE BERICHTEN TUSSEN UNLIMITED-GEBRUIKERS
   - elke Unlimited-gebruiker krijgt een uniek Echo-ID
   - je voegt iemand toe via diens Echo-ID (privacy: niemand
     ziet je zonder dat ID)
   - berichten blijven bewaard tot de ander ze gelezen heeft
   ============================================================ */

const DM_STORE_FILE = path.join(DATA_DIR, "echo_directmsg.json");
const DM_MSG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // vangnet: ongelezen berichten max 30 dagen
const DM_PRESENCE_MS = 25 * 1000;                   // "online" als <25s geleden gezien

// dmUsers: echoId -> { echoId, accountKey, email, name, lang, contacts:[echoId], lastSeen }
const dmUsers = new Map();
// snelle index: accountKey -> echoId
const dmByAccount = new Map();
// dmThreads: threadKey -> [ {id, from, to, srcLang, text, ts, readBy:{}, translations:{}} ]
const dmThreads = new Map();
// push-aanmeldingen per echoId
const dmPush = new Map();

function dmThreadKey(a, b){ return [a, b].sort().join("__"); }

function makeEchoId(){
  let id;
  do{
    const block = () => String(Math.floor(1000 + Math.random()*9000));
    id = "ECHO-" + block() + "-" + block();
  }while(dmUsers.has(id));
  return id;
}

function loadDM(){
  try{
    if(!fs.existsSync(DM_STORE_FILE)) return;
    const raw = fs.readFileSync(DM_STORE_FILE, "utf8");
    const data = JSON.parse(raw || "{}");
    (data.users || []).forEach((u) => {
      if(!u || !u.echoId) return;
      dmUsers.set(u.echoId, {
        echoId: u.echoId,
        accountKey: u.accountKey || "",
        email: u.email || "",
        name: u.name || "",
        lang: u.lang || "en",
        contacts: Array.isArray(u.contacts) ? u.contacts : [],
        lastSeen: 0
      });
      if(u.accountKey) dmByAccount.set(u.accountKey, u.echoId);
    });
    Object.keys(data.threads || {}).forEach((k) => {
      dmThreads.set(k, Array.isArray(data.threads[k]) ? data.threads[k] : []);
    });
    // push-aanmeldingen herstellen zodat meldingen een herstart overleven
    Object.keys(data.push || {}).forEach((echoId) => {
      if(Array.isArray(data.push[echoId])) dmPush.set(echoId, data.push[echoId]);
    });
    console.log("Direct-messages geladen: " + dmUsers.size + " gebruikers");
  }catch(err){
    console.warn("Direct-messages konden niet worden geladen:", err.message || String(err));
  }
}

let dmSaveTimer = null;
function saveDM(){
  // licht uitgesteld opslaan zodat snelle bursts niet telkens schrijven
  if(dmSaveTimer) return;
  dmSaveTimer = setTimeout(() => {
    dmSaveTimer = null;
    try{
      const users = Array.from(dmUsers.values()).map((u) => ({
        echoId: u.echoId, accountKey: u.accountKey, email: u.email,
        name: u.name, lang: u.lang, contacts: u.contacts
      }));
      const threads = {};
      for(const [k, list] of dmThreads.entries()){
        if(list && list.length) threads[k] = list;
      }
      const push = {};
      for(const [echoId, list] of dmPush.entries()){
        if(list && list.length) push[echoId] = list;
      }
      fs.writeFileSync(DM_STORE_FILE, JSON.stringify({ users, threads, push }, null, 2));
    }catch(err){
      console.warn("Direct-messages konden niet worden opgeslagen:", err.message || String(err));
    }
  }, 800);
}

function pruneDM(){
  const cutoff = Date.now() - DM_MSG_MAX_AGE_MS;
  let changed = false;
  for(const [k, list] of dmThreads.entries()){
    const kept = list.filter((m) => m.ts > cutoff);
    if(kept.length !== list.length){ changed = true; }
    if(kept.length) dmThreads.set(k, kept); else dmThreads.delete(k);
  }
  if(changed) saveDM();
}
setInterval(pruneDM, 60 * 60 * 1000); // elk uur opschonen

// Zorg dat de ingelogde Unlimited-gebruiker een Echo-ID heeft (maakt aan indien nodig)
function ensureDmUser(accountKey, email, name, lang){
  let echoId = dmByAccount.get(accountKey);
  let user = echoId ? dmUsers.get(echoId) : null;
  if(!user){
    echoId = makeEchoId();
    user = { echoId, accountKey, email: email || "", name: name || "", lang: lang || "en", contacts: [], lastSeen: Date.now() };
    dmUsers.set(echoId, user);
    dmByAccount.set(accountKey, echoId);
    saveDM();
  }else{
    // naam/taal bijwerken als meegegeven
    if(name && user.name !== name){ user.name = name; saveDM(); }
    if(lang && user.lang !== lang){ user.lang = lang; saveDM(); }
    if(email && !user.email){ user.email = email; }
  }
  user.lastSeen = Date.now();
  return user;
}

function dmPublicContact(echoId){
  const u = dmUsers.get(echoId);
  if(!u) return { echoId, name: "(onbekend)", lang: "en", online: false };
  return {
    echoId: u.echoId,
    name: u.name || u.echoId,
    lang: u.lang || "en",
    online: (Date.now() - (u.lastSeen || 0)) < DM_PRESENCE_MS
  };
}

async function dmTranslate(text, from, to){
  if(!text || from === to) return text;
  try{ return await translateText(text, from, to); }catch(e){ return text; }
}

function dmAddPush(echoId, subscription){
  if(!echoId || !subscription || !subscription.endpoint) return;
  const list = dmPush.get(echoId) || [];
  const filtered = list.filter((s) => s.endpoint !== subscription.endpoint);
  filtered.push(subscription);
  dmPush.set(echoId, filtered);
  saveDM();
}

async function dmNotify(echoId, payload){
  if(!webpush || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const list = dmPush.get(echoId) || [];
  if(!list.length) return;
  const valid = [];
  for(const sub of list){
    try{ await webpush.sendNotification(sub, JSON.stringify(payload)); valid.push(sub); }
    catch(err){ if(err.statusCode !== 404 && err.statusCode !== 410) valid.push(sub); }
  }
  dmPush.set(echoId, valid);
}

// --- Inloggen op het direct-message systeem: geeft je eigen Echo-ID terug ---
// Bepaal de DM-identiteit. Werkt voor IEDEREEN (gratis), via naam + pincode.
// Een Unlimited-account werkt ook (dan gebruiken we de accountKey daarvan).
// Geeft { accountKey, email, name, lang } terug, of { error } bij ongeldige invoer.
function resolveDmIdentity(req){
  const b = req.body || {};
  const name = String(b.name || "").trim().slice(0,40);
  const lang = String(b.lang || "").trim() || "en";
  // 1) Heeft de persoon een geldig Unlimited-account? Gebruik dat (zoals voorheen).
  const gate = requireUnlimited(req);
  if(gate.ok){
    return { accountKey: gate.accountKey, email: gate.email || "", name, lang, unlimited: true };
  }
  // 2) Anders: gratis identiteit via naam + pincode.
  const pin = String(b.pin || "").trim();
  if(!name) return { error: "Voer je naam in." };
  if(!pin || pin.length < 4) return { error: "Kies een pincode van minstens 4 cijfers." };
  // accountKey voor gratis DM-gebruikers: "dmfree:" + naam-lowercase + ":" + pin
  const accountKey = "dmfree:" + name.toLowerCase() + ":" + pin;
  return { accountKey, email: "", name, lang, unlimited: false };
}

app.post("/api/dm/me", (req, res) => {
  const id = resolveDmIdentity(req);
  if(id.error) return jsonError(res, 400, id.error);
  const user = ensureDmUser(id.accountKey, id.email, id.name, id.lang);
  res.json({ ok:true, echoId: user.echoId, name: user.name, lang: user.lang });
});

// --- Contact toevoegen via diens Echo-ID ---
app.post("/api/dm/add-contact", (req, res) => {
  const id = resolveDmIdentity(req);
  if(id.error) return jsonError(res, 400, id.error);
  const me = ensureDmUser(id.accountKey, id.email, id.name, id.lang);
  const targetId = String(req.body && req.body.contactId ? req.body.contactId : "").trim().toUpperCase();
  if(!targetId) return jsonError(res, 400, "Voer een Echo-ID in.");
  if(targetId === me.echoId) return jsonError(res, 400, "Dat is je eigen ID.");
  const target = dmUsers.get(targetId);
  if(!target) return jsonError(res, 404, "Geen gebruiker met dit Echo-ID gevonden.");
  // wederzijds toevoegen
  if(!me.contacts.includes(targetId)) me.contacts.push(targetId);
  if(!target.contacts.includes(me.echoId)) target.contacts.push(me.echoId);
  saveDM();
  res.json({ ok:true, contact: dmPublicContact(targetId) });
});

// --- Contact verwijderen ---
app.post("/api/dm/remove-contact", (req, res) => {
  const id = resolveDmIdentity(req);
  if(id.error) return jsonError(res, 400, id.error);
  const me = ensureDmUser(id.accountKey, id.email, id.name, id.lang);
  const targetId = String(req.body && req.body.contactId ? req.body.contactId : "").trim().toUpperCase();
  me.contacts = me.contacts.filter((c) => c !== targetId);
  saveDM();
  res.json({ ok:true });
});

// --- Contactenlijst ophalen (met online-status en aantal ongelezen) ---
app.post("/api/dm/contacts", (req, res) => {
  const id = resolveDmIdentity(req);
  if(id.error) return jsonError(res, 400, id.error);
  const me = ensureDmUser(id.accountKey, id.email, id.name, id.lang);
  const contacts = me.contacts.map((cid) => {
    const pub = dmPublicContact(cid);
    const key = dmThreadKey(me.echoId, cid);
    const list = dmThreads.get(key) || [];
    const unread = list.filter((m) => m.to === me.echoId && !(m.readBy && m.readBy[me.echoId])).length;
    return Object.assign(pub, { unread });
  });
  res.json({ ok:true, echoId: me.echoId, name: me.name, lang: me.lang, contacts });
});

// --- Bericht sturen naar een contact ---
app.post("/api/dm/send", (req, res) => {
  const id = resolveDmIdentity(req);
  if(id.error) return jsonError(res, 400, id.error);
  const me = ensureDmUser(id.accountKey, id.email, id.name, id.lang);
  const toId = String(req.body && req.body.to ? req.body.to : "").trim().toUpperCase();
  const text = String(req.body && req.body.text ? req.body.text : "").trim().slice(0,2000);
  if(!toId || !text) return jsonError(res, 400, "Ontvanger of tekst ontbreekt.");
  const target = dmUsers.get(toId);
  if(!target) return jsonError(res, 404, "Contact niet gevonden.");
  if(!me.contacts.includes(toId)) return jsonError(res, 403, "Deze persoon staat niet in je contacten.");

  const key = dmThreadKey(me.echoId, toId);
  const list = dmThreads.get(key) || [];
  const msg = {
    id: "dm_" + Date.now() + "_" + Math.random().toString(36).slice(2,8),
    from: me.echoId, to: toId,
    srcLang: me.lang || "en",
    text, ts: Date.now(),
    readBy: {}, translations: {}
  };
  list.push(msg);
  dmThreads.set(key, list);
  saveDM();

  dmNotify(toId, {
    title: (me.name || me.echoId),
    body: text.slice(0, 120),
    dm: me.echoId,
    tag: "dm-" + me.echoId
  }).catch(()=>{});

  res.json({ ok:true, id: msg.id });
});

// --- Gesprek ophalen met een contact (vertaalt naar jouw taal, markeert als gelezen) ---
app.post("/api/dm/thread", async (req, res) => {
  const id = resolveDmIdentity(req);
  if(id.error) return jsonError(res, 400, id.error);
  const me = ensureDmUser(id.accountKey, id.email, id.name, id.lang);
  const otherId = String(req.body && req.body.with ? req.body.with : "").trim().toUpperCase();
  if(!otherId) return jsonError(res, 400, "Geen contact opgegeven.");
  const key = dmThreadKey(me.echoId, otherId);
  const list = dmThreads.get(key) || [];
  const myLang = me.lang || "en";

  const out = [];
  let needUpgrade = false; // zijn er berichten die vertaling nodig hebben maar gratis is?
  for(const m of list){
    let shown = m.text;
    let translated = false;
    let needsTranslation = (m.srcLang !== myLang);
    if(needsTranslation){
      if(id.unlimited){
        // Betaald: vertaal (gratis als al in cache)
        if(m.translations[myLang]){ shown = m.translations[myLang]; translated = true; }
        else{
          const t = await dmTranslate(m.text, m.srcLang, myLang);
          if(t && t !== m.text){ m.translations[myLang] = t; shown = t; translated = true; }
        }
      }else{
        // Gratis gebruiker + andere taal: toon origineel, markeer dat vertaling Unlimited vereist.
        // (Eerder gemaakte vertaling in cache tonen we niet gratis.)
        shown = m.text;
        translated = false;
        needUpgrade = true;
      }
    }
    // markeer berichten aan mij als gelezen
    if(m.to === me.echoId && !(m.readBy && m.readBy[me.echoId])){
      m.readBy = m.readBy || {};
      m.readBy[me.echoId] = Date.now();
    }
    out.push({
      id: m.id,
      mine: m.from === me.echoId,
      from: m.from,
      text: shown,
      original: m.text,
      translated,
      needsTranslation: needsTranslation && !translated, // andere taal maar (nog) niet vertaald
      ts: m.ts,
      read: !!(m.readBy && m.readBy[otherId]) // is door de ander gelezen?
    });
  }
  saveDM();
  res.json({ ok:true, echoId: me.echoId, withUser: dmPublicContact(otherId), messages: out, needUpgrade });
});

// --- Push-aanmelding voor directe berichten ---
app.post("/api/dm/push-subscribe", (req, res) => {
  const id = resolveDmIdentity(req);
  if(id.error) return jsonError(res, 400, id.error);
  const me = ensureDmUser(id.accountKey, id.email, id.name, id.lang);
  const subscription = req.body && req.body.subscription;
  if(!subscription || !subscription.endpoint) return jsonError(res, 400, "Ongeldige aanmelding");
  dmAddPush(me.echoId, subscription);
  res.json({ ok:true });
});

loadDM();


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
