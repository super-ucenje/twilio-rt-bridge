// server.js
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.use("/static", express.static(path.join(__dirname, "static")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// --- μ-law helpers (tiny, good enough for beep) ---
const BIAS = 0x84, CLIP = 32635;
function pcm16ToUlawByte(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0f;
  const ulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return ulaw;
}
function makeBeepUlaw(durationMs = 300, freq = 880, amp = 8000) {
  const samples = Math.floor(8000 * (durationMs / 1000));
  const out = new Uint8Array(samples);
  for (let n = 0; n < samples; n++) {
    const s = Math.round(amp * Math.sin(2 * Math.PI * freq * (n / 8000)));
    out[n] = pcm16ToUlawByte(s);
  }
  return out;
}
function chunk160AndB64(ulawBytes) {
  const chunks = [];
  for (let i = 0; i < ulawBytes.length; i += 160) {
    const slice = ulawBytes.slice(i, Math.min(i + 160, ulawBytes.length));
    const padded = new Uint8Array(160);
    padded.set(slice);
    chunks.push(Buffer.from(padded).toString("base64"));
  }
  return chunks;
}

wss.on("connection", (ws) => {
  let streamSid = "";
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    const ev = msg.event;
    if (ev === "start") {
      streamSid = msg.start?.streamSid || msg.streamSid || "";
      // Send a short beep immediately so you hear something
      const beep = makeBeepUlaw(250, 880);
      for (const b64 of chunk160AndB64(beep)) {
        ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
      }
    } else if (ev === "media") {
      // For now we just swallow frames. Next step: pipe to OpenAI Realtime.
      // const b64 = msg.media?.payload; // base64 μ-law from Twilio every 20 ms
    } else if (ev === "stop") {
      try { ws.close(); } catch {}
    }
  });

  // Keep-alive ping (Twilio tolerates idle, but this helps on some hosts)
  const ping = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 10000);
  ws.on("close", () => clearInterval(ping));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`up on :${PORT}`));


