import { DurableObject } from "cloudflare:workers";
import { activeEntitlement, addUsage } from "./accounts";
import { budget } from "./budget";
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
const BUSY_CHECK_MS = 60_000;
const IDLE_CHECK_MS = 60 * 60_000;
/** Frames after which a room flushes at once; the local check lowers it. */
const flushEvery = (env: Env) => Number(env.FRAME_FLUSH_EVERY ?? "50000");

export class Room extends DurableObject<Env> {
  /** Bytes forwarded per user since the last flush to D1. */
  #unflushed = new Map<string, { bytes: number; frames: number }>();
  /** Frames counted since the last flush, across accounts. */
  #unflushedFrames = 0;
  /** Durable Object requests this room served since the last flush. */
  #requests = 0;
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
    this.#requests += 1;
    const url = new URL(request.url);
    if (url.pathname === "/claimed") return this.#claimed(request);
    if (url.pathname === "/kick") return this.#kick(request);

    const role = request.headers.get("X-Daedalus-Role") as Role;
    const deviceId = request.headers.get("X-Daedalus-Device") ?? "";
    const userId = request.headers.get("X-Daedalus-User") || null;
    const email = request.headers.get("X-Daedalus-Email") ?? "";

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
    // A claimed Mac learns which account it is on, to show its user.
    if (role === "mac" && userId)
      server.send(JSON.stringify({ relay: "account", email }));
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

    const counted = this.#unflushed.get(sender.userId) ?? {
      bytes: 0,
      frames: 0,
    };
    counted.bytes += message.byteLength;
    counted.frames += 1;
    this.#unflushed.set(sender.userId, counted);
    this.#unflushedFrames += 1;
    // A burst is flushed at once rather than left to run until the next
    // alarm, so a frame limit cannot be overrun by minutes of traffic.
    await this.#ensureAlarm(
      this.#unflushedFrames >= flushEvery(this.env) ? 0 : BUSY_CHECK_MS,
    );
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
   * is under its monthly data. Runs every minute while frames flow and
   * hourly otherwise, so revoking access takes effect within the hour even
   * with no traffic. Usage counted since the last flush is lost if the room
   * is evicted first, which makes the limit a little generous, not unsafe.
   *
   * At the data limit, terminals stop (the Mac is told); past a tenth more,
   * which covers the minute between checks, the account's sockets close.
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
    const frames = this.#unflushedFrames;
    const requests = this.#requests + 2; // this alarm, and setting the next
    this.#unflushed.clear();
    this.#unflushedFrames = 0;
    this.#requests = 0;

    // The relay-wide budget first: past it, everyone here is closed.
    const open = (await budget(this.env).add({ frames, doRequests: requests }))
      .open;
    if (!open) {
      for (const socket of sockets)
        socket.close(CLOSE.budgetExhausted, "Remote access is paused");
    }
    for (const userId of new Set([...users, ...flushed.keys()])) {
      const counted = flushed.get(userId) ?? { bytes: 0, frames: 0 };
      const total = await addUsage(
        this.env.DB,
        userId,
        counted.bytes,
        counted.frames,
      );
      if (!open) continue;
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
      if (
        total.frames >= entitlement.monthlyFrames ||
        total.bytes >= 1.1 * limit
      ) {
        for (const socket of mine)
          socket.close(CLOSE.overQuota, "Monthly limit reached");
      } else if (total.bytes >= limit) {
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
