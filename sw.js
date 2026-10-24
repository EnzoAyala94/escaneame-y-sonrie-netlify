/* Service worker de Escanéame y Sonríe: recibe los avisos push (Android y iPhone) */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function hashEndpoint(ep) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ep));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let m = { titulo: 'Escanéame y Sonríe', cuerpo: 'Hay una novedad sobre tu regalo. Toca para verla.', url: '/#personalizar' };
    try {
      if (e.data && e.data.text()) m = { ...m, ...e.data.json() };
      else {
        const s = await self.registration.pushManager.getSubscription();
        if (s) {
          const r = await fetch('/api/aviso?e=' + await hashEndpoint(s.endpoint), { cache: 'no-store' });
          if (r.ok) { const d = await r.json(); if (d.titulo) m = d; }
        }
      }
    } catch {}
    await self.registration.showNotification(m.titulo, {
      body: m.cuerpo, icon: '/icon-192.png', badge: '/icon-192.png',
      tag: 'regalo', renotify: true, data: { url: m.url }
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const v of ventanas) {
      if (new URL(v.url).origin === self.location.origin && 'focus' in v) {
        try { await v.navigate(url); } catch {}
        return v.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
