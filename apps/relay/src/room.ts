import { DurableObject } from "cloudflare:workers";
import { activeEntitlement, addUsage } from "./accounts";
import { CLOSE, type Env, PROTOCOL } from "./util";

/**
 * One room per Mac. It holds the WebSocket of that Mac and of the phones
 * talking to it, and forwards binary frames between them. Frames are
 * end-to-end encrypted by the devices; the room reads only the routing id at
 * the front of each frame (see `packages/remote-protocol/src/frames.ts`).
 *
 * The Worker has already checked who is connecting before a request gets
 * here, and passes the result in `X-Daedalus-*` headers that only it can
 * set, since a room is reachable only through its namespace binding.
 */

type Role = "mac" | "phone";

interface Attachment {
  role: Role;
  deviceId: string;
  /** Null for a Mac nobody has claimed yet. */
  userId: string | null;
}

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PHONES = 10;
const BUSY_CHECK_MS = 5 * 60_000;
const IDLE_CHECK_MS = 60 * 60_000;

export class Room extends DurableObject<Env> {
  /** Bytes forwarded per user since the last flush to D1. */
  #unflushed = new Map<string, number>();
  /** When the next alarm fires: 0 for none, undefined until read. */
  #alarmAt: number | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive pings are answered without waking the room, so an idle
    // connected Mac is not billed for duration.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/claimed") return this.#claimed(request);
    if (url.pathname === "/kick") return this.#kick(request);

    const role = request.headers.get("X-Daedalus-Role") as Role;
    const deviceId = request.headers.get("X-Daedalus-Device") ?? "";
    const userId = request.headers.get("X-Daedalus-User") || null;

    if (
      role === "phone" &&
      this.ctx.getWebSockets("phone").length >= MAX_PHONES &&
      this.#sockets(`phone:${deviceId}`).length === 0
    )
      return new Response("Too many phones", { status: 429 });
    // A second connection from the same device replaces the first, which is
    // what a reconnect after a network change looks like.
    for (const old of this.#sockets(`${role}:${deviceId}`)) {
      old.send(JSON.stringify({ relay: "replaced" }));
      old.close(CLOSE.replaced, "Replaced by a newer connection");
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [role, `${role}:${deviceId}`]);
    server.serializeAttachment({ role, deviceId, userId } satisfies Attachment);
    this.#notice(role, deviceId, true);
    await this.#ensureAlarm(IDLE_CHECK_MS);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "Sec-WebSocket-Protocol": PROTOCOL },
    });
  }

  /** A phone claimed this Mac: hand it its device token and let it rejoin. */
  async #claimed(request: Request): Promise<Response> {
    const { token } = (await request.json()) as { token: string };
    for (const mac of this.ctx.getWebSockets("mac")) {
      mac.send(JSON.stringify({ relay: "claimed", token }));
      mac.close(CLOSE.claimed, "Claimed");
    }
    return new Response("ok");
  }

  /** A device was revoked or its account lost access. */
  async #kick(request: Request): Promise<Response> {
    const { deviceId, code } = (await request.json()) as {
      deviceId?: string;
      code?: number;
    };
    const sockets = deviceId
      ? [
          ...this.#sockets(`mac:${deviceId}`),
          ...this.#sockets(`phone:${deviceId}`),
        ]
      : this.ctx.getWebSockets();
    for (const socket of sockets)
      socket.close(code ?? CLOSE.forbidden, "Access removed");
    return new Response("ok");
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

    // An unclaimed Mac has no phones to talk to.
    if (!sender.userId) return;
    const target =
      sender.role === "phone"
        ? this.#sockets("mac")[0]
        : this.#sockets(
            `phone:${new TextDecoder().decode(frame.subarray(1, 1 + length))}`,
          )[0];
    if (!target) return;

    const from = new TextEncoder().encode(sender.deviceId);
    const out = new Uint8Array(1 + from.length + payload.length);
    out[0] = from.length;
    out.set(from, 1);
    out.set(payload, 1 + from.length);
    target.send(out);

    this.#unflushed.set(
      sender.userId,
      (this.#unflushed.get(sender.userId) ?? 0) + message.byteLength,
    );
    await this.#ensureAlarm(BUSY_CHECK_MS);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const { role, deviceId } = ws.deserializeAttachment() as Attachment;
    // A replaced socket closes after its successor joined; only the last
    // socket for a device leaving means the device went offline.
    const remaining = this.#sockets(`${role}:${deviceId}`).filter(
      (socket) => socket !== ws,
    );
    if (remaining.length === 0) this.#notice(role, deviceId, false);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /**
   * Flushes usage, then checks every connected account still has access and
   * is under its monthly data. Runs every 5 minutes while frames flow and
   * hourly otherwise, so revoking access takes effect within the hour even
   * with no traffic. Usage counted since the last flush is lost if the room
   * is evicted first, which makes the limit a little generous, not unsafe.
   */
  override async alarm(): Promise<void> {
    this.#alarmAt = 0;
    const sockets = this.ctx.getWebSockets();
    const users = new Set<string>();
    for (const socket of sockets) {
      const { userId } = socket.deserializeAttachment() as Attachment;
      if (userId) users.add(userId);
    }
    const flushed = new Map(this.#unflushed);
    this.#unflushed.clear();
    for (const userId of new Set([...users, ...flushed.keys()])) {
      const total = await addUsage(
        this.env.DB,
        userId,
        flushed.get(userId) ?? 0,
      );
      const entitlement = await activeEntitlement(this.env.DB, userId);
      const mine = sockets.filter(
        (socket) =>
          (socket.deserializeAttachment() as Attachment).userId === userId,
      );
      if (!entitlement) {
        for (const socket of mine)
          socket.close(CLOSE.noEntitlement, "No active access");
        continue;
      }
      const limit = entitlement.monthlyMb * 1024 * 1024;
      if (total >= 2 * limit) {
        for (const socket of mine)
          socket.close(CLOSE.overQuota, "Monthly data limit reached");
      } else if (total >= limit) {
        const notice = JSON.stringify({
          relay: "quota",
          limitMb: entitlement.monthlyMb,
        });
        for (const socket of mine) socket.send(notice);
      }
    }
    if (this.ctx.getWebSockets().length > 0)
      await this.#ensureAlarm(IDLE_CHECK_MS);
  }

  async #ensureAlarm(delayMs: number): Promise<void> {
    this.#alarmAt ??= (await this.ctx.storage.getAlarm()) ?? 0;
    const wanted = Date.now() + delayMs;
    if (this.#alarmAt !== 0 && this.#alarmAt <= wanted) return;
    await this.ctx.storage.setAlarm(wanted);
    this.#alarmAt = wanted;
  }

  #sockets(tag: string): WebSocket[] {
    return this.ctx.getWebSockets(tag);
  }

  /** Tells the other side that a device came or went. */
  #notice(role: Role, deviceId: string, online: boolean): void {
    const text = JSON.stringify({ relay: "peer", deviceId, online });
    if (role === "phone") this.#sockets("mac")[0]?.send(text);
    else for (const phone of this.ctx.getWebSockets("phone")) phone.send(text);
  }
}
