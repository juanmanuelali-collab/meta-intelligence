/**
 * set_ga4_property.js — Docta Nexus / Growth Intelligence Platform
 *
 * Asocia el Property ID de Google Analytics 4 de un cliente en Supabase.
 * No hay credencial por cliente — la autenticación es con la Service
 * Account de GOOGLE_SERVICE_ACCOUNT (misma que usa Sheets), así que acá
 * solo se guarda el número de propiedad.
 *
 * IMPORTANTE: antes de correr esto, el email de la Service Account
 * (campo "client_email" del JSON) tiene que estar agregado como Viewer
 * en Google Analytics → Admin → Property Access Management de la
 * propiedad GA4 de ese cliente. Sin eso, la sincronización va a fallar
 * aunque el Property ID esté bien guardado acá.
 *
 * Uso (desde la Shell de Render, parado en la raíz del proyecto):
 *   node set_ga4_property.js <slug> <property_id>
 *
 * Ejemplo:
 *   node set_ga4_property.js zappa-center 123456789
 */

require('dotenv').config();
const { setGA4PropertyId, getGA4PropertyId } = require('./db');

async function main() {
  const [, , slug, propertyId] = process.argv;

  if (!slug || !propertyId) {
    console.error('Uso: node set_ga4_property.js <slug> <property_id>');
    process.exit(1);
  }

  console.log(`Asociando Property ID de GA4 "${propertyId}" a "${slug}"...`);
  const ok = await setGA4PropertyId(slug, propertyId);

  if (!ok) {
    console.error(`✗ No se pudo guardar. Verificá que el slug "${slug}" exista en la tabla clients.`);
    process.exit(1);
  }

  const check = await getGA4PropertyId(slug);
  console.log(check === propertyId
    ? `✓ Property ID asociado y verificado para "${slug}".`
    : `⚠ Se guardó pero la verificación no coincidió — revisá manualmente.`
  );
}

main().catch(e => {
  console.error('✗ Error:', e.message);
  process.exit(1);
});
