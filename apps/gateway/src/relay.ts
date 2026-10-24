import type { ServerWebSocket } from "bun";
import type { RelayNotice } from "@daedalus/remote-protocol";

/**
 * The relay: one room per user, holding that user's Macs (`mac:<macId>`) and
 * the runners of their workspaces (`ws:<workspaceId>`). Frames are end-to-end
 * encrypted; the relay reads only the device id at the front of each one
 * (see `packages/remote-protocol/src/frames.ts`), checks the sender may talk
 * to it, and rewrites it to the sender's id before forwarding.
 *
 * A Mac may send only to runners in the room, and a runner only to the Mac
 * its workspace was made from, so nothing ever crosses users. A runner may
 * leave the id empty for that Mac.
 *
 * Unlike apps/relay, a device that joins is told which of its peers are
 * online already, so a runner knows at once whether to queue its events.
 */

export type Peer =
  | { role: "mac"; userId: string; deviceId: string }
  | {
      role: "runner";
      userId: string;
      deviceId: string;
      workspaceId: string;
      /** The device id of the Mac the workspace was made from. */
      macDeviceId: string;
    };

export type PeerSocket = ServerWebSocket<Peer>;

/** Close codes, as apps/relay's, so clients act on them the same way. */
export const CLOSE = {
  replaced: 4000,
  forbidden: 4403,
} as const;

/** As apps/relay: a Mac's snapshot passes 1 MB, so the cap leaves room. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const macDevice = (macId: string) => `mac:${macId}`;
export const runnerDevice = (workspaceId: string) => `ws:${workspaceId}`;

function send(socket: PeerSocket, data: string | Uint8Array): void {
  try {
    socket.send(data);
  } catch {
    // Closed between lookup and send.
  }
}

export class Relay {
  /** userId -> deviceId -> the device's one socket. */
  readonly #rooms = new Map<string, Map<string, PeerSocket>>();
  /** Told of every frame forwarded to or from a workspace's runner. */
  onActivity?: (userId: string, workspaceId: string) => void;

  isOnline(userId: string, deviceId: string): boolean {
    return this.#rooms.get(userId)?.has(deviceId) ?? false;
  }

  /** How many Macs of the user are connected. */
  macCount(userId: string): number {
    let count = 0;
    for (const socket of this.#rooms.get(userId)?.values() ?? [])
      if (socket.data.role === "mac") count += 1;
    return count;
  }

  /** Closes a device's socket, as when its workspace is deleted. */
  kick(userId: string, deviceId: string, reason: string): void {
    const socket = this.#rooms.get(userId)?.get(deviceId);
    socket?.close(CLOSE.forbidden, reason);
  }

  open(socket: PeerSocket): void {
    const peer = socket.data;
    let room = this.#rooms.get(peer.userId);
    if (!room) {
      room = new Map();
      this.#rooms.set(peer.userId, room);
    }
    // A second connection from the same device replaces the first, which is
    // what a reconnect after a network change looks like.
    const old = room.get(peer.deviceId);
    room.set(peer.deviceId, socket);
    if (old) {
      send(old, JSON.stringify({ relay: "replaced" } satisfies RelayNotice));
      old.close(CLOSE.replaced, "Replaced by a newer connection");
    } else this.#notify(peer, true);
    for (const other of room.values())
      if (other !== socket && this.#hears(socket.data, other.data))
        send(socket, notice(other.data.deviceId, true));
  }

  close(socket: PeerSocket): void {
    const peer = socket.data;
    const room = this.#rooms.get(peer.userId);
    // A replaced socket closes after its successor joined; only the current
    // socket leaving means the device went offline.
    if (room?.get(peer.deviceId) !== socket) return;
    room.delete(peer.deviceId);
    if (room.size === 0) this.#rooms.delete(peer.userId);
    this.#notify(peer, false);
  }

  message(socket: PeerSocket, message: string | Buffer): void {
    if (typeof message === "string") {
      if (message === "ping") send(socket, "pong");
      return;
    }
    const sender = socket.data;
    const room = this.#rooms.get(sender.userId);
    if (room?.get(sender.deviceId) !== socket) return;
    const frame = new Uint8Array(message);
    const length = frame[0];
    if (length === undefined || frame.length < 1 + length) return;
    let to = decoder.decode(frame.subarray(1, 1 + length));
    if (sender.role === "runner" && to === "") to = sender.macDeviceId;
    // A Mac reaches any runner of its user; a runner only its own Mac.
    const allowed =
      sender.role === "mac" ? to.startsWith("ws:") : to === sender.macDeviceId;
    if (!allowed) return;
    const target = room.get(to);
    if (!target) return;

    const payload = frame.subarray(1 + length);
    const from = encoder.encode(sender.deviceId);
    const out = new Uint8Array(1 + from.length + payload.length);
    out[0] = from.length;
    out.set(from, 1);
    out.set(payload, 1 + from.length);
    send(target, out);
    this.onActivity?.(
      sender.userId,
      sender.role === "runner" ? sender.workspaceId : to.slice("ws:".length),
    );
  }

  /**
   * Whether `listener` is told when `subject` comes or goes: a Mac hears
   * about every runner of its user, a runner about its own Mac only.
   */
  #hears(listener: Peer, subject: Peer): boolean {
    if (listener.role === "mac") return subject.role === "runner";
    return subject.role === "mac" && subject.deviceId === listener.macDeviceId;
  }

  #notify(subject: Peer, online: boolean): void {
    const room = this.#rooms.get(subject.userId);
    if (!room) return;
    const text = notice(subject.deviceId, online);
    for (const other of room.values())
      if (this.#hears(other.data, subject)) send(other, text);
  }
}

const notice = (deviceId: string, online: boolean): string =>
  JSON.stringify({ relay: "peer", deviceId, online } satisfies RelayNotice);
