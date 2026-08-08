/**
 * db.js — Docta Nexus / Growth Intelligence Platform
 * Capa de acceso a Supabase. Se importa desde server.js.
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Descifrado de tokens (espejo de encryptToken en migrate_to_supabase.js) ──
function decryptToken(encB64) {
  if (!encB64) return null;
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const buf = Buffer.from(encB64, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// ── Traer un cliente por slug (solo su fila de "clients", sin credenciales todavía — eso es el sub-paso 3.3) ──
async function loadClientDB(slug) {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('slug', slug)
    .eq('active', true)
    .single();
  if (error || !data) return null;
  return data;
}

// ── Verificar password contra el hash bcrypt ──
async function verifyPassword(plainPassword, passwordHash) {
  if (!plainPassword || !passwordHash) return false;
  return bcrypt.compare(plainPassword, passwordHash);
}

// ── Atajo: valida el password de un slug en un solo llamado ──
async function checkPassword(slug, plainPassword) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return false;
  return verifyPassword(plainPassword, clientDB.password_hash);
}

// ── Cifrado de un token nuevo (para cuando el cron lo renueva) ──
function encryptToken(plainText) {
  if (!plainText) return null;
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

// ── Traer access_token + ad_account_id de Meta ya descifrados ──
async function getMetaCredentials(slug) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return null;
  const { data: cred, error } = await supabase
    .from('client_credentials')
    .select('*')
    .eq('client_id', clientDB.id)
    .eq('source', 'meta')
    .single();
  if (error || !cred) return null;
  return {
    clientId: clientDB.id,
    ad_account_id: cred.ad_account_id,
    access_token: decryptToken(cred.access_token_enc),
    token_expires_at: cred.token_expires_at,
  };
}

// ── Guardar un token de Meta renovado (usado por el cron) ──
async function updateMetaToken(slug, newAccessToken) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return false;
  const { error } = await supabase
    .from('client_credentials')
    .update({
      access_token_enc: encryptToken(newAccessToken),
      token_renewed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('client_id', clientDB.id)
    .eq('source', 'meta');
  return !error;
}

// ── Google Ads: traer el customer_id guardado de un cliente ──
async function getGoogleAdsAccountId(slug) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return null;
  const { data: cred, error } = await supabase
    .from('client_credentials')
    .select('ad_account_id')
    .eq('client_id', clientDB.id)
    .eq('source', 'google_ads')
    .single();
  if (error || !cred) return null;
  return cred.ad_account_id;
}

// ── Google Ads: asociar/actualizar el customer_id de un cliente ──
// (no hay token propio por cliente — la auth es a nivel agencia, vía env vars)
async function setGoogleAdsAccountId(slug, customerId) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return false;
  const { error } = await supabase
    .from('client_credentials')
    .upsert(
      { client_id: clientDB.id, source: 'google_ads', ad_account_id: customerId },
      { onConflict: 'client_id,source' }
    );
  return !error;
}

// ── GA4: traer el property_id guardado de un cliente ──
async function getGA4PropertyId(slug) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return null;
  const { data: cred, error } = await supabase
    .from('client_credentials')
    .select('ad_account_id')
    .eq('client_id', clientDB.id)
    .eq('source', 'ga4')
    .single();
  if (error || !cred) return null;
  return cred.ad_account_id;
}

// ── GA4: asociar/actualizar el property_id de un cliente ──
// (misma Service Account de GOOGLE_SERVICE_ACCOUNT para todos los clientes —
// lo que cambia por cliente es el Property ID de GA4, guardado acá igual
// que el Customer ID de Google Ads)
async function setGA4PropertyId(slug, propertyId) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return false;
  const { error } = await supabase
    .from('client_credentials')
    .upsert(
      { client_id: clientDB.id, source: 'ga4', ad_account_id: propertyId },
      { onConflict: 'client_id,source' }
    );
  return !error;
}

// ── Search Console: propiedad verificada del cliente (prefijo de URL o
// "sc-domain:dominio.com", tal cual figura en Search Console) — misma
// Service Account que GA4 (GA4_SERVICE_ACCOUNT), agregada como usuario
// en Search Console de cada propiedad por fuera de este código.
async function getSearchConsoleProperty(slug) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return null;
  const { data: cred, error } = await supabase
    .from('client_credentials')
    .select('ad_account_id')
    .eq('client_id', clientDB.id)
    .eq('source', 'search_console')
    .single();
  if (error || !cred) return null;
  return cred.ad_account_id;
}

async function setSearchConsoleProperty(slug, propertyUrl) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return false;
  const { error } = await supabase
    .from('client_credentials')
    .upsert(
      { client_id: clientDB.id, source: 'search_console', ad_account_id: propertyUrl },
      { onConflict: 'client_id,source' }
    );
  if (error) console.error('[search-console] error al guardar la propiedad:', error.message);
  return !error;
}

// ── Plan de Campañas: ID de la planilla de Google Sheets del cliente ──
// Mismo patrón que GA4/Google Ads: una Service Account compartida
// (GOOGLE_SERVICE_ACCOUNT), lo que cambia por cliente es el Sheet ID —
// el cliente/operador debe compartir esa planilla con el email de la
// Service Account como editor para que esto funcione.
// ── Salud de credenciales — capa de transparencia ──────────────
// Un solo lugar para que CUALQUIER cron (Meta/Google Ads/GA4/Search
// Console) deje registrado si algo falló, sin que cada uno reinvente su
// propio guardado. Se llama con errorMessage=null para limpiar el error
// cuando una corrida vuelve a andar bien — así "last_error" siempre
// refleja el estado REAL más reciente, no un error viejo ya resuelto.
async function setCredentialError(slug, source, errorMessage) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return false;
  const { error } = await supabase
    .from('client_credentials')
    .update({ last_error: errorMessage })
    .eq('client_id', clientDB.id)
    .eq('source', source);
  return !error;
}

// ── Estado de TODAS las credenciales de TODOS los clientes, para el
// panel "Estado de Conexiones" en /admin — una sola consulta, no una
// por cliente. ──
async function getAllCredentialsHealth() {
  const { data, error } = await supabase
    .from('client_credentials')
    .select('source, ad_account_id, token_expires_at, last_error, updated_at, clients(slug, name, active)')
    .order('updated_at', { ascending: false });
  if (error) return [];
  return data.map(r => ({
    slug: r.clients?.slug, name: r.clients?.name, active: r.clients?.active,
    source: r.source, ad_account_id: r.ad_account_id,
    token_expires_at: r.token_expires_at, last_error: r.last_error, updated_at: r.updated_at,
  })).filter(r => r.slug);
}

async function getSheetsId(slug) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return null;
  const { data: cred, error } = await supabase
    .from('client_credentials')
    .select('ad_account_id')
    .eq('client_id', clientDB.id)
    .eq('source', 'sheets')
    .single();
  if (error || !cred) return null;
  return cred.ad_account_id;
}

async function setSheetsId(slug, sheetId) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return false;
  const { error } = await supabase
    .from('client_credentials')
    .upsert(
      { client_id: clientDB.id, source: 'sheets', ad_account_id: sheetId },
      { onConflict: 'client_id,source' }
    );
  return !error;
}

// ── Panel de administración — alta de clientes sin tocar archivos ──
async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, 10);
}

// Crea un cliente nuevo directo en Supabase (tabla clients). Devuelve
// el registro creado, o null si falló (ej. slug duplicado).
async function createClientRecord({ slug, name, password, currency, timezone, colorPrimary, colorAccent, colorBtnText, reportProfile }) {
  const password_hash = await hashPassword(password);
  const { data, error } = await supabase
    .from('clients')
    .insert({
      slug, name, password_hash,
      currency: currency || 'ARS',
      timezone: timezone || 'America/Argentina/Buenos_Aires',
      color_primary: colorPrimary || '#c8f135',
      color_accent: colorAccent || '#a3c72c',
      color_btn_text: colorBtnText || '#0b0b0d',
      report_profile: ['leads', 'hibrido'].includes(reportProfile) ? reportProfile : 'ecommerce',
      active: true,
    })
    .select()
    .single();
  if (error) { console.error('[createClientRecord] Error:', error.message); return null; }
  return data;
}

// Asociar Ad Account ID + Access Token de Meta de un cliente (alta inicial,
// vía panel de admin) — mismo lugar que actualiza el cron (client_credentials).
async function setMetaCredentials(slug, adAccountId, accessToken) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return false;
  const { error } = await supabase
    .from('client_credentials')
    .upsert(
      { client_id: clientDB.id, source: 'meta', ad_account_id: adAccountId, access_token_enc: encryptToken(accessToken), token_renewed_at: new Date().toISOString() },
      { onConflict: 'client_id,source' }
    );
  return !error;
}

// Actualiza datos generales de un cliente ya existente (edición desde el admin)
async function updateClientRecord(slug, fields) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return false;
  const update = {};
  if (fields.name !== undefined) update.name = fields.name;
  if (fields.currency !== undefined) update.currency = fields.currency;
  if (fields.colorPrimary !== undefined) update.color_primary = fields.colorPrimary;
  if (fields.colorAccent !== undefined) update.color_accent = fields.colorAccent;
  if (fields.colorBtnText !== undefined) update.color_btn_text = fields.colorBtnText;
  if (fields.active !== undefined) update.active = fields.active;
  if (fields.reportProfile !== undefined) update.report_profile = fields.reportProfile;
  if (fields.clientPassword) update.password_hash = await hashPassword(fields.clientPassword);
  const { error } = await supabase.from('clients').update(update).eq('id', clientDB.id);
  return !error;
}

// Resumen de qué credenciales tiene conectadas un cliente (para el admin) —
// nunca devuelve el token en sí, solo si está conectado y el ID de cuenta
// (que no es sensible), para poder editar sin exponer el secreto.
async function getClientCredentialsSummary(slug) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return null;
  const { data } = await supabase
    .from('client_credentials')
    .select('source, ad_account_id, access_token_enc')
    .eq('client_id', clientDB.id);
  const bySource = {};
  (data || []).forEach(r => {
    bySource[r.source] = { ad_account_id: r.ad_account_id || null, connected: !!(r.ad_account_id) };
  });
  return bySource;
}

module.exports = {
  supabase, loadClientDB, verifyPassword, checkPassword,
  decryptToken, encryptToken, getMetaCredentials, updateMetaToken,
  getGoogleAdsAccountId, setGoogleAdsAccountId,
  getGA4PropertyId, setGA4PropertyId,
  getSearchConsoleProperty, setSearchConsoleProperty,
  setCredentialError, getAllCredentialsHealth,
  getSheetsId, setSheetsId,
  hashPassword, createClientRecord, setMetaCredentials,
  updateClientRecord, getClientCredentialsSummary,
};
