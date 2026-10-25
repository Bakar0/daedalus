import { expect, test } from "bun:test";
import { SocketWriter } from "./socket-writer";

/**
 * A socket whose buffer holds `room` bytes until `drain` empties it, as a
 * Unix socket's does until the reader reads.
 */
function fakeSocket(room: number) {
  const received: number[] = [];
  let free = room;
  let ended = false;
  let closed = false;
  return {
    received,
    get ended() {
      return ended;
    },
    drain() {
      free = room;
    },
    close() {
      closed = true;
    },
    write(data: Uint8Array) {
      if (closed) return -1;
      const taken = Math.min(free, data.byteLength);
      free -= taken;
      received.push(...data.subarray(0, taken));
      return taken;
    },
    end() {
      ended = true;
    },
  };
}

test("keeps what one write could not take and sends it on drain", () => {
  const socket = fakeSocket(3);
  const writer = new SocketWriter(socket);
  writer.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
  writer.write("ab");
  expect(socket.received).toEqual([1, 2, 3]);
  expect(writer.pendingBytes).toBe(6);
  writer.end();
  expect(socket.ended).toBe(false);
  socket.drain();
  writer.flush();
  expect(socket.received).toEqual([1, 2, 3, 4, 5, 6]);
  socket.drain();
  writer.flush();
  expect(socket.received).toEqual([1, 2, 3, 4, 5, 6, 7, 97, 98]);
  expect(socket.ended).toBe(true);
  writer.write("late");
  expect(socket.received).toHaveLength(9);
});

test("ends at once when nothing is pending", () => {
  const socket = fakeSocket(100);
  const writer = new SocketWriter(socket);
  writer.write("hi");
  writer.end();
  expect(socket.ended).toBe(true);
});

test("a reader that does not read is cut off past the pending limit", () => {
  const socket = fakeSocket(0);
  const writer = new SocketWriter(socket, 10);
  writer.write("12345");
  expect(socket.ended).toBe(false);
  writer.write("678901");
  expect(socket.ended).toBe(true);
  expect(writer.pendingBytes).toBe(0);
});

test("a closed socket drops what is pending", () => {
  const socket = fakeSocket(2);
  const writer = new SocketWriter(socket);
  writer.write("abcdef");
  socket.close();
  writer.flush();
  expect(writer.pendingBytes).toBe(0);
  expect(socket.ended).toBe(true);
});
