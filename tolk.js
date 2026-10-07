/* =====================================================================
   tolk.js - de tolk voor hulpdiensten (zorg en politie)
   - laadt de vaste zorgzinnen en politiezinnen van de schijf
   - routes: /api/tolk/..., /api/zorg/..., /api/politie/...
   - de vertaalcache van de tolk
   Wordt ingeladen vanuit server.js. Alles wat dit bestand van de server
   nodig heeft, krijgt het via ctx mee. Terug naar de server gaat alleen
   bewaarTolkCache, zodat de cache bij het afsluiten wordt opgeslagen.
   ===================================================================== */

module.exports = function tolk(ctx){
  const { app, fs, path, DATA_DIR, safeWriteFileSync, OPENAI_API_KEY, TOLK_MODEL, callOpenAI } = ctx;

  /* De zorgzinnen: vaste vragen en mededelingen voor ambulance- en
     ziekenhuispersoneel, vooraf vertaald. Staan in de repo onder startdata/ en
     worden bij het opstarten een keer naar de blijvende schijf gekopieerd.

     Staat het bestand daar al, dan blijft het staan. Anders zou een nieuwe deploy
     nagekeken vertalingen overschrijven met de ongecontroleerde versie uit de
     repo. Bijwerken doe je door het bestand op de schijf te verwijderen, of door
     de versie op te hogen in startdata en ZORG_ZINNEN_OVERSCHRIJVEN op true te
     zetten via de environment variables.

     Dit blok kan niets kapotmaken: gaat er iets mis, dan komt er een regel in de
     log en draait de rest van de server gewoon door. */
  const ZORG_ZINNEN_FILE = path.join(DATA_DIR, "zorg_zinnen.json");
  const ZORG_ZINNEN_BRON = path.join(__dirname, "startdata", "zorg_zinnen.json");
  const ZORG_ZINNEN_OVERSCHRIJVEN =
    String(process.env.ZORG_ZINNEN_OVERSCHRIJVEN || "").toLowerCase() === "true";

  try{
    const bestaat = fs.existsSync(ZORG_ZINNEN_FILE);
    if(!bestaat || ZORG_ZINNEN_OVERSCHRIJVEN){
      if(fs.existsSync(ZORG_ZINNEN_BRON)){
        fs.copyFileSync(ZORG_ZINNEN_BRON, ZORG_ZINNEN_FILE);
        console.log(bestaat
          ? "Zorgzinnen overschreven vanuit startdata."
          : "Zorgzinnen naar de schijf gekopieerd.");
      }else if(!bestaat){
        console.warn("startdata/zorg_zinnen.json ontbreekt; zorgzinnen niet geplaatst.");
      }
    }
  }catch(err){
    console.warn("Zorgzinnen konden niet naar de schijf:", err.message || String(err));
  }

  /* De lijst inlezen zodat hij niet bij elke aanvraag van de schijf hoeft te
     komen. Lukt het niet, dan blijft hij leeg en merkt de rest van de server er
     niets van. */
  let zorgZinnen = null;

  function laadZorgZinnen(){
    try{
      if(!fs.existsSync(ZORG_ZINNEN_FILE)) return null;
      const raw = fs.readFileSync(ZORG_ZINNEN_FILE, "utf8");
      const data = JSON.parse(raw || "null");
      if(!data || !Array.isArray(data.zinnen)) return null;
      return data;
    }catch(err){
      console.warn("Zorgzinnen konden niet gelezen worden:", err.message || String(err));
      return null;
    }
  }

  zorgZinnen = laadZorgZinnen();
  if(zorgZinnen){
    console.log("Zorgzinnen geladen: " + zorgZinnen.zinnen.length + " zinnen, versie " +
                (zorgZinnen.versie || "onbekend") + ".");
  }

  /* De politiezinnen, op dezelfde manier: uit de repo naar de blijvende schijf,
     en daarna een keer inlezen. Zelfde environment variable om te overschrijven,
     zodat je beide lijsten in een keer kunt bijwerken. */
  const POLITIE_ZINNEN_FILE = path.join(DATA_DIR, "politie_zinnen.json");
  const POLITIE_ZINNEN_BRON = path.join(__dirname, "startdata", "politie_zinnen.json");

  try{
    const bestaat = fs.existsSync(POLITIE_ZINNEN_FILE);
    if(!bestaat || ZORG_ZINNEN_OVERSCHRIJVEN){
      if(fs.existsSync(POLITIE_ZINNEN_BRON)){
        fs.copyFileSync(POLITIE_ZINNEN_BRON, POLITIE_ZINNEN_FILE);
        console.log(bestaat
          ? "Politiezinnen overschreven vanuit startdata."
          : "Politiezinnen naar de schijf gekopieerd.");
      }else if(!bestaat){
        console.warn("startdata/politie_zinnen.json ontbreekt; politiezinnen niet geplaatst.");
      }
    }
  }catch(err){
    console.warn("Politiezinnen konden niet naar de schijf:", err.message || String(err));
  }

  let politieZinnen = null;

  function laadPolitieZinnen(){
    try{
      if(!fs.existsSync(POLITIE_ZINNEN_FILE)) return null;
      const raw = fs.readFileSync(POLITIE_ZINNEN_FILE, "utf8");
      const data = JSON.parse(raw || "null");
      if(!data || !Array.isArray(data.zinnen)) return null;
      return data;
    }catch(err){
      console.warn("Politiezinnen konden niet gelezen worden:", err.message || String(err));
      return null;
    }
  }

  politieZinnen = laadPolitieZinnen();
  if(politieZinnen){
    console.log("Politiezinnen geladen: " + politieZinnen.zinnen.length + " zinnen, versie " +
                (politieZinnen.versie || "onbekend") + ".");
  }

  /* ---------- Zoeken in de zorgzinnen ----------
     Er wordt niet op de hele zin vergeleken maar op trefwoorden, zodat
     "heeft u pijn op de borst" en "heb jij pijn op de borst" allebei bij
     dezelfde zin uitkomen. Elke zin heeft in het bestand een lijstje
     trefwoorden staan; die moeten ALLEMAAL in het gesprokene voorkomen.

     Drie grendels voorkomen een verkeerde treffer:
       1) ontkenning: zit er "niet" of "geen" in het gesprokene en niet in de
          bronzin (of andersom), dan geen treffer
       2) extra inhoud: zegt de spreker woorden die niet in de bronzin staan,
          dan zou die inhoud wegvallen; bij meer dan een woord geen treffer
       3) gelijkspel: passen er twee zinnen even goed, dan geen treffer

     Geen treffer is geen fout. Dan gaat de zin gewoon naar OpenAI, precies
     zoals nu. Liever een keer betalen dan de verkeerde vraag stellen. */
  const ZORG_STOP = new Set((zorgZinnen && zorgZinnen.stopwoorden) || []);
  const POLITIE_STOP = new Set((politieZinnen && politieZinnen.stopwoorden) || []);

  function zorgNormaliseer(tekst){
    return String(tekst || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /* Een zoeker voor beide lijsten. zorgZoek en politieZoek hieronder geven hem
     alleen het juiste boek en de bijbehorende stopwoorden mee. */
  function zinnenZoek(boek, stop, zin, taal){
    if(!boek || !Array.isArray(boek.zinnen)) return null;
    const woorden = zorgNormaliseer(zin).split(" ").filter(Boolean);
    if(!woorden.length) return null;
    const set = new Set(woorden);

    const ontkenning = set.has("niet") || set.has("geen");
    const kern = woorden.filter(w => !stop.has(w) && w.length > 2);

    let beste = null, besteScore = -1e9, gelijk = 0;

    for(const z of boek.zinnen){
      const tw = z.trefwoorden || [];
      if(!tw.length) continue;
      if(!tw.every(w => set.has(w))) continue;
      if(!!z.ontkenning !== ontkenning) continue;

      const eigen = new Set(z.kernwoorden || []);
      const extra = kern.filter(w => !eigen.has(w)).length;
      if(extra > 1) continue;

      const lengteVerschil = Math.abs((z.woordaantal || 0) - woorden.length);
      const score = tw.length * 100 - extra * 10 - lengteVerschil;

      if(score > besteScore){ beste = z; besteScore = score; gelijk = 1; }
      else if(score === besteScore){ gelijk++; }
    }

    if(!beste || gelijk > 1) return null;

    const v = beste.vertalingen && beste.vertalingen[taal];
    if(!v || !v.tekst) return null;
    return { id: beste.id, nl: beste.nl, tekst: v.tekst, status: v.status || "onbekend",
             antwoord: beste.antwoord || "vrij",
             juridisch: beste.juridisch === true };
  }

  function zorgZoek(zin, taal){
    return zinnenZoek(zorgZinnen, ZORG_STOP, zin, taal);
  }

  function politieZoek(zin, taal){
    return zinnenZoek(politieZinnen, POLITIE_STOP, zin, taal);
  }


  /* ---------- Endpoints voor de zorgzinnen ----------
     Staan bewust hier: laat genoeg om dezelfde middleware te krijgen als alle
     andere routes (express.json, cors), maar VOOR het 404-vangnet hieronder.
     Staat een route na dat vangnet, dan antwoordt het vangnet als eerste en
     krijg je "Route niet gevonden" terwijl de route wel bestaat. */
  /* De zoeker als endpoint, zodat de tolk hem kan raadplegen voordat er een
     vertaling bij OpenAI wordt opgevraagd. Geen treffer levert gewoon
     gevonden:false op; de aanroeper valt dan terug op zijn eigen pad. */
  /* ---------- Groeiende vertaaldatabase van de tolk ----------
     Elke zin die de tolk laat vertalen wordt hier bewaard, met de vertaling.
     Komt dezelfde zin nog eens langs, dan gaat hij niet opnieuw naar OpenAI.
     Zo bouwt de lijst zich vanzelf op met wat er in de praktijk gezegd wordt.

     LET OP: hier komen echte gesprekken in te staan. Bij een hotelbalie is dat
     onschuldig, bij de ambulance en de politie staat er in wat patienten en
     verdachten hebben gezegd. Zet TOLK_CACHE_AAN op false als dat niet mag.

     De sleutel is genormaliseerd: hoofdletters, leestekens en accenten tellen
     niet mee, zodat "Heeft u pijn?" en "heeft u pijn" dezelfde regel zijn. */
  const TOLK_CACHE_AAN = String(process.env.TOLK_CACHE_AAN || "true").toLowerCase() !== "false";
  const TOLK_CACHE_FILE = path.join(DATA_DIR, "tolk_cache.json");
  const TOLK_CACHE_MAX = Number(process.env.TOLK_CACHE_MAX || 20000);

  const tolkCache = new Map();
  let tolkCacheVuil = false;

  function tolkNormaliseer(tekst){
    return String(tekst || "")
      .toLowerCase()
      .normalize("NFKD")
      /* Alle combinatietekens weg, niet alleen de Latijnse. Anders werd de
         hamza in het Arabisch een spatie en brak een woord in tweeen. */
      .replace(/\p{M}/gu, "")
      .replace(/[^\p{L}\p{N} ]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tolkSleutel(van, naar, zin){
    return van + "|" + naar + "|" + tolkNormaliseer(zin);
  }

  function laadTolkCache(){
    try{
      if(!fs.existsSync(TOLK_CACHE_FILE)) return;
      const data = JSON.parse(fs.readFileSync(TOLK_CACHE_FILE, "utf8") || "{}");
      for(const k of Object.keys(data)) tolkCache.set(k, data[k]);
      console.log("Tolkcache geladen: " + tolkCache.size + " zinnen.");
    }catch(err){
      console.warn("Tolkcache kon niet gelezen worden:", err.message || String(err));
    }
  }

  function bewaarTolkCache(){
    if(!tolkCacheVuil) return;
    try{
      const data = {};
      for(const [k, v] of tolkCache.entries()) data[k] = v;
      safeWriteFileSync(TOLK_CACHE_FILE, JSON.stringify(data));
      tolkCacheVuil = false;
    }catch(err){
      console.warn("Tolkcache opslaan mislukt:", err.message || String(err));
    }
  }

  function tolkCacheZoek(van, naar, zin){
    if(!TOLK_CACHE_AAN) return null;
    const hit = tolkCache.get(tolkSleutel(van, naar, zin));
    if(!hit || !hit.vertaling) return null;
    hit.aantal = (hit.aantal || 1) + 1;
    hit.laatst = Date.now();
    tolkCacheVuil = true;
    return hit.vertaling;
  }

  function tolkCacheZet(van, naar, zin, vertaling, model){
    if(!TOLK_CACHE_AAN) return;
    const k = tolkSleutel(van, naar, zin);
    const nu = Date.now();
    const bestond = tolkCache.get(k);
    tolkCache.set(k, {
      bron: String(zin).slice(0, 600),
      vertaling: String(vertaling).slice(0, 1200),
      van, naar,
      model: model || "",
      aantal: bestond ? (bestond.aantal || 1) + 1 : 1,
      eerst: bestond && bestond.eerst ? bestond.eerst : nu,
      laatst: nu
    });
    tolkCacheVuil = true;

    /* Te vol? Gooi weg wat het langst niet gebruikt is. Zinnen die vaak
       terugkomen zijn juist het waardevolst en blijven zo staan. */
    if(tolkCache.size > TOLK_CACHE_MAX){
      const opOud = [...tolkCache.entries()].sort((a, b) => (a[1].laatst || 0) - (b[1].laatst || 0));
      const weg = tolkCache.size - TOLK_CACHE_MAX;
      for(let i = 0; i < weg; i++) tolkCache.delete(opOud[i][0]);
    }
  }

  laadTolkCache();
  /* Elke twee minuten wegschrijven als er iets veranderd is. Niet bij elke zin,
     want dan schrijf je de schijf stuk tijdens een druk gesprek. */
  setInterval(bewaarTolkCache, 2 * 60 * 1000);

  /* Een JSON-antwoord van het model uitlezen. Modellen zetten er soms
     codeblokken omheen of een zin ervoor; die halen we weg. */
  function tolkLeesJson(tekst){
    const s = String(tekst || "").trim()
      .replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const begin = s.indexOf("{");
    const eind = s.lastIndexOf("}");
    if(begin < 0 || eind <= begin) return null;
    try{ return JSON.parse(s.slice(begin, eind + 1)); }catch(e){ return null; }
  }

  /* Vertalen met een gewoon tekstmodel, voor de tolk.

     Het realtime model bleek de richting niet betrouwbaar te volgen: het gaf de
     Nederlandse zin terug in plaats van de vertaling. Voorlezen doet het wel
     foutloos. Daarom is vertalen en spreken uit elkaar gehaald: hier wordt
     vertaald, en het realtime model leest het resultaat alleen nog voor.

     Dit kost een extra aanroep per beurt, maar levert een vertaling op die
     klopt. Voor zinnen die op de schijf staan gebeurt dit niet, want die zijn
     al vertaald. */
  app.post("/api/tolk/vertaal", async (req, res) => {
    try{
      const zin  = String((req.body && req.body.zin)  || "").slice(0, 1200).trim();
      let   van  = String((req.body && req.body.van)  || "").slice(0, 60).trim();
      let   naar = String((req.body && req.body.naar) || "").slice(0, 60).trim();

      /* Automatisch: de app geeft de twee talen van het gesprek mee, en het
         model bepaalt welke het is. De app deed dat eerst zelf met een lijstje
         Nederlandse woorden, maar daar zaten woorden in die ook Engels of Duits
         zijn ("want", "even", "met", "hier"). "I want a doctor" gold dan als
         Nederlands en werd niet naar het Nederlands vertaald. */
      const talen = Array.isArray(req.body && req.body.talen)
        ? req.body.talen.map(x => String(x || "").slice(0, 60).trim()).filter(Boolean).slice(0, 2)
        : [];
      const automatisch = talen.length === 2 && (!van || !naar);

      if(!zin || (!automatisch && (!van || !naar))){
        return res.status(400).json({ ok:false, error:"zin, en van+naar of twee talen, zijn verplicht" });
      }
      if(!OPENAI_API_KEY){
        return res.status(503).json({ ok:false, error:"OPENAI_API_KEY ontbreekt" });
      }

      /* Een zin is maar in een van de twee talen, dus hooguit een van beide
         richtingen staat in de database. */
      if(automatisch){
        const a = talen[0], b = talen[1];
        const uitA = tolkCacheZoek(a, b, zin);
        if(uitA) return res.json({ ok:true, vertaling: uitA, van:a, naar:b, bron:"database" });
        const uitB = tolkCacheZoek(b, a, zin);
        if(uitB) return res.json({ ok:true, vertaling: uitB, van:b, naar:a, bron:"database" });
      }

      const systeem = automatisch
        ? ("You are a translation engine for a conversation between " + talen[0] + " and " + talen[1] + ". " +
           "Step 1: decide which of these two languages the text is written in. " +
           "Step 2: translate it into the OTHER of the two languages. " +
           "Reply with JSON only, no other text, in exactly this form: " +
           "{\"source\": \"<" + talen[0] + " or " + talen[1] + ">\", \"translation\": \"<the translation>\"} " +
           "The translation must be written in the other language, never in the source language. " +
           "Never answer, comment, greet or explain inside the translation. " +
           "Keep names, numbers, dates, times and amounts exactly as given. " +
           "Translate the meaning in natural word order, not word by word. " +
           "Address the listener in the polite form normal in a business setting in the target language. " +
           "Greetings, single words, names and short fragments ARE meaningful: translate them. " +
           "Only if the text contains no language at all, set translation to SKIP.")
        : "You are a translation engine. You translate text from " + van + " into " + naar + ". " +
        "You never answer, comment, greet or explain. " +
        "Your entire reply is the translation, written in " + naar + ", and nothing else. " +
        "Replying in " + van + " is a failure. " +
        "Keep names, numbers, dates, times and amounts exactly as given. " +
        "Translate the meaning in natural word order for " + naar + ", not word by word. " +
        "Address the listener in the polite form normal in a business setting in " + naar + ". " +
        "Greetings, single words, names and short fragments ARE meaningful: translate them. " +
        "Only if the text contains no language at all, reply with exactly: SKIP";

      /* Staat deze zin al in de database? Dan hoeft hij niet opnieuw vertaald
         te worden. Dit is de besparing waar het om begonnen was. */
      if(!automatisch){
        const uitCache = tolkCacheZoek(van, naar, zin);
        if(uitCache){
          return res.json({ ok:true, vertaling: uitCache, van, naar, bron:"database" });
        }
      }

      /* Welk model vertaalt. Standaard het gidsmodel en niet OPENAI_MODEL:
         dat laatste staat op de mini-versie, en die is bij talen als Thai,
         Hindi of Arabisch merkbaar zwakker. Te overrulen met TOLK_MODEL. */
      const model = TOLK_MODEL;
      const berichten = [ { role:"system", content: systeem },
                          { role:"user",   content: zin } ];

      let vertaling;
      try{
        vertaling = await callOpenAI(berichten, 0, model);
      }catch(err1){
        /* Sommige modellen accepteren alleen de standaardtemperatuur en geven
           anders een fout. Dan nog een keer, zonder die instelling. */
        const m = String((err1 && err1.message) || err1);
        if(/temperature/i.test(m)){
          console.warn("Tolkvertaling: model wil geen temperature, opnieuw zonder. (" + m + ")");
          vertaling = await callOpenAI(berichten, "geen", model);
        }else{
          throw err1;
        }
      }

      let schoon = String(vertaling || "").trim();

      /* Automatisch: de richting komt uit het antwoord van het model. */
      if(automatisch){
        const j = tolkLeesJson(schoon);
        const bronTaal = j && typeof j.source === "string" ? j.source.trim() : "";
        const tekst    = j && typeof j.translation === "string" ? j.translation.trim() : "";
        const gevonden = talen.find(x => x.toLowerCase() === bronTaal.toLowerCase());
        if(!j || !gevonden){
          console.warn("Tolkvertaling: onleesbaar antwoord van het model: " + schoon.slice(0, 200));
          return res.json({ ok:true, vertaling:null, reden:"onleesbaar antwoord" });
        }
        van  = gevonden;
        naar = talen.find(x => x !== gevonden) || "";
        schoon = tekst;
      }

      if(!schoon){
        console.warn("Tolkvertaling: leeg antwoord van het model.");
        return res.json({ ok:true, vertaling:null, reden:"leeg antwoord" });
      }
      if(schoon.toUpperCase() === "SKIP"){
        console.warn("Tolkvertaling: model gaf SKIP op: " + zin);
        return res.json({ ok:true, vertaling:null, reden:"SKIP" });
      }
      tolkCacheZet(van, naar, zin, schoon, model);
      return res.json({ ok:true, vertaling: schoon, van, naar, bron:"model" });
    }catch(err){
      const melding = err && err.message ? String(err.message) : String(err);
      console.warn("Tolkvertaling mislukt:", melding);
      return res.status(502).json({ ok:false, error:"vertaling mislukt", reden: melding.slice(0, 200) });
    }
  });

  /* De database inzien. Zonder parameters alleen de tellingen; met ?lijst=1 ook
     de zinnen zelf, zodat je kunt zien wat er in de praktijk gezegd wordt en de
     goede zinnen kunt overnemen in zorg_zinnen of politie_zinnen. */
  app.get("/api/tolk/database", (req, res) => {
    try{
      const alles = [...tolkCache.values()];
      const perRichting = {};
      for(const v of alles){
        const r = (v.van || "?") + " naar " + (v.naar || "?");
        perRichting[r] = (perRichting[r] || 0) + 1;
      }
      const antwoord = {
        aan: TOLK_CACHE_AAN,
        zinnen: alles.length,
        maximum: TOLK_CACHE_MAX,
        per_richting: perRichting,
        vaakst: alles.slice().sort((a,b)=>(b.aantal||0)-(a.aantal||0)).slice(0, 20)
                .map(v => ({ bron:v.bron, vertaling:v.vertaling, van:v.van, naar:v.naar, aantal:v.aantal }))
      };
      if(String(req.query.lijst || "") === "1"){
        antwoord.alles = alles.map(v => ({
          bron:v.bron, vertaling:v.vertaling, van:v.van, naar:v.naar,
          aantal:v.aantal, eerst:v.eerst, laatst:v.laatst
        }));
      }
      return res.json(antwoord);
    }catch(err){
      console.warn("Tolkdatabase tonen mislukt:", err.message || String(err));
      return res.status(500).json({ error:"kon de database niet tonen" });
    }
  });

  app.post("/api/zorg/zoek", (req, res) => {
    try{
      const zin = String((req.body && req.body.zin) || "").slice(0, 600);
      const taal = String((req.body && req.body.taal) || "").trim().toLowerCase();
      if(!zin || !taal){
        return res.status(400).json({ gevonden: false, error: "zin en taal zijn verplicht" });
      }
      const treffer = zorgZoek(zin, taal);
      if(!treffer) return res.json({ gevonden: false });
      return res.json({ gevonden: true, ...treffer });
    }catch(err){
      console.warn("Zorgzinnen zoeken mislukt:", err.message || String(err));
      return res.json({ gevonden: false });
    }
  });

  app.post("/api/politie/zoek", (req, res) => {
    try{
      const zin = String((req.body && req.body.zin) || "").slice(0, 600);
      const taal = String((req.body && req.body.taal) || "").trim().toLowerCase();
      if(!zin || !taal){
        return res.status(400).json({ gevonden: false, error: "zin en taal zijn verplicht" });
      }
      const treffer = politieZoek(zin, taal);
      if(!treffer) return res.json({ gevonden: false });
      return res.json({ gevonden: true, ...treffer });
    }catch(err){
      console.warn("Politiezinnen zoeken mislukt:", err.message || String(err));
      return res.json({ gevonden: false });
    }
  });

  app.get("/api/politie/zinnen", (req, res) => {
    try{
      if(!politieZinnen) return res.json({ versie: null, categorieen: [], zinnen: [] });
      const taal = String(req.query.taal || "").trim().toLowerCase();
      const zinnen = politieZinnen.zinnen.map(z => {
        const v = (z.vertalingen && z.vertalingen[taal]) || null;
        return {
          id: z.id, categorie: z.categorie, nl: z.nl, antwoord: z.antwoord,
          juridisch: z.juridisch === true,
          vertaling: v ? v.tekst : null,
          status: v ? (v.status || "onbekend") : "ontbreekt",
          /* Meesturen zodat de tolk in de browser zelf kan zoeken zonder bij
             elke beurt het netwerk op te moeten. */
          trefwoorden: z.trefwoorden || [],
          kernwoorden: z.kernwoorden || [],
          ontkenning: z.ontkenning === true,
          woordaantal: z.woordaantal || 0
        };
      });
      return res.json({
        versie: politieZinnen.versie || null,
        categorieen: politieZinnen.categorieen || [],
        antwoorden: politieZinnen.antwoorden || {},
        stopwoorden: politieZinnen.stopwoorden || [],
        zinnen
      });
    }catch(err){
      console.warn("Politiezinnen lijst mislukt:", err.message || String(err));
      return res.json({ versie: null, categorieen: [], zinnen: [] });
    }
  });

  /* De hele lijst in een taal, voor een scherm waarop personeel een zin kiest. */
  app.get("/api/zorg/zinnen", (req, res) => {
    try{
      if(!zorgZinnen) return res.json({ versie: null, categorieen: [], zinnen: [] });
      const taal = String(req.query.taal || "").trim().toLowerCase();
      const zinnen = zorgZinnen.zinnen.map(z => {
        const v = (z.vertalingen && z.vertalingen[taal]) || null;
        return {
          id: z.id,
          categorie: z.categorie,
          nl: z.nl,
          antwoord: z.antwoord,
          vertaling: v ? v.tekst : null,
          status: v ? (v.status || "onbekend") : "ontbreekt",
          trefwoorden: z.trefwoorden || [],
          kernwoorden: z.kernwoorden || [],
          ontkenning: z.ontkenning === true,
          woordaantal: z.woordaantal || 0
        };
      });
      return res.json({
        versie: zorgZinnen.versie || null,
        categorieen: zorgZinnen.categorieen || [],
        antwoorden: zorgZinnen.antwoorden || {},
        stopwoorden: zorgZinnen.stopwoorden || [],
        zinnen
      });
    }catch(err){
      console.warn("Zorgzinnen lijst mislukt:", err.message || String(err));
      return res.json({ versie: null, categorieen: [], zinnen: [] });
    }
  });

  return { bewaarTolkCache };
};
