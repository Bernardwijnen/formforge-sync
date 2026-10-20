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
  const SERVER_URL = String(process.env.WEBSITE_SERVER_URL || "https://formforge-sync-1.onrender.com").trim();
  const RESPIJT_DAGEN = Number(process.env.WEBSITE_RESPIJT_DAGEN || 14);
  const STRIPE_CHECK_UUR = 6;

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
        mode: "subscription",
        line_items: [lineItem],
        allow_promotion_codes: true,
        customer_email: email,
        success_url: PAGE_URL + sep + "sessie={CHECKOUT_SESSION_ID}",
        cancel_url: PAGE_URL + sep + "geannuleerd=1",
        billing_address_collection: "auto",
        client_reference_id: "website-" + domein,
        metadata: { kind: "website_model1", email: email, domein: domein },
        subscription_data: { metadata: { kind: "website_model1", email: email, domein: domein } }
      };
      const session = await callStripe("/checkout/sessions", payload);
      orders[session.id] = { sessie: session.id, email, domein, aangemaakt: new Date().toISOString(), status: "wacht op betaling", pogingen: 0 };
      save();
      res.json({ url: session.url });
    }catch(e){
      console.error("Websitemodel: betaling aanmaken mislukt:", (e && e.message) || e);
      res.status(500).json({ error: "Betalen starten is niet gelukt. Probeer het later opnieuw." });
    }
  });

  /* ---------- 2. status: is er betaald? ---------- */
  app.get("/api/website/status", async (req, res) => {
    const sessie = cleanSession(req.query.sessie);
    if(!sessie) return res.status(400).json({ error: "Onbekende bestelling." });
    try{
      const rec = await checkPaid(sessie);
      if(!rec) return res.status(404).json({ error: "Onbekende bestelling." });
      res.json({ betaald: !!rec.paid, geinstalleerd: rec.status === "geinstalleerd", domein: rec.domein, email: rec.email });
    }catch(e){
      console.error("Websitemodel: status ophalen mislukt:", (e && e.message) || e);
      res.status(500).json({ error: "Kon de betaling niet controleren. Probeer het zo opnieuw." });
    }
  });

  /* ---------- 3. installeren via FTP ---------- */
  const bezig = new Set();
  app.post("/api/website/installeren", async (req, res) => {
    const b = req.body || {};
    const sessie = cleanSession(b.sessie);
    const host = cleanHost(b.host);
    const user = String(b.user || "").trim().slice(0, 120);
    const pass = String(b.pass || "");
    const map = cleanDir(b.map);
    if(!sessie) return res.status(400).json({ error: "Onbekende bestelling." });
    if(!host) return res.status(400).json({ error: "Vul de FTP-server in, bijvoorbeeld ftp.mijnbedrijf.nl" });
    if(!user || !pass) return res.status(400).json({ error: "Vul de FTP-login en het wachtwoord in." });
    if(!map) return res.status(400).json({ error: "De map klopt niet. Meestal is het /web" });
    if(!ftp) return res.status(503).json({ error: "Installeren is nog niet ingesteld op de server." });
    if(bezig.has(sessie)) return res.status(429).json({ error: "De installatie loopt al. Even geduld." });

    let rec;
    try{ rec = await checkPaid(sessie); }
    catch(e){ return res.status(500).json({ error: "Kon de betaling niet controleren. Probeer het zo opnieuw." }); }
    if(!rec) return res.status(404).json({ error: "Onbekende bestelling." });
    if(!rec.paid) return res.status(402).json({ error: "Deze bestelling is nog niet betaald." });
    if(rec.status === "geinstalleerd") return res.status(409).json({ error: "Deze website is al geinstalleerd. Neem contact met ons op als er iets niet klopt." });
    if((rec.pogingen || 0) >= MAX_POGINGEN) return res.status(429).json({ error: "Te veel pogingen. Neem contact met ons op via info@formforge.nl" });

    // Modelbestanden laden (.txt in de repo, op de hosting zonder .txt)
    const bestanden = [];
    try{
      for(const naam of MODEL_FILES){
        bestanden.push({ naam, data: fs.readFileSync(path.join(MODEL_DIR, naam + ".txt")) });
      }
    }catch(e){
      console.error("Websitemodel: modelbestanden ontbreken in websitemodel1/:", (e && e.message) || e);
      return res.status(500).json({ error: "De installatiebestanden ontbreken op de server. Wij lossen dit op; probeer het later opnieuw." });
    }

    rec.pogingen = (rec.pogingen || 0) + 1;
    rec.ftpHost = host; rec.ftpUser = user; rec.map = map; // wachtwoord wordt bewust niet bewaard
    save();
    bezig.add(sessie);

    const { Readable } = require("stream");
    const client = new ftp.Client(30000);
    let stap = "verbinden";
    try{
      // Eerst versleuteld proberen (FTPS). Lukt dat niet, dan gewone FTP.
      let versleuteld = true;
      try{
        await client.access({ host, user, password: pass, port: 21, secure: true });
      }catch(e1){
        // 530 = inloggen geweigerd: dan heeft het geen zin om zonder versleuteling te proberen.
        const code1 = Number(e1 && e1.code);
        if(code1 === 530) throw e1;
        client.close();
        versleuteld = false;
        await client.access({ host, user, password: pass, port: 21, secure: false });
      }
      rec.versleuteld = versleuteld;

      stap = "map openen";
      await client.cd(map);
      const lijst = await client.list();
      const namen = lijst.map(f => f.name);
      if(namen.includes("admin.php") && !b.overschrijven){
        bezig.delete(sessie); client.close(); rec.pogingen--; save();
        return res.status(409).json({ error: "Er staat al een website met een admin.php in deze map. Vink 'overschrijven' aan als je zeker weet dat die weg mag.", vraagOverschrijven: true });
      }

      stap = "bestanden plaatsen";
      for(const f of bestanden){
        await client.uploadFrom(Readable.from([f.data]), f.naam);
      }

      // Instelcode: alleen wie deze code heeft kan de admin de eerste keer instellen.
      stap = "instelcode plaatsen";
      const code = maakCode();
      const hash = crypto.createHash("sha256").update(code.replace(/-/g, "")).digest("hex");
      await client.ensureDir("data");
      await client.uploadFrom(Readable.from([Buffer.from("Require all denied\n")]), ".htaccess");
      await client.uploadFrom(Readable.from([Buffer.from(JSON.stringify({ hash, aangemaakt: new Date().toISOString() }))]), "setup-code.json");
      // Licentiesleutel: hiermee vraagt de site later of het abonnement nog loopt.
      const licentie = rec.licentie || crypto.randomBytes(24).toString("hex");
      rec.licentie = licentie;
      await client.uploadFrom(Readable.from([Buffer.from(JSON.stringify({ key: licentie, server: SERVER_URL }))]), "licentie.json");
      client.close();

      rec.status = "geinstalleerd";
      rec.geinstalleerdOp = new Date().toISOString();
      save();
      bezig.delete(sessie);

      const adminUrl = "https://" + rec.domein + "/admin.php";
      try{
        await sendResendEmail({
          to: rec.email,
          subject: "Je website staat klaar: " + rec.domein,
          text: "Je website is geinstalleerd op " + rec.domein + ".\r\n\r\nGa naar " + adminUrl + " en stel je e-mailadres en wachtwoord in.\r\nJe instelcode is: " + code + "\r\n\r\nLater inloggen? Klik helemaal onderaan je website op \"Inloggen\", of ga naar " + adminUrl + " en log in met je e-mailadres en wachtwoord.\r\n\r\nWerkt de link nog niet? Een nieuwe domeinnaam kan tot ongeveer een werkdag nodig hebben voordat hij actief is.\r\n\r\nVeiligheid: verander na de installatie je FTP-wachtwoord in het WebReus-portaal.\r\n\r\nNiet tevreden? Binnen 14 dagen na je betaling krijg je je geld terug. Ga naar https://formforge.nl/herroepen/\r\n\r\nFormForge",
          html: "<p>Je website is geinstalleerd op <strong>" + esc(rec.domein) + "</strong>.</p><p>Ga naar <a href=\"" + esc(adminUrl) + "\">" + esc(adminUrl) + "</a> en stel je e-mailadres en wachtwoord in.</p><p>Je instelcode is: <strong style=\"font-size:20px;letter-spacing:2px\">" + esc(code) + "</strong></p><p>Later inloggen? Klik helemaal onderaan je website op <strong>Inloggen</strong>, of ga naar " + esc(adminUrl) + " en log in met je e-mailadres en wachtwoord.</p><p>Werkt de link nog niet? Een nieuwe domeinnaam kan tot ongeveer een werkdag nodig hebben voordat hij actief is.</p><p>Veiligheid: verander na de installatie je FTP-wachtwoord in het WebReus-portaal.</p><p>Niet tevreden? Binnen 14 dagen na je betaling krijg je je geld terug. Ga naar <a href=\"https://formforge.nl/herroepen/\">formforge.nl/herroepen</a>.</p><p>FormForge</p>"
        });
      }catch(e){ console.error("Websitemodel: mail naar klant mislukt:", (e && e.message) || e); }
      try{
        await sendResendEmail({
          to: NOTIFY_EMAIL,
          subject: "Nieuwe website geinstalleerd: " + rec.domein,
          text: "Domein: " + rec.domein + "\r\nKlant: " + rec.email + "\r\nFTP: " + host + " (" + (versleuteld ? "versleuteld" : "onversleuteld") + ")\r\nStripe-sessie: " + sessie + "\r\n"
        });
      }catch(e){ console.error("Websitemodel: melding naar FormForge mislukt:", (e && e.message) || e); }

      res.json({ ok: true, domein: rec.domein, adminUrl, code, versleuteld });
    }catch(e){
      try{ client.close(); }catch(e2){}
      bezig.delete(sessie);
      const m = String((e && e.message) || e);
      console.error("Websitemodel: installatie mislukt bij '" + stap + "' voor " + rec.domein + ":", m);
      let uitleg = "Er ging iets mis bij " + stap + ". Controleer de gegevens en probeer het opnieuw.";
      if(stap === "verbinden"){
        if(Number(e && e.code) === 530 || /^530\b/.test(m)) uitleg = "Inloggen lukt niet: controleer de FTP-login en het wachtwoord uit je WebReus-mail.";
        else if(/ENOTFOUND|getaddrinfo/i.test(m)) uitleg = "De FTP-server is niet gevonden. Controleer de naam, of gebruik het FTP-IP uit je WebReus-mail.";
        else if(/timeout|ETIMEDOUT|ECONNREFUSED/i.test(m)) uitleg = "De FTP-server reageert niet. Probeer het FTP-IP uit je WebReus-mail.";
      }else if(stap === "map openen"){
        uitleg = "De map " + map + " bestaat niet. In de WebReus-mail staat bij Map/Directory welke map het is (meestal /web).";
      }
      rec.laatsteFout = stap + ": " + m.slice(0, 200);
      save();
      res.status(400).json({ error: uitleg, pogingenOver: Math.max(0, MAX_POGINGEN - rec.pogingen) });
    }
  });


  /* ===========================================================
     Licentie: loopt het abonnement nog?
     De site vraagt dit hooguit een paar keer per dag. Wij kijken bij
     Stripe naar de status van het abonnement. Is het niet meer actief
     (niet betaald of opgezegd), dan krijgt de klant RESPIJT_DAGEN dagen.
     Daarna antwoorden we actief:false en gaat de site offline.
     =========================================================== */
  function cleanKey(k){
    const v = String(k || "").trim();
    return /^[a-f0-9]{48}$/.test(v) ? v : "";
  }
  function findByKey(key){
    for(const id of Object.keys(orders)){
      if(orders[id] && orders[id].licentie === key) return orders[id];
    }
    return null;
  }
  const GOED = ["active", "trialing"];
  async function vernieuwStatus(rec, forceer){
    const nu = Date.now();
    const laatst = rec.stripeCheck ? Date.parse(rec.stripeCheck) : 0;
    if(!forceer && laatst && nu - laatst < STRIPE_CHECK_UUR * 3600 * 1000) return;
    if(forceer && laatst && nu - laatst < 60 * 1000) return; // hooguit 1x per minuut
    if(!rec.subscriptionId){ rec.stripeCheck = new Date().toISOString(); return; }
    try{
      const sub = await callStripeGet("/subscriptions/" + encodeURIComponent(rec.subscriptionId));
      rec.stripeStatus = String(sub.status || "");
      if(GOED.includes(rec.stripeStatus)){ rec.probleemSinds = ""; }
      else if(!rec.probleemSinds){ rec.probleemSinds = new Date().toISOString(); }
      rec.stripeCheck = new Date().toISOString();
      save();
      await opzegMeldingen(rec, sub);
    }catch(e){
      // Stripe niet bereikbaar: niets veranderen, de vorige status blijft gelden.
      console.error("Websitemodel: Stripe-status ophalen mislukt:", (e && e.message) || e);
    }
  }
  /* Opzeggen: een mail aan de klant (bevestiging) en aan FormForge.
     We zien het bij de gewone statuscontrole, dus hooguit een paar uur later.
     - Opgezegd per einde termijn: site werkt tot de einddatum, daarna respijt.
     - Direct beeindigd: het respijt loopt al.
     - Opzegging teruggedraaid: alleen een melding aan FormForge.
     Een mislukte betaling is geen opzegging; daarvoor gaat er hier niets uit. */
  function nlDatum(d){
    const maanden = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];
    const x = new Date(d.getTime() + 2 * 3600 * 1000); // ongeveer Nederlandse tijd, alleen voor de datum
    return x.getUTCDate() + " " + maanden[x.getUTCMonth()] + " " + x.getUTCFullYear();
  }
  function periodeEinde(sub){
    const item = sub && sub.items && Array.isArray(sub.items.data) && sub.items.data[0];
    const s = Number(sub.cancel_at || sub.current_period_end || (item && item.current_period_end) || 0);
    return s > 0 ? new Date(s * 1000) : null;
  }
  async function stuurOpzegMails(rec, onderwerpKlant, tekstKlant, onderwerpFF, tekstFF){
    if(rec.email){
      try{
        await sendResendEmail({
          to: rec.email, subject: onderwerpKlant,
          text: tekstKlant.join("\r\n\r\n") + "\r\n\r\nFormForge",
          html: tekstKlant.map(p => "<p>" + esc(p) + "</p>").join("") + "<p>FormForge</p>"
        });
      }catch(e){ console.error("Websitemodel: opzegmail naar klant mislukt:", (e && e.message) || e); }
    }
    try{
      await sendResendEmail({ to: NOTIFY_EMAIL, subject: onderwerpFF, text: tekstFF.join("\r\n") + "\r\n" });
    }catch(e){ console.error("Websitemodel: opzegmelding naar FormForge mislukt:", (e && e.message) || e); }
  }
  async function opzegMeldingen(rec, sub){
    const perEinde = !!(sub.cancel_at_period_end || sub.cancel_at) && GOED.includes(rec.stripeStatus);
    const beeindigd = rec.stripeStatus === "canceled";
    const basisFF = ["Domein: " + rec.domein, "Klant: " + (rec.email || "onbekend"), "Abonnement: " + (rec.subscriptionId || "")];

    if(perEinde && !rec.opzegGemeld){
      const einde = periodeEinde(sub);
      const eindTekst = einde ? nlDatum(einde) : "het einde van je betaalde periode";
      const offTekst = einde ? nlDatum(new Date(einde.getTime() + RESPIJT_DAGEN * 86400 * 1000)) : "";
      rec.opzegGemeld = new Date().toISOString(); rec.opzegEinde = einde ? einde.toISOString() : "";
      save();
      await stuurOpzegMails(rec,
        "Je opzegging is ontvangen: " + rec.domein,
        [
          "We hebben je opzegging voor de website " + rec.domein + " ontvangen.",
          "Je website blijft gewoon werken tot " + eindTekst + ". Je wordt daarna niet meer afgeschreven.",
          "Na die datum heb je nog " + RESPIJT_DAGEN + " dagen" + (offTekst ? " (tot " + offTekst + ")" : "") + ". Daarna gaat je website offline en kun je niet meer inloggen op je beheerpagina.",
          "Je domeinnaam en hosting bij WebReus zijn van jou en lopen gewoon door. Wil je die ook stoppen, regel dat dan zelf bij WebReus.",
          "Toch van gedachten veranderd? Via deze link zet je je abonnement weer aan, dan verandert er niets: " + (rec.licentie ? SERVER_URL + "/api/website/betalen?key=" + rec.licentie : "antwoord op deze mail.")
        ],
        "Website opgezegd (per einde termijn): " + rec.domein,
        basisFF.concat(["Werkt tot: " + eindTekst, "Offline op: " + (offTekst || "onbekend")])
      );
      return;
    }

    if(!perEinde && GOED.includes(rec.stripeStatus) && rec.opzegGemeld){
      // De klant heeft de opzegging teruggedraaid
      rec.opzegGemeld = ""; rec.opzegEinde = "";
      save();
      try{
        await sendResendEmail({ to: NOTIFY_EMAIL, subject: "Opzegging ingetrokken: " + rec.domein, text: basisFF.join("\r\n") + "\r\nHet abonnement loopt weer gewoon door.\r\n" });
      }catch(e){ console.error("Websitemodel: melding ingetrokken opzegging mislukt:", (e && e.message) || e); }
      return;
    }

    if(beeindigd && !rec.beeindigdGemeld){
      rec.beeindigdGemeld = new Date().toISOString();
      const alGemeld = !!rec.opzegGemeld;
      save();
      const start = rec.probleemSinds ? Date.parse(rec.probleemSinds) : Date.now();
      const offTekst = nlDatum(new Date(start + RESPIJT_DAGEN * 86400 * 1000));
      if(alGemeld){
        // Klant kreeg de bevestiging al; alleen FormForge laten weten dat het nu echt gestopt is
        try{
          await sendResendEmail({ to: NOTIFY_EMAIL, subject: "Abonnement gestopt: " + rec.domein, text: basisFF.join("\r\n") + "\r\nOffline op: " + offTekst + "\r\n" });
        }catch(e){ console.error("Websitemodel: melding gestopt mislukt:", (e && e.message) || e); }
        return;
      }
      await stuurOpzegMails(rec,
        "Je abonnement is beeindigd: " + rec.domein,
        [
          "Het abonnement voor je website " + rec.domein + " is beeindigd.",
          "Je website blijft nog online tot " + offTekst + ". Daarna gaat hij offline en kun je niet meer inloggen op je beheerpagina.",
          "Je domeinnaam en hosting bij WebReus zijn van jou en lopen gewoon door. Wil je die ook stoppen, regel dat dan zelf bij WebReus.",
          "Is dit een vergissing? Antwoord op deze mail of mail naar " + NOTIFY_EMAIL + ", dan zetten we het samen weer aan."
        ],
        "Website beeindigd (direct): " + rec.domein,
        basisFF.concat(["Offline op: " + offTekst])
      );
    }
  }
  function licentieAntwoord(rec){
    if(rec.handmatig === "uit") return { actief: false, reden: "handmatig" };
    if(rec.handmatig === "aan" || !rec.probleemSinds) return { actief: true };
    const offlineOp = new Date(Date.parse(rec.probleemSinds) + RESPIJT_DAGEN * 86400 * 1000);
    if(Date.now() < offlineOp.getTime()){
      return { actief: true, waarschuwing: true, offlineOp: offlineOp.toISOString() };
    }
    return { actief: false, reden: "betaling", sinds: offlineOp.toISOString() };
  }

  app.get("/api/website/licentie", async (req, res) => {
    const key = cleanKey(req.query.key);
    if(!key) return res.status(400).json({ error: "Onbekende sleutel." });
    const rec = findByKey(key);
    if(!rec) return res.status(404).json({ error: "Onbekende sleutel." });
    await vernieuwStatus(rec, String(req.query.vers || "") === "1");
    rec.laatstGezien = new Date().toISOString();
    res.json(licentieAntwoord(rec));
  });

  /* Klant wil betalen of zijn betaalgegevens aanpassen: Stripe-klantportaal */
  app.get("/api/website/betalen", async (req, res) => {
    const key = cleanKey(req.query.key);
    const rec = key ? findByKey(key) : null;
    const terug = rec ? "https://" + rec.domein + "/admin.php" : "https://formforge.nl/eigen-website/";
    if(!rec || !rec.customerId){
      return res.redirect(303, "https://formforge.nl/eigen-website/stappenplan/#problemen");
    }
    try{
      const portal = await callStripe("/billing_portal/sessions", { customer: rec.customerId, return_url: terug });
      return res.redirect(303, portal.url);
    }catch(e){
      console.error("Websitemodel: klantportaal openen mislukt:", (e && e.message) || e);
      res.status(200).type("html").send('<!DOCTYPE html><html lang="nl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Betaling regelen</title><body style="font-family:Arial,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;line-height:1.6"><h1>Betaling regelen</h1><p>Dit lukt nu niet automatisch. Mail ons via <a href="mailto:' + esc(NOTIFY_EMAIL) + '">' + esc(NOTIFY_EMAIL) + '</a> met je domeinnaam (' + esc(rec.domein) + '), dan regelen we het samen.</p><p><a href="' + esc(terug) + '">Terug naar je beheerpagina</a></p></body></html>');
    }
  });

  /* ===========================================================
     Wachtwoord vergeten: de site vraagt ons de mail te sturen,
     zodat die betrouwbaar aankomt (via Resend, vanaf info@formforge.nl).
     =========================================================== */
  const resetTeller = new Map();
  app.post("/api/website/reset-mail", async (req, res) => {
    const b = req.body || {};
    const key = cleanKey(b.key);
    const rec = key ? findByKey(key) : null;
    if(!rec) return res.status(404).json({ error: "Onbekende sleutel." });
    const naar = cleanEmail(b.email);
    const link = String(b.link || "");
    const verwacht = new RegExp("^https?://(www\\.)?" + rec.domein.replace(/[.]/g, "\\.") + "/admin\\.php\\?reset=[A-Za-z0-9]{20,80}$");
    if(!naar || !verwacht.test(link)) return res.status(400).json({ error: "Ongeldige aanvraag." });
    const nu = Date.now();
    const lijst = (resetTeller.get(key) || []).filter(t => nu - t < 3600 * 1000);
    if(lijst.length >= 5) return res.status(429).json({ error: "Te vaak geprobeerd. Probeer het over een uur opnieuw." });
    lijst.push(nu); resetTeller.set(key, lijst);
    try{
      await sendResendEmail({
        to: naar,
        subject: "Nieuw wachtwoord voor je website " + rec.domein,
        text: "Je hebt gevraagd om een nieuw wachtwoord voor de beheerpagina van " + rec.domein + ".\r\n\r\nKlik op deze link om een nieuw wachtwoord te kiezen:\r\n" + link + "\r\n\r\nDe link werkt 1 uur. Heb je dit niet zelf gevraagd? Dan kun je deze mail negeren; er verandert niets.\r\n\r\nFormForge",
        html: "<p>Je hebt gevraagd om een nieuw wachtwoord voor de beheerpagina van <strong>" + esc(rec.domein) + "</strong>.</p><p><a href=\"" + esc(link) + "\" style=\"display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold\">Nieuw wachtwoord kiezen</a></p><p>De link werkt 1 uur. Heb je dit niet zelf gevraagd? Dan kun je deze mail negeren; er verandert niets.</p><p>FormForge</p>"
      });
      res.json({ ok: true });
    }catch(e){
      console.error("Websitemodel: resetmail mislukt:", (e && e.message) || e);
      res.status(500).json({ error: "Mail versturen mislukt." });
    }
  });

  /* ===========================================================
     Aanvraag "wij regelen het voor je" en pakketten met service.
     De klant vult zijn gegevens in; FormForge vraagt daarmee op
     naam van de klant het pakket en de domeinnaam aan bij WebReus.
     De klant betaalt WebReus zelf.
     - Titanium: direct een mail aan FormForge (Zelf doen met hulp betaalt nu ook via Stripe)
       en een bevestiging aan de klant.
     - Basis, Premium en Unlimited: eerst betalen via Stripe (maand-
       abonnement). Pas na betaling gaan de mails eruit. De betaling
       staat ook als bestelling in de lijst, zodat FormForge de website
       daarna via de gewone bestelpagina kan installeren
       (formforge.nl/eigen-website/?sessie=...) en de licentie aan het
       maandabonnement hangt.
     Render Environment Variables (optioneel, de standaard staat hieronder):
       WEBSITE_PRICE_BASIS, WEBSITE_PRICE_PREMIUM, WEBSITE_PRICE_UNLIMITED
     =========================================================== */
  const AANVRAAG_FILE = path.join(DATA_DIR, "websitemodel_aanvragen.json");
  const PAKKETTEN = {
    zelf: "Zelf doen, met aanvraag en installatie door FormForge (49 euro eenmalig excl. btw = 59,29 incl. btw, plus de website voor 12 euro per jaar excl. btw = 14,52 incl. btw)",
    basis: "Basis (12,03 euro per maand incl. btw, 1 aanpassing per maand)",
    premium: "Premium (36,23 euro per maand incl. btw, 5 aanpassingen per maand)",
    unlimited: "Unlimited (95,59 euro per maand incl. btw, 12 maanden, website door ons ingevuld)",
    titanium: "Titanium (op maat, op aanvraag)"
  };
  const PAKKET_PRIJS = {
    basis: String(process.env.WEBSITE_PRICE_BASIS || "price_1URSOz5s8MDSsy0e08jsS1BR").trim(),
    premium: String(process.env.WEBSITE_PRICE_PREMIUM || "price_1URSRP5s8MDSsy0eZ0OAqBee").trim(),
    unlimited: String(process.env.WEBSITE_PRICE_UNLIMITED || "price_1URSTc5s8MDSsy0eODnAzDW4").trim(),
    /* Zelf doen met regelen en installeren: eenmalig 59,29 incl. btw, plus het jaarabonnement (WEBSITE_PRICE_ID) */
    zelf: String(process.env.WEBSITE_PRICE_INSTALL || "price_1USIyS5s8MDSsy0eNGmnZX9R").trim()
  };
  /* De regels voor de Stripe-betaling van een pakket */
  function pakketRegels(pakket){
    if(pakket === "zelf"){
      if(!PRICE_ID) return null;
      const jaar = { price: PRICE_ID, quantity: 1 };
      if(TAX_RATE_ID) jaar.tax_rates = [TAX_RATE_ID];
      return [jaar, { price: PAKKET_PRIJS.zelf, quantity: 1 }];
    }
    return [{ price: PAKKET_PRIJS[pakket], quantity: 1 }];
  }
  let aanvragen = [];
  try{ if(fs.existsSync(AANVRAAG_FILE)) aanvragen = JSON.parse(fs.readFileSync(AANVRAAG_FILE, "utf8")) || []; }
  catch(e){ console.error("Websitemodel: aanvragen lezen mislukt:", (e && e.message) || e); aanvragen = []; }
  function bewaarAanvragen(){
    try{ safeWriteFileSync(AANVRAAG_FILE, JSON.stringify(aanvragen, null, 2)); }
    catch(e){ console.error("Websitemodel: aanvragen opslaan mislukt:", (e && e.message) || e); }
  }
  const aanvraagTeller = new Map();
  function veld(v, max){ return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max || 120); }
  function tekstveld(v, max){ return String(v == null ? "" : v).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim().slice(0, max || 3000); }
  function naamVan(a){ return [a.aanhef, a.voorletters, a.tussenvoegsel, a.achternaam].filter(Boolean).join(" "); }

  /* Mail naar FormForge waarbij "Beantwoorden" direct naar de klant gaat.
     Gebruikt dezelfde Resend-sleutel als de server; lukt dat niet, dan de gewone mail. */
  async function mailMetAntwoord({ to, subject, text, replyTo }){
    const key = String(process.env.RESEND_API_KEY || "").trim();
    if(key && FROM_EMAIL && replyTo){
      try{
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, text, reply_to: replyTo })
        });
        if(r.ok) return;
        console.error("Websitemodel: mail met antwoordadres mislukt, status " + r.status);
      }catch(e){ console.error("Websitemodel: mail met antwoordadres mislukt:", (e && e.message) || e); }
    }
    await sendResendEmail({ to, subject, text });
  }

  /* De mails van een aanvraag: naar FormForge en een bevestiging aan de klant */
  async function stuurAanvraagMails(a){
    const titanium = a.pakket === "titanium";
    const betaald = !!a.sessie;
    const naam = naamVan(a);
    const regels = [
      "Nieuwe aanvraag " + a.id,
      "Pakket: " + PAKKETTEN[a.pakket],
      betaald ? "BETAALD via Stripe (" + (a.pakket === "zelf" ? "eenmalig regelen en installeren plus jaarabonnement" : "maandabonnement") + "). Stripe-sessie: " + a.sessie : "",
      "",
      titanium ? "CONTACTGEGEVENS" : "GEGEVENS VOOR WEBREUS (kies daar altijd Nieuwe Klant)",
      "Bedrijf: " + (a.bedrijf || "-"),
      "Aanhef: " + (a.aanhef || "-"),
      "Voorletters: " + (a.voorletters || "-"),
      "Tussenvoegsel: " + (a.tussenvoegsel || "-"),
      "Achternaam: " + a.achternaam,
      "Postcode: " + (a.postcode || "-"),
      "Huisnummer: " + (a.huisnummer || "-"),
      "Toevoeging: " + (a.toevoeging || "-"),
      "Straat: " + (a.straat || "-"),
      "Plaats: " + (a.plaats || "-"),
      "Land: " + a.land,
      "Telefoon: " + a.telefoon,
      "E-mail: " + a.email,
      "",
      "DOMEINNAAM",
      "Gewenst: " + (a.domein || "-"),
      "Alternatief 1: " + (a.domein2 || "-"),
      "Alternatief 2: " + (a.domein3 || "-"),
      "Heeft de domeinnaam al ergens anders: " + (a.heeftDomein ? "ja, verhuiscode opvragen" : "nee"),
      "",
      (titanium ? "WENSEN" : "OPMERKINGEN"),
      a.wensen || "-",
      "",
      titanium ? "Akkoord: mag contact opnemen." : "Akkoord: opdracht en machtiging (art. 23) om namens de klant bij WebReus aan te vragen, in te loggen op de hosting en de website te plaatsen en aan te passen; voorwaarden WebReus en FormForge; prijs van het pakket; direct starten.",
      betaald ? "Website installeren zodra de klant de WebReus-mail heeft doorgestuurd: " + PAGE_URL + (PAGE_URL.includes("?") ? "&" : "?") + "sessie=" + a.sessie : "",
      "Verstuurd vanaf IP: " + a.ip
    ];
    let tekstFF = regels.filter((r, i) => !(r === "" && i === 2));
    if(titanium){
      tekstFF = tekstFF.filter(r => !/^(Postcode|Huisnummer|Toevoeging|Straat|Plaats|Land|Voorletters|Tussenvoegsel|Aanhef|Bedrijf|Gewenst|Alternatief 1|Alternatief 2|Heeft de domeinnaam al ergens anders): (-|nee|Nederland)$/.test(r) && r !== "DOMEINNAAM");
    }
    tekstFF = tekstFF.filter((r, i, arr) => !(r === "" && arr[i - 1] === ""));
    const onderwerp = titanium ? "Titanium-aanvraag: " : (betaald ? "BETAALD - aanvraag website (" + a.pakket + "): " : "Aanvraag website (" + a.pakket + "): ");
    await mailMetAntwoord({ to: NOTIFY_EMAIL, replyTo: a.email, subject: onderwerp + (a.bedrijf || naam) + " " + a.id, text: tekstFF.join("\r\n") + "\r\n" });

    let klantTekst;
    if(titanium){
      klantTekst = ["Beste " + naam + ",", "", "Bedankt voor je aanvraag voor Titanium. We nemen binnen 1 werkdag contact met je op voor een kennismaking. Daarna krijg je van ons een offerte op maat.", "", "Je aanvraagnummer is " + a.id + ".", "", "Met vriendelijke groet,", "FormForge"];
    }else{
      klantTekst = [
        "Beste " + naam + ",", "",
        (betaald ? "Bedankt voor je aanvraag en je betaling. Je pakket: " : "Bedankt voor je aanvraag. Je hebt gekozen voor: ") + PAKKETTEN[a.pakket] + ".", "",
        "Zo gaat het verder:",
        "1. Wij vragen binnen 1 werkdag (niet in het weekend) op jouw naam het Power-pakket en de domeinnaam " + a.domein + " aan bij WebReus.",
        "2. Je krijgt van WebReus een mail over de betaling. Domein en hosting betaal je zelf aan WebReus, ongeveer 45 euro per jaar incl. btw. Betaal die factuur binnen 8 dagen.",
        "3. Na je betaling stuurt WebReus je een mail met je gegevens, met daarin het blok FTP Gegevens. Stuur die mail door naar info@formforge.nl.",
        "4. Wij zetten je website erop en sturen je de link naar je beheerpagina.",
        a.heeftDomein ? "Je gaf aan dat je de domeinnaam al hebt. Dan vragen we je nog om de verhuiscode bij je huidige aanbieder." : "",
        "",
        "Door je aanvraag en het doorsturen van de mail van WebReus machtig je FormForge om namens jou je pakket aan te vragen, in te loggen op je hosting en je website te plaatsen en aan te passen. Dat staat in artikel 23 van onze voorwaarden: https://formforge.nl/voorwaarden/#a23",
        "",
        "Goed om te weten: je hosting bij WebReus is van jou. Opzeggen bij WebReus doe je zelf, schriftelijk en minstens 2 volle maanden voor het einde van het jaar. Stop je bij FormForge, dan loopt je hosting bij WebReus door tot je die daar opzegt.",
        "",
        betaald ? (a.pakket === "zelf" ? "Het regelen en installeren heb je nu in een keer betaald. Je website loopt als jaarabonnement via Stripe: je betaalt elk jaar automatisch 14,52 euro incl. btw. Je website pas je zelf aan in je beheerpagina." : "Je abonnement bij FormForge loopt via Stripe. Je betaalt elke maand automatisch. Aanpassingen vraag je aan door te mailen naar info@formforge.nl.") : "Voor je pakket bij FormForge krijg je van ons apart een betaalverzoek.",
        "",
        "Je aanvraagnummer is " + a.id + ".", "",
        "Bedenk je je? Binnen 14 dagen kun je je bestelling ongedaan maken via https://formforge.nl/herroepen/ (zie artikel 7 van onze voorwaarden).", "",
        "Met vriendelijke groet,", "FormForge"
      ].filter((r, i, arr) => !(r === "" && arr[i - 1] === ""));
    }
    const klantHtml = klantTekst.map(r => r === "" ? "" : "<p>" + esc(r) + "</p>").join("");
    try{
      await sendResendEmail({ to: a.email, subject: titanium ? "Je aanvraag voor Titanium bij FormForge" : "Je aanvraag bij FormForge: " + a.domein, text: klantTekst.join("\r\n") + "\r\n", html: klantHtml });
    }catch(e){ console.error("Websitemodel: bevestiging naar klant mislukt:", (e && e.message) || e); }
  }

  /* Is een betaalde aanvraag inmiddels betaald? Dan de mails sturen (eenmalig). */
  const aanvraagBezig = new Set();
  async function controleerAanvraag(a){
    if(!a || !a.sessie || a.gemaild || aanvraagBezig.has(a.sessie)) return a;
    aanvraagBezig.add(a.sessie);
    try{
      const rec = await checkPaid(a.sessie);
      if(rec && rec.paid && !a.gemaild){
        a.betaald = true;
        if(!rec.pakket){ rec.pakket = a.pakket; rec.aanvraag = a.id; save(); }
        await stuurAanvraagMails(a);
        a.gemaild = new Date().toISOString();
        bewaarAanvragen();
      }
    }finally{ aanvraagBezig.delete(a.sessie); }
    return a;
  }

  app.post("/api/website/aanvraag", async (req, res) => {
    const b = req.body || {};
    if(veld(b.website, 50) !== "") return res.json({ ok: true }); // spamval: onzichtbaar veld
    const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim() || "onbekend";
    const nu = Date.now();
    const lijst = (aanvraagTeller.get(ip) || []).filter(t => nu - t < 3600 * 1000);
    if(lijst.length >= 6) return res.status(429).json({ error: "Te veel aanvragen achter elkaar. Probeer het over een uur opnieuw of mail naar info@formforge.nl." });

    const pakket = String(b.pakket || "");
    if(!PAKKETTEN[pakket]) return res.status(400).json({ error: "Kies een pakket." });
    const titanium = pakket === "titanium";
    const a = {
      pakket,
      bedrijf: veld(b.bedrijf), aanhef: ["Dhr.", "Mevr."].includes(b.aanhef) ? b.aanhef : "",
      voorletters: veld(b.voorletters, 20), tussenvoegsel: veld(b.tussenvoegsel, 20), achternaam: veld(b.achternaam, 80),
      straat: veld(b.straat, 100), huisnummer: veld(b.huisnummer, 10), toevoeging: veld(b.toevoeging, 10),
      postcode: veld(b.postcode, 10).toUpperCase(), plaats: veld(b.plaats, 80),
      land: ["Nederland", "Belgie"].includes(b.land) ? b.land : "Nederland",
      telefoon: veld(b.telefoon, 30), email: cleanEmail(b.email),
      domein: cleanDomain(b.domein), domein2: cleanDomain(b.domein2), domein3: cleanDomain(b.domein3),
      heeftDomein: b.heeftDomein === true || b.heeftDomein === "1",
      wensen: tekstveld(b.wensen, 3000)
    };
    if(!a.achternaam) return res.status(400).json({ error: "Vul je achternaam in." });
    if(!a.email) return res.status(400).json({ error: "Vul een geldig e-mailadres in." });
    if(a.telefoon.replace(/[^0-9]/g, "").length < 9) return res.status(400).json({ error: "Vul een geldig telefoonnummer in." });
    if(titanium){
      if(a.wensen.length < 10) return res.status(400).json({ error: "Vertel kort wat je wilt laten maken." });
      if(b.akkoordContact !== true) return res.status(400).json({ error: "Geef aan dat we contact met je mogen opnemen." });
    }else{
      if(!a.voorletters) return res.status(400).json({ error: "Vul je voorletters in." });
      if(!a.straat || !a.huisnummer || !a.postcode || !a.plaats) return res.status(400).json({ error: "Vul je adres volledig in." });
      if(!a.domein) return res.status(400).json({ error: "Vul een geldige domeinnaam in, bijvoorbeeld mijnbedrijf.nl" });
      if(b.akkoordOpdracht !== true) return res.status(400).json({ error: "Geef ons opdracht om het pakket bij WebReus voor je aan te vragen." });
      if(b.akkoordVoorwaarden !== true) return res.status(400).json({ error: "Ga akkoord met de voorwaarden en de prijs van je pakket." });
    }
    lijst.push(nu); aanvraagTeller.set(ip, lijst);

    a.id = "A" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();
    a.aangemaakt = new Date().toISOString();
    a.ip = ip;

    /* Basis, Premium en Unlimited: eerst betalen */
    const prijs = PAKKET_PRIJS[pakket];
    const regels = prijs ? pakketRegels(pakket) : null;
    if(prijs && regels){
      try{
        const sep = PAGE_URL.includes("?") ? "&" : "?";
        const meta = { kind: "website_model1", email: a.email, domein: a.domein, pakket, aanvraag: a.id };
        const session = await callStripe("/checkout/sessions", {
          mode: "subscription",
          line_items: regels,
          allow_promotion_codes: true,
          customer_email: a.email,
          success_url: PAGE_URL + sep + "pakketsessie={CHECKOUT_SESSION_ID}#aanvraag",
          cancel_url: PAGE_URL + sep + "pakket=" + pakket + "&geannuleerd=1#aanvraag",
          billing_address_collection: "auto",
          client_reference_id: "pakket-" + pakket + "-" + a.domein,
          metadata: meta,
          subscription_data: { metadata: meta }
        });
        a.sessie = session.id;
        orders[session.id] = { sessie: session.id, email: a.email, domein: a.domein, pakket, aanvraag: a.id, aangemaakt: a.aangemaakt, status: "wacht op betaling", pogingen: 0 };
        save();
        aanvragen.push(a); bewaarAanvragen();
        return res.json({ ok: true, id: a.id, url: session.url });
      }catch(e){
        console.error("Websitemodel: betaling pakket aanmaken mislukt:", (e && e.message) || e);
        return res.status(500).json({ error: "Betalen starten is niet gelukt. Probeer het later opnieuw of mail naar info@formforge.nl." });
      }
    }

    /* Titanium (en zelf als de betaling niet is ingesteld): meteen de mails */
    aanvragen.push(a); bewaarAanvragen();
    try{
      await stuurAanvraagMails(a);
      a.gemaild = new Date().toISOString(); bewaarAanvragen();
    }catch(e){
      console.error("Websitemodel: aanvraagmail mislukt:", (e && e.message) || e);
      return res.status(500).json({ error: "Versturen is niet gelukt. Probeer het opnieuw of mail naar info@formforge.nl." });
    }
    res.json({ ok: true, id: a.id });
  });

  /* Terug van Stripe: is de pakketbetaling gelukt? */
  app.get("/api/website/aanvraag-status", async (req, res) => {
    const sessie = cleanSession(req.query.sessie);
    const a = sessie ? aanvragen.find(x => x.sessie === sessie) : null;
    if(!a) return res.status(404).json({ error: "Onbekende aanvraag." });
    try{
      await controleerAanvraag(a);
      res.json({ betaald: !!a.betaald, id: a.id, pakket: a.pakket, domein: a.domein });
    }catch(e){
      console.error("Websitemodel: aanvraagstatus mislukt:", (e && e.message) || e);
      res.status(500).json({ error: "Kon de betaling niet controleren. Probeer het zo opnieuw." });
    }
  });

  /* Vangnet: komt een klant na betalen niet terug op de pagina, dan zien we
     de betaling hier alsnog (elke 10 minuten, aanvragen tot 3 dagen oud). */
  const vangnet = setInterval(async () => {
    const grens = Date.now() - 3 * 24 * 3600 * 1000;
    for(const a of aanvragen){
      if(!a.sessie || a.gemaild || Date.parse(a.aangemaakt) < grens) continue;
      try{ await controleerAanvraag(a); }catch(e){ console.error("Websitemodel: vangnet aanvraag mislukt:", (e && e.message) || e); }
    }
  }, 10 * 60 * 1000);
  if(vangnet.unref) vangnet.unref();

  /* ===========================================================
     Stijlen: de lijst die elke beheerpagina ophaalt.
     Staat in websitemodel1/stijlen.json. Voeg je daar een stijl aan
     toe, dan zien alle klanten hem vanzelf (binnen ongeveer 12 uur).
     =========================================================== */
  const STIJLEN_FILE = path.join(MODEL_DIR, "stijlen.json");
  let stijlenCache = null, stijlenTijd = 0;
  function leesStijlen(){
    if(stijlenCache && Date.now() - stijlenTijd < 5 * 60 * 1000) return stijlenCache;
    try{
      const d = JSON.parse(fs.readFileSync(STIJLEN_FILE, "utf8"));
      const uit = {};
      for(const [k, v] of Object.entries((d && d.stijlen) || {})){
        if(!/^[a-z][a-z0-9-]{1,30}$/.test(k) || !v || !String(v.naam || "").trim()) continue;
        uit[k] = { naam: String(v.naam), tekst: String(v.tekst || ""), fonts: String(v.fonts || ""), css: String(v.css || ""), grote_foto: !!v.grote_foto };
      }
      stijlenCache = uit; stijlenTijd = Date.now();
    }catch(e){
      console.error("Websitemodel: stijlen.json lezen mislukt:", (e && e.message) || e);
      if(!stijlenCache) stijlenCache = {};
    }
    return stijlenCache;
  }
  /* ---------- herroepen: "Mijn bestelling ongedaan maken" ----------
     Wettelijke herroepingsknop (verplicht sinds 19 juni 2026) en de
     geld-terug-garantie van 14 dagen bij Zelf doen. De klant krijgt direct
     een bevestiging op het scherm en per mail. FormForge krijgt een mail en
     stopt daarna zelf het abonnement in Stripe en betaalt terug. */
  const HERROEP_FILE = path.join(DATA_DIR, "websitemodel_herroepingen.json");
  let herroepingen = [];
  try{ if(fs.existsSync(HERROEP_FILE)) herroepingen = JSON.parse(fs.readFileSync(HERROEP_FILE, "utf8")) || []; }
  catch(e){ console.error("Websitemodel: herroepingen lezen mislukt:", (e && e.message) || e); herroepingen = []; }
  function bewaarHerroepingen(){
    try{ safeWriteFileSync(HERROEP_FILE, JSON.stringify(herroepingen, null, 2)); }
    catch(e){ console.error("Websitemodel: herroepingen opslaan mislukt:", (e && e.message) || e); }
  }
  const herroepTeller = new Map();
  const HERROEP_SOORT = {
    zelf: "Zelf doen (website voor 12 euro per jaar)",
    regelen: "Zelf doen, met regelen en installeren door FormForge (49 euro)",
    basis: "Basis",
    premium: "Premium",
    unlimited: "Unlimited",
    anders: "Weet ik niet / iets anders"
  };
  function datumTijd(d){
    try{ return d.toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch(e){ return d.toISOString(); }
  }

  app.post("/api/website/herroepen", async (req, res) => {
    const b = req.body || {};
    if(veld(b.website, 50) !== "") return res.json({ ok: true, id: "H-0", tijd: "" }); // spamval
    const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim() || "onbekend";
    const nu = Date.now();
    const lijst = (herroepTeller.get(ip) || []).filter(t => nu - t < 3600 * 1000);
    if(lijst.length >= 6) return res.status(429).json({ error: "Te veel verzoeken achter elkaar. Probeer het over een uur opnieuw of mail naar info@formforge.nl." });

    const email = cleanEmail(b.email);
    if(!email) return res.status(400).json({ error: "Vul het e-mailadres in waarmee je hebt besteld." });
    const soort = HERROEP_SOORT[b.soort] ? b.soort : "anders";
    const domein = cleanDomain(b.domein) || veld(b.domein, 100);
    const h = {
      id: "H-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
      tijd: new Date().toISOString(),
      email, naam: veld(b.naam, 120), domein, soort,
      opmerking: tekstveld(b.opmerking, 1500),
      ip
    };
    lijst.push(nu); herroepTeller.set(ip, lijst);

    /* Zoek bijbehorende bestellingen en aanvragen, zodat FormForge snel kan handelen */
    const gevonden = [];
    try{
      Object.values(orders).forEach(o => {
        if(o && (o.email === email || (domein && o.domein === domein))){
          gevonden.push("Bestelling Zelf doen: " + (o.domein || "-") + ", " + (o.email || "-") + ", betaald: " + (o.paid ? "ja, op " + (o.betaaldOp || "?") : "nee") +
            (o.pakket ? ", pakket " + o.pakket : "") + (o.subscriptionId ? ", Stripe-abonnement " + o.subscriptionId : "") + (o.customerId ? ", Stripe-klant " + o.customerId : ""));
        }
      });
      aanvragen.forEach(a => {
        if(a && (a.email === email || (domein && a.domein === domein))){
          gevonden.push("Aanvraag " + (a.id || "-") + ": " + (a.pakket || "-") + ", " + (a.domein || "-") + ", " + (a.email || "-") + ", betaald: " + (a.betaald ? "ja" : "nee") + (a.sessie ? ", Stripe-sessie " + a.sessie : "") + ", aangevraagd: " + (a.tijd || a.aangemaakt || "?"));
        }
      });
    }catch(e){}
    h.gevonden = gevonden;
    herroepingen.push(h); bewaarHerroepingen();

    const tijdTekst = datumTijd(new Date(h.tijd));
    const ff = [
      "Iemand wil een bestelling ongedaan maken (herroeping of geld-terug-garantie).",
      "",
      "Nummer: " + h.id,
      "Ontvangen: " + tijdTekst,
      "E-mail: " + email,
      "Naam: " + (h.naam || "-"),
      "Domeinnaam: " + (domein || "-"),
      "Wat: " + HERROEP_SOORT[soort],
      "Opmerking: " + (h.opmerking || "-"),
      "",
      "GEVONDEN BIJ ONS",
      gevonden.length ? gevonden.join("\r\n") : "Niets gevonden op dit e-mailadres of deze domeinnaam. Vraag de klant om meer gegevens.",
      "",
      "WAT JE MOET DOEN",
      "1. Zoek de betaling op in Stripe (op het e-mailadres).",
      "2. Zelf doen binnen 14 dagen na de eerste betaling: geld-terug-garantie, betaal het hele bedrag terug en zeg het jaarabonnement op.",
      "3. Basis, Premium of Unlimited van een particulier binnen 14 dagen: zeg het abonnement direct op en betaal terug, min een deel naar verhouding voor de dagen die al liepen (artikel 7).",
      "4. Terugbetalen binnen 14 dagen na vandaag, via Stripe (Terugbetalen), naar hetzelfde betaalmiddel.",
      "5. Laat de klant weten wat je hebt gedaan. Beantwoorden gaat direct naar de klant.",
      "",
      "Verstuurd vanaf IP: " + ip
    ];
    try{ await mailMetAntwoord({ to: NOTIFY_EMAIL, replyTo: email, subject: "HERROEPING " + h.id + ": " + (domein || email), text: ff.join("\r\n") + "\r\n" }); }
    catch(e){ console.error("Websitemodel: herroepmail naar FormForge mislukt:", (e && e.message) || e); }

    const klant = [
      "Beste " + (h.naam || "klant") + ",",
      "",
      "We hebben je verzoek om je bestelling ongedaan te maken goed ontvangen op " + tijdTekst + ".",
      "",
      "Je verzoek",
      "Nummer: " + h.id,
      "E-mailadres: " + email,
      "Domeinnaam: " + (domein || "-"),
      "Bestelling: " + HERROEP_SOORT[soort],
      "",
      "Wat er nu gebeurt",
      "Valt je verzoek onder de geld-terug-garantie of de bedenktijd, dan stoppen we je bestelling en betalen we je terug binnen 14 dagen, op dezelfde manier als je hebt betaald. Bij een abonnement dat al liep betaal je alleen naar verhouding voor de dagen die al voorbij zijn. We laten je binnen 1 werkdag weten wat we hebben gedaan. Zo staat het in artikel 7 van onze voorwaarden: https://formforge.nl/voorwaarden/#a7",
      "",
      "Je domeinnaam en hosting bij WebReus zijn een aparte overeenkomst met WebReus. Wil je die ook stoppen, regel dat dan bij WebReus.",
      "",
      "Vragen? Beantwoord deze mail of mail naar info@formforge.nl.",
      "",
      "Met vriendelijke groet,",
      "FormForge"
    ];
    try{
      await sendResendEmail({ to: email, subject: "Bevestiging: je bestelling ongedaan maken (" + h.id + ")", text: klant.join("\r\n") + "\r\n", html: klant.map(r => r === "" ? "" : "<p>" + esc(r) + "</p>").join("") });
    }catch(e){ console.error("Websitemodel: herroepbevestiging naar klant mislukt:", (e && e.message) || e); }

    res.json({ ok: true, id: h.id, tijd: tijdTekst });
  });

  /* ---------- bezoekersteller voor formforge.nl ----------
     Zonder cookies en zonder IP-adressen op te slaan. Unieke bezoekers per
     dag worden geteld met een hash van IP en browser plus een geheim dat
     elke dag wisselt en nergens wordt bewaard. Alleen FormForge kan de
     cijfers zien, via een inloglink die naar het meldadres wordt gemaild. */
  const TEL_FILE = path.join(DATA_DIR, "websitemodel_bezoek.json");
  const TEL_TOKENS = path.join(DATA_DIR, "websitemodel_bezoek_tokens.json");
  let tel = { dagen: {} };
  try{ if(fs.existsSync(TEL_FILE)) tel = JSON.parse(fs.readFileSync(TEL_FILE, "utf8")) || { dagen: {} }; }catch(e){ tel = { dagen: {} }; }
  if(!tel.dagen) tel.dagen = {};
  let telTokens = {};
  try{ if(fs.existsSync(TEL_TOKENS)) telTokens = JSON.parse(fs.readFileSync(TEL_TOKENS, "utf8")) || {}; }catch(e){ telTokens = {}; }
  let telVuil = false, telZout = { dag: "", zout: "" }, telUniek = { dag: "", set: new Set() };
  function telDag(d){ return new Date(d || Date.now()).toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" }); }
  function telBewaar(){
    if(!telVuil) return; telVuil = false;
    try{ safeWriteFileSync(TEL_FILE, JSON.stringify(tel)); }catch(e){ console.error("Websitemodel: bezoek opslaan mislukt:", (e && e.message) || e); }
  }
  setInterval(telBewaar, 30 * 1000).unref();
  const TEL_BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|pingdom|uptime|curl|wget|python|java\//i;
  function telSchoonPad(p){
    let v = String(p || "/").split("?")[0].split("#")[0].slice(0, 120);
    if(!v.startsWith("/")) v = "/" + v;
    v = v.replace(/index\.html$/, "").replace(/[^A-Za-z0-9\/._-]/g, "");
    return v || "/";
  }
  function telBron(r){
    try{
      const h = new URL(String(r || "")).hostname.replace(/^www\./, "").toLowerCase();
      if(!h || /(^|\.)formforge\.nl$/.test(h)) return "";
      if(/google\./.test(h)) return "Google";
      if(/bing\./.test(h)) return "Bing";
      if(/facebook\.|fb\./.test(h)) return "Facebook";
      if(/instagram\./.test(h)) return "Instagram";
      if(/linkedin\.|lnkd\./.test(h)) return "LinkedIn";
      return h.slice(0, 60);
    }catch(e){ return ""; }
  }
  app.post("/api/website/tel", (req, res) => {
    res.status(204).end();
    try{
      const ua = String(req.headers["user-agent"] || "");
      if(!ua || TEL_BOT.test(ua)) return;
      const herkomst = String(req.headers["origin"] || req.headers["referer"] || "");
      if(!/^https?:\/\/(www\.)?formforge\.nl(\/|$)/i.test(herkomst)) return;
      const b = req.body || {};
      const dag = telDag();
      if(telZout.dag !== dag){ telZout = { dag, zout: crypto.randomBytes(16).toString("hex") }; }
      if(telUniek.dag !== dag){ telUniek = { dag, set: new Set() }; }
      const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
      const sleutel = crypto.createHash("sha256").update(telZout.zout + "|" + ip + "|" + ua).digest("hex").slice(0, 16);
      const d = tel.dagen[dag] || (tel.dagen[dag] = { views: 0, bezoekers: 0, paden: {}, bronnen: {}, mobiel: 0 });
      d.views++;
      const pad = telSchoonPad(b.p);
      d.paden[pad] = (d.paden[pad] || 0) + 1;
      if(!telUniek.set.has(sleutel)){
        telUniek.set.add(sleutel);
        d.bezoekers++;
        if(/Mobi|Android|iPhone|iPad/i.test(ua)) d.mobiel++;
        const bron = telBron(b.r);
        const bk = bron || "Direct";
        d.bronnen[bk] = (d.bronnen[bk] || 0) + 1;
      }
      telVuil = true;
      const dagen = Object.keys(tel.dagen).sort();
      while(dagen.length > 400){ delete tel.dagen[dagen.shift()]; }
    }catch(e){}
  });

  /* Dagelijks overzicht per mail, om 20:00 uur (Nederlandse tijd) */
  function telDagMail(){
    const dag = telDag();
    const leeg = { views: 0, bezoekers: 0, paden: {}, bronnen: {}, mobiel: 0 };
    const D = k => tel.dagen[k] || leeg;
    const dagLijst = []; for(let i = 29; i >= 0; i--){ dagLijst.push(telDag(Date.now() - i * 86400000)); }
    const som = l => l.reduce((a, k) => { const d = D(k); a.v += d.views; a.b += d.bezoekers; return a; }, { v: 0, b: 0 });
    const s1 = som([dag]), s0 = som([telDag(Date.now() - 86400000)]), s7 = som(dagLijst.slice(-7)), s30 = som(dagLijst), st = som(Object.keys(tel.dagen));
    const nl = n => Number(n).toLocaleString("nl-NL");
    const top = (o, n) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
    const naamPad = p2 => p2 === "/" ? "Voorpagina" : p2;
    const vandaag = D(dag);
    const rijen = [
      ["Vandaag", s1], ["Gisteren", s0], ["Laatste 7 dagen", s7], ["Laatste 30 dagen", s30], ["Sinds de start", st]
    ];
    const datum = new Date().toLocaleDateString("nl-NL", { timeZone: "Europe/Amsterdam", weekday: "long", day: "numeric", month: "long" });
    const tekst = [
      "Bezoekers formforge.nl, " + datum, "",
      ...rijen.map(([n, x]) => n + ": " + nl(x.b) + " bezoekers, " + nl(x.v) + " keer bekeken"), "",
      "Meest bekeken vandaag:",
      ...(top(vandaag.paden, 8).map(([p2, n]) => "- " + naamPad(p2) + ": " + nl(n)) .concat(Object.keys(vandaag.paden || {}).length ? [] : ["- nog geen bezoekers"])), "",
      "Waar kwamen ze vandaan vandaag:",
      ...(top(vandaag.bronnen, 8).map(([p2, n]) => "- " + p2 + ": " + nl(n)).concat(Object.keys(vandaag.bronnen || {}).length ? [] : ["- nog geen bezoekers"])), "",
      "Alle cijfers: " + SERVER_URL + "/api/website/statistiek"
    ];
    const td = 'style="padding:8px 12px;border-bottom:1px solid #eef0f4"';
    const tdn = 'style="padding:8px 12px;border-bottom:1px solid #eef0f4;text-align:right;font-weight:700"';
    const tabel = (kop, lijst) => '<h3 style="margin:22px 0 8px;font-size:16px">' + kop + '</h3><table style="border-collapse:collapse;width:100%;max-width:520px;border:1px solid #e3e6ee">' + (lijst.length ? lijst.map(([a, b]) => '<tr><td ' + td + '>' + esc(a) + '</td><td ' + tdn + '>' + nl(b) + '</td></tr>').join('') : '<tr><td ' + td + '>Nog geen bezoekers.</td></tr>') + '</table>';
    const html = '<div style="font-family:Segoe UI,Arial,sans-serif;color:#1b2a4a">'
      + '<h2 style="margin:0 0 4px">Bezoekers formforge.nl</h2><p style="margin:0 0 16px;color:#5a6680">' + esc(datum) + '</p>'
      + '<table style="border-collapse:collapse;width:100%;max-width:520px;border:1px solid #e3e6ee"><tr><th ' + td + ' align="left"></th><th ' + tdn + '>Bezoekers</th><th ' + tdn + '>Keer bekeken</th></tr>'
      + rijen.map(([n, x]) => '<tr><td ' + td + '>' + n + '</td><td ' + tdn + '>' + nl(x.b) + '</td><td ' + tdn + '>' + nl(x.v) + '</td></tr>').join('') + '</table>'
      + tabel("Meest bekeken vandaag", top(vandaag.paden, 8).map(([p2, n]) => [naamPad(p2), n]))
      + tabel("Waar kwamen ze vandaan vandaag", top(vandaag.bronnen, 8))
      + '<p style="margin-top:20px"><a href="' + esc(SERVER_URL + "/api/website/statistiek") + '">Alle cijfers bekijken</a></p></div>';
    return { onderwerp: "Bezoekers formforge.nl vandaag: " + nl(s1.b), tekst: tekst.join("\r\n") + "\r\n", html };
  }
  async function telMailControle(){
    try{
      const nu = new Date();
      const uur = Number(nu.toLocaleString("en-GB", { timeZone: "Europe/Amsterdam", hour: "2-digit", hourCycle: "h23" }));
      const dag = telDag();
      if(uur < 20 || tel.gemaild === dag) return;
      tel.gemaild = dag; telVuil = true; telBewaar();
      const m = telDagMail();
      await sendResendEmail({ to: NOTIFY_EMAIL, subject: m.onderwerp, text: m.tekst, html: m.html });
    }catch(e){ console.error("Websitemodel: dagoverzicht bezoekers mislukt:", (e && e.message) || e); }
  }
  setInterval(telMailControle, 60 * 1000).unref();

  function telEsc(s){ return esc(s); }
  function telPagina(inhoud){
    return '<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Bezoekers formforge.nl</title><style>'
      + 'body{margin:0;font-family:"Segoe UI",Arial,sans-serif;background:#f4f6fb;color:#1b2a4a;}main{max-width:900px;margin:0 auto;padding:28px 18px 60px;}'
      + 'h1{font-size:26px;margin:0 0 4px;}p.sub{color:#5a6680;margin:0 0 22px;}.kaarten{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;}'
      + '.k{background:#fff;border:1px solid #e3e6ee;border-radius:14px;padding:16px;}.k small{display:block;color:#5a6680;font-size:13px;}.k b{display:block;font-size:28px;margin-top:4px;}.k span{font-size:13px;color:#5a6680;}'
      + 'h2{font-size:18px;margin:28px 0 10px;}.grafiek{background:#fff;border:1px solid #e3e6ee;border-radius:14px;padding:16px;display:flex;align-items:flex-end;gap:3px;height:180px;}'
      + '.balk{flex:1;background:#2f6fed;border-radius:3px 3px 0 0;min-height:2px;position:relative;}.balk:hover{background:#1f5ad6;}'
      + 'table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e6ee;border-radius:14px;overflow:hidden;}td,th{padding:10px 14px;border-bottom:1px solid #eef0f4;text-align:left;font-size:15px;}th{background:#fafbfd;font-size:13px;color:#5a6680;}td.n{text-align:right;font-weight:700;}'
      + '.knop{display:inline-block;background:#2f6fed;color:#fff;border:0;border-radius:999px;padding:13px 22px;font:700 16px "Segoe UI",Arial,sans-serif;cursor:pointer;}.msg{margin-top:14px;color:#1d8a5b;font-weight:600;}'
      + '.uitleg{margin-top:24px;font-size:13px;color:#5a6680;}</style></head><body><main>' + inhoud + '</main></body></html>';
  }
  function telTokenGeldig(t){
    const v = telTokens[String(t || "")];
    return !!(v && v > Date.now());
  }
  const telLinkTeller = [];
  app.post("/api/website/statistiek/link", async (req, res) => {
    const nu = Date.now();
    while(telLinkTeller.length && nu - telLinkTeller[0] > 3600 * 1000) telLinkTeller.shift();
    if(telLinkTeller.length >= 5) return res.status(429).json({ error: "Er zijn net al een paar links verstuurd. Kijk in je mail of probeer het over een uur opnieuw." });
    telLinkTeller.push(nu);
    const t = crypto.randomBytes(24).toString("hex");
    Object.keys(telTokens).forEach(k => { if(telTokens[k] < nu) delete telTokens[k]; });
    telTokens[t] = nu + 30 * 24 * 3600 * 1000;
    try{ safeWriteFileSync(TEL_TOKENS, JSON.stringify(telTokens)); }catch(e){}
    const link = SERVER_URL + "/api/website/statistiek?t=" + t;
    try{
      await sendResendEmail({ to: NOTIFY_EMAIL, subject: "Je inloglink voor de bezoekers van formforge.nl",
        text: "Met deze link zie je de bezoekers van formforge.nl. De link werkt 30 dagen. Bewaar hem als bladwijzer.\r\n\r\n" + link + "\r\n\r\nGeef deze link aan niemand anders.\r\n",
        html: "<p>Met deze link zie je de bezoekers van formforge.nl. De link werkt 30 dagen. Bewaar hem als bladwijzer.</p><p><a href=\"" + esc(link) + "\">Bezoekers bekijken</a></p><p>Geef deze link aan niemand anders.</p>" });
    }catch(e){ return res.status(500).json({ error: "De mail kon niet worden verstuurd." }); }
    res.json({ ok: true });
  });
  app.get("/api/website/statistiek", (req, res) => {
    res.set("Cache-Control", "no-store");
    const t = String(req.query.t || "");
    if(!telTokenGeldig(t)){
      return res.send(telPagina('<h1>Bezoekers formforge.nl</h1><p class="sub">Alleen voor FormForge. Klik op de knop, dan krijg je een inloglink in je mail (' + telEsc(NOTIFY_EMAIL) + ').</p>'
        + '<button class="knop" id="k">Stuur mij een inloglink</button><div class="msg" id="m"></div>'
        + '<script>document.getElementById("k").onclick=function(){var b=this;b.disabled=true;fetch("/api/website/statistiek/link",{method:"POST"}).then(function(r){return r.json();}).then(function(j){document.getElementById("m").textContent=j.ok?"Verstuurd. Kijk in je mail.":(j.error||"Dat lukte niet.");}).catch(function(){document.getElementById("m").textContent="Geen verbinding.";b.disabled=false;});};</script>'));
    }
    telBewaar();
    const vandaag = telDag();
    const dagLijst = [];
    for(let i = 29; i >= 0; i--){ dagLijst.push(telDag(Date.now() - i * 86400000)); }
    const leeg = { views: 0, bezoekers: 0, paden: {}, bronnen: {}, mobiel: 0 };
    const D = k => tel.dagen[k] || leeg;
    function som(lijst){ return lijst.reduce((a, k) => { const d = D(k); a.v += d.views; a.b += d.bezoekers; a.m += d.mobiel || 0; return a; }, { v: 0, b: 0, m: 0 }); }
    const s1 = som([vandaag]), s0 = som([telDag(Date.now() - 86400000)]), s7 = som(dagLijst.slice(-7)), s30 = som(dagLijst);
    const totaal = som(Object.keys(tel.dagen));
    const max = Math.max(1, ...dagLijst.map(k => D(k).bezoekers));
    const nl = n => Number(n).toLocaleString("nl-NL");
    const kaart = (t2, s, sub) => '<div class="k"><small>' + t2 + '</small><b>' + nl(s.b) + '</b><span>' + nl(s.v) + ' keer bekeken' + (sub || '') + '</span></div>';
    const paden = {}, bronnen = {};
    dagLijst.forEach(k => { const d = D(k); Object.entries(d.paden || {}).forEach(([p2, n]) => paden[p2] = (paden[p2] || 0) + n); Object.entries(d.bronnen || {}).forEach(([p2, n]) => bronnen[p2] = (bronnen[p2] || 0) + n); });
    const top = (o, n) => Object.entries(o).sort((a, b2) => b2[1] - a[1]).slice(0, n);
    const naamPad = p2 => p2 === "/" ? "Voorpagina" : p2;
    let h = '<h1>Bezoekers formforge.nl</h1><p class="sub">Bijgewerkt: ' + new Date().toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" }) + '. Ververs de pagina voor de nieuwste cijfers.</p>';
    h += '<div class="kaarten">' + kaart("Vandaag", s1) + kaart("Gisteren", s0) + kaart("Laatste 7 dagen", s7) + kaart("Laatste 30 dagen", s30) + kaart("Sinds de start", totaal) + '</div>';
    h += '<h2>Bezoekers per dag (30 dagen)</h2><div class="grafiek">' + dagLijst.map(k => '<div class="balk" title="' + k + ': ' + D(k).bezoekers + ' bezoekers" style="height:' + Math.round(D(k).bezoekers / max * 100) + '%"></div>').join('') + '</div>';
    h += '<h2>Meest bekeken pagina\'s (30 dagen)</h2><table><tr><th>Pagina</th><th style="text-align:right">Keer bekeken</th></tr>' + (top(paden, 15).map(([p2, n]) => '<tr><td>' + telEsc(naamPad(p2)) + '</td><td class="n">' + nl(n) + '</td></tr>').join('') || '<tr><td colspan="2">Nog geen bezoekers.</td></tr>') + '</table>';
    h += '<h2>Waar komen ze vandaan? (30 dagen)</h2><table><tr><th>Bron</th><th style="text-align:right">Bezoekers</th></tr>' + (top(bronnen, 12).map(([p2, n]) => '<tr><td>' + telEsc(p2) + '</td><td class="n">' + nl(n) + '</td></tr>').join('') || '<tr><td colspan="2">Nog geen bezoekers.</td></tr>') + '</table>';
    h += '<p class="uitleg">Op een telefoon of tablet: ' + (s30.b ? Math.round(s30.m / s30.b * 100) : 0) + '% van de bezoekers (30 dagen). Bezoekers worden per dag geteld: wie op twee dagen langskomt, telt twee keer. We gebruiken geen cookies en bewaren geen IP-adressen. Zoekmachines en robots tellen niet mee.</p>';
    res.send(telPagina(h));
  });

  app.get("/api/website/stijlen", (req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json({ stijlen: leesStijlen() });
  });

  console.log("Websitemodel geladen. Prijs ingesteld: " + (PRICE_ID ? "ja" : "nee") + ", FTP-pakket: " + (ftp ? "ja" : "nee") + ", stijlen: " + Object.keys(leesStijlen()).length);
  return {};
};
