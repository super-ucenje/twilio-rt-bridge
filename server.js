// server.js — Twilio <Stream> ↔ OpenAI Realtime (G.711 μ-law 8k) + outbound dial + graceful hangup

import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

// ---------- ENV ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview";
const RAW_LANG       = process.env.LANG || "hr";
const VOICE          = process.env.VOICE || "alloy";
const DEBUG          = (process.env.DEBUG || "0") === "1";

const SESSION_INSTRUCTIONS =
  process.env.SESSION_INSTRUCTIONS ||
  "Ti si Ivana, ljubazna agentica korisničke podrške. Odgovaraj kratko i na hrvatskom. " +
  "Ako korisnik kaže da je gotovo (npr. 'doviđenja', 'bok', 'to je sve', 'prekini'), " +
  "kratko se pristojno oprosti i POZOVI alat hangup_call kako bi se poziv prekinuo.";

const TWILIO_ACCOUNT_SID       = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN        = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_FROM              = process.env.TWILIO_FROM        || "";
const TWILIO_MACHINE_DETECTION = (process.env.TWILIO_MACHINE_DETECTION || "").trim();

const TWIML_URL = (process.env.TWIML_URL || "").trim();
const BASE_URL  = (process.env.BASE_URL  || "").trim();

// ---------- utils ----------
const OA_LANGS = new Set([
  "af","ar","az","be","bg","bs","ca","cs","cy","da","de","el","en","es","et",
  "fa","fi","fr","gl","he","hi","hr","hu","hy","id","is","it","ja","kk","kn",
  "ko","lt","lv","mi","mk","mr","ms","ne","nl","no","pl","pt","ro","ru","sk",
  "sl","sr","sv","sw","ta","th","tl","tr","uk","ur","vi","zh"
]);
function normLang(v, fallback = "hr") {
  if (!v) return fallback;
  let s = String(v).trim().toLowerCase();
  if (s === "c" || s.startsWith("c.")) return fallback;
  s = s.split(/[_.-]/)[0];
  if (s.length !== 2) return fallback;
  return OA_LANGS.has(s) ? s : fallback;
}
const LANG = normLang(RAW_LANG);

function hostBase(req) {
  return BASE_URL || `https://${req.get("host")}`;
}

// ---------- app ----------
const app = express();                      // ✅ create app first
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ✅ now it's safe to mount static
app.use(express.static("public"));          // serves /public/* as https://.../file

app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// TwiML (GET/POST)
app.all("/twiml", (req, res) => {
  const wsUrl = hostBase(req).replace(/^http/, "ws") + "/ws";
  const xml = `
<Response>
  <Connect>
    <Stream url="${wsUrl}"/>
  </Connect>
</Response>`.trim();
  console.log(`[twiml:${req.method}] wsUrl=${wsUrl}`);
  res.set("Content-Type", "text/xml; charset=utf-8").status(200).send(xml);
});

// Twilio status callback (debug)
app.post("/twilio-status", (req, res) => {
  console.log("[/twilio-status]", JSON.stringify(req.body || {}, null, 2));
  res.sendStatus(204);
});

// Outbound call trigger: POST /trigger-call {"to":"+385..."}
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

// HR farewells
const FAREWELL_RE = /\b(dovi[đd]enja?|bok|to je sve|prekini|prekid|prekin[iy]te|hvala(?:\s+vam|\s+ti)?(?:\s+lijepo)?|vidimo se|lijep? pozdrav)\b/i;

wss.on("connection", (twilio, req) => {
  let streamSid = "";
  let callSid   = "";
  let closed    = false;
  console.log("[/ws] Twilio connected from", req.socket.remoteAddress);

  // μ-law pacing to Twilio (160B ~ 20ms)
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
          twilio.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload, track: "outbound" }
          }));
          if (DEBUG) console.log("[twilio<-oa] 160B");
        } catch (e) {
          console.warn("[/ws] twilio.send failed", e?.message || e);
        }
      }, 20);
    }
  }

  // OA Realtime WS
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

  // keep-alive
  const keepAlive = setInterval(() => {
    try { oa.ping(); } catch {}
    try { twilio.ping?.(); } catch {}
  }, 15000);

  // Turn/hangup state
  let commitTimer = null;
  let awaitingResponse = false;

  let hangupRequested = false;
  let hangupReason = "farewell";
  let hangupTimeout = null;

  function scheduleCommitAndRespond(delay = 250) {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      if (oa.readyState !== WebSocket.OPEN) return;
      oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      if (!awaitingResponse) {
        awaitingResponse = true;
        oa.send(JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio", "text"] }
        }));
      }
    }, delay);
  }

  async function twilioHangupNow(reason = "goodbye") {
    if (!callSid || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return;
    try {
      const form = new URLSearchParams();
      form.set("Status", "completed");
      const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
      const r = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: form.toString()
      });
      const t = await r.text();
      if (!r.ok) console.warn("[hangup] Twilio error", r.status, t);
      else console.log("[hangup] Twilio OK", callSid, reason);
    } catch (e) {
      console.warn("[hangup] exception", e?.message || e);
    }
  }

  function drainAndHangup(reason = "goodbye") {
    const check = setInterval(async () => {
      if (outQueue.length === 0) {
        clearInterval(check);
        setTimeout(async () => {
          await twilioHangupNow(reason);
          try { oa.close(); } catch {}
          try { twilio.close(); } catch {}
        }, 120);
      }
    }, 30);
  }

  function requestHangup(reason = "farewell", sayGoodbye = true) {
    if (hangupRequested) return;
    hangupRequested = true;
    hangupReason = reason;

    if (sayGoodbye && oa.readyState === WebSocket.OPEN) {
      oa.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: "Razumijem, prekidam poziv. Doviđenja!"
        }
      }));
    }

    if (hangupTimeout) clearTimeout(hangupTimeout);
    hangupTimeout = setTimeout(() => {
      drainAndHangup(reason);
    }, 2500);
  }

  // --- OA session setup ---
  oa.on("open", () => {
    console.log("[/ws->OA] Realtime open");
    const tools = [{
      type: "function",
      name: "hangup_call",
      description: "Hang up the current phone call immediately when the caller says goodbye or the task is done.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string", description: "why the call should be ended" } }
      }
    }];

    oa.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: SESSION_INSTRUCTIONS,
        modalities: ["audio", "text"],
        voice: VOICE,
        input_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1", language: LANG },
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", silence_duration_ms: 400 },
        tools
      }
    }));

    // first line
    oa.send(JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio", "text"], instructions: "Pozdrav! Kako Vam mogu pomoći?" }
    }));
  });

  // Tool-call args buffering + ACK
  const pendingToolCalls = new Map(); // id -> { name, argsChunk }
  function ackToolOutput(tool_call_id, payload) {
    if (oa.readyState !== WebSocket.OPEN) return;
    oa.send(JSON.stringify({
      type: "response.tool_output",
      tool_call_id,
      output: JSON.stringify(payload ?? { ok: true })
    }));
  }

  // OA messages
  oa.on("message", (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (DEBUG && msg?.type) console.log("[OA]", msg.type);

    // audio deltas
    if (msg.type === "response.audio.delta" && typeof msg.delta === "string" && msg.delta.length) {
      enqueueToTwilio(Buffer.from(msg.delta, "base64"));
    }
    if (msg.type === "response.output_audio.delta" && typeof msg.delta === "string" && msg.delta.length) {
      enqueueToTwilio(Buffer.from(msg.delta, "base64"));
    }
    if (msg.type === "response.delta" && msg.delta && typeof msg.delta.audio === "string") {
      enqueueToTwilio(Buffer.from(msg.delta.audio, "base64"));
    }

    // tool-call args stream
    if (msg.type === "response.function_call_arguments.delta") {
      const id = msg.item_id || msg.tool_call_id || "default";
      const entry = pendingToolCalls.get(id) || { name: msg.name || msg.tool_name || "", argsChunk: "" };
      if (msg.name || msg.tool_name) entry.name = msg.name || msg.tool_name;
      entry.argsChunk += (msg.delta || "");
      pendingToolCalls.set(id, entry);
    }

    if (msg.type === "response.function_call_arguments.done") {
      const id = msg.item_id || msg.tool_call_id || "default";
      const entry = pendingToolCalls.get(id);
      if (entry) {
        pendingToolCalls.delete(id);
        let args = {};
        try { args = entry.argsChunk ? JSON.parse(entry.argsChunk) : {}; } catch {}
        const toolName = entry.name || msg.name || msg.tool_name || "";

        if (DEBUG) console.log("[OA] tool DONE:", toolName, args, "id=", id);

        if (toolName === "hangup_call") {
          ackToolOutput(id, { ok: true, reason: args?.reason || "requested" });
          requestHangup(args?.reason || "tool");
        }
      }
    }

    // backup signals (non-delta)
    if (
      (msg.type === "response.tool_call.created"   && msg.tool?.name === "hangup_call") ||
      (msg.type === "response.tool_call.delta"     && msg.tool_name     === "hangup_call") ||
      (msg.type === "response.tool_call.completed" && (msg.name === "hangup_call" || msg.tool_name === "hangup_call"))
    ) {
      if (DEBUG) console.log("[OA] hangup_call signal (legacy)");
      requestHangup("tool-legacy");
    }

    // user speech transcripts → immediate hangup if farewell
    if (
      (msg.type && msg.type.includes("input_audio_transcription")) &&
      (typeof msg.transcript === "string" || typeof msg.text === "string")
    ) {
      const utt = (msg.transcript || msg.text || "");
      if (DEBUG && utt) console.log("[USER said]", utt);
      if (FAREWELL_RE.test(utt)) {
        requestHangup("user-farewell");
      }
    }

    // When any response finishes, if hangup already requested, drain now
    if (msg.type === "response.completed" || msg.type === "response.error") {
      awaitingResponse = false;
      if (hangupRequested) {
        drainAndHangup(hangupReason);
      }
    }

    if ((msg.type && msg.type.includes("error")) || msg.error) {
      console.warn("[OA ERROR]", JSON.stringify(msg, null, 2));
    }
  });

  oa.on("error", (e) => console.error("[/ws->OA] error:", e?.message || e));
  oa.on("close", () => {
    console.log("[/ws->OA] closed");
    if (!closed) try { twilio.close(); } catch {}
  });

  // ---- Twilio side ----
  twilio.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const ev = m.event;

    if (ev === "connected") { console.log("[/ws] event=connected"); return; }

    if (ev === "start") {
      streamSid = m.start?.streamSid || m.streamSid || streamSid || "STREAM";
      callSid   = m.start?.callSid   || m.callSid   || callSid   || "";
      console.log("[/ws] event=start streamSid=", streamSid, "callSid=", callSid, "lang=", LANG);
      return; // ✅ removed beep
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
      clearInterval(keepAlive);
      if (hangupTimeout) clearTimeout(hangupTimeout);
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
    clearInterval(keepAlive);
    if (hangupTimeout) clearTimeout(hangupTimeout);
    try { oa.close(); } catch {}
  });
});

// ---------- boot ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`up on :${PORT}`));