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

module.exports = { supabase, loadClientDB, verifyPassword, decryptToken };
