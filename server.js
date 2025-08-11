// server.js — Twilio <Stream> ↔ OpenAI Realtime (μ-law 8k), outbound dial
// Fixes: use WS subprotocol "realtime", add compatible session fields,
// force audio responses, and add verbose debug logging.

import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

// ---------- ENV ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview";
const LANG           = (process.env.LANG || "hr").toLowerCase().slice(0, 2);
const VOICE          = process.env.VOICE || "alloy";
const DEBUG          = (process.env.DEBUG || "0") === "1";

const SESSION_INSTRUCTIONS =
  process.env.SESSION_INSTRUCTIONS ||
  "Ti si Ivana, ljubazna agentica korisničke podrške. Odgovaraj kratko i na hrvatskom. Ako ne znaš odgovor, reci da će te kolega uskoro nazvati.";

const TWILIO_ACCOUNT_SID       = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN        = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_FROM              = process.env.TWILIO_FROM        || "";
const TWILIO_MACHINE_DETECTION = (process.env.TWILIO_MACHINE_DETECTION || "").trim();

const TWIML_URL = (process.env.TWIML_URL || "").trim();
const BASE_URL  = (process.env.BASE_URL  || "").trim();

// ---------- helpers ----------
function hostBase(req) {
  return BASE_URL || `https://${req.get("host")}`;
}

function makeBeepUlaw(ms = 180, freq = 880, amp = 9000) {
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

// ---------- app ----------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio posts form data

app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Serve TwiML on GET and POST
app.all("/twiml", (req, res) => {
  const wsUrl = hostBase(req).replace(/^http/, "ws") + "/ws";
  const xml = `
<Response>
  <Connect>
    <Stream url="${wsUrl}"/>
  </Connect>
</Response>`.trim();
  console.log(`[twiml:${req.method}] wsUrl=`, wsUrl);
  res.set("Content-Type", "text/xml; charset=utf-8").status(200).send(xml);
});

// Twilio call status callback
app.post("/twilio-status", (req, res) => {
  console.log("[/twilio-status]", JSON.stringify(req.body || {}, null, 2));
  res.sendStatus(204);
});

// Trigger outbound call: POST /trigger-call {"to":"+385953881324"}
app.post("/trigger-call", async (req, res) => {
  try {
    const rawTo = String(req.body.to || req.body.phone || "").trim();
    if (!rawTo) return res.status(400).json({ ok: false, error: "Missing 'to' in body" });

    let to = rawTo.replace(/[^\d+]/g, "");
    if (!to.startsWith("+")) to = "+" + to;

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN)
      return res.status(400).json({ ok: false, error: "Missing TWILIO creds" });
    if (!TWILIO_FROM)
      return res.status(400).json({ ok: false, error: "Missing TWILIO_FROM (E.164)" });

    const base  = hostBase(req);
    const wsUrl = base.replace(/^http/, "ws") + "/ws";

    const form = new URLSearchParams();
    form.set("To", to);
    form.set("From", TWILIO_FROM);

    let used;
    if (TWIML_URL) {
      used = "Url";
      form.set("Url", TWIML_URL);
    } else {
      used = "Twiml";
      const twiml = `
<Response>
  <Connect>
    <Stream url="${wsUrl}"/>
  </Connect>
</Response>`.trim();
      form.set("Twiml", twiml);
    }
    if (TWILIO_MACHINE_DETECTION) form.set("MachineDetection", TWILIO_MACHINE_DETECTION);

    form.set("StatusCallback", base + "/twilio-status");
    ["initiated", "ringing", "answered", "completed"].forEach(ev =>
      form.append("StatusCallbackEvent", ev)
    );

    console.log("[/trigger-call] creating call", { to, used, wsUrl });

    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    });

    const text = await resp.text();
    let payload; try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    console.log("[/trigger-call] Twilio resp", resp.status, payload);

    if (!resp.ok) return res.status(resp.status).json({ ok: false, error: payload, used });
    return res.status(200).json({ ok: true, call_sid: payload.sid, status: payload.status, used });
  } catch (e) {
    console.error("[/trigger-call] error", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------- WS: Twilio <Stream> ↔ OpenAI Realtime ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (twilio, req) => {
  let streamSid = "";
  let closed = false;
  console.log("[/ws] Twilio connected from", req.socket.remoteAddress);

  // Strict 160B μ-law frames every ~20 ms
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
        } catch (e) {
          console.warn("[/ws] twilio.send failed", e?.message || e);
        }
      }, 20);
    }
  }

  // Connect to OpenAI Realtime (IMPORTANT: subprotocol "realtime")
  if (!OPENAI_API_KEY) console.error("[/ws] OPENAI_API_KEY missing");
  const oa = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    "realtime",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  let commitTimer = null;
  let awaitingResponse = false;
  function scheduleCommitAndRespond(delay = 250) {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      if (oa.readyState !== WebSocket.OPEN) return;
      oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      if (!awaitingResponse) {
        awaitingResponse = true;
        // Force audio output each time
        oa.send(JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio"], conversation: "default" }
        }));
      }
    }, delay);
  }

  oa.on("open", () => {
    console.log("[/ws->OA] Realtime open");

    // Session config. Include both legacy and current keys for max compatibility.
    oa.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: SESSION_INSTRUCTIONS,
        modalities: ["text", "audio"],
        voice: VOICE,

        // Input audio (Twilio -> OA)
        input_audio_format: "g711_ulaw",
        input_audio_sample_rate_hz: 8000,
        input_audio_transcription: { model: "gpt-4o-mini-transcribe", language: LANG },

        // Output audio (OA -> Twilio)
        audio_format: "g711_ulaw",              // some previews still read this
        output_audio_format: "g711_ulaw",       // current name
        output_audio_sample_rate_hz: 8000,

        // Let server VAD help, we still do tiny commits for snappiness
        turn_detection: { type: "server_vad", silence_duration_ms: 400 }
      }
    }));

    // Proactive greeting (audio)
    oa.send(JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio"], instructions: "Pozdrav! Kako Vam mogu pomoći?" }
    }));
  });

  // Log EVERYTHING useful from OpenAI
  oa.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch {
      console.warn("[OA raw]", data?.toString?.().slice(0, 200));
      return;
    }

    if (DEBUG && msg?.type) console.log("[OA]", msg.type);

    // Audio deltas
    if (
      (msg.type === "response.output_audio.delta" ||
       msg.type === "response.audio.delta" ||
       msg.type === "response.delta") && msg.delta?.audio
    ) {
      const ulawChunk = Buffer.from(msg.delta.audio, "base64");
      enqueueToTwilio(ulawChunk);
    }

    // Useful to see text content while debugging
    if (DEBUG && msg.type === "response.output_text.delta" && msg.delta) {
      console.log("[OA text]", msg.delta);
    }

    // If the API sends any error, surface it
    if ((msg.type && msg.type.includes("error")) || msg.error) {
      console.warn("[OA ERROR]", JSON.stringify(msg, null, 2));
    }

    if (msg.type === "response.completed" || msg.type === "response.error") {
      awaitingResponse = false;
    }
  });

  oa.on("error", (e) => console.error("[/ws->OA] error:", e?.message || e));
  oa.on("close", () => { console.log("[/ws->OA] closed"); if (!closed) try { twilio.close(); } catch {} });

  // Twilio -> OA
  twilio.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const ev = m.event;

    if (ev === "connected") { console.log("[/ws] event=connected"); return; }

    if (ev === "start") {
      streamSid = m.start?.streamSid || m.streamSid || streamSid || "STREAM";
      console.log("[/ws] event=start streamSid=", streamSid);
      enqueueToTwilio(makeBeepUlaw(180, 880));
      return;
    }

    if (ev === "media") {
      const b64 = m.media?.payload;
      if (!b64 || oa.readyState !== WebSocket.OPEN) return;
      oa.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      scheduleCommitAndRespond(250);
      return;
    }

    if (ev === "stop") {
      console.log("[/ws] event=stop");
      closed = true;
      if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
      if (pacingTimer) { clearInterval(pacingTimer); pacingTimer = null; }
      try { oa.close(); } catch {}
      try { twilio.close(); } catch {}
      return;
    }
  });

  twilio.on("close", () => {
    console.log("[/ws] twilio closed");
    closed = true;
    if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
    if (pacingTimer) { clearInterval(pacingTimer); pacingTimer = null; }
    try { oa.close(); } catch {}
  });
});

// ---------- boot ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`up on :${PORT}`));