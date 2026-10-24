/**
 * Pago manual: el regalo queda pendiente hasta que el administrador lo activa.
 *   GET  /api/admin?config=1            → { manual, precios }   (público)
 *   GET  /api/admin?lista=1             → regalos (requiere clave)
 *   POST /api/admin { id, accion }      → 'activar' | 'pendiente' | 'eliminar' (requiere clave)
 * La clave se envía en el encabezado "x-admin-clave".
 * Variable en Netlify: ADMIN_CLAVE (inventa una clave larga; solo tú la conoces).
 */
import { getStore } from '@netlify/blobs';
import { timingSafeEqual } from 'node:crypto';

// Mismos precios que index.html y pago.mjs
const PRECIOS = { esencial: 12, especial: 19, premium: 29, cumple: 22, aniversario: 22, pareja: 26 };
const ID_OK = /^[a-f0-9]{20}$/;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});
const wompiActivo = () => Boolean(process.env.WOMPI_CLIENT_ID && process.env.WOMPI_CLIENT_SECRET);
function autorizado(req) {
  const clave = process.env.ADMIN_CLAVE || '';
  const dada = req.headers.get('x-admin-clave') || '';
  const a = Buffer.from(clave), b = Buffer.from(dada);
  return clave.length >= 6 && a.length === b.length && timingSafeEqual(a, b);
}
const resumen = (id, d) => ({
  id, codigo: id.slice(0, 6).toUpperCase(), estado: d.estado || 'pagado',
  destinatario: d.destinatario, remitente: d.remitente, paquete: d.paquete,
  precio: PRECIOS[d.paquete] || 0, ocasion: d.ocasion, fotos: (d.fotos || []).length,
  creado: d.creado, pago: d.pago || null
});

export default async (req) => {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.searchParams.has('config')) {
    return json({ manual: Boolean(process.env.ADMIN_CLAVE) && !wompiActivo(), precios: PRECIOS });
  }
  if (!process.env.ADMIN_CLAVE) return json({ error: 'Falta la variable ADMIN_CLAVE en Netlify.' }, 503);
  if (!autorizado(req)) return json({ error: 'Clave incorrecta' }, 401);

  const store = getStore('regalos');
  try {
    if (req.method === 'GET') {
      const { blobs } = await store.list();
      const lista = [];
      for (const { key } of blobs.slice(0, 300)) {
        if (!ID_OK.test(key)) continue;
        const d = await store.get(key, { type: 'json' });
        if (d) lista.push(resumen(key, d));
      }
      lista.sort((a, b) => String(b.creado || '').localeCompare(String(a.creado || '')));
      return json({ regalos: lista });
    }
    if (req.method === 'POST') {
      let b; try { b = await req.json(); } catch { return json({ error: 'Datos no válidos' }, 400); }
      const id = String(b.id || '');
      if (!ID_OK.test(id)) return json({ error: 'Regalo no válido' }, 400);
      const d = await store.get(id, { type: 'json' });
      if (!d) return json({ error: 'No encontramos este regalo' }, 404);
      if (b.accion === 'eliminar') { await store.delete(id); return json({ ok: true }); }
      if (b.accion === 'activar') {
        const nuevo = { ...d, estado: 'pagado', pago: { via: 'manual', fecha: new Date().toISOString(), nota: String(b.nota || '').slice(0, 120) } };
        await store.setJSON(id, nuevo); return json({ ok: true, regalo: resumen(id, nuevo) });
      }
      if (b.accion === 'pendiente') {
        const { pago, ...resto } = d; const nuevo = { ...resto, estado: 'pendiente' };
        await store.setJSON(id, nuevo); return json({ ok: true, regalo: resumen(id, nuevo) });
      }
      return json({ error: 'Acción no válida' }, 400);
    }
    return json({ error: 'Método no permitido' }, 405);
  } catch (err) {
    return json({ error: err.message || 'Error del servidor' }, 500);
  }
};

export const config = { path: '/api/admin' };
