// Grilles de La Bande à Paulo : fonctionnement hors connexion.
// • Page et morceaux : réseau d'abord pour recevoir les mises à jour, MAIS si le réseau ne répond pas
//   en 3,5 s (salle sans réseau, wifi capricieux), on sert tout de suite la copie enregistrée.
// • Icônes, logo, polices : copie enregistrée d'abord.
// • La vidéo de présentation n'est pas gardée (trop lourde) : elle demande internet.
const CACHE = "grilles-paulo-v96";
const CORE = ["./", "index.html", "songs.json", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "logo.png", "guide.jpg"];
const WAIT = 3500;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(CORE.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // on reprend les fichiers de l'ancienne version encore utiles avant de la supprimer
    const keys = await caches.keys();
    const cur = await caches.open(CACHE);
    for (const k of keys) {
      if (k === CACHE) continue;
      const old = await caches.open(k);
      for (const req of await old.keys()) { if (!(await cur.match(req))) { const r = await old.match(req); if (r) await cur.put(req, r); } }
      await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

const keyOf = (url) => url.origin + url.pathname;
async function fromCache(req, url) {
  const c = await caches.open(CACHE);
  return (await c.match(keyOf(url))) || (await c.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? (await c.match(new URL("index.html", self.registration.scope).href)) || (await c.match(new URL("./", self.registration.scope).href)) : undefined);
}
function networkFirst(req, url, page) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
    const net = fetch(page ? keyOf(url) + "?v=" + Date.now() : req, page ? { cache: "no-store", credentials: "same-origin" } : { cache: "no-store" })
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(keyOf(url), copy)); } return res; });
    net.then(finish).catch(async () => { const hit = await fromCache(req, url); if (hit) finish(hit); else if (!done) { done = true; resolve(Response.error()); } });
    setTimeout(async () => { if (done) return; const hit = await fromCache(req, url); if (hit) finish(hit); }, WAIT);
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (/\.(mp4|webm)$/i.test(url.pathname) || req.headers.has("range")) return; // vidéo : internet seulement

  const page = req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith(".html");
  if (page || /songs\.json$/.test(url.pathname) || /sw\.js$/.test(url.pathname)) { e.respondWith(networkFirst(req, url, page)); return; }
  // le reste (icônes, logo, manifeste) : copie enregistrée d'abord
  e.respondWith(fromCache(req, url).then((hit) => hit || fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(keyOf(url), copy)); } return res; })));
});
