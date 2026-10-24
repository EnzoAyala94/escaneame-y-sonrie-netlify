/**
 * Cobro con tarjeta (Wompi El Salvador) antes de activar el regalo.
 *   GET  /api/pago?config=1      → { activo, precios }
 *   GET  /api/pago?id=...        → { estado: 'pendiente' | 'pagado' }
 *   POST /api/pago { id }        → crea el enlace de pago de Wompi y devuelve { url }
 *   POST /api/pago { id, accion:'confirmar', ...parámetros del redirect } → verifica el pago
 *   POST /api/webhook-wompi      → aviso de Wompi (servidor a servidor) cuando el pago se aprueba
 *
 * Variables en Netlify: WOMPI_CLIENT_ID y WOMPI_CLIENT_SECRET (App ID y API Secret del panel de Wompi).
 * Opcional: WOMPI_EMAIL_AVISOS (correo donde quieres recibir aviso de cada venta).
 * Sin esas variables los pagos quedan apagados y el sitio funciona como antes.
 */
import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Precios oficiales en USD. Se cobran desde aquí, nunca desde el navegador.
// Si cambias un precio en index.html, cámbialo también aquí.
const PRECIOS = { esencial: 12, especial: 19, premium: 29, cumple: 22, aniversario: 22, pareja: 26 };
const NOMBRES = {
  esencial: 'Tarjeta con dedicatoria', especial: 'Galería y carta digital', premium: 'Experiencia completa',
  cumple: 'Álbum de etapas', aniversario: 'Línea del tiempo', pareja: 'Carta privada'
};
const ID_OK = /^[a-f0-9]{20}$/;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});
const activo = () => Boolean(process.env.WOMPI_CLIENT_ID && process.env.WOMPI_CLIENT_SECRET);
const hmac = texto => createHmac('sha256', process.env.WOMPI_CLIENT_SECRET).update(texto, 'utf8').digest('hex');
const igual = (a, b) => {
  const x = Buffer.from(String(a || '').toLowerCase()), y = Buffer.from(String(b || '').toLowerCase());
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};

let token = null, vence = 0;
async function obtenerToken() {
  if (token && Date.now() < vence) return token;
  const r = await fetch('https://id.wompi.sv/connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', audience: 'wompi_api',
      client_id: process.env.WOMPI_CLIENT_ID, client_secret: process.env.WOMPI_CLIENT_SECRET
    })
  });
  if (!r.ok) throw new Error(`Wompi rechazó las credenciales (${r.status}). Revisa WOMPI_CLIENT_ID y WOMPI_CLIENT_SECRET.`);
  const d = await r.json();
  token = d.access_token; vence = Date.now() + ((d.expires_in || 3600) - 120) * 1000;
  return token;
}
async function wompi(ruta, opciones = {}) {
  const r = await fetch('https://api.wompi.sv' + ruta, {
    ...opciones,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await obtenerToken() }
  });
  const texto = await r.text();
  let d; try { d = JSON.parse(texto); } catch { d = { texto }; }
  if (!r.ok) throw new Error(`Wompi respondió ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  return d;
}
async function marcarPagado(store, id, datos, pago) {
  if (datos.estado && datos.estado !== 'pendiente') return;
  await store.setJSON(id, { ...datos, estado: 'pagado', pago: { ...pago, fecha: new Date().toISOString() } });
}

async function webhook(req, store) {
  if (!activo()) return new Response('Pagos no configurados', { status: 503 });
  const cuerpo = await req.text(); // tal cual llegó, sin modificar
  const firma = req.headers.get('wompi_hash') || req.headers.get('wompi-hash') || '';
  if (!igual(hmac(cuerpo), firma)) return new Response('Firma no válida', { status: 401 });
  let w; try { w = JSON.parse(cuerpo); } catch { return new Response('JSON no válido', { status: 400 }); }
  if (w.ResultadoTransaccion !== 'ExitosaAprobada') return new Response('ok');
  const id = String(w.EnlacePago?.IdentificadorEnlaceComercio || '');
  if (!ID_OK.test(id)) return new Response('ok');
  const datos = await store.get(id, { type: 'json' });
  if (!datos || !PRECIOS[datos.paquete]) return new Response('ok');
  if (Number(w.Monto) + 0.001 < PRECIOS[datos.paquete]) return new Response('Monto insuficiente');
  await marcarPagado(store, id, datos, { idTransaccion: w.IdTransaccion, esReal: Boolean(w.EsProductiva), via: 'webhook' });
  return new Response('ok');
}

export default async (req) => {
  const store = getStore({ name: 'regalos', consistency: 'strong' }); // 'strong': los cambios se ven al instante
  const url = new URL(req.url);
  try {
    if (url.pathname.endsWith('/webhook-wompi')) return await webhook(req, store);

    if (req.method === 'GET') {
      if (url.searchParams.has('config')) return json({ activo: activo(), precios: PRECIOS });
      const id = url.searchParams.get('id') || '';
      if (!ID_OK.test(id)) return json({ error: 'Enlace no válido' }, 400);
      const datos = await store.get(id, { type: 'json' });
      if (!datos) return json({ error: 'No encontramos este regalo' }, 404);
      return json({ estado: datos.estado === 'pendiente' ? 'pendiente' : 'pagado' }); // entregado cuenta como pagado
    }
    if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
    if (!activo()) return json({ error: 'Los pagos con tarjeta todavía no están configurados.' }, 503);

    let b; try { b = await req.json(); } catch { return json({ error: 'Datos no válidos' }, 400); }
    const id = String(b.id || '');
    if (!ID_OK.test(id)) return json({ error: 'Regalo no válido' }, 400);
    const datos = await store.get(id, { type: 'json' });
    if (!datos) return json({ error: 'No encontramos este regalo' }, 404);
    if ((datos.estado || 'pagado') !== 'pendiente') return json({ estado: 'pagado' }); // pagado o entregado
    const precio = PRECIOS[datos.paquete];
    if (!precio) return json({ error: 'Paquete no válido' }, 400);

    if (b.accion === 'confirmar') {
      const idTransaccion = String(b.idTransaccion || ''), idEnlace = String(b.idEnlace || ''), monto = String(b.monto || '');
      // El hash del redirect de un enlace de pago se arma con: identificador + idTransaccion + idEnlace + monto
      if (!igual(hmac(`${id}${idTransaccion}${idEnlace}${monto}`), b.hash)) return json({ estado: 'pendiente', error: 'No pudimos verificar el pago.' }, 400);
      if (idEnlace !== String(datos.idEnlace)) return json({ estado: 'pendiente', error: 'El pago no corresponde a este regalo.' }, 400);
      const t = await wompi('/TransaccionCompra/' + encodeURIComponent(idTransaccion));
      const pagado = Number(t.monto ?? t.montoOriginal ?? 0);
      if (!t.esAprobada || pagado + 0.001 < precio) return json({ estado: 'pendiente', error: t.mensaje || 'El banco no aprobó el pago.' });
      await marcarPagado(store, id, datos, { idTransaccion, esReal: Boolean(t.esReal), via: 'redirect' });
      return json({ estado: 'pagado' });
    }

    // Crear el enlace de pago (pantalla segura de Wompi)
    const origen = process.env.URL || url.origin;
    const configuracion = {
      urlRedirect: `${origen}/`,
      urlRetorno: `${origen}/#personalizar`,
      urlWebhook: `${origen}/api/webhook-wompi`,
      notificarTransaccionCliente: true
    };
    if (process.env.WOMPI_EMAIL_AVISOS) configuracion.emailsNotificacion = process.env.WOMPI_EMAIL_AVISOS;
    const enlace = await wompi('/EnlacePago', {
      method: 'POST',
      body: JSON.stringify({
        identificadorEnlaceComercio: id,
        monto: precio,
        nombreProducto: `Escanéame y Sonríe: ${NOMBRES[datos.paquete]}`,
        formaPago: {
          permitirTarjetaCreditoDebido: true, permitirPagoConPuntoAgricola: false,
          permitirPagoEnCuotasAgricola: false, permitirPagoEnBitcoin: false, permitePagoQuickPay: false
        },
        infoProducto: { descripcionProducto: `Regalo digital con código QR para ${datos.destinatario}` },
        configuracion,
        limitesDeUso: { cantidadMaximaPagosExitosos: 1 }
      })
    });
    await store.setJSON(id, { ...datos, idEnlace: enlace.idEnlace });
    return json({ estado: 'pendiente', url: enlace.urlEnlace, prueba: enlace.estaProductivo === false });
  } catch (err) {
    return json({ error: err.message || 'No se pudo procesar el pago.' }, 502);
  }
};

export const config = { path: ['/api/pago', '/api/webhook-wompi'] };
