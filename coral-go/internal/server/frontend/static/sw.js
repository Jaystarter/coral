/* Coral Service Worker — keeps local static assets fresh during active development */

const CACHE_NAME = 'coral-runtime-v5';
const SHELL_ASSETS = [
    '/static/favicon.png',
    '/static/coral.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
        return;
    }

    // API and WebSocket requests: always go to network
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
        return;
    }

    // HTML is local live state. Never serve a cached app shell over current UI code.
    if (event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html')) {
        event.respondWith(fetch(new Request(event.request, { cache: 'no-store' })));
        return;
    }

    // Static JS/CSS: network-first (ensures code updates load after restart)
    if (url.pathname.startsWith('/static/') && (url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))) {
        event.respondWith(
            fetch(new Request(event.request, { cache: 'no-store' }))
                .then((response) => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    // Other static assets (images, fonts): cache-first
    if (url.pathname.startsWith('/static/')) {
        event.respondWith(
            caches.match(event.request).then((cached) => cached || fetch(event.request))
        );
        return;
    }

    event.respondWith(fetch(event.request));
});
