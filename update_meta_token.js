/**
 * update_meta_token.js — Docta Nexus / Growth Intelligence Platform
 *
 * Actualiza el access_token de Meta de un cliente directo en Supabase
 * (cifrado), para cuando Meta invalida el token y hay que reemplazarlo
 * a mano — ya no se edita el JSON, esa era la forma vieja.
 *
 * Uso (desde la Shell de Render, parado en la raíz del proyecto):
 *   node update_meta_token.js <slug> "<nuevo_access_token>"
 *
 * Ejemplo:
 *   node update_meta_token.js zappa-center "EAAG..."
 *
 * Requiere las mismas variables de entorno que ya tenés cargadas
 * (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY).
 */

require('dotenv').config();
const { updateMetaToken, getMetaCredentials } = require('./db');

async function main() {
  const [, , slug, newToken] = process.argv;

  if (!slug || !newToken) {
    console.error('Uso: node update_meta_token.js <slug> "<nuevo_access_token>"');
    process.exit(1);
  }

  console.log(`Actualizando token de Meta para "${slug}"...`);
  const ok = await updateMetaToken(slug, newToken);

  if (!ok) {
    console.error(`✗ No se pudo actualizar. Verificá que el slug "${slug}" exista en la tabla clients.`);
    process.exit(1);
  }

  // Verificación: releer y confirmar que el token guardado coincide
  const check = await getMetaCredentials(slug);
  const matches = check?.access_token === newToken;
  console.log(matches
    ? `✓ Token actualizado y verificado para "${slug}".`
    : `⚠ El token se guardó pero la verificación no coincidió — revisá manualmente.`
  );
}

main().catch(e => {
  console.error('✗ Error:', e.message);
  process.exit(1);
});
