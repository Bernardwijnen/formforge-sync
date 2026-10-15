/* ===========================================================
   Websitemodel 1 - verkoop en automatische installatie
   "Een website voor 1 euro per maand" (14,52 euro per jaar incl. 21% btw)

   Zo werkt het:
   1. De klant vult op formforge.nl zijn e-mail en domeinnaam in.
      POST /api/website/bestellen maakt een Stripe-betaling (jaarabonnement).
   2. Na betalen komt de klant terug op de pagina met ?sessie=...
      GET /api/website/status controleert bij Stripe of er echt betaald is.
   3. De klant vult de FTP-gegevens uit zijn WebReus-mail in.
      POST /api/website/installeren zet de bestanden via FTP op zijn hosting.
      Het FTP-wachtwoord wordt alleen voor deze ene upload gebruikt en
      NOOIT opgeslagen.
   4. De klant krijgt een instelcode. Alleen met die code kan hij op
      zijndomein.nl/admin.php zijn e-mail en wachtwoord instellen.

   Benodigd:
   - npm-pakket basic-ftp (in package.json)
   - Render Environment Variables:
       WEBSITE_PRICE_ID     het price_... van het jaarabonnement in Stripe (verplicht)
       WEBSITE_TAX_RATE_ID  alleen nodig als de prijs in Stripe excl. btw is (nu niet)
       WEBSITE_PAGE_URL     adres van de bestelpagina (optioneel, standaard hieronder)
   - De modelbestanden in de map websitemodel1 naast server.js:
       websitemodel1/admin.php.txt
       websitemodel1/contact.php.txt
       websitemodel1/index.html.txt
   =========================================================== */

module.exports = function({ app, fs, path, crypto, DATA_DIR, safeWriteFileSync, callStripe, callStripeGet, sendResendEmail, FROM_EMAIL }){
  const PRICE_ID = String(process.env.WEBSITE_PRICE_ID || "").trim();
  const TAX_RATE_ID = String(process.env.WEBSITE_TAX_RATE_ID || "").trim();
  const PAGE_URL = String(process.env.WEBSITE_PAGE_URL || "https://formforge.nl/eigen-website/").trim();
  const NOTIFY_EMAIL = String(process.env.WEBSITE_NOTIFY_EMAIL || FROM_EMAIL || "info@formforge.nl").trim();
  const STORE_FILE = path.join(DATA_DIR, "websitemodel_bestellingen.json");
  const MODEL_DIR = path.join(__dirname, "websitemodel1");
  const MODEL_FILES = ["admin.php", "contact.php", "index.html"];
  const MAX_POGINGEN = 8;

  let ftp = null;
  try{ ftp = require("basic-ftp"); }
  catch(e){ console.error("Websitemodel: pakket basic-ftp ontbreekt. Zet \"basic-ftp\" in package.json."); }

  /* ---------- opslag ---------- */
  let orders = {};
  try{
    if(fs.existsSync(STORE_FILE)) orders = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) || {};
  }catch(e){
    console.error("Websitemodel: bestellingen lezen mislukt:", (e && e.message) || e);
    try{ fs.copyFileSync(STORE_FILE, STORE_FILE + ".corrupt-" + Date.now()); }catch(e2){}
    orders = {};
  }
  function save(){
    try{ safeWriteFileSync(STORE_FILE, JSON.stringify(orders, null, 2)); }
    catch(e){ console.error("Websitemodel: bestellingen opslaan mislukt:", (e && e.message) || e); }
  }

  /* ---------- hulpfuncties ---------- */
  function cleanDomain(d){
    let s = String(d || "").trim().toLowerCase();
    s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) && s.length <= 100 ? s : "";
  }
  function cleanEmail(e){
    const s = String(e || "").trim().toLowerCase().slice(0, 160);
    return /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(s) ? s : "";
  }
  function cleanSession(s){
    const v = String(s || "").trim();
    return /^cs_[A-Za-z0-9_]{10,250}$/.test(v) ? v : "";
  }
  function cleanHost(h){
    const s = String(h || "").trim().toLowerCase();
    return /^[a-z0-9.-]{3,120}$/.test(s) && s.indexOf(".") > 0 ? s : "";
  }
  function cleanDir(d){
    let s = String(d || "/web").trim();
    if(!s.startsWith("/")) s = "/" + s;
    return /^\/[A-Za-z0-9._\/-]{0,80}$/.test(s) && s.indexOf("..") === -1 ? s.replace(/\/+$/, "") || "/" : "";
  }
  function esc(s){
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function maakCode(){
    // 10 tekens, zonder letters die op elkaar lijken
    const tekens = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    const bytes = crypto.randomBytes(10);
    for(let i = 0; i < 10; i++) code += tekens[bytes[i] % tekens.length];
    return code.slice(0, 5) + "-" + code.slice(5);
  }

  /* Haalt de betaling op bij Stripe en zet de bestelling bij als er betaald is */
  async function checkPaid(sessie){
    let rec = orders[sessie];
    if(rec && rec.paid) return rec;
    const s = await callStripeGet("/checkout/sessions/" + encodeURIComponent(sessie));
    const meta = s.metadata || {};
    if(meta.kind !== "website_model1") return null;
    const betaald = s.payment_status === "paid" || s.payment_status === "no_payment_required";
    if(!rec){
      rec = {
        sessie, email: cleanEmail(meta.email || s.customer_email || (s.customer_details && s.customer_details.email)),
        domein: cleanDomain(meta.domein), aangemaakt: new Date().toISOString(),
        status: "nieuw", pogingen: 0
      };
      orders[sessie] = rec;
    }
    rec.customerId = typeof s.customer === "string" ? s.customer : (rec.customerId || "");
    rec.subscriptionId = typeof s.subscription === "string" ? s.subscription : (rec.subscriptionId || "");
    if(betaald && !rec.paid){ rec.paid = true; rec.betaaldOp = new Date().toISOString(); rec.status = "betaald"; }
    save();
    return rec;
  }

  /* ---------- 1. bestellen: Stripe-betaling aanmaken ---------- */
  app.post("/api/website/bestellen", async (req, res) => {
    const b = req.body || {};
    const email = cleanEmail(b.email);
    const domein = cleanDomain(b.domein);
    if(!email) return res.status(400).json({ error: "Vul een geldig e-mailadres in." });
    if(!domein) return res.status(400).json({ error: "Vul een geldige domeinnaam in, bijvoorbeeld mijnbedrijf.nl" });
    if(b.akkoord !== true && b.akkoord !== "1") return res.status(400).json({ error: "Ga akkoord met de voorwaarden." });
    if(!PRICE_ID) return res.status(503).json({ error: "Bestellen is nog niet ingesteld (WEBSITE_PRICE_ID ontbreekt)." });
    try{
      const sep = PAGE_URL.includes("?") ? "&" : "?";
      const lineItem = { price: PRICE_ID, quantity: 1 };
      if(TAX_RATE_ID) lineItem.tax_rates = [TAX_RATE_ID];
      const payload = {
        mode:
