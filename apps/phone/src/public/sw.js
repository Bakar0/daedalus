// Daedalus phone service worker: shows the push the relay sends when a
// session on the user's Mac needs them. The push carries no data, by design:
// what the session is waiting on stays end-to-end encrypted in the app.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("Daedalus", {
      body: "A session on your Mac needs you.",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "daedalus-attention",
      renotify: true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const open = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      if (open) return open.focus();
      return self.clients.openWindow("/");
    })(),
  );
});
