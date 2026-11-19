// Service worker: кэширует оболочку приложения, чтобы оно открывалось мгновенно и без сети.
// Запросы к api.anthropic.com и другим сайтам не кэшируются.
var CACHE = "claude-pwa-v1";
var SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./mobile.css",
  "./markdown.js",
  "./storage.js",
  "./app.js",
  "./vendor/claude-api.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/favicon-32.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Страница: сначала сеть (чтобы обновления приходили), без сети — из кэша.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put("./index.html", copy); });
        return res;
      }).catch(function () { return caches.match("./index.html"); })
    );
    return;
  }
  // Остальные файлы: из кэша, параллельно обновляем.
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
