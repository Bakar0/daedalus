// A stand-in for an ACP adapter, run as a child by the host's tests. It
// speaks newline-delimited JSON-RPC on stdio and answers by the prompt's text:
// "permission" asks before it writes, "slow" runs until cancelled, "ask"
// sends a request no client supports, and anything else is echoed.
type Message = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

const send = (message: Message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (update: Record<string, unknown>) =>
  send({
    method: "session/update",
    params: { sessionId: "fake-1", update },
  });
const say = (text: string) =>
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });

const waiting = new Map<number, (message: Message) => void>();
let cancelled: (() => void) | undefined;

async function prompt(id: number, text: string): Promise<void> {
  if (text.includes("permission")) {
    update({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      kind: "edit",
      status: "pending",
      title: "Write hello.txt",
    });
    const answer = await new Promise<Message>((resolve) => {
      waiting.set(900, resolve);
      send({
        id: 900,
        method: "session/request_permission",
        params: {
          sessionId: "fake-1",
          toolCall: { toolCallId: "tool-1", title: "Write hello.txt" },
          options: [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        },
      });
    });
    const outcome = (answer.result as { outcome?: Record<string, unknown> })
      ?.outcome;
    if (outcome?.outcome === "cancelled") {
      send({ id, result: { stopReason: "cancelled" } });
      return;
    }
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: outcome?.optionId === "yes" ? "completed" : "failed",
    });
    say(outcome?.optionId === "yes" ? "written" : "refused");
  } else if (text.includes("slow")) {
    say("working");
    await new Promise<void>((resolve) => (cancelled = resolve));
    send({ id, result: { stopReason: "cancelled" } });
    return;
  } else if (text.includes("ask")) {
    const answer = await new Promise<Message>((resolve) => {
      waiting.set(901, resolve);
      send({ id: 901, method: "fs/read_text_file", params: { path: "/x" } });
    });
    say(answer.error ? "no file access" : "file read");
  } else {
    say("you said: ");
    say(text);
  }
  send({ id, result: { stopReason: "end_turn" } });
}

function handle(message: Message): void {
  if (message.method === undefined) {
    if (message.id !== undefined) {
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
    return;
  }
  const { id, method, params = {} } = message;
  if (method === "session/cancel") {
    cancelled?.();
    cancelled = undefined;
    return;
  }
  if (id === undefined) return;
  if (method === "initialize")
    send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (method === "session/new")
    send({
      id,
      result: {
        sessionId: "fake-1",
        modes: { currentModeId: "default", meta: params._meta ?? null },
      },
    });
  else if (method === "session/load" && params.sessionId === "never-written")
    send({ id, error: { code: -32002, message: "No such session" } });
  else if (method === "session/load") {
    update({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "earlier" },
    });
    send({ id, result: {} });
  } else if (method === "session/set_mode")
    if (params.modeId === "nope")
      send({ id, error: { code: -32602, message: "No such mode" } });
    else {
      update({ sessionUpdate: "current_mode_update", modeId: params.modeId });
      send({ id, result: {} });
    }
  else if (method === "session/prompt") {
    const blocks = params.prompt as Array<{ text?: string }>;
    void prompt(id, blocks.map((block) => block.text ?? "").join(""));
  } else send({ id, error: { code: -32601, message: "Unknown method" } });
}

if (process.argv.includes("--die")) {
  process.stderr.write("not signed in\n");
  process.exit(3);
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += String(chunk);
  let at: number;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line) handle(JSON.parse(line) as Message);
  }
});
process.stdin.on("end", () => process.exit(0));
