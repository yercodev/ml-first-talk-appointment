// Cliente minimo de las funciones RPC de Supabase (PostgREST). Sin supabase-js.
// Los errores de la API llegan como { code, message, details } con su estado HTTP.
export function config() {
  return window.ML_CONFIG || {};
}

export function isConfigured() {
  const { supabaseUrl, anonKey } = config();
  return !!supabaseUrl && !!anonKey && !anonKey.startsWith('PEGAR_');
}

/** Llama a public.<name>(args). Devuelve { ok, status, data }; nunca lanza por errores de red (status 0). */
export async function rpc(name, args = {}) {
  const { supabaseUrl, anonKey } = config();
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

/** Las paginas que llevan datos privados (admin, reserva) no se pintan dentro de un marco. */
export function refuseFraming() {
  if (window.top !== window.self) {
    document.documentElement.replaceChildren();
    throw new Error('framing');
  }
}
