import { describe, expect, test } from "vitest";
import type { TerminalSize } from "@daedalus/platform";
import { PhoneWindowSize } from "./remote";

class RecordingTmux {
  readonly calls: string[] = [];
  async pinWindowSize(session: string, size: TerminalSize) {
    this.calls.push(`pin ${session} ${size.cols}x${size.rows}`);
  }
  async unpinWindowSize(session: string) {
    this.calls.push(`unpin ${session}`);
  }
}

const setup = () => {
  const tmux = new RecordingTmux();
  return { tmux, sizes: new PhoneWindowSize(tmux) };
};

describe("PhoneWindowSize", () => {
  test("hold pins the window to the phone's size", async () => {
    const { tmux, sizes } = setup();
    await sizes.hold("a", { cols: 50, rows: 20 });
    expect(tmux.calls).toEqual(["pin a 50x20"]);
  });

  test("the window stays pinned until the last phone releases", async () => {
    const { tmux, sizes } = setup();
    await sizes.hold("a", { cols: 50, rows: 20 });
    await sizes.hold("a", { cols: 60, rows: 25 });
    await sizes.release("a");
    expect(tmux.calls).toEqual(["pin a 50x20", "pin a 60x25"]);
    await sizes.release("a");
    expect(tmux.calls.at(-1)).toBe("unpin a");
  });

  test("sessions are pinned and released independently", async () => {
    const { tmux, sizes } = setup();
    await sizes.hold("a", { cols: 50, rows: 20 });
    await sizes.hold("b", { cols: 40, rows: 15 });
    await sizes.release("a");
    expect(tmux.calls).toEqual(["pin a 50x20", "pin b 40x15", "unpin a"]);
  });

  test("yieldToMac unpins once and only while a phone holds the session", async () => {
    const { tmux, sizes } = setup();
    await sizes.yieldToMac("a");
    expect(tmux.calls).toEqual([]);
    await sizes.hold("a", { cols: 50, rows: 20 });
    await sizes.yieldToMac("a");
    await sizes.yieldToMac("a");
    expect(tmux.calls).toEqual(["pin a 50x20", "unpin a"]);
  });

  test("reclaim pins the phone's last size again after a yield", async () => {
    const { tmux, sizes } = setup();
    await sizes.hold("a", { cols: 50, rows: 20 });
    await sizes.reclaim("a");
    expect(tmux.calls).toEqual(["pin a 50x20"]);
    await sizes.resize("a", { cols: 55, rows: 22 });
    await sizes.yieldToMac("a");
    await sizes.reclaim("a");
    expect(tmux.calls).toEqual([
      "pin a 50x20",
      "pin a 55x22",
      "unpin a",
      "pin a 55x22",
    ]);
  });

  test("a resize while yielded takes the window back", async () => {
    const { tmux, sizes } = setup();
    await sizes.hold("a", { cols: 50, rows: 20 });
    await sizes.yieldToMac("a");
    await sizes.resize("a", { cols: 52, rows: 21 });
    await sizes.reclaim("a");
    expect(tmux.calls).toEqual(["pin a 50x20", "unpin a", "pin a 52x21"]);
  });

  test("release forgets the size, so a later reclaim does nothing", async () => {
    const { tmux, sizes } = setup();
    await sizes.hold("a", { cols: 50, rows: 20 });
    await sizes.release("a");
    await sizes.reclaim("a");
    expect(tmux.calls).toEqual(["pin a 50x20", "unpin a"]);
  });
});
