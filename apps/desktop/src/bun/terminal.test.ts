import { describe, expect, test, vi } from "vitest";
import {
  authorizeTerminalRequest,
  BoundedTerminalBuffer,
  isTyping,
  TerminalConnection,
} from "./terminal";

const AGENT_ID = "12345678-1234-4123-8123-123456789abc";

describe("terminal transport authentication", () => {
  test("requires the private token, terminal path, and a UUID session id", () => {
    expect(
      authorizeTerminalRequest(
        new Request(`http://127.0.0.1/terminal?token=secret&agent=${AGENT_ID}`),
        "secret",
      ),
    ).toEqual({ kind: "agent", id: AGENT_ID });
    expect(
      authorizeTerminalRequest(
        new Request(
          `http://127.0.0.1/terminal?token=secret&integrated=${AGENT_ID}&cols=120&rows=32`,
        ),
        "secret",
      ),
    ).toEqual({
      kind: "integrated",
      id: AGENT_ID,
      initialSize: { cols: 120, rows: 32 },
    });
    expect(
      authorizeTerminalRequest(
        new Request(`http://127.0.0.1/terminal?agent=${AGENT_ID}`),
        "secret",
      ),
    ).toBeUndefined();
    expect(
      authorizeTerminalRequest(
        new Request(
          `http://127.0.0.1/terminal?token=secret&agent=${AGENT_ID}&integrated=${AGENT_ID}`,
        ),
        "secret",
      ),
    ).toBeUndefined();
    expect(
      authorizeTerminalRequest(
        new Request("http://127.0.0.1/terminal?token=secret&agent=not-an-id"),
        "secret",
      ),
    ).toBeUndefined();
    expect(
      authorizeTerminalRequest(
        new Request(
          `http://127.0.0.1/terminal?token=secret&agent=${AGENT_ID}&cols=1&rows=1`,
        ),
        "secret",
      ),
    ).toBeUndefined();
  });
});

describe("bounded terminal buffering", () => {
  test("retains only bounded recent output from a noisy producer", () => {
    const buffer = new BoundedTerminalBuffer(10);
    buffer.push(new TextEncoder().encode("123456"));
    buffer.push(new TextEncoder().encode("abcdef"));
    expect(buffer.byteLength).toBeLessThanOrEqual(10);
    expect(buffer.takeDroppedBytes()).toBe(6);
    expect(new TextDecoder().decode(buffer.shift())).toBe("abcdef");

    buffer.push(new TextEncoder().encode("0123456789OVERFLOW"));
    expect(buffer.byteLength).toBe(10);
    expect(new TextDecoder().decode(buffer.shift())).toBe("89OVERFLOW");
  });
});

describe("terminal connection lifecycle", () => {
  test("forwards PTY output, input, and resize and cleans up", async () => {
    const sent: Array<string | Uint8Array> = [];
    const write = vi.fn();
    const resize = vi.fn();
    const close = vi.fn();
    let output: ((chunk: Uint8Array) => void) | undefined;
    const connection = new TerminalConnection({
      agentId: AGENT_ID,
      socket: {
        send: (data) => void sent.push(data),
        getBufferedAmount: () => 0,
      },
      status: "reconnected",
      createBridge: (listener) => {
        output = listener;
        return { start: async () => {}, write, resize, close };
      },
    });

    await connection.start();
    output?.(new TextEncoder().encode("\r\nlive"));
    await connection.message(JSON.stringify({ type: "input", data: "go\r" }));
    await connection.message(
      JSON.stringify({ type: "resize", cols: 101, rows: 32 }),
    );
    connection.close();

    expect(String(sent[0])).toContain('"status":"reconnected"');
    expect(new TextDecoder().decode(sent[1] as Uint8Array)).toBe("\r\nlive");
    expect(write).toHaveBeenCalledWith("go\r");
    expect(resize).toHaveBeenCalledWith(101, 32);
    expect(close).toHaveBeenCalledOnce();
  });

  test("pauses delivery above the socket high-water mark and bounds queued output", async () => {
    const sent: Array<string | Uint8Array> = [];
    let buffered = 300 * 1024;
    let output: ((chunk: Uint8Array) => void) | undefined;
    const connection = new TerminalConnection({
      agentId: AGENT_ID,
      socket: {
        send: (data) => void sent.push(data),
        getBufferedAmount: () => buffered,
      },
      status: "live",
      createBridge: (listener) => {
        output = listener;
        return {
          start: async () => {},
          write: () => {},
          resize: () => {},
          close: () => {},
        };
      },
    });
    await connection.start();
    output?.(new Uint8Array(2 * 1024 * 1024));
    expect(connection.buffer.byteLength).toBe(1024 * 1024);
    buffered = 0;
    connection.flush();
    expect(
      sent.some((item) => String(item).includes('"type":"overflow"')),
    ).toBe(true);
    connection.close();
  });

  test("reports a lost session and closes both socket and bridge", async () => {
    const sent: Array<string | Uint8Array> = [];
    const closeSocket = vi.fn();
    const closeBridge = vi.fn();
    const connection = new TerminalConnection({
      agentId: AGENT_ID,
      socket: {
        send: (data) => void sent.push(data),
        close: closeSocket,
      },
      status: "live",
      createBridge: () => ({
        start: async () => {},
        write: () => {},
        resize: () => {},
        close: closeBridge,
      }),
    });
    await connection.start();
    connection.end("lost");
    expect(sent.some((item) => String(item).includes('"status":"lost"'))).toBe(
      true,
    );
    expect(closeBridge).toHaveBeenCalledOnce();
    expect(closeSocket).toHaveBeenCalledOnce();
  });
});

describe("isTyping", () => {
  test("a keystroke is typing; the terminal answering for itself is not", () => {
    expect(isTyping("a")).toBe(true);
    expect(isTyping("\r")).toBe(true);
    expect(isTyping("\x1b")).toBe(true);
    // Focus reports, a cursor position report and a device attributes answer.
    expect(isTyping("\x1b[I")).toBe(false);
    expect(isTyping("\x1b[O")).toBe(false);
    expect(isTyping("\x1b[12;40R")).toBe(false);
    expect(isTyping("\x1b[?62;22c")).toBe(false);
    expect(isTyping("\x1b]11;rgb:0000/0000/0000\x07")).toBe(false);
    // A DCS answer, such as xterm.js's reply to a version query.
    expect(isTyping("\x1bP>|xterm.js(5.5.0)\x1b\\")).toBe(false);
    expect(isTyping("\x1b[Ix")).toBe(true);
    // Mouse reports scroll and select; they are not typing.
    expect(isTyping("\x1b[<64;10;5M\x1b[<65;10;5M")).toBe(false);
    expect(isTyping("\x1b[M`!!")).toBe(false);
  });
});
