import { RelayAccount } from "@daedalus/remote-protocol";
import { phoneIdentity } from "./storage";

/**
 * Push notifications for "a session needs you". The phone subscribes with
 * the browser's push service and gives the relay only the endpoint; pushes
 * arrive empty and the service worker shows a fixed line (`public/sw.js`).
 */
export type PushState =
  | "unsupported"
  /** iPhone and iPad: web push works only from the Home Screen. */
  | "install_first"
  | "off"
  | "on"
  | "blocked";

const standalone = () =>
  matchMedia("(display-mode: standalone)").matches ||
  (navigator as { standalone?: boolean }).standalone === true;

export async function pushState(): Promise<PushState> {
  if (/iPhone|iPad/.test(navigator.userAgent) && !standalone())
    return "install_first";
  if (!("serviceWorker" in navigator) || !("PushManager" in window))
    return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  return subscription && Notification.permission === "granted" ? "on" : "off";
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export async function turnOnPush(token: string): Promise<PushState> {
  if ((await Notification.requestPermission()) !== "granted")
    return pushState();
  const account = new RelayAccount(location.origin, token);
  const { publicKey } = await account.pushKey();
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    }));
  await account.setPushSubscription(phoneIdentity().id, subscription.endpoint);
  return "on";
}

export async function turnOffPush(token: string): Promise<PushState> {
  const registration = await navigator.serviceWorker.getRegistration();
  await (await registration?.pushManager.getSubscription())?.unsubscribe();
  await new RelayAccount(location.origin, token)
    .removePushSubscription(phoneIdentity().id)
    .catch(() => undefined);
  return pushState();
}

export function registerServiceWorker(): void {
  if ("serviceWorker" in navigator)
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}
