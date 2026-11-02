/* Serenity Space Meal Pass — service worker.
   Makes the site installable and opens fast. Pages and app code are fetched fresh when online
   (cached copy used only when offline); libraries and icons are cached. Supabase data is never cached. */
const VERSION = "mp-v15";
const SHELL = ["./", "index.html", "pass.html", "styles.css", "app.css", "app.js", "config.js", "manifest.webmanifest",
  "assets/tree.png", "assets/logo.png", "assets/icon-192.png", "assets/icon-512.png", "assets/apple-touch-icon.png",
  "vendor/supabase.js", "vendor/qrcode.js", "vendor/jsQR.min.js"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;        // Supabase, fonts etc. go straight to the network
  const isLib = url.pathname.includes("/vendor/") || url.pathname.includes("/assets/");
  if (isLib) {   // cache first
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; })));
    return;
  }
  // network first, so app updates appear immediately; fall back to cache offline
  e.respondWith(fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return res; })
    .catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match("index.html"))));
});
