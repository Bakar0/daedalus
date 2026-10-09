import { DurableObject } from "cloudflare:workers";

/**
 * The Daedalus relay. One Durable Object ("room") per Mac holds that Mac's
 * WebSocket and those of the phones talking to it, and forwards binary frames
 * between them. Frames are end-to-end encrypted by the devices; the relay
 * reads only the routing id at the front of each frame (see
 * `packages/remote-protocol/src/frames.ts`).
 *
 * Phase 0 has no accounts: anyone who knows a Mac's id can join its room.
 * They cannot read or forge anything, because pairing and every message are
 * checked by the devices, but they can knock. Accounts and entitlements come
 * in phase 1 and gate `connect` here.
 */

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
}

type Role = "mac" | "phone";

interface Attachment {
  role: Role;
  deviceId: string;
}

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PHONES = 10;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname !== "/v1/connect")
      return new Response("Not found", { status: 404 });
    const room = url.searchParams.get("room") ?? "";
    const role = url.searchParams.get("role");
    const device = url.searchParams.get("device") ?? "";
    if (
      !ID.test(room) ||
      !ID.test(device) ||
      (role !== "mac" && role !== "phone") ||
      (role === "mac" && device !== room)
    )
      return new Response("Bad connect request", { status: 400 });
    if (request.headers.get("Upgrade") !== "websocket")
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive pings are answered without waking the object, so an idle
    // connected Mac is not billed for duration.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") as Role;
    const deviceId = url.searchParams.get("device") as string;

    if (role === "phone") {
      const phones = this.ctx.getWebSockets("phone");
      if (phones.length >= MAX_PHONES && !this.#socket("phone", deviceId))
        return new Response("Too many phones", { status: 429 });
    }
    // A second connection from the same device replaces the first, which is
    // what a reconnect after a network change looks like.
    for (const old of this.ctx.getWebSockets(`${role}:${deviceId}`)) {
      old.send(JSON.stringify({ relay: "replaced" }));
      old.close(4000, "Replaced by a newer connection");
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [role, `${role}:${deviceId}`]);
    server.serializeAttachment({ role, deviceId } satisfies Attachment);
    this.#notice(role, deviceId, true);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message === "string") return;
    if (message.byteLength > MAX_FRAME_BYTES) {
      ws.close(1009, "Frame too large");
      return;
    }
    const sender = ws.deserializeAttachment() as Attachment;
    const frame = new Uint8Array(message);
    const length = frame[0];
    if (length === undefined || frame.length < 1 + length) return;
    const payload = frame.subarray(1 + length);

    const target =
      sender.role === "phone"
        ? this.#socket("mac")
        : this.#socket(
            "phone",
            new TextDecoder().decode(frame.subarray(1, 1 + length)),
          );
    if (!target) return;

    const from = new TextEncoder().encode(sender.deviceId);
    const out = new Uint8Array(1 + from.length + payload.length);
    out[0] = from.length;
    out.set(from, 1);
    out.set(payload, 1 + from.length);
    target.send(out);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const { role, deviceId } = ws.deserializeAttachment() as Attachment;
    // A replaced socket closes after its successor joined; only the last
    // socket for a device leaving means the device went offline.
    const remaining = this.ctx
      .getWebSockets(`${role}:${deviceId}`)
      .filter((socket) => socket !== ws);
    if (remaining.length === 0) this.#notice(role, deviceId, false);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  #socket(role: Role, deviceId?: string): WebSocket | undefined {
    const sockets = this.ctx.getWebSockets(
      deviceId === undefined ? role : `${role}:${deviceId}`,
    );
    return sockets[sockets.length - 1];
  }

  /** Tells the other side that a device came or went. */
  #notice(role: Role, deviceId: string, online: boolean): void {
    const text = JSON.stringify({ relay: "peer", deviceId, online });
    if (role === "phone") this.#socket("mac")?.send(text);
    else for (const phone of this.ctx.getWebSockets("phone")) phone.send(text);
  }
}
