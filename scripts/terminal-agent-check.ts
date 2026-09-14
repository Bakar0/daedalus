import {
  captureTmuxPane,
  CommandTmuxClient,
  TmuxPtyBridge,
} from "@daedalus/platform";

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const tmux = new CommandTmuxClient(`daedalus-terminal-test-${suffix}`);
const session = `daedalus_${suffix}`;
const target = { socketName: tmux.socketName, session };
const decoder = new TextDecoder();

await tmux.createSession({
  session,
  cwd: process.cwd(),
  executable: "/bin/sh",
  args: [],
});

try {
  const firstOutput: string[] = [];
  let observedBytes = 0;
  const firstBridge = new TmuxPtyBridge(
    (bytes) => {
      observedBytes += bytes.byteLength;
      if (firstOutput.join("").length < 1_000_000)
        firstOutput.push(decoder.decode(bytes));
    },
    target,
    { cols: 93, rows: 31 },
  );
  void firstBridge.start();
  await sleep(150);
  firstBridge.resize(93, 31);
  await sleep(100);
  firstBridge.write(
    "printf '\\033[35mAGENT_COLOR\\033[0m Unicode: שלום 世界 😀\\n'; stty size\r",
  );
  await sleep(700);
  firstBridge.write(
    "stty raw -echo; dd bs=1 count=3 2>/dev/null | od -An -tx1; stty sane\r",
  );
  await sleep(100);
  firstBridge.write("\u001b[Z");
  await sleep(300);
  firstBridge.write(
    "i=0; while [ $i -lt 5000 ]; do printf 'NOISE-%04d-abcdefghijklmnopqrstuvwxyz\\n' $i; i=$((i+1)); done; printf 'NOISE_DONE\\n'\r",
  );
  await sleep(1_300);
  firstBridge.close();

  const live = firstOutput.join("");
  if (!live.includes("AGENT_COLOR") || !live.includes("שלום 世界 😀"))
    throw new Error("ANSI or Unicode agent output was not delivered live");
  if (!live.includes("31 93"))
    throw new Error(
      `Agent terminal resize failed: ${JSON.stringify(live.slice(-2_000))}`,
    );
  if (!/1b\s+5b\s+5a/.test(live))
    throw new Error("Shift+Tab escape sequence was not preserved by the PTY");
  if (!live.includes("NOISE_DONE"))
    throw new Error(`Large output was incomplete (${observedBytes} bytes)`);

  const capture = decoder.decode(await captureTmuxPane(target));
  if (!capture.includes("NOISE_DONE"))
    throw new Error("Bounded reconnect capture missed recent output");

  const secondOutput: string[] = [];
  const secondBridge = new TmuxPtyBridge(
    (bytes) => secondOutput.push(decoder.decode(bytes)),
    target,
  );
  void secondBridge.start();
  await sleep(150);
  secondBridge.write("printf 'AGENT_RECONNECTED\\n'\r");
  await sleep(600);
  secondBridge.close();
  if (!secondOutput.join("").includes("AGENT_RECONNECTED"))
    throw new Error("Live output did not resume after reconnect");

  console.log("PASS per-agent interactive input and output");
  console.log("PASS ANSI and Unicode delivery");
  console.log("PASS resize (31 rows x 93 columns)");
  console.log("PASS Shift+Tab escape sequence");
  console.log(`PASS noisy redraw (${observedBytes} PTY bytes observed)`);
  console.log("PASS bounded capture and reconnect");
  console.log("PASS tmux remains authoritative across bridge cleanup");
} finally {
  await tmux.stop(session, true);
  if (await tmux.hasSession(session))
    throw new Error("Terminal test session cleanup failed");
}
