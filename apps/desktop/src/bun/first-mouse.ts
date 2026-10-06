import { dlopen, FFIType, type Pointer } from "bun:ffi";

const cString = (text: string) => Buffer.from(`${text}\0`);
let applied = false;

/**
 * Lets the click that brings the window to the front also land on what was
 * clicked, as it does in Finder, Xcode and any Electron app with
 * `acceptFirstMouse`. AppKit only passes that click through when the view
 * under it answers YES to `acceptsFirstMouse:`, and WKWebView answers NO, so
 * every button in an inactive Daedalus window needed two clicks.
 *
 * Electrobun has no option for this, and its AppKit thread is not Bun's, so
 * a JavaScript callback cannot answer the question in time. Instead the
 * method is pointed at an implementation that already exists and always
 * returns YES: `+[NSObject accessInstanceVariablesDirectly]`. It takes no
 * argument, and on both macOS calling conventions an unused extra argument
 * (the NSEvent) is simply ignored. Applied once, process-wide, before the
 * first window opens; a failure leaves the default behaviour in place.
 */
export function acceptFirstMouse(): boolean {
  if (applied) return true;
  if (process.platform !== "darwin") return false;
  try {
    const system = dlopen("/usr/lib/libSystem.B.dylib", {
      dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
    });
    // RTLD_NOW: WKWebView has to exist as a class before it can be changed.
    system.symbols.dlopen(
      cString("/System/Library/Frameworks/WebKit.framework/WebKit"),
      2,
    );
    const { symbols: objc } = dlopen("/usr/lib/libobjc.A.dylib", {
      objc_getClass: { args: [FFIType.ptr], returns: FFIType.ptr },
      object_getClass: { args: [FFIType.ptr], returns: FFIType.ptr },
      sel_registerName: { args: [FFIType.ptr], returns: FFIType.ptr },
      class_getMethodImplementation: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.ptr,
      },
      class_replaceMethod: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.ptr,
      },
    });
    const webView = objc.objc_getClass(cString("WKWebView"));
    const nsObject = objc.objc_getClass(cString("NSObject"));
    if (!webView || !nsObject) return false;
    const alwaysYes = objc.class_getMethodImplementation(
      objc.object_getClass(nsObject) as Pointer,
      objc.sel_registerName(cString("accessInstanceVariablesDirectly")),
    );
    if (!alwaysYes) return false;
    objc.class_replaceMethod(
      webView,
      objc.sel_registerName(cString("acceptsFirstMouse:")),
      alwaysYes,
      // BOOL (id self, SEL _cmd, NSEvent *event)
      cString("c@:@"),
    );
    applied = true;
    return true;
  } catch {
    return false;
  }
}
