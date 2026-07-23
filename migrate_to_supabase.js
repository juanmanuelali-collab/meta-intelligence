/**
 * ============================================================
 * Growth Intelligence Platform — Docta Nexus
 * Paso 2: Migración de clients/*.json y data/*.json a Supabase
 * ============================================================
 *
 * Requisitos:
 *   npm install @supabase/supabase-js bcryptjs dotenv
 *
 * Variables de entorno necesarias (.env):
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ...        (la service_role, NO la anon)
 *   ENCRYPTION_KEY=una-clave-random-de-32-bytes-en-hex
 *
 * Para generar ENCRYPTION_KEY (correr una vez en tu terminal):
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Cómo correrlo:
 *   node migrate_to_supabase.js --dry-run     (revisa sin escribir nada)
 *   node migrate_to_supabase.js               (migra de verdad)
 *
 * IMPORTANTE: correr esto DESDE la carpeta que contiene clients/
 * y (si ya la conseguiste) data/ — es decir, la raíz del proyecto
 * meta-intelligence actual.
 * ============================================================
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.argv.includes('--dry-run');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLIENTS_DIR = path.join(__dirname, 'clients');
const DATA_DIR = path.join(__dirname, 'data'); // puede no existir todavía

// ── Cifrado de tokens (AES-256-GCM) ────────────────────────────
function encryptToken(plainText) {
  if (!plainText) return null;
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Guardamos iv + authTag + datos, todo junto en base64 (server.js lo separa al leer)
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

// ── Regla del jueves: a qué mes calendario pertenece una semana ISO ──
function isoWeekThursdayMonth(isoYear, isoWeek) {
  // Jan 4 siempre cae en la semana ISO 1 del año — punto de partida estándar.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // domingo=0 → 7
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const thursday = new Date(week1Monday);
  thursday.setUTCDate(week1Monday.getUTCDate() + (isoWeek - 1) * 7 + 3);
  return { month: thursday.getUTCMonth() + 1, year: thursday.getUTCFullYear() };
}

function getIsoWeekOfDate(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { isoYear: d.getUTCFullYear(), isoWeek: weekNo };
}

// ── Paso A: migrar clients/*.json → clients + client_credentials ──
async function migrateClients() {
  const files = fs.readdirSync(CLIENTS_DIR).filter(f => f.endsWith('.json'));
  console.log(`\n[clients] Encontrados ${files.length} archivos.\n`);

  const slugToId = {};

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(CLIENTS_DIR, file), 'utf8'));
    console.log(`→ Migrando cliente: ${raw.slug}`);

    const passwordHash = bcrypt.hashSync(raw.password, 10);

    const clientRow = {
      slug: raw.slug,
      name: raw.name,
      password_hash: passwordHash,
      currency: raw.currency || 'ARS',
      timezone: raw.timezone || 'America/Argentina/Buenos_Aires',
      color_primary: raw.colorPrimary || '#c8f135',
      color_accent: raw.colorAccent || '#a3c72c',
      color_btn_text: raw.colorBtnText || '#0b0b0d',
      email_alerts: raw.email_alerts || [],
      report_hour: raw.report_hour ?? 8,
      // FIX del hallazgo: el motor lee kpi_targets, los archivos tienen "objectives"
      kpi_targets: raw.objectives || raw.kpi_targets || {},
      alert_thresholds: raw.alert_thresholds || {},
      client_profile: raw.client_profile || null,
      client_rubro: raw.client_rubro || null,
      excluded_metrics: raw.excluded_metrics || [],
      custom_conversions: raw.custom_conversions || [],
    };

    if (DRY_RUN) {
      console.log('  [dry-run] insertaría:', JSON.stringify(clientRow, null, 2));
      slugToId[raw.slug] = `dry-run-${raw.slug}`;
    } else {
      const { data, error } = await supabase
        .from('clients')
        .upsert(clientRow, { onConflict: 'slug' })
        .select('id, slug')
        .single();
      if (error) { console.error(`  ✗ Error insertando cliente ${raw.slug}:`, error.message); continue; }
      slugToId[raw.slug] = data.id;
      console.log(`  ✓ Cliente creado/actualizado (id: ${data.id})`);
    }

    // Credenciales de Meta
    if (raw.access_token) {
      const credRow = {
        client_id: slugToId[raw.slug],
        source: 'meta',
        ad_account_id: raw.ad_account_id,
        access_token_enc: encryptToken(raw.access_token),
        token_renewed_at: raw.token_renewed_at || null,
      };
      if (DRY_RUN) {
        console.log('  [dry-run] insertaría credenciales Meta (token cifrado, no se muestra)');
      } else {
        const { error: credError } = await supabase
          .from('client_credentials')
          .upsert(credRow, { onConflict: 'client_id,source' });
        if (credError) console.error(`  ✗ Error insertando credenciales de ${raw.slug}:`, credError.message);
        else console.log('  ✓ Credenciales Meta migradas (token cifrado)');
      }
    }

    // Memoria histórica → ai_insights (si el archivo la tiene)
    if (Array.isArray(raw.memory) && raw.memory.length > 0) {
      console.log(`  → Migrando ${raw.memory.length} entradas de memoria histórica...`);
      for (const entry of raw.memory) {
        const d = new Date(entry.fecha + 'T12:00:00Z');
        const { isoYear, isoWeek } = getIsoWeekOfDate(d);
        const insightRow = {
          client_id: slugToId[raw.slug],
          period_type: 'week',
          iso_year: isoYear,
          iso_week: isoWeek,
          module: 'meta_ads',
          insight_type: 'diagnosis',
          source_model: 'claude', // heredado de generateDailySummary (usaba Haiku)
          content: {
            resumen: entry.resumen,
            acciones: entry.acciones,
            alertas: entry.alertas,
            fecha_original: entry.fecha,
            migrado_de: 'client.memory',
          },
        };
        if (!DRY_RUN) {
          const { error: insError } = await supabase.from('ai_insights').insert(insightRow);
          if (insError) console.error(`    ✗ Error migrando memoria del ${entry.fecha}:`, insError.message);
        }
      }
      console.log('  ✓ Memoria histórica migrada');
    }
  }

  return slugToId;
}

// ── Paso B: migrar data/{slug}/{fecha}.json → ad_metrics_daily ──
async function migrateHistoricalMetrics(slugToId) {
  if (!fs.existsSync(DATA_DIR)) {
    console.log('\n[data] No se encontró la carpeta data/ — se omite este paso.');
    console.log('       Cuando la consigas de Render, corré este script de nuevo');
    console.log('       (no va a duplicar clientes ya migrados, usa upsert).\n');
    return;
  }

  const slugs = fs.readdirSync(DATA_DIR).filter(f =>
    fs.statSync(path.join(DATA_DIR, f)).isDirectory()
  );
  console.log(`\n[data] Encontradas ${slugs.length} carpetas de clientes con histórico.\n`);

  for (const slug of slugs) {
    const clientId = slugToId[slug];
    if (!clientId) { console.warn(`  ⚠ Slug "${slug}" no tiene cliente migrado, se omite.`); continue; }

    const dayFiles = fs.readdirSync(path.join(DATA_DIR, slug)).filter(f => f.endsWith('.json'));
    console.log(`→ ${slug}: ${dayFiles.length} snapshots diarios`);

    for (const dayFile of dayFiles) {
      const dateStr = dayFile.replace('.json', ''); // YYYY-MM-DD
      const snapshot = JSON.parse(fs.readFileSync(path.join(DATA_DIR, slug, dayFile), 'utf8'));
      const acc = snapshot.account || snapshot.metricsData?.account || {};

      const metricRow = {
        client_id: clientId,
        source: 'meta',
        date: dateStr,
        campaign_id: null, // snapshot es a nivel cuenta; campañas quedan para el conector nuevo
        campaign_name: null,
        spend: acc.spend || 0,
        impressions: acc.impressions || 0,
        clicks: acc.clicks || 0,
        ctr: acc.ctr || null,
        cpm: acc.cpm || null,
        roas: acc.roas || null,
        frequency: acc.frequency || null,
        conversions: acc.purchases || 0,
        conversion_value: acc.conversionValue || 0,
        extra_metrics: { migrado_de: 'data/*.json', health_score: snapshot.analysis?.health_score },
      };

      if (!DRY_RUN) {
        const { error } = await supabase
          .from('ad_metrics_daily')
          .upsert(metricRow, { onConflict: 'client_id,source,date,campaign_id' });
        if (error) console.error(`    ✗ Error en ${slug}/${dateStr}:`, error.message);
      }
    }
    console.log(`  ✓ ${slug} migrado`);
  }
}

// ── Main ──────────────────────────────────────────────────────
(async () => {
  console.log('============================================================');
  console.log(` Migración a Supabase ${DRY_RUN ? '(DRY RUN — no se escribe nada)' : '(EJECUCIÓN REAL)'}`);
  console.log('============================================================');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('✗ Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el .env');
    process.exit(1);
  }
  if (!DRY_RUN && !process.env.ENCRYPTION_KEY) {
    console.error('✗ Falta ENCRYPTION_KEY en el .env (necesaria para cifrar tokens)');
    process.exit(1);
  }

  const slugToId = await migrateClients();
  await migrateHistoricalMetrics(slugToId);

  console.log('\n============================================================');
  console.log(' Migración terminada.');
  console.log('============================================================\n');
})();
