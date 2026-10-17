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
          text: "Je website is geinstalleerd op " + rec.domein + ".\r\n\r\nGa naar " + adminUrl + " en stel je e-mailadres en wachtwoord in.\r\nJe instelcode is: " + code + "\r\n\r\nLater inloggen? Klik helemaal onderaan je website op \"Inloggen\", of ga naar " + adminUrl + " en log in met je e-mailadres en wachtwoord.\r\n\r\nWerkt de link nog niet? Een nieuwe domeinnaam kan tot ongeveer een werkdag nodig hebben voordat hij actief is.\r\n\r\nVeiligheid: verander na de installatie je FTP-wachtwoord in het WebReus-portaal.\r\n\r\nFormForge",
          html: "<p>Je website is geinstalleerd op <strong>" + esc(rec.domein) + "</strong>.</p><p>Ga naar <a href=\"" + esc(adminUrl) + "\">" + esc(adminUrl) + "</a> en stel je e-mailadres en wachtwoord in.</p><p>Je instelcode is: <strong style=\"font-size:20px;letter-spacing:2px\">" + esc(code) + "</strong></p><p>Later inloggen? Klik helemaal onderaan je website op <strong>Inloggen</strong>, of ga naar " + esc(adminUrl) + " en log in met je e-mailadres en wachtwoord.</p><p>Werkt de link nog niet? Een nieuwe domeinnaam kan tot ongeveer een werkdag nodig hebben voordat hij actief is.</p><p>Veiligheid: verander na de installatie je FTP-wachtwoord in het WebReus-portaal.</p><p>FormForge</p>"
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
     - Zelf doen (met hulp) en Titanium: direct een mail aan FormForge
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
    zelf: "Zelf doen, met aanvraag en installatie door FormForge (49 euro eenmalig excl. btw, 59,29 incl. btw)",
    basis: "Basis (12,04 euro per maand incl. btw, 1 aanpassing per maand)",
    premium: "Premium (36,24 euro per maand incl. btw, 5 aanpassingen per maand)",
    unlimited: "Unlimited (95,59 euro per maand incl. btw, 12 maanden, website door ons ingevuld)",
    titanium: "Titanium (op maat, op aanvraag)"
  };
  const PAKKET_PRIJS = {
    basis: String(process.env.WEBSITE_PRICE_BASIS || "price_1URSOz5s8MDSsy0e08jsS1BR").trim(),
    premium: String(process.env.WEBSITE_PRICE_PREMIUM || "price_1URSRP5s8MDSsy0eZ0OAqBee").trim(),
    unlimited: String(process.env.WEBSITE_PRICE_UNLIMITED || "price_1URSTc5s8MDSsy0eODnAzDW4").trim()
  };
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
      betaald ? "BETAALD via Stripe (maandabonnement). Stripe-sessie: " + a.sessie : "",
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
      titanium ? "Akkoord: mag contact opnemen." : "Akkoord: opdracht om namens de klant bij WebReus aan te vragen, voorwaarden WebReus en FormForge, prijs van het pakket, direct starten.",
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
        "2. Je krijgt van WebReus een mail over de betaling. Domein en hosting betaal je zelf aan WebReus, ongeveer 45 euro per jaar incl. btw.",
        "3. Na je betaling stuurt WebReus je een mail met je gegevens, met daarin het blok FTP Gegevens. Stuur die mail door naar info@formforge.nl.",
        "4. Wij zetten je website erop en sturen je de link naar je beheerpagina.",
        a.heeftDomein ? "Je gaf aan dat je de domeinnaam al hebt. Dan vragen we je nog om de verhuiscode bij je huidige aanbieder." : "",
        "",
        betaald ? "Je abonnement bij FormForge loopt via Stripe. Je betaalt elke maand automatisch. Aanpassingen vraag je aan door te mailen naar info@formforge.nl." : "Voor je pakket bij FormForge krijg je van ons apart een betaalverzoek.",
        "",
        "Je aanvraagnummer is " + a.id + ".", "",
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
    if(prijs){
      try{
        const sep = PAGE_URL.includes("?") ? "&" : "?";
        const meta = { kind: "website_model1", email: a.email, domein: a.domein, pakket, aanvraag: a.id };
        const session = await callStripe("/checkout/sessions", {
          mode: "subscription",
          line_items: [{ price: prijs, quantity: 1 }],
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

    /* Zelf doen (met hulp) en Titanium: meteen de mails */
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
  app.get("/api/website/stijlen", (req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json({ stijlen: leesStijlen() });
  });

  console.log("Websitemodel geladen. Prijs ingesteld: " + (PRICE_ID ? "ja" : "nee") + ", FTP-pakket: " + (ftp ? "ja" : "nee") + ", stijlen: " + Object.keys(leesStijlen()).length);
  return {};
};
