/**
 * Avisos push (Android y iPhone) para los clientes.
 *   GET  /api/aviso?clave=1      → { publico }  clave pública VAPID (se crea sola la primera vez)
 *   GET  /api/aviso?info=<id>    → datos mínimos del regalo para mostrar su estado
 *   GET  /api/aviso?e=<hash>     → último aviso para ese teléfono (lo lee el service worker)
 *   POST /api/aviso { id, suscripcion } → guarda la suscripción del teléfono para ese regalo
 */
import { getStore } from '@netlify/blobs';
import { generateKeyPairSync } from 'node:crypto';

const PRECIOS = { esencial: 12, especial: 19, premium: 29, cumple: 22, aniversario: 22, pareja: 26 };
const ID_OK = /^[a-f0-9]{20}$/;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

async function clavesVapid(cfg) {
  let k = await cfg.get('vapid', { type: 'json' });
  if (k) return k;
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const publico = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
  await cfg.setJSON('vapid', { publico, privadoJwk: privateKey.export({ format: 'jwk' }) });
  return await cfg.get('vapid', { type: 'json' }); // relee por si otra petición la creó al mismo tiempo
}

export default async (req) => {
  const url = new URL(req.url);
  const cfg = getStore({ name: 'config', consistency: 'strong' });
  const avisos = getStore({ name: 'avisos', consistency: 'strong' });
  try {
    if (req.method === 'GET') {
      if (url.searchParams.has('clave')) return json({ publico: (await clavesVapid(cfg)).publico });
      const info = url.searchParams.get('info');
      if (info !== null) {
        if (!ID_OK.test(info)) return json({ error: 'Enlace no válido' }, 400);
        const d = await getStore({ name: 'regalos', consistency: 'strong' }).get(info, { type: 'json' });
        if (!d) return json({ error: 'No encontramos este regalo' }, 404);
        return json({
          codigo: info.slice(0, 6).toUpperCase(), estado: d.estado === 'pendiente' ? 'pendiente' : 'pagado',
          bloqueado: Boolean(d.bloqueado), paquete: d.paquete, precio: PRECIOS[d.paquete] || 0,
          destinatario: d.destinatario, remitente: d.remitente
        });
      }
      const e = url.searchParams.get('e') || '';
      if (!/^[a-f0-9]{40}$/.test(e)) return json({});
      return json((await avisos.get('msg-' + e, { type: 'json' })) || {});
    }
    if (req.method === 'POST') {
      let b; try { b = await req.json(); } catch { return json({ error: 'Datos no válidos' }, 400); }
      const id = String(b.id || ''), s = b.suscripcion || {};
      if (!ID_OK.test(id)) return json({ error: 'Regalo no válido' }, 400);
      if (typeof s.endpoint !== 'string' || !s.endpoint.startsWith('https://') || s.endpoint.length > 1000) return json({ error: 'Suscripción no válida' }, 400);
      const existe = await getStore({ name: 'regalos', consistency: 'strong' }).get(id, { type: 'json' });
      if (!existe) return json({ error: 'No encontramos este regalo' }, 404);
      const lista = ((await avisos.get('subs-' + id, { type: 'json' })) || []).filter(x => x.endpoint !== s.endpoint);
      lista.push({ endpoint: s.endpoint, creado: new Date().toISOString() });
      await avisos.setJSON('subs-' + id, lista.slice(-5));
      return json({ ok: true });
    }
    return json({ error: 'Método no permitido' }, 405);
  } catch (err) {
    return json({ error: err.message || 'Error del servidor' }, 500);
  }
};

export const config = { path: '/api/aviso' };
