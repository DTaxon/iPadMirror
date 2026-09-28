import { DurableObject } from "cloudflare:workers";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;
const TURN_TTL_SECONDS = 4 * 60 * 60;

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN || "*";

  if (allowed === "*") {
    headers.set("Access-Control-Allow-Origin", "*");
  } else if (origin === allowed) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }

  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let result = "";
  for (const byte of bytes) result += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return result;
}

function validCode(value) {
  return new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(value);
}

async function getIceServers(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return {
      mode: "stun-only",
      iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
    };
  }

  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    console.error("TURN credential request failed", response.status, detail);
    throw new Error("TURN credential generation failed.");
  }

  const data = await response.json();
  return {
    mode: "stun-turn",
    iceServers: data.iceServers,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), request, env);
    }

    if (url.pathname === "/health") {
      return withCors(json({ ok: true, service: "ipad-mirror-signal" }), request, env);
    }

    if (url.pathname === "/api/session" && request.method === "POST") {
      return withCors(json({ code: randomCode() }, { status: 201 }), request, env);
    }

    if (url.pathname === "/api/ice" && request.method === "GET") {
      try {
        const config = await getIceServers(env);
        return withCors(json(config), request, env);
      } catch (error) {
        return withCors(json({ error: error.message }, { status: 502 }), request, env);
      }
    }

    if (url.pathname.startsWith("/ws/")) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      const code = url.pathname.slice(4).toUpperCase();
      if (!validCode(code)) return new Response("Invalid session code", { status: 400 });

      const role = url.searchParams.get("role");
      if (role !== "viewer" && role !== "sender") {
        return new Response("role must be viewer or sender", { status: 400 });
      }

      const stub = env.SIGNALING_SESSION.getByName(code);
      return stub.fetch(request);
    }

    return withCors(
      json({
        service: "ipad-mirror-signal",
        endpoints: ["POST /api/session", "GET /api/ice", "GET /ws/:code?role=viewer|sender", "GET /health"],
      }),
      request,
      env,
    );
  },
};

export class SignalingSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    if (role !== "viewer" && role !== "sender") {
      return new Response("Invalid role", { status: 400 });
    }

    const existing = this.ctx.getWebSockets().find((socket) => {
      const attachment = socket.deserializeAttachment();
      return attachment?.role === role;
    });

    if (existing) {
      return new Response(`A ${role} is already connected to this session`, { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, connectedAt: Date.now() });

    this.sendTo(server, {
      type: "welcome",
      role,
      peerConnected: this.hasPeer(role),
    });
    this.broadcastExcept(server, { type: "peer-status", role, connected: true });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment();
    if (!attachment?.role) return;

    let payload;
    try {
      payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      this.sendTo(ws, { type: "error", message: "Invalid JSON message" });
      return;
    }

    const allowedTypes = new Set(["ready", "offer", "answer", "ice", "bye"]);
    if (!allowedTypes.has(payload.type)) {
      this.sendTo(ws, { type: "error", message: "Unsupported signaling message" });
      return;
    }

    if (payload.type === "ready") {
      this.sendTo(ws, { type: "peer-status", connected: this.hasPeer(attachment.role) });
      return;
    }

    this.broadcastExcept(ws, payload);
  }

  async webSocketClose(ws, code, reason) {
    const attachment = ws.deserializeAttachment();
    try { ws.close(code, reason); } catch (_) {}
    if (attachment?.role) {
      this.broadcastExcept(ws, { type: "peer-left", role: attachment.role });
    }
  }

  async webSocketError(ws, error) {
    console.error("WebSocket error", error);
    const attachment = ws.deserializeAttachment();
    if (attachment?.role) {
      this.broadcastExcept(ws, { type: "peer-left", role: attachment.role });
    }
  }

  hasPeer(role) {
    return this.ctx.getWebSockets().some((socket) => {
      const attachment = socket.deserializeAttachment();
      return attachment?.role && attachment.role !== role;
    });
  }

  broadcastExcept(excluded, payload) {
    const encoded = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== excluded) {
        try { socket.send(encoded); } catch (_) {}
      }
    }
  }

  sendTo(socket, payload) {
    try { socket.send(JSON.stringify(payload)); } catch (_) {}
  }
}
