/**
 * set_google_ads_account.js — Docta Nexus / Growth Intelligence Platform
 *
 * Asocia el Customer ID de Google Ads de un cliente en Supabase.
 * No hay token por cliente — la autenticación es a nivel agencia
 * (Developer Token / Client ID / Secret / Refresh Token en variables
 * de entorno), así que acá solo se guarda el número de cuenta.
 *
 * Uso (desde la Shell de Render, parado en la raíz del proyecto):
 *   node set_google_ads_account.js <slug> <customer_id>
 *
 * Ejemplo:
 *   node set_google_ads_account.js zappa-center 123-456-7890
 */

require('dotenv').config();
const { setGoogleAdsAccountId, getGoogleAdsAccountId } = require('./db');

async function main() {
  const [, , slug, customerId] = process.argv;

  if (!slug || !customerId) {
    console.error('Uso: node set_google_ads_account.js <slug> <customer_id>');
    process.exit(1);
  }

  console.log(`Asociando Customer ID de Google Ads "${customerId}" a "${slug}"...`);
  const ok = await setGoogleAdsAccountId(slug, customerId);

  if (!ok) {
    console.error(`✗ No se pudo guardar. Verificá que el slug "${slug}" exista en la tabla clients.`);
    process.exit(1);
  }

  const check = await getGoogleAdsAccountId(slug);
  console.log(check === customerId
    ? `✓ Customer ID asociado y verificado para "${slug}".`
    : `⚠ Se guardó pero la verificación no coincidió — revisá manualmente.`
  );
}

main().catch(e => {
  console.error('✗ Error:', e.message);
  process.exit(1);
});
