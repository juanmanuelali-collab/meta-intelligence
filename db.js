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

module.exports = {
  supabase, loadClientDB, verifyPassword, checkPassword,
  decryptToken, getMetaCredentials, updateMetaToken,
};
