const Express = require("express");
const Cors = require("cors");
const Multer = require("multer");
const OpenAI = require("openai");

const app = Express();

const upload = Multer({
  storage: Multer.memoryStorage()
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(Cors({
  origin: true,
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(Express.json({
  limit: "50mb"
}));

const Sessies = {};

app.get("/", (Vereiste,Res)=>{
  Res.send("FormForge ECHO backend online");
});

app.post("/api/signaling/session", (Vereiste,Res)=>{

  const { code } = Vereiste.body;

  Sessies[code] = {
    offer:null,
    answer:null,
    createdAt:Date.now()
  };

  Res.json({
    ok:true
  });

});

app.post("/api/signaling/offer", (Vereiste,Res)=>{

  const { code, sdp } = Vereiste.body;

  if(!Sessies[code]){
    Sessies[code] = {};
  }

  Sessies[code].offer = sdp;

  Res.json({
    ok:true
  });

});

app.get("/api/signaling/offer/:code", (Vereiste,Res)=>{

  const sessie = Sessies[Vereiste.params.code];

  Res.json({
    sdp: sessie && sessie.offer
      ? sessie.offer
      : null
  });

});

app.post("/api/signaling/answer", (Vereiste,Res)=>{

  const { code, sdp } = Vereiste.body;

  if(!Sessies[code]){
    Sessies[code] = {};
  }

  Sessies[code].answer = sdp;

  Res.json({
    ok:true
  });

});

app.get("/api/signaling/answer/:code", (Vereiste,Res)=>{

  const sessie = Sessies[Vereiste.params.code];

  Res.json({
    sdp: sessie && sessie.answer
      ? sessie.answer
      : null
  });

});

app.post("/api/signaling/clear", (Vereiste,Res)=>{

  const { code } = Vereiste.body;

  delete Sessies[code];

  Res.json({
    ok:true
  });

});

app.post("/api/speech/transcribe", upload.single("audio"), async (Vereiste, Res) => {

  try{

    if(!Vereiste.file){

      return Res.status(400).json({
        error:"Geen audio ontvangen"
      });

    }

    const file = new File(
      [Vereiste.file.buffer],
      Vereiste.file.originalname || "speech.webm",
      {
        type: Vereiste.file.mimetype || "audio/webm"
      }
    );

    const transcriptie = await openai.audio.transcriptions.create({
      file:file,
      model:"gpt-4o-mini-transcribe"
    });

    Res.json({
      text: transcriptie.text || ""
    });

  }catch(fout){

    console.error("Transcriptie fout:", fout);

    Res.status(500).json({
      error:"Transcriptie mislukt",
      details:fout.message
    });

  }

});

const PORT = process.env.PORT || 10000;

app.listen(PORT, ()=>{

  console.log(
    "FormForge ECHO backend draait op poort " + PORT
  );

});
