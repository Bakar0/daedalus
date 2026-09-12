import {
  captureSpikePane,
  ensureSpikeSession,
  sendSpikeInput,
  TmuxControlBridge,
} from "@daedalus/platform";

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const decoder = new TextDecoder();
const output: string[] = [];

await ensureSpikeSession(process.cwd());
const firstBridge = new TmuxControlBridge((bytes) =>
  output.push(decoder.decode(bytes)),
);
void firstBridge.start();
firstBridge.resize(91, 27);
await sleep(150);
await sendSpikeInput(
  "printf '\\033[31mCOLOR\\033[0m Unicode: שלום 世界 😀\\n'; stty size\r",
);
await sleep(1_500);
firstBridge.close();

const firstPass = output.join("");
if (!firstPass.includes("COLOR") || !firstPass.includes("שלום 世界 😀")) {
  throw new Error(
    `Unicode/color interactive output missing: ${JSON.stringify(firstPass)}`,
  );
}
if (!firstPass.includes("27 91")) {
  throw new Error(
    `Resize was not observed by the shell: ${JSON.stringify(firstPass)}`,
  );
}

const reconnectCapture = decoder.decode(await captureSpikePane());
if (!reconnectCapture.includes("שלום 世界 😀")) {
  throw new Error("Durable tmux capture did not survive bridge disconnect");
}

const secondOutput: string[] = [];
const secondBridge = new TmuxControlBridge((bytes) =>
  secondOutput.push(decoder.decode(bytes)),
);
void secondBridge.start();
await sleep(150);
await sendSpikeInput("printf 'RECONNECTED\\n'\r");
await sleep(1_000);
secondBridge.close();
if (!secondOutput.join("").includes("RECONNECTED")) {
  throw new Error("Live output did not resume after reconnect");
}

console.log("PASS interactive input/output");
console.log("PASS ANSI color and Unicode bytes");
console.log("PASS resize (27 rows x 91 columns)");
console.log("PASS disconnect capture and live reconnect");
console.log("PASS tmux session persistence independent of bridge lifecycle");
