/* server.js — Twilio WS ↔ OpenAI Realtime (WS) bridge, μ-law passthrough @ 8 kHz */

import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview";
const LANG = (process.env.LANG || "hr").toLowerCase().slice(0, 2);
const VOICE = process.env.VOICE || "alloy";
const SESSION_INSTRUCTIONS =
  process.env.SESSION_INSTRUCTIONS ||
  "Ti si Ivana, ljubazna agentica korisničke podrške. Odgovaraj kratko i na hrvatskom. Ako ne znaš odgovor, reci da će te kolega uskoro nazvati.";

// ---------- tiny μ-law helpers ----------
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

// ---------- app + WS ----------
const app = express();
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.status(200).send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (twilio) => {
  let streamSid = "";
  let closed = false;

  // outbound pacing to Twilio (160 bytes every 20 ms)
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
        if (outQueue.length === 0) { /* keep timer alive for jitter */ }
      }, 20);
    }
  }

  // OpenAI Realtime (WS) for this call
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

  // Forward Realtime audio deltas back to Twilio
  oa.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // handle both possible event names for audio bytes
    const isDelta =
      msg.type === "response.output_audio.delta" ||
      msg.type === "response.audio.delta" ||
      msg.type === "response.delta";

    if (isDelta && msg.delta?.audio) {
      const ulawChunk = Buffer.from(msg.delta.audio, "base64");
      enqueueToTwilio(ulawChunk);
    }

    // Optionally greet right after the session is ready (first response)
    if (msg.type === "session.updated") {
      const greet = {
        type: "response.create",
        response: { instructions: "Pozdrav! Kako Vam mogu pomoći?" }
      };
      oa.send(JSON.stringify(greet));
    }
  });

  oa.on("close", () => {
    if (!closed) try { twilio.close(); } catch (_) {}
  });
  oa.on("error", (e) => console.error("OpenAI WS error:", e?.message || e));

  // Handle Twilio messages
  twilio.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const ev = m.event;

    if (ev === "start") {
      streamSid = m.start?.streamSid || m.streamSid || streamSid || "STREAM";
      // quick beep to confirm outbound path
      const beep = makeBeepUlaw(200, 880);
      enqueueToTwilio(beep);
      return;
    }

    if (ev === "media") {
      const b64 = m.media?.payload;
      if (!b64 || oa.readyState !== WebSocket.OPEN) return;
      // append μ-law audio from caller into Realtime buffer
      oa.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      return;
    }

    if (ev === "stop") {
      try { oa.close(); } catch (_e) {}
      try { twilio.close(); } catch (_e) {}
      closed = true;
      if (pacingTimer) { clearInterval(pacingTimer); pacingTimer = null; }
      return;
    }
  });

  twilio.on("close", () => {
    closed = true;
    if (pacingTimer) { clearInterval(pacingTimer); pacingTimer = null; }
    try { oa.close(); } catch (_) {}
  });

  // keep the socket alive
  const ping = setInterval(() => {
    if (twilio.readyState === WebSocket.OPEN) try { twilio.ping(); } catch (_) {}
    if (oa.readyState === WebSocket.OPEN) try { oa.ping?.(); } catch (_) {}
  }, 10000);
  twilio.on("close", () => clearInterval(ping));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`up on :${PORT}`));
