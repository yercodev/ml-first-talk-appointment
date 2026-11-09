// Configuracion publica del front. La clave `anon` es publica por diseno (va en el navegador);
// lo que protege los datos son las funciones ml_* de Supabase, no esta clave.
window.ML_CONFIG = {
  supabaseUrl: 'https://dojgxfotawtxitgcppyn.supabase.co',
  anonKey: 'PEGAR_ANON_KEY_STAGING',
};
