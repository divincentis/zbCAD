// Companion to plan.html (the Deadline Planner), in the same folder. It adds:
//   - offline reopening: serves the page from cache, refreshing the cache in the background whenever
//     the network is available, so updates show up on the next open;
//   - system notifications on phones (Android and iPhone only show web notifications through a worker).
// The page registers this as plan-sw.js?app=<its file name>, scoped to that page alone. It must stay
// that way: every zbCAD tool shares this origin, and a worker scoped to the folder would serve all of
// them from this cache.
const CACHE = 'deadline-planner-v3';
const APP_URL = new URL(new URL(self.location).searchParams.get('app') || 'plan.html', self.location).href;

self.addEventListener('install', (e) => {
    e.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        // cache: 'reload' skips the browser's HTTP cache so a fresh copy is stored.
        await cache.add(new Request(APP_URL, { cache: 'reload' }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

    // Always refresh from the network (revalidating past the HTTP cache) and store the result.
    const network = fetch(req, { cache: 'no-cache' }).then(async (res) => {
        if (res.ok) {
            const cache = await caches.open(CACHE);
            await cache.put(req, res.clone());
        }
        return res;
    });
    // Keep the worker alive until the background refresh is saved, even when the cached copy was served.
    e.waitUntil(network.catch(() => {}));

    e.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        try {
            return await network;
        } catch (err) {
            // Offline and not cached: for page loads (e.g. opened as the folder URL), fall back to the app.
            if (req.mode === 'navigate') {
                const app = await cache.match(APP_URL, { ignoreSearch: true });
                if (app) return app;
            }
            throw err;
        }
    })());
});

// Tapping an alert brings the planner to the front, or opens it if it was closed.
self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    e.waitUntil((async () => {
        const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const open = list.find(c => c.url.split(/[?#]/)[0] === APP_URL) || list[0];
        if (open) {
            try { return await open.focus(); } catch (err) {}
        }
        return self.clients.openWindow(APP_URL);
    })());
});
