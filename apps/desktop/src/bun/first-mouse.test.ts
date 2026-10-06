import { describe, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { acceptFirstMouse } from "./first-mouse";

const cString = (text: string) => Buffer.from(`${text}\0`);

describe.if(process.platform === "darwin")("acceptFirstMouse", () => {
  test("makes a WKWebView take the click that activates its window", () => {
    expect(acceptFirstMouse()).toBe(true);
    // Applying twice is a no-op, not a second swap.
    expect(acceptFirstMouse()).toBe(true);
    const { symbols: objc } = dlopen("/usr/lib/libobjc.A.dylib", {
      objc_getClass: { args: [FFIType.ptr], returns: FFIType.ptr },
      sel_registerName: { args: [FFIType.ptr], returns: FFIType.ptr },
      class_createInstance: {
        args: [FFIType.ptr, FFIType.u64],
        returns: FFIType.ptr,
      },
      objc_msgSend: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.bool,
      },
    });
    // A bare instance is enough: the new method never looks at itself.
    const webView = objc.class_createInstance(
      objc.objc_getClass(cString("WKWebView")),
      0,
    );
    expect(
      objc.objc_msgSend(
        webView,
        objc.sel_registerName(cString("acceptsFirstMouse:")),
        null,
      ),
    ).toBe(true);
  });
});
