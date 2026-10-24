/**
 * Función de Netlify: escribe dedicatorias con la API de Claude.
 * La clave vive en Netlify (variable ANTHROPIC_API_KEY), nunca en el HTML.
 * El sitio la llama en /api/dedicatoria.
 */
export default async (req) => {
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  const clave = process.env.ANTHROPIC_API_KEY;
  if (!clave) return json({ error: 'Falta la variable ANTHROPIC_API_KEY en Netlify' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }

  // Solo se reenvía lo necesario y con límites, para que nadie abuse de tu clave.
  const payload = {
    model: 'claude-haiku-5-5',
    max_tokens: 400,
    system: String(body.system || '').slice(0, 1500),
    messages: [{ role: 'user', content: String(body.messages?.[0]?.content || '').slice(0, 1500) }]
  };

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': clave, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload)
    });
    return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  } catch {
    return json({ error: 'No se pudo conectar con la IA' }, 502);
  }
};

export const config = { path: '/api/dedicatoria' };
