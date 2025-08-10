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

    const host = req.get("host");
    const base = BASE_URL || `https://${host}`;
    const wsUrl = base.replace(/^http/, "ws") + "/ws";

    const twiml = `
<Response>
  <Connect>
    <Stream url="${wsUrl}"/>
  </Connect>
</Response>`.trim();

    const form = new URLSearchParams();
    form.set("To", to);
    form.set("From", TWILIO_FROM);
    form.set("Twiml", twiml);
    if (TWILIO_MACHINE_DETECTION) form.set("MachineDetection", TWILIO_MACHINE_DETECTION);

    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    });

    const text = await resp.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }

    if (!resp.ok) return res.status(resp.status).json({ ok: false, error: payload, wsUrl, inlineTwiml: true });
    return res.status(200).json({ ok: true, call_sid: payload.sid, status: payload.status, to, wsUrl, inlineTwiml: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});


// ... keep your imports, env, express routes (/health, /twiml, /trigger-call) ...

// ----- WS: Twilio <Stream> ↔ OpenAI Realtime -----
import { WebSocketServer, WebSocket } from "ws";
import http from "http";

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (twilio) => {
  let streamSid = "";
  let closed = false;

  // outbound pacing queue (160 bytes == 20 ms μ-law @ 8 kHz)
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

  // small test beep so you know outbound is alive
  function makeBeepUlaw(ms = 200, freq = 880, amp = 9000) {
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
      for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
      const mantissa = (s >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0f;
      out[n] = ~(sign | (exponent << 4) | mantissa) & 0xff;
    }
    return out;
  }

  // --- OpenAI Realtime WS ---
  const oa = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(process.env.REALTIME_MODEL || "gpt-4o-realtime-preview")}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY || ""}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  // state for committing audio and triggering responses
  let lastAppendAt = 0;
  let commitTimer = null;
  let awaitingResponse = false;

  function scheduleCommitAndRespond(delay = 300) {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      if (oa.readyState !== WebSocket.OPEN) return;
      // commit whatever we appended since last time
      oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      // ask the model to respond (one at a time)
      if (!awaitingResponse) {
        awaitingResponse = true;
        oa.send(JSON.stringify({ type: "response.create", response: { conversation: "default" } }));
      }
    }, delay);
  }

  oa.on("open", () => {
    // Configure session for μ-law 8 kHz in/out, Croatian, server VAD, and voice
    const LANG = (process.env.LANG || "hr").toLowerCase().slice(0,2);
    const VOICE = process.env.VOICE || "alloy";
    const SESSION_INSTRUCTIONS = process.env.SESSION_INSTRUCTIONS ||
      "Ti si Ivana, ljubazna agentica korisničke podrške. Odgovaraj kratko i na hrvatskom. Ako ne znaš odgovor, reci da će te kolega uskoro nazvati.";

    oa.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: SESSION_INSTRUCTIONS,
        modalities: ["text", "audio"],
        voice: VOICE,
        input_audio_format: "g711_ulaw",
        input_audio_sample_rate_hz: 8000,
        input_audio_transcription: { model: "whisper-1", language: LANG },
        output_audio_format: "g711_ulaw",
        output_audio_sample_rate_hz: 8000,
        // server VAD lets us skip manual commit; we’ll still commit on short pauses to be proactive
        turn_detection: { type: "server_vad", silence_duration_ms: 400 }
      }
    }));

    // Proactive greeting (don’t wait for user)
    oa.send(JSON.stringify({
      type: "response.create",
      response: { instructions: "Pozdrav! Kako Vam mogu pomoći?" }
    }));
  });

  oa.on("message", (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }

    // stream μ-law audio from OpenAI → Twilio
    if (
      (msg.type === "response.output_audio.delta" ||
       msg.type === "response.audio.delta" ||
       msg.type === "response.delta") && msg.delta?.audio
    ) {
      const ulawChunk = Buffer.from(msg.delta.audio, "base64");
      enqueueToTwilio(ulawChunk);
    }

    // when a response completes, allow the next one
    if (msg.type === "response.completed" || msg.type === "response.error") {
      awaitingResponse = false;
    }
  });

  oa.on("error", (e) => console.error("OpenAI WS error:", e?.message || e));
  oa.on("close", () => { if (!closed) try { twilio.close(); } catch {} });

  // --- Twilio <Stream> side ---
  twilio.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const ev = m.event;

    if (ev === "start") {
      streamSid = m.start?.streamSid || m.streamSid || streamSid || "STREAM";
      // short audible cue
      enqueueToTwilio(makeBeepUlaw(180, 880));
      return;
    }

    if (ev === "media") {
      const b64 = m.media?.payload;
      if (!b64 || oa.readyState !== WebSocket.OPEN) return;
      // append caller audio to OpenAI
      oa.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      lastAppendAt = Date.now();
      // commit+respond after a short pause to reduce latency
      scheduleCommitAndRespond(300);
      return;
    }

    if (ev === "stop") {
      closed = true;
      if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
      if (pacingTimer) { clearInterval(pacingTimer); pacingTimer = null; }
      try { oa.close(); } catch {}
      try { twilio.close(); } catch {}
      return;
    }
  });

  twilio.on("close", () => {
    closed = true;
    if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
    if (pacingTimer) { clearInterval(pacingTimer); pacingTimer = null; }
    try { oa.close(); } catch {}
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`up on :${PORT}`));
