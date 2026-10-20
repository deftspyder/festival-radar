// Festival Radar service worker: shows presale alerts and opens the right page when one is tapped.
// It does not cache pages, so the site always loads fresh from GitHub Pages.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Festival Radar', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'Festival Radar';
  const opts = {
    body: d.body || '',
    icon: 'icons/icon-192.png',
    tag: d.tag || undefined,
    data: { url: d.url || './', view: d.view || d.url || './' }
  };
  // Buttons show on Android and computers; iPhones just open the main link (tickets).
  if (d.view && d.url !== d.view) opts.actions = [{ action: 'tickets', title: 'Buy tickets' }, { action: 'view', title: 'View on Festival Radar' }];
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const target = new URL((e.action === 'view' ? data.view : data.url) || './', self.registration.scope).href;
  const inSite = target.startsWith(self.registration.scope) && !/\/go\.html/.test(target);
  e.waitUntil((async () => {
    if (inSite) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) {
        if (w.url.startsWith(self.registration.scope)) { try { await w.navigate(target); } catch (err) {} return w.focus(); }
      }
    }
    return self.clients.openWindow(target);
  })());
});
