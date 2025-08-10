// server.js — minimal Express + WS that works on Railway
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();

// health + root
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.status(200).send("ok"));

const server = http.createServer(app);

// basic WS endpoint so Twilio can connect later
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  console.log("WS connected");
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg?.event === "start") {
      const streamSid = msg.start?.streamSid || "TEST";
      // send one silent μ-law frame to prove outbound works
      const payload = Buffer.alloc(160, 0xff).toString("base64");
      ws.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
    }
  });
});

// IMPORTANT: listen on Railway's assigned port and 0.0.0.0
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`up on :${PORT}`));
