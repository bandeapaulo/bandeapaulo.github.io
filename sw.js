// Grilles de La Bande à Paulo : fonctionnement hors connexion.
// Pages et grilles : réseau d'abord (pour recevoir les mises à jour), sinon copie locale.
// Polices : copie locale d'abord.
const CACHE = "grilles-paulo-v88";
const CORE = ["./", "index.html", "songs.json", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "logo.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Page de l'appli : on contourne le cache de GitHub (jusqu'à 10 min) pour recevoir tout de suite la dernière version.
  const page = req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith(".html");
  e.respondWith(
    fetch(page ? url.origin + url.pathname + "?v=" + Date.now() : req, page ? { cache: "no-store", credentials: "same-origin" } : undefined)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(url.origin + url.pathname, copy)); // une seule copie par fichier, même avec ?v=…
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : undefined)))
  );
});
