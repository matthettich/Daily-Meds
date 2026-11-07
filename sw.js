// Bump this version whenever you change index.html so phones pick up the update.
const CACHE = "daily-meds-v120";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "check.html", "help.html", "privacy.html"];
const REQUIRED = ["./", "index.html"];

self.addEventListener("install", e => {
  // The app page itself must be saved, or the update is refused and the previous version keeps working offline.
  // Everything else is cached one by one so a single missing file can't stop the update.
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => REQUIRED.includes(u) ? c.add(u) : c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  // Other apps live on the same github.io address, so only clear old Daily meds copies.
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("daily-meds-") && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html")))
    );
    return;
  }
  if (url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com")) {
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request).then(res => {
        const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res;
      }))
    );
  }
});
