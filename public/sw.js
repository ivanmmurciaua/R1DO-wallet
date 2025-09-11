const CACHE_NAME = "safekey-wallet-cache-v1";
const urlsToCache = [
  "/",
  "/favicon.ico",
  "/ethereum-badge.svg",
  // Add more assets or routes as needed
];

// Install event: cache essential files
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(urlsToCache);
    }),
  );
  self.skipWaiting();
});

// Activate event: cleanup old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        }),
      ),
    ),
  );
  self.clients.claim();
});

// Fetch event: serve cached files if offline
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((response) => {
      // Return cached response if found, else fetch from network
      return (
        response ||
        fetch(event.request).then((networkResponse) => {
          // Optionally cache new requests here
          return networkResponse;
        })
      );
    }),
  );
});

// self.addEventListener('push', function (event) {
//   if (event.data) {
//     const data = event.data.json()
//     const options = {
//       body: data.body,
//       icon: data.icon || '/icons/icon-128x128.png',
//       badge: '/badge.png',
//       vibrate: [100, 50, 100],
//       data: {
//         dateOfArrival: Date.now(),
//         primaryKey: '2',
//       },
//     }
//     event.waitUntil(self.registration.showNotification(data.title, options))
//   }
// })

// self.addEventListener('notificationclick', function (event) {
//   console.log('Notification click received.')
//   event.notification.close()
//   event.waitUntil(clients.openWindow('<https://your-website.com>'))
// })
