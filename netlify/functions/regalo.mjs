/**
 * Guarda y entrega los regalos (textos + fotos) usando Netlify Blobs,
 * para que el QR muestre todo en cualquier teléfono.
 *   POST /api/regalo        → guarda el regalo y devuelve { id }
 *   GET  /api/regalo?id=... → devuelve el regalo
 */
import { getStore } from '@netlify/blobs';

const MAX_FOTOS = 12;
const MAX_FOTO = 1_500_000; // ~1.1 MB por foto ya comprimida
const pagosActivos = () => Boolean((process.env.WOMPI_CLIENT_ID && process.env.WOMPI_CLIENT_SECRET) || process.env.ADMIN_CLAVE);
const txt = (v, n) => String(v ?? '').slice(0, n);
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

export default async (req) => {
  const store = getStore('regalos');

  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('id') || '';
    if (!/^[a-f0-9]{20}$/.test(id)) return json({ error: 'Enlace no válido' }, 400);
    const datos = await store.get(id, { type: 'json' });
    if (!datos) return json({ error: 'No encontramos este regalo' }, 404);
    // Un regalo sin pagar no se puede abrir (los regalos antiguos no tienen estado y se consideran pagados)
    if (datos.estado === 'pendiente') return json({ error: 'Este regalo todavía no está activo.', estado: 'pendiente' }, 402);
    const { idEnlace, pago, ...publico } = datos;
    return json(publico);
  }

  if (req.method === 'POST') {
    let b;
    try { b = await req.json(); } catch { return json({ error: 'Datos no válidos' }, 400); }

    const fotos = Array.isArray(b.fotos) ? b.fotos.slice(0, MAX_FOTOS) : [];
    const fotoMala = fotos.some(f => typeof f !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(f) || f.length > MAX_FOTO);
    if (fotoMala) return json({ error: 'Alguna foto no es válida o pesa demasiado' }, 400);

    const datos = {
      paquete: txt(b.paquete, 20), destinatario: txt(b.destinatario, 40), remitente: txt(b.remitente, 40),
      ocasion: txt(b.ocasion, 20), tema: txt(b.tema, 20), dedicatoria: txt(b.dedicatoria, 400),
      musica: txt(b.musica, 200), mensajeFinal: txt(b.mensajeFinal, 200),
      recuerdos: (Array.isArray(b.recuerdos) ? b.recuerdos : []).slice(0, 20).map(r => ({ titulo: txt(r?.titulo, 30), texto: txt(r?.texto, 120) })),
      fotos, creado: new Date().toISOString(),
      // Con Wompi configurado, el regalo queda pendiente hasta que se pague
      estado: pagosActivos() ? 'pendiente' : 'pagado'
    };
    if (!datos.destinatario || !datos.remitente || !datos.dedicatoria) return json({ error: 'Faltan datos obligatorios' }, 400);

    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    await store.setJSON(id, datos);
    return json({ id, requierePago: datos.estado === 'pendiente' }, 201);
  }

  return json({ error: 'Método no permitido' }, 405);
};

export const config = { path: '/api/regalo' };
