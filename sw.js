// Service worker: guarda la app en el celular para que abra sin señal.
// Cambia VERSION en cada actualización para que los celulares descarguen la nueva.
const VERSION = 'cv-1.6.1';
const ARCHIVOS = [
  './', './index.html', './styles.css', './app.js', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ARCHIVOS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Primero la red (para recibir actualizaciones); sin señal, la copia guardada.
// cache: 'no-cache' = siempre pregunta al servidor si hay versión nueva (GitHub guarda copias 10 min).
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then(res => {
      const copia = res.clone();
      caches.open(VERSION).then(c => c.put(req, copia));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
