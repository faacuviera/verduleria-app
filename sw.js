const CACHE_NAME = "jeeo-cache-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./utils.js",
  "./manifest.json",
  "./Logo.png",
  "./assets/hero-ingresos.svg",
  "./assets/hero-cxc.svg",
  "./assets/hero-alumnos.svg",
  "./assets/hero-gastos.svg"
];
self.addEventListener("install",(e)=>{
  e.waitUntil((async()=>{
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(ASSETS);
    self.skipWaiting();
  })());
});
self.addEventListener("activate",(e)=>{
  e.waitUntil((async()=>{
    const keys = await caches.keys();
    await Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)));
    self.clients.claim();
  })());
});
self.addEventListener("fetch",(e)=>{
  const req = e.request;

  // Navegaciones: devolvemos la app cacheada (offline-first)
  if (req.mode === "navigate") {
    e.respondWith((async()=>{
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match("./index.html");
      try{
        const res = await fetch(req);
        if (res && res.status === 200) cache.put("./index.html", res.clone());
        return res;
      }catch(err){
        return cached || new Response("Sin conexión y recurso no está en caché.", {status: 503});
      }
    })());
    return;
  }

  // Otros assets: cache-first con relleno de red y fallback
  e.respondWith((async()=>{
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;
    try{
      const res = await fetch(req);
      if (req.method==="GET" && res && res.status===200 && res.type==="basic"){
        cache.put(req, res.clone());
      }
      return res;
    }catch(err){
      return cached || new Response("Sin conexión y recurso no está en caché.", {status: 503});
    }
  })());
});
