/**
 * Pago manual: el regalo queda pendiente hasta que el administrador lo activa.
 *   GET  /api/admin?config=1            → { manual, precios }   (público)
 *   GET  /api/admin?lista=1             → regalos (requiere clave)
 *   POST /api/admin { id, accion }      → 'activar' | 'pendiente' | 'eliminar' (requiere clave)
 * La clave se envía en el encabezado "x-admin-clave".
 * Variable en Netlify: ADMIN_CLAVE (inventa una clave larga; solo tú la conoces).
 */
import { getStore } from '@netlify/blobs';
import { timingSafeEqual, createPrivateKey, createSign, createHash } from 'node:crypto';

/* ---------- Avisos push al teléfono del cliente (Android y iPhone) ---------- */
// Se envía un "push" sin contenido; el teléfono pide el texto a /api/aviso (así no hace falta cifrar).
function jwtVapid(aud, claves, sub) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const datos = `${b64({ typ: 'JWT', alg: 'ES256' })}.${b64({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub })}`;
  const firma = createSign('SHA256').update(datos).sign({ key: createPrivateKey({ key: claves.privadoJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `${datos}.${firma.toString('base64url')}`;
}
const hashEndpoint = ep => createHash('sha256').update(ep).digest('hex').slice(0, 40);
async function avisarTelefonos(id, mensaje, origen) {
  const avisos = getStore({ name: 'avisos', consistency: 'strong' });
  const subs = (await avisos.get('subs-' + id, { type: 'json' })) || [];
  if (!subs.length) return 0;
  const claves = await getStore({ name: 'config', consistency: 'strong' }).get('vapid', { type: 'json' });
  if (!claves) return 0;
  const sub = origen.startsWith('https://') ? origen : 'mailto:avisos@escaneameysonrie.app';
  let enviados = 0; const vigentes = [];
  await Promise.all(subs.map(async s => {
    try {
      await avisos.setJSON('msg-' + hashEndpoint(s.endpoint), { ...mensaje, t: Date.now() });
      const r = await fetch(s.endpoint, { method: 'POST', headers: {
        TTL: '86400', Urgency: 'high', 'Content-Length': '0',
        Authorization: `vapid t=${jwtVapid(new URL(s.endpoint).origin, claves, sub)}, k=${claves.publico}`
      } });
      if (r.status === 404 || r.status === 410) return; // el teléfono canceló los avisos
      vigentes.push(s); if (r.ok) enviados++;
    } catch { vigentes.push(s); }
  }));
  if (vigentes.length !== subs.length) await avisos.setJSON('subs-' + id, vigentes);
  return enviados;
}
const conLimite = (p, ms) => Promise.race([p, new Promise(ok => setTimeout(() => ok(0), ms))]);

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
  creado: d.creado, pago: d.pago || null, entrega: d.entrega || null,
  telefono: d.telefono || '', bloqueado: d.bloqueado || null
});

export default async (req) => {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.searchParams.has('config')) {
    return json({ manual: Boolean(process.env.ADMIN_CLAVE) && !wompiActivo(), precios: PRECIOS });
  }
  if (!process.env.ADMIN_CLAVE) return json({ error: 'Falta la variable ADMIN_CLAVE en Netlify.' }, 503);
  if (!autorizado(req)) return json({ error: 'Clave incorrecta' }, 401);

  const store = getStore({ name: 'regalos', consistency: 'strong' }); // 'strong': los cambios se ven al instante
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
      const estado = d ? (d.estado || 'pagado') : null;
      // Eliminar: solo regalos sin pagar. Pagados y entregados quedan como historial.
      if (b.accion === 'eliminar') {
        if (!d) return json({ ok: true }); // ya no existía: seguro de repetir
        if (estado === 'entregado') return json({ error: 'Los regalos entregados no se pueden eliminar: forman parte del historial.' }, 409);
        if (estado === 'pagado') return json({ error: 'Este regalo está pagado. Bloquéalo primero si de verdad quieres eliminarlo.' }, 409);
        await store.delete(id); return json({ ok: true });
      }
      if (!d) return json({ error: 'No encontramos este regalo' }, 404);
      if (b.accion === 'entregar') {
        if (estado !== 'pagado') return json({ error: 'Solo se puede marcar como entregado un regalo pagado.' }, 409);
        const nuevo = { ...d, estado: 'entregado', entrega: { fecha: new Date().toISOString() } };
        await store.setJSON(id, nuevo); return json({ ok: true, regalo: resumen(id, nuevo) });
      }
      if (b.accion === 'desentregar') {
        if (estado !== 'entregado') return json({ error: 'Este regalo no está marcado como entregado.' }, 409);
        const { entrega, ...resto } = d; const nuevo = { ...resto, estado: 'pagado' };
        await store.setJSON(id, nuevo); return json({ ok: true, regalo: resumen(id, nuevo) });
      }
      if (b.accion === 'activar') {
        // Al confirmar el pago queda directamente como "pagado y entregado"
        const ahora = new Date().toISOString();
        const { bloqueado, ...sinBloqueo } = d;
        const nuevo = { ...sinBloqueo, estado: 'entregado', pago: { via: 'manual', fecha: ahora, nota: String(b.nota || '').slice(0, 120) }, entrega: { fecha: ahora } };
        await store.setJSON(id, nuevo);
        const avisados = await conLimite(avisarTelefonos(id, {
          titulo: '¡Tu pago fue aprobado! 🎉', cuerpo: `Tu regalo ${id.slice(0, 6).toUpperCase()} para ${d.destinatario} ya está activo. Toca para ver tu QR.`,
          url: `/#personalizar?ver=${id}`
        }, process.env.URL || url.origin), 6000);
        return json({ ok: true, avisados, regalo: resumen(id, nuevo) });
      }
      if (b.accion === 'pendiente') {
        const { pago, entrega, ...resto } = d; const nuevo = { ...resto, estado: 'pendiente', bloqueado: { fecha: new Date().toISOString() } };
        await store.setJSON(id, nuevo);
        const avisados = await conLimite(avisarTelefonos(id, {
          titulo: 'Tu regalo quedó pendiente', cuerpo: `No pudimos confirmar el pago del regalo ${id.slice(0, 6).toUpperCase()}. Escríbenos por WhatsApp al 6217 7184.`,
          url: `/#personalizar?ver=${id}`
        }, process.env.URL || url.origin), 6000);
        return json({ ok: true, avisados, regalo: resumen(id, nuevo) });
      }
      return json({ error: 'Acción no válida' }, 400);
    }
    return json({ error: 'Método no permitido' }, 405);
  } catch (err) {
    return json({ error: err.message || 'Error del servidor' }, 500);
  }
};

export const config = { path: '/api/admin' };
