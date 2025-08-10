// server.js — Railway Node service: Twilio outbound + Twilio <Stream> ↔ OpenAI Realtime
import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

// ----- ENV -----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview";
const LANG = (process.env.LANG || "hr").toLowerCase().slice(0, 2);
const VOICE = process.env.VOICE || "alloy";
const SESSION_INSTRUCTIONS =
  process.env.SESSION_INSTRUCTIONS ||
  "Ti si Ivana, ljubazna agentica korisničke podrške. Odgovaraj kratko i na hrvatskom. Ako ne znaš odgovor, reci da će te kolega uskoro nazvati.";

// Twilio creds for outbound
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_FROM        = process.env.TWILIO_FROM        || ""; // verified or purchased caller ID (E.164)
const TWILIO_MACHINE_DETECTION = process.env.TWILIO_MACHINE_DETECTION || ""; // e.g. "Enable" or ""

// Where Twilio fetches TwiML from. If not set, we’ll use `${BASE_URL}/twiml`
const TWIML_URL = process.env.TWIML_URL || "";
// Your public Railway base URL, e.g. "https://twilio-rt-bridge-production.up.railway.app"
const BASE_URL  = process.env.BASE_URL  || "";

// ----- μ-law helpers -----
function chunk160Base64(ulawBytes) {
  const chunks = [];
  for (let i = 0; i < ulawBytes.length; i += 160) {
    const slice = ulawBytes.subarray(i, Math.min(i + 160, ulawBytes.length));
    const padded = new Uint8Array(160);
    padded.set(slice);
    chunks.push(Buffer.from(padded).toString("base64"));
  }
  return chunks;
}
function makeBeepUlaw(ms = 250, freq = 880, amp = 9000) {
  const BIAS = 0x84, CLIP = 32635;
  const samples = Math.floor(8000 * (ms / 1000));
  const out = new Uint8Array(samples);
  for (let n = 0; n < samples; n++) {
    let s = Math.round(amp * Math.sin(2 * Math.PI * freq * (n / 8000)));
    let sign = (s >> 8) & 0x80;
    if (sign !== 0) s = -s;
    if (s > CLIP) s = CLIP;
    s += BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    const mantissa = (s >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0f;
    const ulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
    out[n] = ulaw;
  }
  return out;
}

// ----- app + routes -----
const app = express();
app.use(express.json());

// Health
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.status(200).send("ok"));

// TwiML served by this app (use if you don’t want a TwiML Bin)
app.get("/twiml", (req, res) => {
  const base = BASE_URL || `https://${req.get("host")}`;
  const wsUrl = base.replace(/^http/, "ws") + "/ws";
  const xml = `
<Response>
  <Connect>
    <Stream url="${wsUrl}"/>
  </Connect>
</Response>`.trim();
  res.set("Content-Type", "text/xml; charset=utf-8").status(200).send(xml);
});

// Outbound call trigger (POST /trigger-call {to:"+3859..."})
app.post("/trigger-call", async (req, res) => {
  try {
    const rawTo = String(req.body.to || req.body.phone || "").trim();
    if (!rawTo) return res.status(400).json({ ok: false, error: "Missing 'to' in body" });

    let to = rawTo.replace(/[^\d+]/g, "");
    if (!to.startsWith("+")) to = "+" + to;

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN)
      return res.status(400).json({ ok: false, error: "Missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN env" });
    if (!TWILIO_FROM)
      return res.status(400).json({ ok: false, error: "Missing TWILIO_FROM env (verified/purchased E.164)" });

    const twimlUrl = TWIML_URL || (BASE_URL ? `${BASE_URL}/twiml` : "");
    if (!twimlUrl)
      return res.status(400).json({ ok: false, error: "Missing TWIML_URL or BASE_URL env" });

    const form = new URLSearchParams();
    form.set("To", to);
    form.set("From", TWILIO_FROM);
    form.set("Url", twimlUrl);
    if (TWILIO_MACHINE_DETECTION) form.set("MachineDetection", TWILIO_MACHINE_DETECTION);

    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString(),
      timeout: 15000
    });

    const text = await resp.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }

    if (!resp.ok) return res.status(resp.status).json({ ok: false, error: payload });
    return res.status(200).json({ ok: true, call_sid: payload.sid, status: payload.status, to });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// ----- WS: Twilio <Stream> ↔ OpenAI Realtime -----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (twilio) => {
  let streamSid = "";
  let closed = false;

  let outQueue = Buffer.alloc(0);
  let pacingTimer = null;
  function enqueueToTwilio(ulawBytes) {
    outQueue = Buffer.concat([outQueue, Buffer.from(ulawBytes)]);
    if (!pacingTimer) {
      pacingTimer = setInterval(() => {
        if (closed) { clearInterval(pacingTimer); pacingTimer = null; return; }
        if (outQueue.length === 0) return;
        const frame = outQueue.subarray(0, 160);
        outQueue = outQueue.subarray(Math.min(160, outQueue.length));
        const payload = Buffer.from(frame).toString("base64");
        try {
          twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
        } catch (_) {}
      }, 20);
    }
  }

  const oa = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  oa.on("open", () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions: SESSION_INSTRUCTIONS,
        modalities: ["text", "audio"],
        voice: VOICE,
        turn_detection: { type: "server_vad", silence_duration_ms: 600 },
        input_audio_transcription: { model: "whisper-1", language: LANG },
        input_audio_format: "g711_ulaw",
        input_audio_sample_rate_hz: 8000,
        output_audio_format: "g711_ulaw",
        output_audio_sample_rate_hz: 8000
      }
    };
    oa.send(JSON.stringify(sessionUpdate));
  });

  oa.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    const isDelta =
      msg.type === "response.output_audio.delta" ||
      msg.type === "response.audio.delta" ||
      msg.type === "response.delta";

    if (isDelta && msg.delta?.audio) {
      const ulawChunk = Buffer.from(msg.delta.audio, "base64");
      enqueueToTwilio(ulawChunk);
    }

    if (msg.type === "session.updated") {
      const greet = {
        type: "response.create",
        response: { instructions: "Pozdrav! Kako Vam mogu pomoći?" }
      };
      try { oa.send(JSON.stringify(greet)); } catch {}
    }
  });

  oa.on("close", () => { if (!closed) try { twilio.close(); } catch (_) {} });
  oa.on("error", (e) => console.error("OpenAI WS error:", e?.message || e));

  twilio.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const ev = m.event;

    if (ev === "start") {
      streamSid = m.start?.streamSid || m.streamSid || streamSid || "STREAM";
      const beep = makeBeepUlaw(200, 880);
      enqueueToTwilio(beep);
      return;
    }

    if (ev === "media") {
      const b64 = m.media?.payload;
      if (!b64 || oa.readyState !== WebSocket.OPEN) return;
      oa.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      return;
    }

    if (ev === "stop") {
      closed = true;
      try { oa.close(); } catch (_e) {}
      try { twilio.close(); } catch (_e) {}
      if (pacingTimer) { clearInterval(pacingTimer); pacingTimer = null; }
      return;
    }
  });

  twilio.on("close", () => {
    closed = true;
    if (pacingTimer) { clearInterval(pacingTimer); pacingTimer = null; }
    try { oa.close(); } catch (_) {}
  });

  const ping = setInterval(() => {
    if (twilio.readyState === WebSocket.OPEN) try { twilio.ping(); } catch (_) {}
    if (oa.readyState === WebSocket.OPEN) try { oa.ping?.(); } catch (_) {}
  }, 10000);
  twilio.on("close", () => clearInterval(ping));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`up on :${PORT}`));
