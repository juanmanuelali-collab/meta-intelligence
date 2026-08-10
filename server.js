require('dotenv').config();

// Red de seguridad: un error sin atrapar en CUALQUIER ruta (ej. una función
// que ya no existe, un await que falla sin try/catch) no debe tumbar todo
// el servidor — solo se loguea, el proceso sigue vivo. Esto es lo que pasó
// con el bug de "setSheetsId is not a function": sin esto, un solo request
// mal formado tiraba abajo TODO el server (502 en todas las rutas) hasta
// que Render lo reiniciaba solo.
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION] El proceso sigue vivo. Error:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION] El proceso sigue vivo. Error:', err);
});

const express    = require('express');
const fetch      = require('node-fetch');
const path       = require('path');
const fs         = require('fs');
const cron       = require('node-cron');
const crypto     = require('crypto');
const { google } = require('googleapis');
const { loadClientDB, verifyPassword, checkPassword, getMetaCredentials, updateMetaToken, getGoogleAdsAccountId, getGA4PropertyId, getSearchConsoleProperty, setSearchConsoleProperty, getSheetsId, setSheetsId, createClientRecord, setMetaCredentials, setGoogleAdsAccountId, setGA4PropertyId, updateClientRecord, getClientCredentialsSummary, setCredentialError, getAllCredentialsHealth, supabase } = require('./db'); // Sub-pasos 3.1/3.2/3.3 — auth + credenciales vía Supabase
const { fetchSearchConsoleSummary, fetchTopQueries, fetchTopPages, fetchByCountry, fetchByDevice, fetchBySearchType, inspectUrl } = require('./searchconsole'); // Conector Search Console — reusa GA4_SERVICE_ACCOUNT
const { fetchCampaignMetrics, normalizeToAdMetricsRows, fetchShoppingProducts, fetchCampaignMetricsRange, aggregateCampaignRows, fetchTopKeywords, fetchConversionActionsSummary } = require('./google_ads'); // Fase 1 — conector Google Ads
const { fetchGA4WeeklyMetrics, fetchGA4AcquisitionForDate, fetchGA4SiteMetricsForDate, fetchGA4AcquisitionForRange, fetchGA4SiteMetricsForRange, fetchGA4TopPages, fetchGA4TopItems, fetchGA4FunnelCounts, GA4_FUNNEL_EVENTS, fetchGA4TopItemsDetailed, fetchGA4DeviceBreakdown, fetchGA4Demographics, fetchGA4KeyEventsSummary } = require('./ga4'); // Integración GA4 — tráfico y eventos por semana (post-Fase 5)

const app  = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY     = process.env.OPENAI_API_KEY;
const RESEND_KEY     = process.env.RESEND_API_KEY;
const META_API_VER   = 'v23.0'; // v19 dado de baja por Meta (~feb-2026, 2 años desde su lanzamiento)
const TZ             = process.env.TIMEZONE || 'America/Argentina/Buenos_Aires';
const SHEET_ID       = process.env.GOOGLE_SHEET_ID;

// ── GOOGLE SHEETS — LOGGER DE COSTOS IA ───────────────────────
const AI_PRICES = {
  'claude-haiku-4-5-20251001': { input: 0.80,  output: 4.00  },
  'claude-sonnet-4-20250514':  { input: 3.00,  output: 15.00 },
  'claude-sonnet-5':           { input: 3.00,  output: 15.00 },
  'claude-opus-4-5':           { input: 15.00, output: 75.00 },
  'gpt-4o-mini':               { input: 0.15,  output: 0.60  },
  'gpt-4o':                    { input: 2.50,  output: 10.00 },
};

function calcCost(model, inputTokens, outputTokens) {
  const p = AI_PRICES[model];
  if (!p) return 0;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

async function getSheetsClient() {
  try {
    // GA4_SERVICE_ACCOUNT ya funciona (Analytics anda perfecto) — la reusamos
    // para Sheets en vez de depender de GOOGLE_SERVICE_ACCOUNT, que venía con
    // un invalid_grant sin resolver desde antes. Si en algún momento se
    // resuelve esa segunda cuenta, se puede volver a separar sin problema.
    const raw = process.env.GA4_SERVICE_ACCOUNT || process.env.GOOGLE_SERVICE_ACCOUNT || '{}';
    const creds = JSON.parse(raw);
    // Render a veces escapa las \n del private_key — las restauramos
    if (creds.private_key) {
      creds.private_key = creds.private_key.replace(/\\n/g, '\n');
    }
    if (!creds.client_email) {
      console.error('[sheets] GA4_SERVICE_ACCOUNT/GOOGLE_SERVICE_ACCOUNT sin client_email — verificar variable de entorno');
      return null;
    }
    console.log('[sheets] Autenticando como:', creds.client_email);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return google.sheets({ version: 'v4', auth });
  } catch(e) {
    console.error('[sheets] Error auth:', e.message);
    return null;
  }
}

// ── PLAN DE CAMPAÑAS: la planilla de Sheets de cada cliente es la ÚNICA
// fuente — no se guarda copia en Supabase. Se lee por nombre de columna
// (no por posición fija), para tolerar variaciones en el Sheet real del
// cliente. Estructura real (A a K): Campaign Name, Channel, Start Date,
// End Date, Budget %, Objective, Target Audience, Creative, Status,
// KPI Principal, Notas.
// ── Plan de Campañas — Supabase es la fuente única, el Sheet es de SOLO
// EXPORTACIÓN (un botón "Exportar a Sheet" escribe una pestaña nueva con
// el plan del período; nunca se lee el Sheet como fuente de datos). ──

// "2026-08" → "agosto 2026", para nombrar la pestaña exportada.
function periodToLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return `${MESES_ES[m - 1]} ${y}`;
}

// Crea una pestaña nueva en la planilla del cliente (ej. "agosto 2026") con
// el plan tal cual está en Supabase — nunca pisa una pestaña existente,
// siempre agrega una nueva. Dirección única Supabase → Sheet.
// Las columnas replican EXACTAMENTE las del Plan Master (mismo orden, mismos
// nombres) para que cualquier mes se vea igual que el molde del que salió —
// campos que el mes todavía no tiene (decision/decision_reason, motor de
// Fase 2) quedan en blanco, no se sacan de la estructura.
const CHANNEL_LABELS_ES = { meta: 'Meta Ads', google_ads: 'Google Ads' };
const ACTIVE_DAYS_LABELS_ES = { todos: 'Todos los días', lunes_viernes: 'Lunes a viernes', lunes_sabado: 'Lunes a sábado', sabado_domingo: 'Sábado y domingo' };
async function exportPlanToSheet(sheetId, tabName, items) {
  const sheets = await getSheetsClient();
  if (!sheets) throw new Error('No se pudo autenticar con Google Sheets — revisar GA4_SERVICE_ACCOUNT/GOOGLE_SERVICE_ACCOUNT.');
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });
  const header = ['Campaign Name', 'campaign_id', 'Channel', 'Inicio', 'Fin', 'Objective', 'Campaign Objective', 'Budget Diario', 'Días activos', 'Dias Calculados', 'Budget Mensual', 'Status', 'KPI 1', 'First KPI Target', 'KPI 2', 'Second KPI Target', 'KPI 3', 'Third KPI Target', 'decision', 'decision_reason', 'Notas', 'Restricciones'];
  const values = [header, ...items.map(r => [
    r.campaign_name || '', r.plan_code || '', CHANNEL_LABELS_ES[r.channel] || r.channel || '',
    r.start_date || '', r.end_date || '', r.objective || '', r.campaign_objective || '',
    r.budget_diario ?? '', ACTIVE_DAYS_LABELS_ES[r.active_days_pattern] || r.active_days_pattern || '', r.calculated_days ?? r.dias ?? '',
    r.budget_mensual ?? '', r.status || '',
    r.kpi_1 || '', r.kpi_1_target ?? '', r.kpi_2 || '', r.kpi_2_target ?? '', r.kpi_3 || '', r.kpi_3_target ?? '',
    r.decision || '', r.decision_reason || '', r.notas || '', r.restricciones || '',
  ])];
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId, range: `'${tabName}'!A1`, valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

async function ensureSheetHeaders(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Hoja 1!A1:J1',
    });
    if (!res.data.values || res.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Hoja 1!A1',
        valueInputOption: 'RAW',
        requestBody: { values: [['Fecha', 'Hora', 'Cliente', 'Modelo', 'Tipo de Llamado', 'Tokens Input', 'Tokens Output', 'Costo USD', 'Proveedor', 'Notas']] },
      });
    }
  } catch(e) {
    console.warn('[sheets] Error headers:', e.message);
  }
}

async function logAiCall({ slug, model, callType, inputTokens, outputTokens, notes = '' }) {
  if (!SHEET_ID) {
    console.warn('[sheets] GOOGLE_SHEET_ID no configurado');
    return;
  }
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    await ensureSheetHeaders(sheets);
    const now = new Date();
    const fecha = now.toLocaleDateString('es-AR', { timeZone: TZ });
    const hora  = now.toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
    const costo = calcCost(model, inputTokens, outputTokens);
    const proveedor = model.startsWith('gpt') ? 'OpenAI' : 'Anthropic';
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Hoja 1!A:J',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[fecha, hora, slug || 'sistema', model, callType, inputTokens, outputTokens, parseFloat(costo.toFixed(6)), proveedor, notes]] },
    });
    console.log(`[sheets] ✓ Logged: ${slug} | ${model} | ${callType} | in:${inputTokens} out:${outputTokens} | $${costo.toFixed(5)}`);
  } catch(e) {
    console.error('[sheets] Error logging:', e.message);
  }
}

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── HELPERS ───────────────────────────────────────────────────
// Alta de clientes (post-Fase 5, admin panel): ya no se lee de archivos.
// Todo (colores, kpi_targets, dash_config, etc.) vive en la tabla
// `clients` de Supabase — un cliente nuevo es un INSERT, sin deploy.
async function loadClient(slug) {
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return null;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return null;
  return {
    name: clientDB.name,
    slug: clientDB.slug,
    currency: clientDB.currency || 'ARS',
    timezone: clientDB.timezone,
    client_profile: clientDB.client_profile,
    client_rubro: clientDB.client_rubro,
    report_profile: ['leads', 'hibrido'].includes(clientDB.report_profile) ? clientDB.report_profile : 'ecommerce',
    colorPrimary: clientDB.color_primary || '#c8f135',
    colorAccent: clientDB.color_accent || '#a3c72c',
    colorBtnText: clientDB.color_btn_text || '#0b0b0d',
    email_alerts: clientDB.email_alerts || [],
    report_hour: clientDB.report_hour,
    kpi_targets: clientDB.kpi_targets || {},
    alert_thresholds: clientDB.alert_thresholds || {},
    excluded_metrics: clientDB.excluded_metrics || [],
    custom_conversions: clientDB.custom_conversions || {},
    dash_config: clientDB.dash_config || {},
    report_email: clientDB.report_email || null,
  };
}

// Sub-paso 3.3: mismo objeto que loadClient (colores, kpi_targets, etc.
// ya vienen de Supabase), pero access_token / ad_account_id se pisan
// con lo que hay en client_credentials, que es donde vive lo sensible.
async function loadClientWithCreds(slug) {
  const client = await loadClient(slug);
  if (!client) return null;
  const creds = await getMetaCredentials(slug);
  if (creds) {
    client.access_token = creds.access_token;
    client.ad_account_id = creds.ad_account_id;
  }
  return client;
}

async function listClients() {
  const { data, error } = await supabase.from('clients').select('slug').eq('active', true);
  if (error) { console.error('[listClients] Error:', error.message); return []; }
  return (data || []).map(c => c.slug);
}

// Sub-paso 3.4: saveData/loadHistory ahora escriben/leen en Supabase
// (ad_metrics_daily), no en data/{slug}/{fecha}.json. El "data" que
// se guarda por día sigue siendo el mismo objeto {date, metrics, analysis}
// que ya usaba el resto del código — lo empaquetamos en extra_metrics
// para no tener que rediseñar cada endpoint que lo consume.
async function saveDataDB(slug, data) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return false;
  const acc = data.metrics?.account || {};
  const row = {
    client_id: clientDB.id,
    source: 'meta',
    date: data.date || today(),
    campaign_id: '__ACCOUNT__', // snapshot a nivel cuenta — antes null, pero Postgres nunca
    // trata dos NULL como iguales en un UNIQUE constraint, así que el upsert de abajo jamás
    // detectaba conflicto y insertaba una fila nueva cada vez que se abría el dashboard.
    campaign_name: null,
    spend: acc.spend || 0,
    impressions: acc.impressions || 0,
    clicks: acc.clicks || 0,
    ctr: acc.ctr ?? null,
    cpm: acc.cpm ?? null,
    roas: acc.roas ?? null,
    frequency: acc.frequency ?? null,
    conversions: acc.purchases || 0,
    conversion_value: acc.revenue || 0,
    extra_metrics: data, // objeto completo {date, metrics, analysis} — así ningún endpoint existente se rompe
  };
  const { error } = await supabase
    .from('ad_metrics_daily')
    .upsert(row, { onConflict: 'client_id,source,date,campaign_id' });
  if (error) console.error(`[saveDataDB] Error guardando snapshot de ${slug}:`, error.message);
  return !error;
}

async function loadHistoryDB(slug, days = 14) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return [];
  const { data, error } = await supabase
    .from('ad_metrics_daily')
    .select('date, extra_metrics')
    .eq('client_id', clientDB.id)
    .eq('source', 'meta')
    .eq('campaign_id', '__ACCOUNT__')
    .order('date', { ascending: false })
    .limit(days);
  if (error) { console.error(`[loadHistoryDB] Error leyendo historial de ${slug}:`, error.message); return []; }
  // Devolvemos el objeto original {date, metrics, analysis} guardado en extra_metrics,
  // igual forma que devolvía loadHistory() leyendo los archivos viejos.
  return data.map(row => row.extra_metrics).filter(Boolean);
}

// Snapshot de HOY (equivalente a fs.existsSync(todayFile) + leerlo)
async function getTodaySnapshotDB(slug) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return null;
  const { data, error } = await supabase
    .from('ad_metrics_daily')
    .select('extra_metrics')
    .eq('client_id', clientDB.id)
    .eq('source', 'meta')
    .eq('date', today())
    .eq('campaign_id', '__ACCOUNT__')
    .maybeSingle();
  if (error || !data) return null;
  return data.extra_metrics;
}

// Actualizar SOLO una parte del snapshot de hoy (ej: analysis, followers)
// sin pisar el resto — equivalente a leer/mergear/reescribir el JSON viejo.
async function patchTodaySnapshotDB(slug, patch) {
  const current = await getTodaySnapshotDB(slug);
  if (!current) return false; // no hay snapshot de hoy, nada que parchear
  const merged = { ...current, ...patch };
  return saveDataDB(slug, merged);
}

function today() { return new Date().toISOString().slice(0, 10); }

// ── META API ──────────────────────────────────────────────────
async function metaFetch(path, token) {
  const r = await fetch('https://graph.facebook.com/' + META_API_VER + path + '&access_token=' + token);
  const d = await r.json();
  if (d.error) throw new Error('Meta API: ' + d.error.message);
  return d;
}

// ── HELPERS GLOBALES (usados en fetchAccountMetrics Y en /metrics) ──
function getAction(actions, type) {
  const a = (actions || []).find(a => a.action_type === type);
  return a ? parseInt(a.value) : 0;
}
function getActionValue(actionValues, type) {
  const a = (actionValues || []).find(a => a.action_type === type);
  return a ? parseFloat(a.value) : 0;
}

function calcKpis(data) {
  if (!data) return {};
  const spend       = parseFloat(data.spend || 0);
  const clicks      = parseInt(data.clicks || 0);
  const impressions = parseInt(data.impressions || 0);
  const reach       = parseInt(data.reach || 0);
  const frequency   = parseFloat(data.frequency || 0);
  const ctr         = parseFloat(data.ctr || 0);
  const cpm         = parseFloat(data.cpm || 0);
  const uniqueClicks= parseInt(data.unique_clicks || 0);
  const uniqueCtr   = parseFloat(data.unique_ctr || 0);

  const actions      = data.actions || [];
  const actionValues = data.action_values || [];

  // ── PIXEL (offsite) ──────────────────────────────────────
  const pixelPurchase    = getAction(actions, 'offsite_conversion.fb_pixel_purchase');
  const pixelAddToCart   = getAction(actions, 'offsite_conversion.fb_pixel_add_to_cart');
  const pixelCheckout    = getAction(actions, 'offsite_conversion.fb_pixel_initiate_checkout');
  const pixelViewContent = getAction(actions, 'offsite_conversion.fb_pixel_view_content');
  const pixelSearch      = getAction(actions, 'offsite_conversion.fb_pixel_search');
  const pixelWishlist    = getAction(actions, 'offsite_conversion.fb_pixel_add_to_wishlist');
  const pixelReg         = getAction(actions, 'offsite_conversion.fb_pixel_complete_registration');
  const pixelLead        = getAction(actions, 'offsite_conversion.fb_pixel_lead');
  const pixelCustom      = getAction(actions, 'offsite_conversion.fb_pixel_custom');

  // ── CONVERSIONES ONSITE (on-Facebook) ────────────────────
  const onsitePurchase   = getAction(actions, 'onsite_conversion.purchase');
  const onsiteAddToCart  = getAction(actions, 'onsite_conversion.add_to_cart');
  const onsiteCheckout   = getAction(actions, 'onsite_conversion.checkout');
  const donations        = getAction(actions, 'onsite_conversion.donate');

  // ── COMPRAS CONSOLIDADAS (pixel + onsite + omni) ─────────
  const purchases     = pixelPurchase || onsitePurchase ||
                        getAction(actions, 'purchase') || getAction(actions, 'omni_purchase');
  const purchaseValue = getActionValue(actionValues, 'offsite_conversion.fb_pixel_purchase') ||
                        getActionValue(actionValues, 'purchase') ||
                        getActionValue(actionValues, 'omni_purchase');

  // ── CARRITO / CHECKOUT CONSOLIDADOS ──────────────────────
  const addToCart        = pixelAddToCart || onsiteAddToCart || getAction(actions, 'add_to_cart');
  const initiateCheckout = pixelCheckout  || onsiteCheckout  || getAction(actions, 'initiate_checkout');
  const completeReg      = pixelReg || getAction(actions, 'complete_registration');

  // ── LEADS ────────────────────────────────────────────────
  const leads        = pixelLead || getAction(actions, 'lead');
  const leadgenLeads = getAction(actions, 'onsite_conversion.lead_grouped') ||
                       getAction(actions, 'leadgen_grouped');

  // ── TRÁFICO / CLICKS ──────────────────────────────────────
  const landingPageViews = getAction(actions, 'landing_page_view');
  const linkClicks       = getAction(actions, 'link_click');
  const outboundClicks   = getAction(actions, 'outbound_click');

  // ── MENSAJERÍA ────────────────────────────────────────────
  const messagingConn       = getAction(actions, 'onsite_conversion.total_messaging_connection');
  const messagingFirstReply = getAction(actions, 'onsite_conversion.messaging_first_reply');
  const messagingStarted7d  = getAction(actions, 'onsite_conversion.messaging_conversation_started_7d');
  const msgDepth2           = getAction(actions, 'onsite_conversion.messaging_user_depth_2_message_send');
  const msgDepth3           = getAction(actions, 'onsite_conversion.messaging_user_depth_3_message_send');
  const msgDepth5           = getAction(actions, 'onsite_conversion.messaging_user_depth_5_message_send');

  // ── VIDEO ─────────────────────────────────────────────────
  const videoViews    = getAction(actions, 'video_view');
  const videoViews3s  = videoViews; // video_view ya es 3s
  // Fields directos de video (vienen fuera del array actions)
  const videoViews10s = parseInt(data.video_10_sec_watched_actions?.[0]?.value || 0);
  const videoViews15s = parseInt(data.video_15_sec_watched_actions?.[0]?.value || 0);
  const videoViews30s = parseInt(data.video_30_sec_watched_actions?.[0]?.value || 0);
  const videoAvgTime  = parseFloat(data.video_avg_time_watched_actions?.[0]?.value || 0);
  const videoP25      = getAction(actions, 'video_p25_watched_actions');
  const videoP50      = getAction(actions, 'video_p50_watched_actions');
  const videoP75      = getAction(actions, 'video_p75_watched_actions');
  const videoP95      = getAction(actions, 'video_p95_watched_actions');
  const thruPlays     = getAction(actions, 'video_p100_watched_actions');

  // ── ENGAGEMENT / SOCIAL ──────────────────────────────────
  const postEngagement = getAction(actions, 'post_engagement');
  const postReactions  = getAction(actions, 'post_reaction');
  const postLikes      = getAction(actions, 'like');
  const postComments   = getAction(actions, 'comment');
  const postShares     = getAction(actions, 'share');
  const pageEngagement = getAction(actions, 'page_engagement');
  const postSaves      = getAction(actions, 'onsite_conversion.post_save') || getAction(actions, 'post_save');

  // ── SEGUIDORES / PERFIL ──────────────────────────────────
  const newFollowersPage = getAction(actions, 'follow');
  const newFollowersIG   = getAction(actions, 'onsite_conversion.follow');
  const igProfileVisits  = getAction(actions, 'ig_profile_visit') ||
                           getAction(actions, 'onsite_conversion.instagram_profile_visit');

  // ── KPIs CALCULADOS ───────────────────────────────────────
  const conversions = purchases || leads || leadgenLeads || 0;
  const roas  = spend > 0 && purchaseValue > 0 ? purchaseValue / spend : null;
  const cpl   = spend > 0 && leads > 0 ? spend / leads : null;
  const cpmsg = spend > 0 && messagingConn > 0 ? spend / messagingConn : null;

  return {
    spend, clicks, impressions, reach, frequency, ctr, cpm, uniqueClicks, uniqueCtr,
    // Pixel
    pixelPurchase, pixelAddToCart, pixelCheckout, pixelViewContent,
    pixelSearch, pixelWishlist, pixelReg, pixelLead, pixelCustom,
    // Onsite
    onsitePurchase, onsiteAddToCart, onsiteCheckout, donations,
    // Consolidados
    purchases, purchaseValue, addToCart, initiateCheckout, completeReg,
    leads, leadgenLeads,
    // Tráfico
    landingPageViews, linkClicks, outboundClicks,
    // Mensajería
    messagingConn, messagingFirstReply, messagingStarted7d,
    msgDepth2, msgDepth3, msgDepth5,
    // Video
    videoViews, videoViews3s, videoViews10s, videoViews15s, videoViews30s,
    videoP25, videoP50, videoP75, videoP95, thruPlays, videoAvgTime,
    // Engagement
    postEngagement, postReactions, postLikes, postComments, postShares,
    pageEngagement, postSaves,
    // Seguidores
    newFollowersPage, newFollowersIG, igProfileVisits,
    // KPIs
    conversions, roas, cpl, cpmsg, revenue: purchaseValue,
  };
}

// ── Meta Ads: métricas a nivel campaña para UNA fecha puntual ──
// (liviano, sin adsets/ads/video — se usa solo para el cron diario
// de "ayer", no para el dashboard interactivo que usa fetchAccountMetrics)
async function fetchMetaCampaignMetricsForDate(accountId, token, dateStr) {
  const fields = 'spend,impressions,clicks,ctr,cpm,frequency,actions,action_values,campaign_id,campaign_name';
  const timeRange = encodeURIComponent(JSON.stringify({ since: dateStr, until: dateStr }));
  const path = `/${accountId}/insights?fields=${fields}&time_range=${timeRange}&level=campaign&limit=100&`;
  const result = await metaFetch(path, token);
  return result.data || [];
}

// ── Métricas de campaña de Meta en vivo para un RANGO de fechas (since != until) ──
// La Graph API ya agrega automáticamente sobre todo el rango cuando no se pasa
// time_increment — se usa para el Informe, en vez de leer ad_metrics_daily.
async function fetchMetaCampaignMetricsForRange(accountId, token, since, until) {
  const fields = 'spend,impressions,clicks,ctr,cpm,frequency,reach,actions,action_values,campaign_id,campaign_name';
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  const path = `/${accountId}/insights?fields=${fields}&time_range=${timeRange}&level=campaign&limit=100&`;
  const result = await metaFetch(path, token);
  return result.data || [];
}

// ── Mapear el resultado crudo de Meta (una fecha) a filas listas para ad_metrics_daily ──
function normalizeMetaRowsForDate(clientId, dateStr, rawResults) {
  return rawResults.map(cm => {
    const kpis = calcKpis(cm);
    return {
      client_id: clientId,
      source: 'meta',
      date: dateStr,
      campaign_id: cm.campaign_id ? String(cm.campaign_id) : null,
      campaign_name: cm.campaign_name || null,
      spend: kpis.spend || 0,
      impressions: kpis.impressions || 0,
      clicks: kpis.clicks || 0,
      ctr: kpis.ctr ?? null,
      cpm: kpis.cpm ?? null,
      roas: kpis.roas ?? null,
      frequency: kpis.frequency ?? null,
      conversions: kpis.purchases || 0,
      conversion_value: kpis.revenue || 0,
      extra_metrics: null, // el snapshot "rico" (con analysis, adsets, etc.) sigue viniendo de saveDataDB — esto es solo el respaldo histórico de campaña por día
    };
  });
}

async function fetchAccountMetrics(client) {
  const token = client.access_token;
  const accountId = client.ad_account_id;

  const fieldsBase = [
    'spend','impressions','clicks','ctr','cpm','reach','frequency',
    'actions','action_values','unique_clicks','unique_ctr'
  ].join(',');

  const videoFields = ',video_10_sec_watched_actions,video_15_sec_watched_actions,video_30_sec_watched_actions,video_avg_time_watched_actions';
  const fieldsWithVideo = fieldsBase + videoFields;

  // Helper: intenta con video fields, si falla usa base
  const fetchInsights = async (path, useVideo=true) => {
    const fields = useVideo ? fieldsWithVideo : fieldsBase;
    const url = path.replace('__FIELDS__', fields);
    try {
      const result = await metaFetch(url, token);
      console.log('[fetchInsights] OK:', url.substring(0,80), '→', result.data?.length, 'rows');
      return result;
    } catch(e) {
      if (useVideo) {
        console.log('[fetchInsights] Video fields fallaron, reintentando sin video:', e.message);
        const fallbackUrl = path.replace('__FIELDS__', fieldsBase);
        try {
          const result = await metaFetch(fallbackUrl, token);
          console.log('[fetchInsights] Fallback OK:', result.data?.length, 'rows');
          return result;
        } catch(e2) {
          console.error('[fetchInsights] Fallback también falló:', e2.message);
          return { data: [] };
        }
      }
      console.error('[fetchInsights] Error sin video:', e.message, '|', url.substring(0,80));
      return { data: [] };
    }
  };

  const [accountData, campaignData, campaignStatus, adsetData, adData] = await Promise.all([
    fetchInsights('/' + accountId + '/insights?fields=__FIELDS__&date_preset=last_7d&level=account&', true),
    fetchInsights('/' + accountId + '/insights?fields=__FIELDS__,campaign_id,campaign_name&date_preset=last_7d&level=campaign&limit=50&', true),
    metaFetch('/' + accountId + '/campaigns?fields=id,name,effective_status,status,objective&limit=50&', token).catch(e => { console.error('campaigns:', e.message); return {data:[]}; }),
    fetchInsights('/' + accountId + '/insights?fields=__FIELDS__,adset_id,adset_name,campaign_name&date_preset=last_7d&level=adset&sort=spend_descending&limit=30&', false),
    fetchInsights('/' + accountId + '/insights?fields=ad_id,ad_name,adset_id,adset_name,campaign_name,__FIELDS__&date_preset=last_7d&level=ad&sort=spend_descending&limit=25&', false),
  ]);

  // Mapa de estado real + objetivo por campaign_id
  const campaignStatusMap = {};
  (campaignStatus.data || []).forEach(c => {
    campaignStatusMap[c.id] = {
      status: c.effective_status || c.status || 'UNKNOWN',
      objective: c.objective || ''
    };
  });

  // Mapa de learning_stage por adset — fetchear separado
  let adsetLearningMap = {};
  try {
    const adsetStatusData = await metaFetch(
      '/' + accountId + '/adsets?fields=id,effective_status,learning_stage_info&limit=100&',
      token
    );
    (adsetStatusData.data || []).forEach(a => {
      adsetLearningMap[a.id] = {
        status: a.effective_status,
        learning: a.learning_stage_info
      };
    });
  } catch(e) { /* fallback silencioso */ }

  // Usar funciones globales (definidas fuera de fetchAccountMetrics)


  const accountRaw = accountData.data?.[0] || {};
  const accountKpis = { ...calcKpis(accountRaw), _raw: accountRaw };

  const campaignList = (campaignData.data || []).map(cm => {
    const kpis = calcKpis(cm);
    const campInfo = campaignStatusMap[cm.campaign_id] || {};
    return {
      id: cm.campaign_id, name: cm.campaign_name,
      status: campInfo.status || 'ACTIVE',
      objective: campInfo.objective || '',
      _actions: filterActions(cm.actions),
      ...kpis,
      phase: detectPhase(kpis)
    };
  });
  const adsetList = (adsetData.data || []).map(a => {
    const kpis = calcKpis(a);
    const adsetInfo = adsetLearningMap[a.adset_id] || {};
    const phase = detectPhaseReal(kpis, adsetInfo.learning);
    return {
      id: a.adset_id, name: a.adset_name, campaignName: a.campaign_name,
      status: adsetInfo.status || 'ACTIVE',
      _actions: filterActions(a.actions),
      ...kpis, phase,
      fatigueScore: calcFatigue(kpis)
    };
  });
  const adList = (adData.data || []).map(ad => {
    const kpis = calcKpis(ad);
    return {
      id: ad.ad_id, name: ad.ad_name,
      adsetName: ad.adset_name, campaignName: ad.campaign_name,
      _actions: filterActions(ad.actions),
      ...kpis,
      fatigueScore: calcFatigue(kpis)
    };
  });

  return {
    date: today(),
    account: accountKpis,
    campaigns: campaignList,
    adsets: adsetList,
    ads: adList,
  };
}

// ── WHITELIST DE ACTION TYPES VÁLIDOS (sin app events) ───────
const VALID_ACTION_TYPES = new Set([
  // Pixel offsite (web)
  'offsite_conversion.fb_pixel_purchase',
  'offsite_conversion.fb_pixel_add_to_cart',
  'offsite_conversion.fb_pixel_initiate_checkout',
  'offsite_conversion.fb_pixel_add_payment_info',
  'offsite_conversion.fb_pixel_add_shipping_info',
  'offsite_conversion.fb_pixel_view_content',
  'offsite_conversion.fb_pixel_search',
  'offsite_conversion.fb_pixel_add_to_wishlist',
  'offsite_conversion.fb_pixel_complete_registration',
  'offsite_conversion.fb_pixel_add_payment_info',
  'offsite_conversion.fb_pixel_lead',
  'offsite_conversion.fb_pixel_custom',
  // Onsite (on-Facebook)
  'onsite_conversion.purchase',
  'onsite_conversion.add_to_cart',
  'onsite_conversion.checkout',
  'onsite_conversion.donate',
  'onsite_conversion.flow_complete',
  'onsite_conversion.post_save',
  'onsite_conversion.lead_grouped',
  // Mensajería
  'onsite_conversion.total_messaging_connection',
  'onsite_conversion.messaging_first_reply',
  'onsite_conversion.messaging_conversation_started_7d',
  'onsite_conversion.messaging_user_depth_2_message_send',
  'onsite_conversion.messaging_user_depth_3_message_send',
  'onsite_conversion.messaging_user_depth_5_message_send',
  'onsite_conversion.messaging_block',
  'onsite_conversion.messaging_user_subscribed',
  // Leads
  'lead',
  'leadgen_grouped',
  'onsite_conversion.lead_grouped',
  // Tráfico
  'link_click',
  'outbound_click',
  'landing_page_view',
  // Video
  'video_view',
  'video_view_3s',
  'video_view_10s',
  'video_view_15s',
  'video_view_30s',
  'video_p25_watched_actions',
  'video_p50_watched_actions',
  'video_p75_watched_actions',
  'video_p95_watched_actions',
  'video_p100_watched_actions',
  // Engagement / Social
  'post_engagement',
  'page_engagement',
  'post_reaction',
  'like',
  'comment',
  'post',
  'share',
  'photo_view',
  'rsvp',
  'checkin',
  'onsite_conversion.post_save',
  // Seguidores / Perfil
  'follow',
  'onsite_conversion.follow',
  'ig_profile_visit',
  'onsite_conversion.instagram_profile_visit',
  // Donaciones
  'donate_total',
  'donate_website',
  'donate_on_facebook',
  // Contacto / Llamadas
  'contact_total',
  'contact_website',
  'click_to_call_call_confirm',
  'click_to_call_native_call_placed',
  // Conversiones estándar agrupadas
  'omni_purchase',
  'omni_add_to_cart',
  'omni_complete_registration',
  'omni_view_content',
  'omni_search',
  'omni_initiated_checkout',
  // Otras conversiones web
  'find_location_total',
  'find_location_website',
  'schedule_total',
  'schedule_website',
  'start_trial_total',
  'start_trial_website',
  'submit_application_total',
  'submit_application_website',
  'submit_application_on_facebook',
  'subscribe_total',
  'subscribe_website',
  'donate_website',
  'customize_product_total',
  'customize_product_website',
]);

function filterActions(actions) {
  return (actions || []).filter(a => VALID_ACTION_TYPES.has(a.action_type));
}

function detectPhaseReal(kpis, learningInfo) {
  // Usar el estado real del algoritmo que devuelve Meta
  if (learningInfo) {
    const status = learningInfo.status;
    if (status === 'LEARNING') return 'learning';
    if (status === 'LEARNING_LIMITED') return 'learning_limited';
  }
  // Fallback: detectar por métricas si no hay learningInfo
  return detectPhase(kpis);
}

function detectPhase(kpis) {
  const frequency = kpis.frequency || 0;
  const ctr       = kpis.ctr       || 0;
  const spend     = kpis.spend     || 0;
  // Sin datos suficientes no podemos determinar la fase
  if (spend === 0) return 'unknown';
  if (frequency > 3.5 || ctr < 0.5) return 'fatigue';
  return 'stable';
}

function calcFatigue(kpis) {
  let score = 0;
  if (kpis.frequency > 4) score += 40;
  else if (kpis.frequency > 3) score += 20;
  if (kpis.ctr < 0.5) score += 30;
  else if (kpis.ctr < 1.0) score += 15;
  if (kpis.cpm > 200) score += 20;
  return Math.min(score, 100);
}

// ── MEMORIA AUTOMÁTICA DEL CLIENTE ───────────────────────────
async function generateDailySummary(client, metricsData, analysis) {
  const acc = metricsData.account || {};
  const camps = metricsData.campaigns || [];

  const prompt = `Sos un analista de Paid Media. Generá un resumen diario MUY CONCISO (máx 3 líneas) de las campañas de Meta Ads del cliente "${client.name}" para guardar como memoria histórica.

DATOS DEL DÍA (${today()}):
- Gasto: $${Math.round(acc.spend||0)} | Impresiones: ${acc.impressions||0} | CTR: ${(acc.ctr||0).toFixed(2)}%
- CPM: $${Math.round(acc.cpm||0)} | Frecuencia: ${(acc.frequency||0).toFixed(1)} | ROAS: ${acc.roas?acc.roas.toFixed(2)+'x':'N/A'}
- Mensajes: ${acc.messagingConn||0} | Leads: ${acc.leads||0} | Compras: ${acc.purchases||0}
- Health score: ${analysis.health_score||0}/100
- Campañas en aprendizaje: ${camps.filter(c=>c.phase==='learning'||c.phase==='learning_limited').length}
- Campañas en fatiga: ${camps.filter(c=>c.phase==='fatigue').length}
- Acciones recomendadas: ${(analysis.recommendations||[]).slice(0,2).map(r=>r.action).join(' / ')}

Respondé SOLO con un JSON así (sin markdown):
{"resumen": "1-2 oraciones sobre el estado general y lo más importante del día", "acciones": "acciones concretas recomendadas o aplicadas", "alertas": "problemas críticos detectados o vacío si no hay"}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await r.json();
    logAiCall({ slug: client.slug, model: 'claude-haiku-4-5-20251001', callType: 'memory_summary', inputTokens: d.usage?.input_tokens || 0, outputTokens: d.usage?.output_tokens || 0 }).catch(()=>{});
    const text = d.content?.[0]?.text || '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    return { fecha: today(), ...parsed };
  } catch(e) {
    console.warn('[memory] Error generando resumen:', e.message);
    return {
      fecha: today(),
      resumen: `Gasto $${Math.round(acc.spend||0)}, CTR ${(acc.ctr||0).toFixed(2)}%, score ${analysis.health_score||0}/100.`,
      acciones: (analysis.recommendations||[]).slice(0,1).map(r=>r.action).join('') || '',
      alertas: (analysis.alerts||[]).filter(a=>a.type==='critical').map(a=>a.message).join('') || '',
    };
  }
}

// Sub-paso 3.5: la memoria del análisis IA pasa de client.memory (JSON)
// a la tabla ai_insights. iso_year/iso_week se calculan a partir de la
// fecha del resumen (misma lógica que usó migrate_to_supabase.js).
function getIsoWeekOfDate(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { isoYear: d.getUTCFullYear(), isoWeek: weekNo };
}

async function saveClientMemory(slug, entry) {
  try {
    const clientDB = await loadClientDB(slug);
    if (!clientDB) return;
    const d = new Date(entry.fecha + 'T12:00:00Z');
    const { isoYear, isoWeek } = getIsoWeekOfDate(d);
    const row = {
      client_id: clientDB.id,
      period_type: 'week',
      iso_year: isoYear,
      iso_week: isoWeek,
      module: 'meta_ads',
      insight_type: 'diagnosis',
      source_model: 'claude',
      content: {
        resumen: entry.resumen,
        acciones: entry.acciones,
        alertas: entry.alertas,
        fecha_original: entry.fecha,
      },
    };
    // Evitar duplicados del mismo día: borramos el insight de esa fecha si ya existía
    await supabase
      .from('ai_insights')
      .delete()
      .eq('client_id', clientDB.id)
      .eq('module', 'meta_ads')
      .eq('insight_type', 'diagnosis')
      .eq('content->>fecha_original', entry.fecha);
    const { error } = await supabase.from('ai_insights').insert(row);
    if (error) throw error;
    console.log(`[memory] Guardado resumen del ${entry.fecha} para ${slug}`);
  } catch(e) {
    console.error('[memory] Error guardando:', e.message);
  }
}

async function loadClientMemory(slug) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return [];
  const { data, error } = await supabase
    .from('ai_insights')
    .select('content')
    .eq('client_id', clientDB.id)
    .eq('module', 'meta_ads')
    .eq('insight_type', 'diagnosis')
    .order('content->>fecha_original', { ascending: true })
    .limit(60);
  if (error) { console.error('[memory] Error leyendo:', error.message); return []; }
  return data.map(row => ({
    fecha: row.content.fecha_original,
    resumen: row.content.resumen,
    acciones: row.content.acciones,
    alertas: row.content.alertas,
  }));
}

function formatMemoryForPrompt(memory) {
  if (!memory || memory.length === 0) return '';
  const recent = memory.slice(-14); // últimos 14 días
  const lines = recent.map(m =>
    `• ${m.fecha}: ${m.resumen}${m.acciones ? ' | Acciones: ' + m.acciones : ''}${m.alertas ? ' | ⚠️ ' + m.alertas : ''}`
  ).join('\n');
  return `\nHISTORIAL DEL CLIENTE (${recent.length} días registrados):\n${lines}\nUsá este historial para detectar tendencias, evaluar si las acciones anteriores funcionaron y contextualizar el análisis de hoy.\n`;
}
async function runAnalysis(client, metricsData) {
  const history = await loadHistoryDB(client.slug || 'demo', 7);
  const memory  = await loadClientMemory(client.slug || 'demo');
  const targets = client.kpi_targets || {};
  const objKpis = targets.obj_kpis || {};
  const analysisBase = targets.analysis_base || '';
  const clientProfile = targets.client_profile || '';

  // ── PERFILES DE CLIENTE ──────────────────────────────────────
  const clientRubro = targets.client_rubro || '';
  const customConversions = targets.custom_conversions || [];
  const excludedMetrics = targets.excluded_metrics || [];

  const PROFILES = {
    ecommerce: {
      nombre: 'eCommerce — Tienda online',
      foco: 'ROAS, CPA, valor de conversiones y embudo pixel (vista → carrito → checkout → compra). Cada campaña puede tener objetivo distinto (prospecting, remarketing, awareness) pero el norte siempre es el ROAS global.',
      metricas_principales: 'ROAS, CPA, Compras, Valor de conversiones, Checkout iniciado, Al carrito, V.Contenido pixel',
      metricas_ignorar: 'No mencionar depth de mensajería como KPI principal. Campañas de awareness dentro de un ecommerce son válidas — no penalizarlas por no convertir directo.',
      benchmarks: 'ROAS >2x mínimo viable, >4x saludable. CTR feed 1-3%. Frecuencia prospecting máx 3.5, remarketing hasta 5. Add to cart rate >5% del alcance es bueno. Checkout rate >50% del carrito es saludable.',
      acciones_prioritarias: 'Escalar conjuntos ROAS positivo, pausar anuncios con fatigaScore >75, optimizar embudo pixel, separar prospecting de remarketing en campañas distintas.',
    },
    servicios_leads: {
      nombre: 'Empresa de servicios — Leads y Mensajería',
      foco: 'Generación de leads y mensajes calificados para cerrar ventas offline. El cierre sucede fuera de Meta — Meta solo abre la conversación.',
      metricas_principales: 'Conexiones de mensajería, Costo por mensaje, Depth 2/3/5, CPL, Leads, Primeras respuestas',
      metricas_ignorar: 'NO mencionar ROAS ni pixel de compras — este cliente no tiene ecommerce. No evaluar valor de conversiones monetarias. El "éxito" es la conversación iniciada, no la compra.',
      benchmarks: 'Depth 5 / Conexiones >25% indica conversaciones profundas de calidad. Depth 2 / Conexiones >65% mínimo. Costo por mensaje evaluar contra ticket del servicio (si servicio vale $50k, pagar $3k por mensaje es razonable). Frecuencia frío máx 3, retargeting hasta 4.',
      acciones_prioritarias: 'Mejorar hooks para aumentar tasa de apertura de chat, optimizar horarios de entrega según respuesta comercial, segmentar por intención, evaluar si el equipo responde los mensajes a tiempo.',
    },
    productos_sin_ecommerce: {
      nombre: 'Productos sin eCommerce — Venta offline o local',
      foco: 'Tráfico calificado, mensajes de consulta y visitas a local. El cliente vende productos físicos pero sin tienda online — Meta genera el contacto inicial.',
      metricas_principales: 'Clics, Vistas de landing, Mensajes, CPC, CTR, Alcance local',
      metricas_ignorar: 'NO evaluar ROAS de compras online — no aplica. No penalizar por falta de pixel de conversión si el modelo es offline.',
      benchmarks: 'CTR >1.5% saludable para tráfico frío. CPC comparar contra margen del producto. Frecuencia máx 3 para audiencias frías. Mensajes evaluar contra costo de adquisición del cliente.',
      acciones_prioritarias: 'Optimizar copy y creatividad para generar consultas, usar objetivo de mensajes o tráfico según canal de cierre, segmentar por zona geográfica si es local, testear formatos de catálogo sin compra online.',
    },
    ong: {
      nombre: 'ONG / Causa social — Donaciones y Concientización',
      foco: 'Donaciones generadas, alcance de la causa, engagement con contenido de impacto y construcción de comunidad comprometida.',
      metricas_principales: 'Donaciones (custom events), Costo por donación, Alcance, Compartidos, Guardados, Engagement, Nuevos seguidores',
      metricas_ignorar: 'NO mencionar ROAS — no aplica para ONGs. No evaluar conversiones comerciales. No penalizar CPM alto si el mensaje llega a la audiencia correcta. Los compartidos orgánicos son especialmente valiosos.',
      benchmarks: 'Compartidos >2% del alcance es excelente para una causa social. Engagement rate >5% indica contenido resonante. Costo por donación evaluar contra donación promedio histórica. Frecuencia puede llegar a 4-5 para mensajes de causa urgente.',
      acciones_prioritarias: 'Amplificar contenido de alto impacto emocional, usar testimonios reales y datos concretos, crear lookalike de donantes actuales, optimizar landing de donación, testear urgencia vs impacto en el copy.',
    },
    marca: {
      nombre: 'Marca / Awareness / Institucional',
      foco: 'Construcción de marca, CPM eficiente, frecuencia óptima de recordación y alcance único máximo. El éxito es ser recordado.',
      metricas_principales: 'Alcance único, CPM, Frecuencia, Impresiones, Engagement de marca, Nuevos seguidores',
      metricas_ignorar: 'NO mencionar ROAS ni CPA como métricas de éxito. No penalizar CTR bajo — en awareness el objetivo es exposición, no clics. No esperar conversiones directas.',
      benchmarks: 'CPM varía por mercado. Frecuencia ideal 2-4 para recordación. Alcance >15% del target en el período es bueno. CTR 0.3-0.8% es normal y esperado para awareness puro.',
      acciones_prioritarias: 'Maximizar alcance único con presupuesto disponible, diversificar placements para menor CPM, usar video corto para mayor impacto, construir audiencias de remarketing para futura conversión.',
    },
    creador: {
      nombre: 'Creador de contenido / Media / Comunidad',
      foco: 'ThruPlays, retención de video, crecimiento de comunidad y engagement genuino con el contenido.',
      metricas_principales: 'ThruPlays, Video 3s/25%/75%, Tiempo promedio de vista, Nuevos seguidores, Compartidos, Guardados',
      metricas_ignorar: 'NO evaluar ROAS ni CPA como KPIs principales. No penalizar CTR bajo si las visualizaciones y retención son altas.',
      benchmarks: 'Retención al 75% >20% es excelente. Drop 3s→10s >50% indica hook débil — la gente no llega al contenido. ThruPlay rate >15% saludable. Costo por seguidor evaluar contra valor de largo plazo del fan.',
      acciones_prioritarias: 'Optimizar los primeros 3 segundos (hook visual + audio), testear miniaturas, usar subtítulos para retención en silencio, distribuir a lookalike de viewers de alto engagement, crear ciclo de contenido → comunidad → remarketing.',
    },
  };

  const profile = PROFILES[clientProfile] || null;

  const EXCLUSION_LABELS = {
    roas: 'ROAS ni retorno sobre inversión publicitaria',
    compras: 'compras, conversiones de compra ni valor de conversiones del pixel',
    mensajeria: 'mensajería, WhatsApp, Messenger, depth de conversación ni conexiones de mensajería',
    video: 'ThruPlays, retención de video, reproducciones ni métricas de video',
    leads: 'leads, CPL ni costo por lead',
    engagement: 'engagement, reacciones, comentarios ni interacciones con publicaciones',
    seguidores: 'nuevos seguidores ni crecimiento de comunidad',
    trafico: 'tráfico, clics de salida ni vistas de landing page',
  };

  const exclusionSection = excludedMetrics.length > 0
    ? `\nMÉTRICAS PROHIBIDAS — NO MENCIONAR BAJO NINGÚN CONCEPTO:\n${excludedMetrics.map(e => `  ❌ NO hablar de ${EXCLUSION_LABELS[e] || e}`).join('\n')}\nEstas métricas no aplican al modelo de negocio de este cliente. Si aparecen en los datos, ignoralas completamente. No las analices, no las menciones, no hagas recomendaciones sobre ellas.\n`
    : '';

  const rubroSection = clientRubro ? `\nRUBRO Y CONTEXTO DEL NEGOCIO: ${clientRubro}\n` : '';

  const customConvSection = customConversions.length > 0
    ? `\nCONVERSIONES PERSONALIZADAS DE ESTE CLIENTE:\n${customConversions.map(c=>`  "${c.key}" = ${c.label}`).join('\n')}\nCuando veas estos action types en los datos, nombralos como "${customConversions.map(c=>c.label).join('", "')}" en tu análisis — no uses el nombre técnico.\n`
    : '';

  // Sección de perfil para el prompt
  const profileSection = profile ? `
## PERFIL DEL NEGOCIO: ${profile.nombre.toUpperCase()}
Este es el contexto más importante. TODA tu respuesta debe estar alineada con este perfil.
${rubroSection}
FOCO DEL ANÁLISIS: ${profile.foco}
MÉTRICAS QUE MÁS IMPORTAN: ${profile.metricas_principales}
RESTRICCIONES OBLIGATORIAS: ${profile.metricas_ignorar}
BENCHMARKS PARA ESTE TIPO DE NEGOCIO: ${profile.benchmarks}
ACCIONES TÍPICAS PARA ESTE PERFIL: ${profile.acciones_prioritarias}
${customConvSection}${exclusionSection}
IMPORTANTE: Las campañas individuales pueden tener distintos objetivos (alcance, tráfico, conversiones) — analizá cada una según su objetivo específico, pero siempre en el contexto del negocio definido arriba.
` : `
## PERFIL DEL NEGOCIO: NO CONFIGURADO
${rubroSection}
El tipo de negocio no fue configurado. Analizá con criterio general. Incluí en el resumen una recomendación para configurar el perfil del cliente en KPIs & Objetivos para obtener análisis más precisos.
${customConvSection}${exclusionSection}
`;

  // Construir sección de KPIs por objetivo
  const objLabels = {
    conv: '🛒 Conversiones / Ventas',
    msg: '💬 Mensajería / Leads',
    trafico: '🌐 Tráfico',
    alcance: '📢 Alcance / Awareness',
    video: '🎬 Video / Reproducciones',
    eng: '⭐ Engagement / Interacción',
  };
  const kpiLines = Object.entries(objKpis)
    .filter(([,v]) => v && v.length > 0)
    .map(([k,v]) => `  ${objLabels[k]||k}: ${v.join(' → ')}`);

  const mainKpisSection = kpiLines.length > 0
    ? `\nKPIs NUMÉRICOS CONFIGURADOS POR OBJETIVO:\n${kpiLines.join('\n')}\n`
    : '';

  const memorySection = formatMemoryForPrompt(memory);

  const system = `Sos un experto en Paid Media con especialización profunda en Meta Ads y el algoritmo Andromeda/Advantage+.
${profileSection}
## Algoritmo Meta Andromeda
- Fases: Aprendizaje (<50 conv/semana), Estabilización, Fatiga
- Advantage+: Meta optimiza automáticamente audiencias, placements y creatividades
- Fatiga creativa: frecuencia >3.5 señal temprana, >4.5 crítico
- Subasta: bid + presupuesto + calidad del anuncio determinan el delivery
- En aprendizaje: NO pausar ni editar — el algoritmo necesita mínimo 50 conversiones para salir

## Relaciones entre métricas (aplicar según perfil del cliente)
- CPM alto + CTR bajo → creatividad débil o audiencia saturada
- Muchos clics + pocas conversiones → problema post-click
- Frecuencia alta + CTR cayendo → fatiga creativa avanzada
- CTR saludable: feed 1-3%, stories/reels >1.5%

## Formato de respuesta
Respondé SIEMPRE en JSON válido, sin markdown, sin texto fuera del JSON.
Cada campo de análisis debe ser un ARRAY DE ITEMS, no un texto largo.
Esto es crítico para el renderizado visual del dashboard.${excludedMetrics.length > 0 ? `

## REGLA ABSOLUTA — MÉTRICAS BLOQUEADAS
${excludedMetrics.map(e => `❌ PROHIBIDO mencionar "${EXCLUSION_LABELS[e] || e}" en cualquier parte de tu respuesta.`).join('\n')}
Esto incluye títulos, detalles, recomendaciones, conclusiones y alertas. Si el dato aparece en los números, ignoralo. No es relevante para este cliente.` : ''}`;

  // Base de análisis del cliente
  const analysisBaseSection = analysisBase
    ? `\nCONTEXTO ESPECÍFICO DEL CLIENTE:\n${analysisBase}\nTené en cuenta este contexto en todo el análisis.\n`
    : '';

  const acc = metricsData.account || {};
  const camps = metricsData.campaigns || [];
  const adsets = metricsData.adsets || [];
  const ads = metricsData.ads || [];

  // Filtros dinámicos según métricas excluidas
  const excl = new Set(excludedMetrics);
  const noRoas     = excl.has('roas');
  const noCompras  = excl.has('compras');
  const noMsg      = excl.has('mensajeria');
  const noVideo    = excl.has('video');
  const noLeads    = excl.has('leads');
  const noEngage   = excl.has('engagement');
  const noSegs     = excl.has('seguidores');
  const noTrafico  = excl.has('trafico');

  // Construir métricas de cuenta filtrando excluidas
  const acctLines = [
    `Gasto: $${Math.round(acc.spend||0)} | Impresiones: ${acc.impressions||0} | Alcance: ${acc.reach||0}`,
    `CTR: ${(acc.ctr||0).toFixed(2)}% | CPM: $${Math.round(acc.cpm||0)} | Frecuencia: ${(acc.frequency||0).toFixed(1)}`,
    !noRoas     ? `ROAS: ${acc.roas ? acc.roas.toFixed(2)+'x' : 'N/A'}` : null,
    !noMsg      ? `Mensajería: ${acc.messagingConn||0} conexiones | ${acc.messagingFirstReply||0} primeras respuestas | Costo x msg: $${Math.round(acc.cpmsg||0)}` : null,
    !noLeads    ? `Leads: ${acc.leads||0}` : null,
    !noCompras  ? `Compras: ${acc.purchases||0} | Valor compras: $${Math.round(acc.purchaseValue||0)}` : null,
    !noSegs     ? `Nuevos seguidores: ${acc.newFollowersPage||0} (pág) + ${acc.newFollowersIG||0} (IG)` : null,
    !noEngage   ? `Compartidos: ${acc.postShares||0} | Guardados: ${acc.postSaves||0} | Engagement: ${acc.postEngagement||0}` : null,
    !noVideo    ? `Video views: ${acc.videoViews||0} | ThruPlays: ${acc.thruPlays||0}` : null,
    !noTrafico  ? `Vistas de landing: ${acc.landingPageViews||0} | Clics salida: ${acc.outboundClicks||0}` : null,
  ].filter(Boolean).join('\n');

  // Construir datos de campañas filtrando excluidas
  const campData = camps.slice(0,12).map(c => {
    const row = { nombre: c.name, fase: c.phase, gasto: '$'+Math.round(c.spend||0), ctr: (c.ctr||0).toFixed(2)+'%', cpm: '$'+Math.round(c.cpm||0), freq: (c.frequency||0).toFixed(1) };
    if(!noRoas)    row.roas = c.roas ? c.roas.toFixed(2)+'x' : 'N/A';
    if(!noMsg)     row.mensajes = c.messagingConn||0;
    if(!noLeads)   row.leads = c.leads||0;
    if(!noCompras) row.compras = c.purchases||0;
    return row;
  });

  const adsetData = adsets.slice(0,15).map(a => {
    const row = { nombre: a.name, campana: a.campaignName, fase: a.phase, fatiga: a.fatigueScore, gasto: '$'+Math.round(a.spend||0), ctr: (a.ctr||0).toFixed(2)+'%', cpm: '$'+Math.round(a.cpm||0), freq: (a.frequency||0).toFixed(1) };
    if(!noMsg)   row.mensajes = a.messagingConn||0;
    if(!noLeads) row.leads = a.leads||0;
    return row;
  });

  const prompt = `Analizá las campañas de Meta Ads para el cliente "${client.name}".
${mainKpisSection}${analysisBaseSection}${memorySection}
OBJETIVOS DEFINIDOS:
${targets.target_roas && !noRoas ? '- ROAS mínimo: ' + targets.target_roas + 'x' : ''}
${targets.target_ctr ? '- CTR mínimo: ' + targets.target_ctr + '%' : ''}
${targets.target_cpm ? '- CPM máximo: $' + targets.target_cpm : ''}
${targets.target_frequency ? '- Frecuencia máxima: ' + targets.target_frequency : ''}
${targets.target_cpmsg && !noMsg ? '- Costo por mensaje máximo: $' + targets.target_cpmsg : ''}

MÉTRICAS CUENTA (últimos 7 días):
${acctLines}

CAMPAÑAS (${camps.length}):
${JSON.stringify(campData, null, 2)}

CONJUNTOS DE ANUNCIOS / AUDIENCIAS (${adsets.length}):
${JSON.stringify(adsetData, null, 2)}

ANUNCIOS TOP (${ads.length}):
${JSON.stringify(ads.slice(0,12).map(a=>{
  const row = { nombre: a.name, conjunto: a.adsetName, fatiga: a.fatigueScore, gasto: '$'+Math.round(a.spend||0), ctr: (a.ctr||0).toFixed(2)+'%', freq: (a.frequency||0).toFixed(1) };
  if(!noMsg)    row.mensajes = a.messagingConn||0;
  if(!noEngage) { row.compartidos = a.postShares||0; row.guardados = a.postSaves||0; }
  return row;
}), null, 2)}

${history.length > 1 ? 'TENDENCIA (' + history.length + ' días):\n' + JSON.stringify(history.map(h => {
  const row = { date: h.date, spend: h.metrics?.account?.spend };
  if(!noRoas) row.roas = h.metrics?.account?.roas;
  if(!noMsg)  row.mensajes = h.metrics?.account?.messagingConn;
  return row;
}), null, 2) : ''}

Respondé ÚNICAMENTE con este JSON (sin markdown):
{
  "summary_items": [
    {"icon": "🔴|🟡|🟢|💡|⚠️", "titulo": "título corto", "detalle": "1-2 oraciones"}
  ],
  "algorithm_phase": "learning|stable|fatigue|mixed",
  "algorithm_items": [
    {"icon": "📊|⚠️|✅|🔄", "titulo": "título", "detalle": "explicación"}
  ],
  "health_score": 0-100,
  "critical_campaigns": [
    {"name": "nombre", "issue": "problema con datos concretos", "action": "acción concreta"}
  ],
  "adset_insights": [
    {"icon": "🔴|🟡|🟢|💡", "titulo": "nombre del conjunto o audiencia", "detalle": "análisis de esa audiencia y recomendación"}
  ],
  "creative_items": [
    {"icon": "🔴|🟡|🟢|💡", "titulo": "nombre del anuncio", "detalle": "estado, fatiga y recomendación"}
  ],
  "recommendations": [
    {"priority": 1, "action": "acción concreta", "impact": "alto|medio|bajo", "detail": "por qué y cómo", "campana": "nombre o 'cuenta'"}
  ],
  "conclusion_items": [
    {"icon": "✅|🎯|📈|⚡", "titulo": "punto clave", "detalle": "detalle accionable"}
  ],
  "alerts": [
    {"type": "warning|critical", "metric": "nombre", "current": "valor", "target": "objetivo", "message": "mensaje"}
  ]
}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 6000, system, messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'Error Claude');
  logAiCall({ slug: client.slug || 'sistema', model: 'claude-opus-4-5', callType: 'dashboard_analysis', inputTokens: d.usage?.input_tokens || 0, outputTokens: d.usage?.output_tokens || 0 }).catch(()=>{});
  const text = d.content.map(b => b.text || '').join('');
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    // Intentar recuperar JSON parcial completándolo
    try {
      const partial = text.replace(/```json|```/g, '').trim();
      // Contar llaves y corchetes abiertos para cerrar el JSON
      let fixed = partial;
      const opens = (partial.match(/\{/g)||[]).length - (partial.match(/\}/g)||[]).length;
      const openArr = (partial.match(/\[/g)||[]).length - (partial.match(/\]/g)||[]).length;
      for(let i=0;i<openArr;i++) fixed += ']';
      for(let i=0;i<opens;i++) fixed += '}';
      return JSON.parse(fixed);
    } catch {
      return {
        summary_items: [{icon:'⚠️', titulo:'Análisis incompleto', detalle:'El análisis se generó pero el JSON quedó truncado. Intentá actualizar nuevamente.'}],
        health_score: 50, recommendations: [], alerts: [], critical_campaigns: [],
        algorithm_items: [], creative_items: [], adset_insights: [], conclusion_items: []
      };
    }
  }
}

// ── EMAIL ─────────────────────────────────────────────────────

// ── EMAIL ─────────────────────────────────────────────────────
// ── PIPELINE COMPLETO ─────────────────────────────────────────
async function runPipeline(slug) {
  const client = await loadClientWithCreds(slug);
  if (!client) throw new Error('Cliente no encontrado: ' + slug);
  client.slug = slug;

  console.log('[' + new Date().toISOString() + '] Procesando ' + client.name + '...');

  let metrics, analysis;
  try {
    metrics = await fetchAccountMetrics(client);
  } catch(e) {
    console.error('Error Meta API:', e.message);
    // Usar datos de demo si falla la API
    metrics = generateDemoMetrics();
  }

  analysis = await runAnalysis(client, metrics);
  // Guardar resumen en memoria del cliente (async)
  generateDailySummary(client, metrics, analysis)
    .then(entry => saveClientMemory(slug, entry))
    .catch(e => console.warn('[memory] Error:', e.message));
  const result = { date: today(), metrics, analysis };
  await saveDataDB(slug, result);
  return result;
}

function generateDemoMetrics() {
  return {
    date: today(),
    account: { spend: 45230, impressions: 892000, clicks: 12400, ctr: 1.39, cpm: 50.70, reach: 234000, frequency: 2.8, conversions: 87, revenue: 189400, roas: 4.19, cpa: 520 },
    campaigns: [
      { id: '1', name: 'Campaña Conversiones — Temporada', spend: 28000, ctr: 1.6, cpm: 45, roas: 5.2, cpa: 420, conversions: 66, frequency: 2.1, phase: 'stable' },
      { id: '2', name: 'Remarketing — Visitantes Web', spend: 12000, ctr: 0.8, cpm: 85, roas: 2.8, cpa: 780, conversions: 15, frequency: 4.2, phase: 'fatigue' },
      { id: '3', name: 'Tráfico Frío — Lookalike', spend: 5230, ctr: 1.1, cpm: 38, roas: null, cpa: null, conversions: 6, frequency: 1.3, phase: 'learning' }
    ],
    ads: [
      { id: 'a1', name: 'Video bota lifestyle bar', campaignName: 'Conversiones', spend: 15000, ctr: 2.1, frequency: 1.8, fatigueScore: 10 },
      { id: 'a2', name: 'Carrusel 3 productos', campaignName: 'Conversiones', spend: 9000, ctr: 1.4, frequency: 2.3, fatigueScore: 25 },
      { id: 'a3', name: 'Foto producto fondo blanco', campaignName: 'Remarketing', spend: 8000, ctr: 0.6, frequency: 5.1, fatigueScore: 75 },
    ]
  };
}

// ── RENOVACIÓN AUTOMÁTICA DE TOKENS META ─────────────────────
const META_APP_ID     = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;

// ── Mails de alerta — vía Resend (API HTTP simple, sin dependencia nueva:
// el proyecto ya usa fetch en todos lados). Requiere RESEND_API_KEY como
// variable de entorno en Render. Si no está seteada, no rompe nada —
// solo loguea y no manda el mail (mismo criterio que el resto de la
// plataforma: una integración que falta nunca debe tumbar el proceso).
async function sendAlertEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[EMAIL] RESEND_API_KEY no configurada — no se mandó el aviso:', subject);
    return false;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Docta Nexus <reportes@doctanexus.com>', to: Array.isArray(to) ? to : [to], subject, html }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.message || `Resend respondió ${r.status}`);
    }
    return true;
  } catch (e) {
    console.error('[EMAIL] Error enviando vía Resend:', e.message);
    return false;
  }
}

// Destinatario de los avisos: si el cliente tiene su propio email_alerts
// cargado, se usa ese. Si no, cae a la casilla interna de Docta Nexus
// (ALERT_EMAIL en Render) — así no hace falta cargar nada por cliente
// para empezar a recibir avisos de tokens vencidos.
function resolveAlertRecipients(clientDB) {
  if (clientDB.email_alerts?.length) return clientDB.email_alerts;
  return process.env.ALERT_EMAIL ? [process.env.ALERT_EMAIL] : [];
}

async function renewTokenIfNeeded(slug) {
  if (!META_APP_ID || !META_APP_SECRET) return;
  const clientDB = await loadClientDB(slug);
  const creds = await getMetaCredentials(slug);
  if (!clientDB || !creds || !creds.access_token) return;

  try {
    // Verificar estado del token con Meta Debug API
    const debugUrl = `https://graph.facebook.com/debug_token?input_token=${creds.access_token}&access_token=${META_APP_ID}|${META_APP_SECRET}`;
    const r = await fetch(debugUrl);
    const d = await r.json();
    const tokenData = d.data;

    if (!tokenData || !tokenData.is_valid) {
      console.log(`[TOKEN] Token de ${slug} inválido — intentando renovar...`);
    } else {
      const expiresAt = tokenData.expires_at; // timestamp Unix
      const daysLeft  = expiresAt ? Math.floor((expiresAt - Date.now()/1000) / 86400) : 999;
      console.log(`[TOKEN] ${slug}: válido, vence en ${daysLeft} días`);

      // Solo renovar si vence en menos de 15 días o ya expiró
      if (daysLeft > 15) { await setCredentialError(slug, 'meta', null); return; }
      console.log(`[TOKEN] ${slug}: renovando token (${daysLeft} días restantes)...`);
    }

    // Renovar token
    const renewUrl = `https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${creds.access_token}`;
    const rr = await fetch(renewUrl);
    const rd = await rr.json();

    if (!rr.ok || !rd.access_token) {
      throw new Error(rd.error?.message || 'No se pudo renovar el token');
    }

    // Guardar token nuevo cifrado en Supabase (fuente de verdad desde el Sub-paso 3.3)
    const saved = await updateMetaToken(slug, rd.access_token);
    if (!saved) throw new Error('No se pudo guardar el token renovado en Supabase');
    console.log(`[TOKEN] ${slug}: token renovado exitosamente ✓`);
    await setCredentialError(slug, 'meta', null);

    // Notificar por email
    const successRecipients = resolveAlertRecipients(clientDB);
    if (successRecipients.length) {
      await sendAlertEmail({
        to: successRecipients,
        subject: `✓ Token Meta renovado automáticamente — ${clientDB.name}`,
        html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0b0b0d;color:#edeef0;border-radius:12px;padding:24px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
            <div style="width:32px;height:32px;background:#c8f135;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#0b0b0d">D</div>
            <div style="font-weight:600">Meta Intelligence · Docta Nexus</div>
          </div>
          <div style="background:#151518;border-radius:8px;padding:16px;border-left:3px solid #5de8a0">
            <div style="color:#5de8a0;font-weight:600;margin-bottom:8px">✓ Token renovado automáticamente</div>
            <div style="color:#9a9aaa;font-size:13px;line-height:1.6">
              El token de acceso de <strong style="color:#edeef0">${clientDB.name}</strong> fue renovado automáticamente.<br>
              Válido por aproximadamente 60 días más.<br>
              Fecha: ${new Date().toLocaleDateString('es-AR')}
            </div>
          </div>
          <div style="text-align:center;margin-top:16px;font-size:11px;color:#52525c">
            Meta Intelligence · <a href="https://doctanexus.com" style="color:#c8f135;text-decoration:none">Docta Nexus</a>
          </div>
        </div>`,
      });
    }

  } catch(e) {
    console.error(`[TOKEN] Error renovando token de ${slug}:`, e.message);
    await setCredentialError(slug, 'meta', e.message).catch(() => {});
    // Notificar el error por email
    const errorRecipients = resolveAlertRecipients(clientDB);
    if (errorRecipients.length) {
      await sendAlertEmail({
        to: errorRecipients,
        subject: `⚠️ Error renovando token Meta — ${clientDB.name} — acción requerida`,
        html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0b0b0d;color:#edeef0;border-radius:12px;padding:24px">
          <div style="background:#151518;border-radius:8px;padding:16px;border-left:3px solid #f26d6d">
            <div style="color:#f26d6d;font-weight:600;margin-bottom:8px">⚠️ Token de Meta requiere renovación manual</div>
            <div style="color:#9a9aaa;font-size:13px;line-height:1.6">
              No se pudo renovar automáticamente el token de <strong style="color:#edeef0">${clientDB.name}</strong>.<br>
              Error: ${e.message}<br><br>
              Renovalo manualmente desde <a href="https://developers.facebook.com/tools/explorer/" style="color:#c8f135">Graph API Explorer</a>.
            </div>
          </div>
          <div style="text-align:center;margin-top:16px;font-size:11px;color:#52525c">
            Meta Intelligence · <a href="https://doctanexus.com" style="color:#c8f135;text-decoration:none">Docta Nexus</a>
          </div>
        </div>`,
      });
    }
  }
}

// ── CRON: renovación de tokens cada 12 horas ──────────────────
cron.schedule('0 */12 * * *', async () => {
  console.log('[CRON] Verificando tokens de Meta...');
  for (const slug of await listClients()) {
    await renewTokenIfNeeded(slug).catch(e =>
      console.error('[CRON] Error verificando token de ' + slug + ':', e.message)
    );
  }
}, { timezone: TZ });

// ── CRON: refresh diario de métricas de Google Ads ────────────
// Corre una vez al día, a la madrugada, para tener el dato de "ayer"
// ya cargado en Supabase cuando el equipo entra a revisar el dashboard.
// Solo procesa clientes que tengan un Customer ID asociado (los que
// no usan Google Ads simplemente no tienen fila en client_credentials
// con source='google_ads', y se saltean solos).
cron.schedule('0 6 * * *', async () => {
  console.log('[CRON] Actualizando métricas de Google Ads...');
  for (const slug of await listClients()) {
    try {
      const customerId = await getGoogleAdsAccountId(slug);
      if (!customerId) continue; // este cliente no tiene Google Ads asociado

      const clientDB = await loadClientDB(slug);
      if (!clientDB) continue;

      const dateStr = yesterday();
      const raw = await fetchCampaignMetrics(customerId, dateStr);
      const rows = normalizeToAdMetricsRows(clientDB.id, dateStr, raw);

      if (rows.length > 0) {
        const { error } = await supabase
          .from('ad_metrics_daily')
          .upsert(rows, { onConflict: 'client_id,source,date,campaign_id' });
        if (error) throw new Error(error.message);
      }
      console.log(`[CRON] Google Ads OK: ${slug} (${rows.length} campañas)`);
      await setCredentialError(slug, 'google_ads', null);
    } catch(e) {
      console.error(`[CRON] Error Google Ads en ${slug}:`, e.message);
      await setCredentialError(slug, 'google_ads', e.message).catch(() => {});
    }
  }
}, { timezone: TZ });

// ── CRON: refresh diario de métricas de Meta Ads ("ayer") ──────
// Antes, Meta solo se guardaba en Supabase cuando alguien abría el
// dashboard ese día (getTodaySnapshotDB / saveDataDB en runPipeline).
// Si nadie entraba, ese día quedaba sin registro. Este cron asegura
// que "ayer" siempre quede guardado a nivel campaña en ad_metrics_daily,
// igual que ya pasa con Google Ads — así el motor de Intelligence
// (WoW/YoY) y los análisis de IA siempre tienen base histórica real.
// Nota: esto es un respaldo A NIVEL CAMPAÑA; el snapshot "rico" del
// día (con adsets/ads/analysis) lo sigue generando runPipeline cuando
// alguien entra al dashboard — no se pisan entre sí.
cron.schedule('15 6 * * *', async () => {
  console.log('[CRON] Actualizando métricas de Meta Ads (ayer)...');
  const dateStr = yesterday();
  for (const slug of await listClients()) {
    try {
      const client = await loadClientWithCreds(slug);
      if (!client || !client.access_token || !client.ad_account_id) continue; // sin credenciales de Meta, se saltea

      const clientDB = await loadClientDB(slug);
      if (!clientDB) continue;

      const raw = await fetchMetaCampaignMetricsForDate(client.ad_account_id, client.access_token, dateStr);
      const rows = normalizeMetaRowsForDate(clientDB.id, dateStr, raw);

      if (rows.length > 0) {
        const { error } = await supabase
          .from('ad_metrics_daily')
          .upsert(rows, { onConflict: 'client_id,source,date,campaign_id' });
        if (error) throw new Error(error.message);
      }
      console.log(`[CRON] Meta Ads OK: ${slug} (${rows.length} campañas)`);
      await setCredentialError(slug, 'meta', null);
    } catch(e) {
      console.error(`[CRON] Error Meta Ads en ${slug}:`, e.message);
      await setCredentialError(slug, 'meta', e.message).catch(() => {});
    }
  }
}, { timezone: TZ });

// ── CRON: refresh diario de Usuarios y Canales de Adquisición + Métricas de Sitio (GA4) ──
// Mismo criterio que los crons de Meta/Google Ads: asegura que "ayer"
// siempre quede guardado, sin depender de que alguien abra la solapa
// eCommerce ese día. Solo corre para clientes con GA4 asociado.
cron.schedule('45 6 * * *', async () => {
  console.log('[CRON] Sincronizando datos de Analytics (GA4)...');
  const dateStr = yesterday();
  for (const slug of await listClients()) {
    try {
      const propertyId = await getGA4PropertyId(slug);
      if (!propertyId) continue; // sin GA4 asociado, se saltea
      const rows = await syncGA4AcquisitionForDate(slug, dateStr);
      console.log(`[CRON] GA4 Adquisición OK: ${slug} (${rows.length} canales)`);
      await setCredentialError(slug, 'ga4', null);
    } catch(e) {
      console.error(`[CRON] Error GA4 Adquisición en ${slug}:`, e.message);
      await setCredentialError(slug, 'ga4', e.message).catch(() => {});
    }
    try {
      const propertyId = await getGA4PropertyId(slug);
      if (!propertyId) continue;
      await syncGA4SiteMetricsForDate(slug, dateStr);
      console.log(`[CRON] GA4 Métricas de sitio OK: ${slug}`);
      await setCredentialError(slug, 'ga4', null);
    } catch(e) {
      console.error(`[CRON] Error GA4 Métricas de sitio en ${slug}:`, e.message);
      await setCredentialError(slug, 'ga4', e.message).catch(() => {});
    }
  }
}, { timezone: TZ });

// ── CRON: briefing diario (Growth Score + agente OpenAI) ───────
// Corre después de los crons de Meta/Google/GA4 (6:00/6:15/6:45), así
// el briefing de cada cliente ya tiene los datos de "ayer" frescos.
cron.schedule('0 7 * * *', async () => {
  console.log('[CRON] Generando briefing diario...');
  for (const slug of await listClients()) {
    try {
      await generateDailyBriefing(slug);
      console.log(`[CRON] Briefing OK: ${slug}`);
    } catch (e) {
      console.error(`[CRON] Error briefing en ${slug}:`, e.message);
    }
  }
}, { timezone: TZ });

// ── ENDPOINTS ─────────────────────────────────────────────────
// Login
// Sub-paso 3.1: la verificación de password ahora es contra Supabase
// (password_hash, bcrypt). El resto de los datos del cliente (colores,
// kpi_targets, etc.) TODAVÍA se leen del JSON viejo — eso se unifica
// en el sub-paso 3.2, para no tocar todo de una.
// ── Panel de administración (/admin) — alta de clientes sin archivos ni deploy ──
// IMPORTANTE: este bloque tiene que ir ANTES de cualquier ruta /api/:slug/...
// de acá abajo. Express matchea rutas en orden de registro, y /api/:slug/login
// matchea CUALQUIER path con esa forma — incluido /api/admin/login (tomando
// "admin" como si fuera un slug de cliente). Si este bloque queda más abajo,
// /api/admin/login nunca se ejecuta y responde 404 "Cliente no encontrado".
function checkAdminPassword(password) {
  return !!process.env.ADMIN_PASSWORD && password === process.env.ADMIN_PASSWORD;
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!checkAdminPassword(password)) return res.status(401).json({ error: 'Contraseña incorrecta' });
  res.json({ ok: true });
});

// Listado simple de clientes existentes, para el panel de admin
app.get('/api/admin/clients', async (req, res) => {
  const { password } = req.query;
  if (!checkAdminPassword(password)) return res.status(401).json({ error: 'No autorizado' });
  const { data, error } = await supabase
    .from('clients')
    .select('slug, name, currency, active, created_at, report_profile')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ clients: data });
});

// Alta de un cliente nuevo — Datos generales
app.post('/api/admin/clients', async (req, res) => {
  const { password, name, slug, clientPassword, currency, timezone, colorPrimary, colorAccent, colorBtnText, reportProfile } = req.body;
  if (!checkAdminPassword(password)) return res.status(401).json({ error: 'No autorizado' });
  if (!name || !slug || !clientPassword) return res.status(400).json({ error: 'Faltan name, slug o clientPassword' });
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'El slug solo puede tener minúsculas, números y guiones' });

  const existing = await loadClientDB(slug);
  if (existing) return res.status(409).json({ error: `Ya existe un cliente con el slug "${slug}"` });

  const created = await createClientRecord({ slug, name, password: clientPassword, currency, timezone, colorPrimary, colorAccent, colorBtnText, reportProfile });
  if (!created) return res.status(500).json({ error: 'No se pudo crear el cliente' });
  res.json({ ok: true, client: created });
});

// Traer UN cliente puntual con su estado de credenciales, para editarlo.
// Nunca devuelve el access_token en sí — solo si está conectado y el ID de cuenta.
app.get('/api/admin/clients/:slug', async (req, res) => {
  const slug = req.params.slug;
  const { password } = req.query;
  if (!checkAdminPassword(password)) return res.status(401).json({ error: 'No autorizado' });
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const creds = await getClientCredentialsSummary(slug);
  res.json({
    client: {
      slug: clientDB.slug, name: clientDB.name, currency: clientDB.currency,
      color_primary: clientDB.color_primary, color_accent: clientDB.color_accent, color_btn_text: clientDB.color_btn_text,
      active: clientDB.active, report_profile: clientDB.report_profile || 'ecommerce',
    },
    credentials: creds,
  });
});

// Editar datos generales de un cliente ya existente
app.put('/api/admin/clients/:slug', async (req, res) => {
  const slug = req.params.slug;
  const { password, name, clientPassword, currency, colorPrimary, colorAccent, colorBtnText, active, reportProfile } = req.body;
  if (!checkAdminPassword(password)) return res.status(401).json({ error: 'No autorizado' });
  const ok = await updateClientRecord(slug, { name, clientPassword, currency, colorPrimary, colorAccent, colorBtnText, active, reportProfile });
  if (!ok) return res.status(500).json({ error: 'No se pudo actualizar. Verificá que el slug exista.' });
  res.json({ ok: true });
});

// Alta de un cliente — Datos de Meta (Ad Account ID + Access Token, se pegan a mano)
app.post('/api/admin/clients/:slug/meta', async (req, res) => {
  const slug = req.params.slug;
  const { password, ad_account_id, access_token } = req.body;
  if (!checkAdminPassword(password)) return res.status(401).json({ error: 'No autorizado' });
  if (!ad_account_id || !access_token) return res.status(400).json({ error: 'Faltan ad_account_id o access_token' });
  const ok = await setMetaCredentials(slug, ad_account_id, access_token);
  if (!ok) return res.status(500).json({ error: 'No se pudo guardar. Verificá que el slug exista.' });
  res.json({ ok: true });
});

// Alta de un cliente — Datos de Google Ads (Customer ID)
app.post('/api/admin/clients/:slug/google-ads', async (req, res) => {
  const slug = req.params.slug;
  const { password, customer_id } = req.body;
  if (!checkAdminPassword(password)) return res.status(401).json({ error: 'No autorizado' });
  if (!customer_id) return res.status(400).json({ error: 'Falta customer_id' });
  const ok = await setGoogleAdsAccountId(slug, customer_id);
  if (!ok) return res.status(500).json({ error: 'No se pudo guardar. Verificá que el slug exista.' });
  res.json({ ok: true });
});

// Alta de un cliente — Datos de Analytics (Property ID de GA4)
// ── Salud de credenciales — capa de transparencia ──────────────
// Para el banner del propio dashboard del cliente: solo SUS fuentes con
// un error activo ahora mismo (last_error no nulo). No expone nada de
// otros clientes.
app.get('/api/:slug/credentials/health', async (req, res) => {
  const slug = req.params.slug;
  const { password } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const all = await getAllCredentialsHealth();
    const mine = all.filter(r => r.slug === slug && r.last_error);
    res.json({ issues: mine.map(r => ({ source: r.source, error: r.last_error, since: r.updated_at })) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Para el panel "Estado de Conexiones" en /admin: TODOS los clientes,
// todas las fuentes, con o sin error — así se ve también lo que está sano.
app.get('/api/admin/credentials-health', async (req, res) => {
  const { password } = req.query;
  if (!checkAdminPassword(password)) return res.status(401).json({ error: 'No autorizado' });
  try {
    const all = await getAllCredentialsHealth();
    res.json({ credentials: all });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Fuerza el chequeo de un cliente AHORA (en vez de esperar al cron de cada
// 12hs) — para cuando se acaba de arreglar un token a mano y no tiene
// sentido esperar a que el error viejo se limpie solo.
app.post('/api/admin/credentials-health/recheck', async (req, res) => {
  const { password, slug } = req.body;
  if (!checkAdminPassword(password)) return res.status(401).json({ error: 'No autorizado' });
  if (!slug) return res.status(400).json({ error: 'Falta slug' });
  try {
    await renewTokenIfNeeded(slug);
    const all = await getAllCredentialsHealth();
    res.json({ credentials: all.filter(c => c.slug === slug) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/clients/:slug/ga4', async (req, res) => {
  const slug = req.params.slug;
  const { password, property_id } = req.body;
  if (!checkAdminPassword(password)) return res.status(401).json({ error: 'No autorizado' });
  if (!property_id) return res.status(400).json({ error: 'Falta property_id' });
  const ok = await setGA4PropertyId(slug, property_id);
  if (!ok) return res.status(500).json({ error: 'No se pudo guardar. Verificá que el slug exista.' });
  res.json({ ok: true });
});

app.post('/api/admin/clients/:slug/search-console', async (req, res) => {
  const slug = req.params.slug;
  const { password, property } = req.body;
  if (!checkAdminPassword(password)) return res.status(401).json({ error: 'No autorizado' });
  if (!property) return res.status(400).json({ error: 'Falta la propiedad' });
  const ok = await setSearchConsoleProperty(slug, property);
  if (!ok) return res.status(500).json({ error: 'No se pudo guardar. Verificá que el slug exista.' });
  res.json({ ok: true });
});

// Alta de un cliente — ID de la planilla de Google Sheets del Plan de Campañas
app.post('/api/admin/clients/:slug/sheets', async (req, res) => {
  const slug = req.params.slug;
  const { password, sheet_id } = req.body;
  if (!checkAdminPassword(password)) return res.status(401).json({ error: 'No autorizado' });
  if (!sheet_id) return res.status(400).json({ error: 'Falta sheet_id' });
  try {
    const ok = await setSheetsId(slug, sheet_id);
    if (!ok) return res.status(500).json({ error: 'No se pudo guardar. Verificá que el slug exista.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin/sheets] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Sirve el panel de admin en /admin — también antes de las rutas de cliente
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/api/:slug/login', async (req, res) => {
  const slug = req.params.slug;
  const { password } = req.body;

  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });

  const ok = await verifyPassword(password, clientDB.password_hash);
  if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });

  res.json({
    ok: true,
    name: clientDB.name,
    colorPrimary: clientDB.color_primary || '#c8f135',
    colorAccent: clientDB.color_accent || '#a3c72c',
    colorBtnText: clientDB.color_btn_text || '#0b0b0d',
    kpi_targets: clientDB.kpi_targets,
    alert_config: clientDB.alert_thresholds,
    dash_config: clientDB.dash_config,
    currency: clientDB.currency || 'ARS'
  });
});

// Obtener datos del dashboard (requiere auth via query param)
app.get('/api/:slug/dashboard', async (req, res) => {
  const slug = req.params.slug;
  const client = await loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });

  try {
    // Intentar cargar datos de hoy (Sub-paso 3.4: desde ad_metrics_daily)
    let result = await getTodaySnapshotDB(slug);
    if (!result) {
      // Generar datos nuevos
      result = await runPipeline(slug);
    }
    const history = await loadHistoryDB(slug, 14);
    res.json({ ...result, history, currency: client.currency || 'ARS', report_profile: client.report_profile });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Refrescar análisis manualmente
app.post('/api/:slug/refresh', async (req, res) => {
  const slug = req.params.slug;
  const client = await loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const result = await runPipeline(slug);
    const history = await loadHistoryDB(slug, 14);
    res.json({ ...result, history, currency: client.currency || 'ARS', report_profile: client.report_profile });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Refresh solo métricas (sin correr el agente — más rápido)
app.post('/api/:slug/refresh-metrics', async (req, res) => {
  const slug = req.params.slug;
  const client = await loadClientWithCreds(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    client.slug = slug;
    const metrics = await fetchAccountMetrics(client);
    // Cargar análisis previo si existe
    const history = await loadHistoryDB(slug, 1);
    const prevAnalysis = history[0]?.analysis || {};
    const result = { date: today(), metrics, analysis: prevAnalysis };
    await saveDataDB(slug, result);
    res.json({ ...result, history: await loadHistoryDB(slug, 14), currency: client.currency || 'ARS' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

function yesterday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── Semana ISO: a qué mes calendario pertenece (regla del jueves) ──
// Misma lógica que migrate_to_supabase.js — la semana "pertenece" al
// mes que contiene su jueves. Necesario porque las semanas ISO no
// encajan limpio dentro de los meses calendario.
function isoWeekThursdayMonth(isoYear, isoWeek) {
  const thursday = isoWeekThursdayDate(isoYear, isoWeek);
  return { month: thursday.getUTCMonth() + 1, year: thursday.getUTCFullYear() };
}

// Fase 2 — Funnel y Audiencias: carga manual semanal.
// Guarda directo a nivel semana (no día), porque es carga manual —
// nadie va a tipear un funnel completo todos los días.
app.post('/api/:slug/funnel-weekly/save', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, iso_year, iso_week, ...fields } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });

  if (!iso_year || !iso_week) return res.status(400).json({ error: 'Falta iso_year o iso_week' });

  try {
    const { month, year } = isoWeekThursdayMonth(iso_year, iso_week);
    const row = {
      client_id: clientDB.id,
      iso_year,
      iso_week,
      month_of_week: month,
      year_of_week: year,
      usuarios: fields.usuarios ?? null,
      sesiones: fields.sesiones ?? null,
      landing_views: fields.landing_views ?? null,
      view_item: fields.view_item ?? null,
      add_to_cart: fields.add_to_cart ?? null,
      begin_checkout: fields.begin_checkout ?? null,
      add_payment_info: fields.add_payment_info ?? null,
      purchases: fields.purchases ?? null,
      repeat_purchases: fields.repeat_purchases ?? null,
      audience_data: fields.audience_data ?? {},
      notes: fields.notes ?? null,
      loaded_by: fields.loaded_by ?? null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from('funnel_weekly')
      .upsert(row, { onConflict: 'client_id,iso_year,iso_week' });
    if (error) throw new Error(error.message);
    res.json({ ok: true, iso_year, iso_week, month_of_week: month });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Fase 2 — Historial de Funnel/Audiencias ya cargado
app.get('/api/:slug/funnel-weekly/history', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, weeks } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });

  const { data, error } = await supabase
    .from('funnel_weekly')
    .select('*')
    .eq('client_id', clientDB.id)
    .order('iso_year', { ascending: false })
    .order('iso_week', { ascending: false })
    .limit(Number(weeks) || 12);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ history: data });
});

// ── Integración GA4 — sincronizar tráfico y eventos de UNA semana ──
// Trae los datos de Analytics para el lunes-a-domingo de esa semana ISO
// (mismo criterio que period=week de Meta/Google) y los guarda en
// funnel_weekly — la MISMA tabla que ya usaba la carga manual del
// Fase 2, así el historial y el análisis de IA no necesitan tocarse.
// loaded_by='ga4_sync' distingue estos registros de los cargados a mano.
app.post('/api/:slug/ga4/sync-week', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, iso_year, iso_week } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  if (!iso_year || !iso_week) return res.status(400).json({ error: 'Falta iso_year o iso_week' });

  try {
    const propertyId = await getGA4PropertyId(slug);
    if (!propertyId) return res.status(400).json({ error: 'Este cliente no tiene una propiedad de Google Analytics asociada.' });

    const thursday = isoWeekThursdayDate(Number(iso_year), Number(iso_week));
    const monday = new Date(thursday); monday.setUTCDate(thursday.getUTCDate() - 3);
    const sunday = new Date(thursday); sunday.setUTCDate(thursday.getUTCDate() + 3);
    const fmt = d => d.toISOString().split('T')[0];

    const metrics = await fetchGA4WeeklyMetrics(propertyId, fmt(monday), fmt(sunday));
    const { month, year } = isoWeekThursdayMonth(iso_year, iso_week);

    const row = {
      client_id: clientDB.id,
      iso_year, iso_week,
      month_of_week: month,
      year_of_week: year,
      usuarios: metrics.usuarios,
      sesiones: metrics.sesiones,
      landing_views: metrics.vistas_pagina,
      view_item: metrics.view_item,
      add_to_cart: metrics.add_to_cart,
      begin_checkout: metrics.begin_checkout,
      add_payment_info: metrics.add_payment_info,
      purchases: metrics.purchases,
      audience_data: { usuarios_nuevos: metrics.usuarios_nuevos, sesiones_comprometidas: metrics.sesiones_comprometidas },
      loaded_by: 'ga4_sync',
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from('funnel_weekly')
      .upsert(row, { onConflict: 'client_id,iso_year,iso_week' });
    if (error) throw new Error(error.message);
    res.json({ ok: true, iso_year, iso_week, metrics });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Rediseño de Analytics en eCommerce — Usuarios y Canales de Adquisición ──
// Guarda por canal y por DÍA (no por semana) en ga4_acquisition_daily, para
// tener histórico diario real — el cron de abajo llama a esta misma lógica
// todos los días para "ayer", y este endpoint permite además sincronizar
// un día puntual a mano (para pruebas o para completar días salteados).
async function syncGA4AcquisitionForDate(slug, dateStr) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) throw new Error('Cliente no encontrado');
  const propertyId = await getGA4PropertyId(slug);
  if (!propertyId) throw new Error('Este cliente no tiene una propiedad de Google Analytics asociada.');

  const rows = await fetchGA4AcquisitionForDate(propertyId, dateStr);
  const upsertRows = rows.map(r => ({
    client_id: clientDB.id,
    date: dateStr,
    channel: r.channel,
    sessions: r.sessions,
    users: r.users,
    avg_engagement_seconds: r.avg_engagement_seconds,
    bounce_rate: r.bounce_rate,
    purchases: r.purchases,
    updated_at: new Date().toISOString(),
  }));
  if (upsertRows.length > 0) {
    const { error } = await supabase
      .from('ga4_acquisition_daily')
      .upsert(upsertRows, { onConflict: 'client_id,date,channel' });
    if (error) throw new Error(error.message);
  }
  return upsertRows;
}

app.post('/api/:slug/ga4/sync-acquisition-day', async (req, res) => {
  const slug = req.params.slug;
  const { password, date } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const dateStr = date || yesterday();
    const rows = await syncGA4AcquisitionForDate(slug, dateStr);
    res.json({ ok: true, date: dateStr, rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Adquisición por canal para el período seleccionado — EN VIVO contra la
// API de GA4 (Ayer/7d/14d/Mes/Semana N), sin depender de lo guardado por el
// cron en Supabase (que sigue existiendo solo como histórico de referencia).
app.get('/api/:slug/ga4/acquisition-history', async (req, res) => {
  const slug = req.params.slug;
  const { password, period, iso_year, iso_week } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });

  try {
    const propertyId = await getGA4PropertyId(slug);
    if (!propertyId) return res.status(400).json({ error: 'Este cliente no tiene una propiedad de Google Analytics asociada.' });
    const { since, until } = computeDateRangeForPeriod(period || '7d', iso_year, iso_week);
    const channels = await fetchGA4AcquisitionForRange(propertyId, since, until);
    res.json({ channels, has_data: channels.length > 0 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Métricas de usuarios a nivel SITIO (Total usuarios, nuevos, engagement, rebote) ──
// Mismo patrón que la adquisición por canal: se guarda por día vía cron para
// tener histórico, y se agrega según el período elegido para mostrar en el panel.
async function syncGA4SiteMetricsForDate(slug, dateStr) {
  const clientDB = await loadClientDB(slug);
  if (!clientDB) throw new Error('Cliente no encontrado');
  const propertyId = await getGA4PropertyId(slug);
  if (!propertyId) throw new Error('Este cliente no tiene una propiedad de Google Analytics asociada.');

  const m = await fetchGA4SiteMetricsForDate(propertyId, dateStr);
  const { error } = await supabase
    .from('ga4_site_metrics_daily')
    .upsert({
      client_id: clientDB.id, date: dateStr,
      total_users: m.total_users, new_users: m.new_users,
      avg_engagement_seconds: m.avg_engagement_seconds, bounce_rate: m.bounce_rate,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'client_id,date' });
  if (error) throw new Error(error.message);
  return m;
}

app.post('/api/:slug/ga4/sync-site-metrics-day', async (req, res) => {
  const slug = req.params.slug;
  const { password, date } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const dateStr = date || yesterday();
    const m = await syncGA4SiteMetricsForDate(slug, dateStr);
    res.json({ ok: true, date: dateStr, metrics: m });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/:slug/ga4/site-metrics-history', async (req, res) => {
  const slug = req.params.slug;
  const { password, period, iso_year, iso_week } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });

  try {
    const propertyId = await getGA4PropertyId(slug);
    if (!propertyId) return res.status(400).json({ error: 'Este cliente no tiene una propiedad de Google Analytics asociada.' });
    const { since, until } = computeDateRangeForPeriod(period || '7d', iso_year, iso_week);
    const site = await fetchGA4SiteMetricsForRange(propertyId, since, until);
    res.json(site);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Top URLs y Top Artículos — en vivo, para el período seleccionado (sin guardar histórico) ──
app.get('/api/:slug/ga4/top-pages', async (req, res) => {
  const slug = req.params.slug;
  const { password, period, iso_year, iso_week } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const propertyId = await getGA4PropertyId(slug);
    if (!propertyId) return res.status(400).json({ error: 'Este cliente no tiene una propiedad de Google Analytics asociada.' });
    const { since, until } = computeDateRangeForPeriod(period || '7d', iso_year, iso_week);
    const pages = await fetchGA4TopPages(propertyId, since, until, 10);
    res.json({ pages });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/:slug/ga4/top-items', async (req, res) => {
  const slug = req.params.slug;
  const { password, period, iso_year, iso_week } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const propertyId = await getGA4PropertyId(slug);
    if (!propertyId) return res.status(400).json({ error: 'Este cliente no tiene una propiedad de Google Analytics asociada.' });
    const { since, until } = computeDateRangeForPeriod(period || '7d', iso_year, iso_week);
    const items = await fetchGA4TopItems(propertyId, since, until, 10);
    res.json({ items });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// ── SEARCH CONSOLE — todo en un solo endpoint (misma lógica que ya
// usa el resto de las solapas: elegís período, apretás Actualizar,
// se trae todo junto). Las fechas se corren 3 días atrás por dentro
// de cada función del conector (delay propio de la API de Google) —
// acá no hay que hacer nada especial con el período que llega.
// ══════════════════════════════════════════════════════════════════
app.get('/api/:slug/search-console/summary', async (req, res) => {
  const slug = req.params.slug;
  const { password, period, iso_year, iso_week } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const property = await getSearchConsoleProperty(slug);
    if (!property) return res.status(400).json({ error: 'Este cliente no tiene una propiedad de Search Console asociada.' });
    const { since, until } = computeDateRangeForPeriod(period || '7d', iso_year, iso_week);
    const [summary, queries, pages, byCountry, byDevice, bySearchType] = await Promise.all([
      fetchSearchConsoleSummary(property, since, until),
      fetchTopQueries(property, since, until, 20),
      fetchTopPages(property, since, until, 20),
      fetchByCountry(property, since, until, 10),
      fetchByDevice(property, since, until),
      fetchBySearchType(property, since, until),
    ]);
    res.json({ summary, queries, pages, by_country: byCountry, by_device: byDevice, by_search_type: bySearchType });
    setCredentialError(slug, 'search_console', null).catch(() => {});
  } catch(e) {
    res.status(500).json({ error: e.message });
    setCredentialError(slug, 'search_console', e.message).catch(() => {});
  }
});

// ── Estado de indexación (URL Inspection) para un lote de URLs — se usa
// contra las de "Top páginas" apenas se abre la solapa. Cada URL es una
// llamada separada a Google, así que van todas en paralelo pero el
// tamaño del lote lo controla el frontend (no más de las que ya vinieron
// en Top páginas). Si alguna URL puntual falla, no tira abajo el resto.
app.post('/api/:slug/search-console/indexation', async (req, res) => {
  const slug = req.params.slug;
  const { password, urls } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  if (!Array.isArray(urls) || !urls.length) return res.status(400).json({ error: 'Falta la lista de URLs a chequear' });
  try {
    const property = await getSearchConsoleProperty(slug);
    if (!property) return res.status(400).json({ error: 'Este cliente no tiene una propiedad de Search Console asociada.' });
    const results = await Promise.all(urls.slice(0, 20).map(async (u) => {
      try {
        return await inspectUrl(property, u);
      } catch (e) {
        return { url: u, verdict: 'error', error: e.message, indexed: null };
      }
    }));
    res.json({ results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── "Chequear esta URL" suelto — para una URL puntual que no esté en
// Top páginas (ej. algo recién publicado, sin tráfico todavía).
app.post('/api/:slug/search-console/inspect-url', async (req, res) => {
  const slug = req.params.slug;
  const { password, url } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  if (!url) return res.status(400).json({ error: 'Falta la URL a chequear' });
  try {
    const property = await getSearchConsoleProperty(slug);
    if (!property) return res.status(400).json({ error: 'Este cliente no tiene una propiedad de Search Console asociada.' });
    const result = await inspectUrl(property, url);
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FUNNEL ECOMMERCE — view_item → add_to_cart → begin_checkout → add_shipping_info → add_payment_info → purchase ──
// En vivo para el período seleccionado, con tasa de conversión entre cada paso.
// Arma los pasos del funnel de eCommerce a partir de fetchGA4FunnelCounts —
// counts[event] = {count, users}. Devuelve, por cada paso: eventos, usuarios,
// % de conversión (en eventos, como ya se mostraba) y cuánta gente se pierde
// pasando al siguiente paso, en cantidad de usuarios y en %.
function buildGA4FunnelSteps(counts) {
  return GA4_FUNNEL_EVENTS.map((event, i) => {
    const cur = counts[event] || { count: 0, users: 0 };
    const prev = i > 0 ? (counts[GA4_FUNNEL_EVENTS[i - 1]] || { count: 0, users: 0 }) : null;
    const first = counts[GA4_FUNNEL_EVENTS[0]] || { count: 0, users: 0 };
    const conversionFromPrev = (i > 0 && prev.count) ? +(cur.count / prev.count * 100).toFixed(1) : null;
    const conversionFromStart = (i > 0 && first.count) ? +(cur.count / first.count * 100).toFixed(1) : null;
    const usersLost = (i > 0) ? Math.max(0, prev.users - cur.users) : 0;
    const usersLostPct = (i > 0 && prev.users) ? +(usersLost / prev.users * 100).toFixed(1) : null;
    return {
      event, count: cur.count, users: cur.users,
      conversion_from_prev: conversionFromPrev, conversion_from_start: conversionFromStart,
      users_lost: usersLost, users_lost_pct: usersLostPct,
    };
  });
}

app.get('/api/:slug/ga4/funnel', async (req, res) => {
  const slug = req.params.slug;
  const { password, period, iso_year, iso_week } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const propertyId = await getGA4PropertyId(slug);
    if (!propertyId) return res.status(400).json({ error: 'Este cliente no tiene una propiedad de Google Analytics asociada.' });
    const { since, until } = computeDateRangeForPeriod(period || '7d', iso_year, iso_week);
    const counts = await fetchGA4FunnelCounts(propertyId, since, until);
    const steps = buildGA4FunnelSteps(counts);
    res.json({ steps });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Punto 3 (post-Fase 5) — Business/eCommerce SEMANAL ─────────
// Carga manual semanal de los mismos 6 campos que la carga mensual,
// para quienes quieren seguimiento más fino que mes a mes. Vive en
// su propia tabla (business_metrics_weekly), separada de la mensual
// (business_metrics_monthly) — no se pisan ni se derivan una de otra.
app.post('/api/:slug/business-weekly/save', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, iso_year, iso_week, ...fields } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  if (!iso_year || !iso_week) return res.status(400).json({ error: 'Falta iso_year o iso_week' });

  try {
    const { month, year } = isoWeekThursdayMonth(iso_year, iso_week);
    const row = {
      client_id: clientDB.id,
      iso_year,
      iso_week,
      month_of_week: month,
      year_of_week: year,
      facturacion: fields.facturacion ?? null,
      pedidos: fields.pedidos ?? null,
      tasa_conversion_ecommerce: fields.tasa_conversion_ecommerce ?? null,
      clientes_nuevos: fields.clientes_nuevos ?? null,
      clientes_recurrentes: fields.clientes_recurrentes ?? null,
      notes: fields.notes ?? null,
      loaded_by: fields.loaded_by ?? null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from('business_metrics_weekly')
      .upsert(row, { onConflict: 'client_id,iso_year,iso_week' });
    if (error) throw new Error(error.message);
    res.json({ ok: true, iso_year, iso_week, month_of_week: month });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/:slug/business-weekly/history', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, weeks } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });

  const { data, error } = await supabase
    .from('business_metrics_weekly')
    .select('*')
    .eq('client_id', clientDB.id)
    .order('iso_year', { ascending: false })
    .order('iso_week', { ascending: false })
    .limit(Number(weeks) || 12);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ history: data });
});

// ── Fase 3 — Business / eCommerce mensual ──────────────────────
// Suma automática de inversión/venta por canal desde ad_metrics_daily
// para un año/mes puntual (regla del jueves ya aplica en ad_metrics_daily
// porque ahí se guarda por fecha real, así que agrupamos directo por
// año/mes calendario de la columna `date`).
async function sumChannelForMonth(clientId, source, year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const end = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

  const { data, error } = await supabase
    .from('ad_metrics_daily')
    .select('spend, conversion_value')
    .eq('client_id', clientId)
    .eq('source', source)
    .neq('campaign_id', '__ACCOUNT__')
    .gte('date', start)
    .lt('date', end);
  if (error || !data) return { spend: 0, revenue: 0 };
  return data.reduce((acc, r) => ({
    spend: acc.spend + Number(r.spend || 0),
    revenue: acc.revenue + Number(r.conversion_value || 0),
  }), { spend: 0, revenue: 0 });
}

app.post('/api/:slug/business-monthly/save', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, year, month, ...fields } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  if (!year || !month) return res.status(400).json({ error: 'Falta year o month' });

  try {
    // Auto-cálculo de inversión/venta por canal desde ad_metrics_daily
    const metaTotals = await sumChannelForMonth(clientDB.id, 'meta', year, month);
    const googleTotals = await sumChannelForMonth(clientDB.id, 'google_ads', year, month);

    const row = {
      client_id: clientDB.id,
      year, month,
      facturacion: fields.facturacion ?? null,
      pedidos: fields.pedidos ?? null,
      inversion_meta_auto: metaTotals.spend,
      inversion_meta_manual: fields.inversion_meta_manual ?? null,
      inversion_google_auto: googleTotals.spend,
      inversion_google_manual: fields.inversion_google_manual ?? null,
      venta_meta_auto: metaTotals.revenue,
      venta_meta_manual: fields.venta_meta_manual ?? null,
      venta_google_auto: googleTotals.revenue,
      venta_google_manual: fields.venta_google_manual ?? null,
      tasa_conversion_ecommerce: fields.tasa_conversion_ecommerce ?? null,
      margen_bruto_pct: fields.margen_bruto_pct ?? null,
      margen_neto_pct: fields.margen_neto_pct ?? null,
      costo_logistico: fields.costo_logistico ?? null,
      costo_producto_promedio: fields.costo_producto_promedio ?? null,
      objetivo_mensual: fields.objetivo_mensual ?? null,
      roas_esperado: fields.roas_esperado ?? null,
      cac_maximo: fields.cac_maximo ?? null,
      stock_total: fields.stock_total ?? null,
      productos_sin_stock: fields.productos_sin_stock ?? null,
      nps: fields.nps ?? null,
      cantidad_reclamos: fields.cantidad_reclamos ?? null,
      tiempo_entrega_promedio_dias: fields.tiempo_entrega_promedio_dias ?? null,
      cantidad_vendedores: fields.cantidad_vendedores ?? null,
      clientes_nuevos: fields.clientes_nuevos ?? null,
      clientes_recurrentes: fields.clientes_recurrentes ?? null,
      extra_metrics: fields.extra_metrics ?? {},
      notes: fields.notes ?? null,
      loaded_by: fields.loaded_by ?? null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from('business_metrics_monthly')
      .upsert(row, { onConflict: 'client_id,year,month' });
    if (error) throw new Error(error.message);

    res.json({ ok: true, year, month, inversion_meta_auto: metaTotals.spend, inversion_google_auto: googleTotals.spend });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Nota: se eliminaron pctDelta, shiftIsoWeek, groupCampaignRows,
// aggregateSearchImpressionShare, aggregateAdMetricsForWeek, dateRangeForPeriod,
// aggregateAdMetricsForDateRange, buildSourceComparison, getWeeklySeries y
// detectLaggedSignal — todo el motor de comparación WoW/YoY y señales de halo,
// a pedido del usuario. isoWeekThursdayDate y computeDateRangeForPeriod se
// mantienen: siguen siendo la base de los filtros de período en vivo.

function isoWeekThursdayDate(isoYear, isoWeek) {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const thursday = new Date(week1Monday);
  thursday.setUTCDate(week1Monday.getUTCDate() + (isoWeek - 1) * 7 + 3);
  return thursday;
}

// ── Rango de fechas para un período dado — mismo criterio que fetchMetricsByPeriod (Meta) ──
// Se usa para unificar los filtros (Ayer/7d/14d/Mes/Semana N) en Google Ads
// y Analytics con el resto del sistema. period='week' requiere isoYear/isoWeek.
function computeDateRangeForPeriod(period, isoYear, isoWeek) {
  const today = new Date();
  const fmt = d => d.toISOString().split('T')[0];
  const daysAgo = n => { const d = new Date(today); d.setUTCDate(today.getUTCDate() - n); return d; };
  if (period === 'yesterday') {
    const y = fmt(daysAgo(1));
    return { since: y, until: y };
  } else if (period === '14d') {
    return { since: fmt(daysAgo(14)), until: fmt(daysAgo(1)) };
  } else if (period === 'month') {
    return { since: fmt(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))), until: fmt(daysAgo(1)) };
  } else if (period === 'month_prev') {
    const y = today.getUTCFullYear(), m = today.getUTCMonth();
    return { since: fmt(new Date(Date.UTC(y, m - 1, 1))), until: fmt(new Date(Date.UTC(y, m, 0))) };
  } else if (period === 'week') {
    if (!isoYear || !isoWeek) throw new Error('Falta iso_year o iso_week para period=week');
    const thursday = isoWeekThursdayDate(Number(isoYear), Number(isoWeek));
    const monday = new Date(thursday); monday.setUTCDate(thursday.getUTCDate() - 3);
    const sunday = new Date(thursday); sunday.setUTCDate(thursday.getUTCDate() + 3);
    return { since: fmt(monday), until: fmt(sunday) };
  }
  // 7d default
  return { since: fmt(daysAgo(7)), until: fmt(daysAgo(1)) };
}

// ── Fase 4.3 — Agente experto Claude + GPT (generalización del patrón
// "Andrómeda" de creativos a las 4 solapas: Meta, Google, eCommerce,
// Transversal). Recibe SIEMPRE el contexto ya calculado por 4.1/4.2/
// business-monthly — nunca datos crudos, para evitar alucinaciones
// numéricas (mismo criterio que ya usamos en todo el proyecto).

const SCOPE_LABELS = {
  meta: 'Meta Ads',
  google_ads: 'Google Ads',
  ecommerce: 'eCommerce y rentabilidad de negocio',
  transversal: 'estrategia integral de adquisición y negocio, cruzando Meta Ads, Google Ads y eCommerce',
  ga4_metrics: 'tráfico y comportamiento del sitio en Google Analytics',
  ga4_funnel: 'funnel de eCommerce en Google Analytics (conversión entre etapas)',
};

async function runExpertClaude(scope, contextText, slug) {
  const prompt = `Sos un analista senior experto en eCommerce y paid media, especializado en ${SCOPE_LABELS[scope]}. Mirá los datos YA CALCULADOS a continuación (no recalcules nada, ya vienen resueltos) y dá tu diagnóstico desde el ángulo de RENTABILIDAD Y EFICIENCIA DE MEDIOS:

${contextText}

Respondé SOLO en JSON:
{"diagnostico":"qué está pasando en 2-3 oraciones","causa_probable":"por qué probablemente está pasando","prioridad":"alta|media|baja","accion_recomendada":"la acción más importante a tomar"}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  logAiCall({ slug, model: 'claude-haiku-4-5-20251001', callType: 'expert_analysis_claude_' + scope, inputTokens: d.usage?.input_tokens || 0, outputTokens: d.usage?.output_tokens || 0 }).catch(()=>{});
  return JSON.parse((d.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim());
}

async function runExpertGPT(scope, contextText, slug) {
  const prompt = `Sos un analista senior experto en eCommerce y paid media, especializado en ${SCOPE_LABELS[scope]}. Mirá los datos YA CALCULADOS a continuación (no recalcules nada, ya vienen resueltos) y dá tu diagnóstico desde el ángulo de CRECIMIENTO Y OPORTUNIDAD ESTRATÉGICA:

${contextText}

Respondé SOLO en JSON:
{"diagnostico":"qué está pasando en 2-3 oraciones","causa_probable":"por qué probablemente está pasando","prioridad":"alta|media|baja","accion_recomendada":"la acción más importante a tomar"}`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  logAiCall({ slug, model: 'gpt-4o-mini', callType: 'expert_analysis_gpt_' + scope, inputTokens: d.usage?.prompt_tokens || 0, outputTokens: d.usage?.completion_tokens || 0 }).catch(()=>{});
  return JSON.parse((d.choices?.[0]?.message?.content || '{}').replace(/```json|```/g, '').trim());
}

async function runExpertSynthesis(scope, contextText, claudeR, gptR, slug) {
  const prompt = `Sos un Growth Manager Senior. Dos analistas evaluaron ${SCOPE_LABELS[scope]} con estos datos:

${contextText}

Análisis de Claude (ángulo rentabilidad/eficiencia): ${JSON.stringify(claudeR)}
Análisis de GPT (ángulo crecimiento/oportunidad): ${JSON.stringify(gptR)}

Dá un veredicto final integrado. Respondé SOLO en JSON:
{"resumen_ejecutivo":"2-3 oraciones integrando ambos ángulos","prioridad":"alta|media|baja","accion_inmediata":"la 1 acción más importante a tomar ahora","impacto_estimado":"estimación cualitativa del impacto si se actúa (ej: alto/medio/bajo, con breve razón)"}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 700, messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error('Claude synthesis: ' + (d.error?.message || r.status));
  logAiCall({ slug, model: 'claude-sonnet-5', callType: 'expert_synthesis_' + scope, inputTokens: d.usage?.input_tokens || 0, outputTokens: d.usage?.output_tokens || 0 }).catch(()=>{});
  return JSON.parse((d.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim());
}

async function runExpertAnalysis(scope, contextText, slug) {
  const [claude, gpt] = await Promise.all([
    runExpertClaude(scope, contextText, slug).catch(e => ({ error: e.message })),
    runExpertGPT(scope, contextText, slug).catch(e => ({ error: e.message })),
  ]);
  const synthesis = await runExpertSynthesis(scope, contextText, claude, gpt, slug).catch(e => ({ error: e.message }));
  return { claude, gpt, synthesis };
}

// ── Armado de contexto en texto plano por solapa (para el prompt) ──
// Etiqueta legible del período para el texto del prompt de IA — mismo
// criterio que usa el frontend (giWeekLabel) para "Semana N".
function periodLabelForPrompt(period, isoYear, isoWeek) {
  if (period === 'week') return `semana ${isoWeek}`;
  return ({ yesterday: 'ayer', '7d': 'los últimos 7 días', '14d': 'los últimos 14 días', month: 'este mes', month_prev: 'el mes anterior' }[period] || period);
}

// Resumen de métricas EN VIVO de un canal (Meta o Google Ads) para el
// período seleccionado, sin comparación WoW/YoY (eliminada a pedido del
// usuario — el análisis de IA ahora describe el período actual contra los
// objetivos configurados, no contra semanas anteriores).
function summarizeChannelMetricsForPrompt(label, periodLabel, current, targets) {
  if (!current || (!current.spend && !current.impressions && !current.clicks)) {
    return `${label}: sin datos para ${periodLabel}.`;
  }
  let txt = `${label} — ${periodLabel}: gasto $${current.spend}, ROAS ${current.roas ?? 'N/D'}, CPA $${current.cpa ?? 'N/D'}, CTR ${current.ctr ?? 'N/D'}%, conversiones ${current.conversions}.`;
  const t = targets || {};
  const roasStatus = (t.roas_min != null && current.roas != null) ? (current.roas >= t.roas_min ? 'cumple' : 'por_debajo') : null;
  const cpaStatus = (t.cpa_max != null && current.cpa != null) ? (current.cpa <= t.cpa_max ? 'cumple' : 'por_encima') : null;
  const ctrStatus = (t.ctr_min != null && current.ctr != null) ? (current.ctr >= t.ctr_min ? 'cumple' : 'por_debajo') : null;
  if (roasStatus || cpaStatus || ctrStatus) {
    txt += ` Vs. objetivo configurado: ROAS ${roasStatus ?? 'N/D'} (mínimo ${t.roas_min ?? 'N/D'}), CPA ${cpaStatus ?? 'N/D'} (máximo ${t.cpa_max ?? 'N/D'}), CTR ${ctrStatus ?? 'N/D'} (mínimo ${t.ctr_min ?? 'N/D'}).`;
  }
  return txt;
}

function summarizeEcommerceForPrompt(row) {
  if (!row) return 'eCommerce: sin datos cargados para este mes todavía.';
  const inversionTotal = Number(row.inversion_meta_auto ?? 0) + Number(row.inversion_google_auto ?? 0);
  const ticketPromedio = row.pedidos ? +(row.facturacion / row.pedidos).toFixed(2) : null;
  const cacReal = row.clientes_nuevos ? +(inversionTotal / row.clientes_nuevos).toFixed(2) : null;
  return `eCommerce ${row.month}/${row.year}: facturación $${row.facturacion ?? 'N/D'}, pedidos ${row.pedidos ?? 'N/D'}, ticket promedio $${ticketPromedio ?? 'N/D'}, tasa de conversión del sitio ${row.tasa_conversion_ecommerce ?? 'N/D'}%. Inversión total (Meta+Google) $${inversionTotal}, CAC real $${cacReal ?? 'N/D'}. Clientes nuevos ${row.clientes_nuevos ?? 'N/D'}, recurrentes ${row.clientes_recurrentes ?? 'N/D'}.`;
}

function summarizeGA4MetricsForPrompt(site, topPages, topItems) {
  if (!site || !site.has_data) return 'Analytics: sin datos de tráfico cargados todavía para esta semana.';
  let txt = `Sitio esta semana: ${site.total_users} usuarios totales, ${site.new_users} usuarios nuevos, tiempo de interacción medio por usuario activo de ${site.avg_engagement_seconds} segundos, tasa de rebote ${site.bounce_rate}%.`;
  if (topPages?.length) {
    txt += ` Páginas más visitadas: ${topPages.slice(0, 5).map(p => `${p.path} (${p.views} vistas)`).join(', ')}.`;
  }
  if (topItems?.length) {
    txt += ` Artículos más vistos: ${topItems.slice(0, 5).map(i => `${i.item} (${i.views} vistas)`).join(', ')}.`;
  }
  return txt;
}

function summarizeGA4FunnelForPrompt(steps) {
  if (!steps || !steps.length) return 'Funnel de eCommerce: sin datos cargados todavía para esta semana.';
  const labels = { view_item: 'Vista de producto', add_to_cart: 'Agregado al carrito', begin_checkout: 'Checkout iniciado', add_shipping_info: 'Datos de envío', add_payment_info: 'Datos de pago', purchase: 'Compra' };
  return 'Funnel de eCommerce esta semana: ' + steps.map(s =>
    `${labels[s.event] || s.event}: ${s.count} eventos, ${s.users} usuarios${s.conversion_from_prev != null ? ` (${s.conversion_from_prev}% vs. paso anterior, ${s.conversion_from_start}% vs. el inicio del funnel; se pierden ${s.users_lost} usuarios, ${s.users_lost_pct}% respecto al paso anterior)` : ''}`
  ).join('. ') + '.';
}

// ── Módulo "Inteligencia" (briefing diario) ────────────────────────
// Growth Score 100% determinístico sobre datos reales de Supabase
// (nunca se le pide el puntaje a la IA). Un agente experto de OpenAI
// redacta el storytelling (headline/motivo/acción) a partir de HECHOS
// ya calculados — nunca recibe permiso de inventar números.

function daysAgoDate(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}
function fmtDate(d) { return d.toISOString().split('T')[0]; }
function daysBetweenDates(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

// Serie diaria agregada (spend-weighted) de un canal para los últimos N días.
// Se agrega en JS a partir de las filas por campaña — ad_metrics_daily
// guarda una fila por campaña/día, no un total de cuenta.
async function fetchChannelDailySeries(clientId, source, days = 8) {
  const since = fmtDate(daysAgoDate(days));
  const { data, error } = await supabase
    .from('ad_metrics_daily')
    .select('date, spend, conversion_value, frequency')
    .eq('client_id', clientId).eq('source', source)
    .neq('campaign_id', '__ACCOUNT__')
    .gte('date', since)
    .order('date', { ascending: true });
  if (error || !data) return [];
  const byDate = {};
  for (const r of data) {
    const d = byDate[r.date] || (byDate[r.date] = { spend: 0, convValue: 0, freqSum: 0, freqN: 0 });
    d.spend += Number(r.spend || 0);
    d.convValue += Number(r.conversion_value || 0);
    if (r.frequency != null) { d.freqSum += Number(r.frequency); d.freqN += 1; }
  }
  return Object.keys(byDate).sort().map(date => {
    const d = byDate[date];
    return {
      date,
      spend: d.spend,
      roas: d.spend > 0 ? +(d.convValue / d.spend).toFixed(3) : null,
      frequency: d.freqN ? +(d.freqSum / d.freqN).toFixed(2) : null,
    };
  });
}

// Confianza real (no inventada por la IA): racha de días consecutivos
// con la misma dirección en el campo indicado. 3+ días = alta, 2 = media,
// menos = baja. Se usa tanto para ROAS como para frecuencia.
function computeTrendConfidence(series, field) {
  const points = series.filter(p => p[field] != null);
  if (points.length < 2) return { confidence: 'baja', streakDays: 0, direction: null };
  let streak = 0, direction = null;
  for (let i = points.length - 1; i > 0; i--) {
    const delta = points[i][field] - points[i - 1][field];
    const dir = delta > 0 ? 'sube' : delta < 0 ? 'baja' : null;
    if (dir === null) break;
    if (direction === null) { direction = dir; streak = 1; }
    else if (dir === direction) streak++;
    else break;
  }
  return { confidence: streak >= 3 ? 'alta' : streak === 2 ? 'media' : 'baja', streakDays: streak, direction };
}

// Salud de tracking: ¿está conectado y tiene datos frescos (últimos 3 días)?
async function getTrackingHealth(clientId) {
  const { data: credRows } = await supabase.from('client_credentials').select('source').eq('client_id', clientId);
  const configured = new Set((credRows || []).map(r => r.source));
  const todayStr = today();
  const result = {};
  for (const src of ['meta', 'google_ads', 'ga4']) {
    if (!configured.has(src)) { result[src] = { configured: false, fresh: false, lastDate: null }; continue; }
    const table = src === 'ga4' ? 'ga4_site_metrics_daily' : 'ad_metrics_daily';
    let q = supabase.from(table).select('date').eq('client_id', clientId).order('date', { ascending: false }).limit(1);
    if (table === 'ad_metrics_daily') q = q.eq('source', src);
    const { data } = await q;
    const lastDate = data?.[0]?.date || null;
    result[src] = { configured: true, lastDate, fresh: lastDate ? daysBetweenDates(lastDate, todayStr) <= 3 : false };
  }
  return result;
}

// Promedio de ROAS ponderado por spend en los últimos N días con spend > 0.
function weightedRoas(series, days) {
  const recent = series.slice(-days).filter(p => p.spend > 0);
  const totalSpend = recent.reduce((s, p) => s + p.spend, 0);
  if (!totalSpend) return null;
  const totalConv = recent.reduce((s, p) => s + (p.roas != null ? p.roas * p.spend : 0), 0);
  return +(totalConv / totalSpend).toFixed(2);
}

// ── Motor determinístico: Growth Score + hechos reales para narrar ──
async function computeGrowthScoreAndFacts(client, clientId, slug) {
  const targets = client.kpi_targets || {};
  const alerts  = client.alert_thresholds || {};
  const roasMin = Number(targets.roas_min ?? 2);
  const freqMax = Number(targets.frecuencia_max ?? alerts.frecuencia_alert ?? 4);

  const [metaSeries, googleSeries, tracking, funnelRowsR, bizRowsR] = await Promise.all([
    fetchChannelDailySeries(clientId, 'meta', 8),
    fetchChannelDailySeries(clientId, 'google_ads', 8),
    getTrackingHealth(clientId),
    supabase.from('funnel_weekly').select('*').eq('client_id', clientId).order('iso_year', { ascending: false }).order('iso_week', { ascending: false }).limit(2),
    supabase.from('business_metrics_monthly').select('*').eq('client_id', clientId).order('year', { ascending: false }).order('month', { ascending: false }).limit(1),
  ]);
  const funnelRows = funnelRowsR.data || [];
  const bizRows    = bizRowsR.data || [];

  const facts = [];
  const metaRoas7   = weightedRoas(metaSeries, 7);
  const googleRoas7 = weightedRoas(googleSeries, 7);
  const metaConf    = computeTrendConfidence(metaSeries, 'roas');
  const googleConf  = computeTrendConfidence(googleSeries, 'roas');

  if (metaRoas7 != null && metaRoas7 < roasMin) {
    const spend7 = metaSeries.slice(-7).reduce((s, p) => s + p.spend, 0);
    const diff = spend7 * (roasMin - metaRoas7);
    facts.push({ tipo: 'critico', canal: 'Meta Ads', hecho: `ROAS promedio de los últimos 7 días: ${metaRoas7} (objetivo: ${roasMin})`, confianza: metaConf.confidence, impacto_estimado: diff > 0 ? `-$${Math.round(diff).toLocaleString('es-AR')} vs. objetivo` : null });
  }
  if (googleRoas7 != null && googleRoas7 < roasMin) {
    const spend7 = googleSeries.slice(-7).reduce((s, p) => s + p.spend, 0);
    const diff = spend7 * (roasMin - googleRoas7);
    facts.push({ tipo: 'critico', canal: 'Google Ads', hecho: `ROAS promedio de los últimos 7 días: ${googleRoas7} (objetivo: ${roasMin})`, confianza: googleConf.confidence, impacto_estimado: diff > 0 ? `-$${Math.round(diff).toLocaleString('es-AR')} vs. objetivo` : null });
  }
  if (metaRoas7 != null && metaRoas7 >= roasMin * 1.3) {
    facts.push({ tipo: 'escalar', canal: 'Meta Ads', hecho: `ROAS de ${metaRoas7}, muy por encima del objetivo (${roasMin})`, confianza: metaConf.confidence, impacto_estimado: null });
  }
  if (googleRoas7 != null && googleRoas7 >= roasMin * 1.3) {
    facts.push({ tipo: 'escalar', canal: 'Google Ads', hecho: `ROAS de ${googleRoas7}, muy por encima del objetivo (${roasMin})`, confianza: googleConf.confidence, impacto_estimado: null });
  }

  const metaFreqPoints = metaSeries.filter(p => p.frequency != null);
  const lastFreq = metaFreqPoints.length ? metaFreqPoints[metaFreqPoints.length - 1].frequency : null;
  const freqConf = computeTrendConfidence(metaSeries, 'frequency');
  if (lastFreq != null && lastFreq > freqMax) {
    facts.push({ tipo: 'critico', canal: 'Meta Ads', hecho: `Frecuencia de ${lastFreq} (máximo recomendado: ${freqMax}) — señal de fatiga de creatividades`, confianza: freqConf.confidence, impacto_estimado: null });
  }

  const notConfigured = Object.entries(tracking).filter(([, v]) => !v.configured).map(([k]) => k);
  const staleConfigured = Object.entries(tracking).filter(([, v]) => v.configured && !v.fresh).map(([k]) => k);
  const trackingLabels = { meta: 'Meta Ads', google_ads: 'Google Ads', ga4: 'Google Analytics' };
  if (notConfigured.length) {
    facts.push({ tipo: 'critico', canal: 'Tracking', hecho: `Todavía no está conectado: ${notConfigured.map(m => trackingLabels[m] || m).join(', ')}`, confianza: 'alta', impacto_estimado: null });
  }
  if (staleConfigured.length) {
    facts.push({ tipo: 'oportunidad', canal: 'Tracking', hecho: `Conectado, pero sin datos sincronizados en los últimos 3 días: ${staleConfigured.map(m => trackingLabels[m] || m).join(', ')} (la primera sincronización puede tardar hasta 24hs)`, confianza: 'media', impacto_estimado: null });
  }

  if (funnelRows.length >= 2) {
    const rateOf = r => r.landing_views ? +((r.purchases || 0) / r.landing_views * 100).toFixed(2) : null;
    const rLatest = rateOf(funnelRows[0]), rPrev = rateOf(funnelRows[1]);
    if (rLatest != null && rPrev != null && rLatest < rPrev) {
      facts.push({ tipo: 'critico', canal: 'Funnel', hecho: `Conversión landing→compra bajó de ${rPrev}% a ${rLatest}% semana a semana`, confianza: 'media', impacto_estimado: null });
    } else if (rLatest != null && rPrev != null && rLatest > rPrev) {
      facts.push({ tipo: 'oportunidad', canal: 'Funnel', hecho: `Conversión landing→compra mejoró de ${rPrev}% a ${rLatest}% semana a semana`, confianza: 'media', impacto_estimado: null });
    }
  }

  if (bizRows.length && bizRows[0].objetivo_mensual) {
    const row = bizRows[0];
    const now = new Date();
    const daysInMonth = new Date(Date.UTC(row.year, row.month, 0)).getUTCDate();
    const isCurrentMonth = row.year === now.getUTCFullYear() && row.month === now.getUTCMonth() + 1;
    const dayOfMonth = isCurrentMonth ? now.getUTCDate() : daysInMonth;
    const expectedPace = Number(row.objetivo_mensual) * (dayOfMonth / daysInMonth);
    if (row.facturacion != null && expectedPace > 0) {
      const pct = ((Number(row.facturacion) / expectedPace) - 1) * 100;
      if (pct <= -15) facts.push({ tipo: 'critico', canal: 'Negocio', hecho: `Facturación de ${row.month}/${row.year} un ${Math.abs(pct).toFixed(0)}% por debajo del ritmo esperado para el objetivo mensual`, confianza: 'media', impacto_estimado: null });
      else if (pct >= 15) facts.push({ tipo: 'oportunidad', canal: 'Negocio', hecho: `Facturación de ${row.month}/${row.year} un ${pct.toFixed(0)}% por encima del ritmo esperado para el objetivo mensual`, confianza: 'media', impacto_estimado: null });
    }
  }

  // ── Hechos de Analytics (GA4): funnel en vivo + salud del sitio ──
  // Solo corre si el cliente tiene una propiedad GA4 asociada. Nunca rompe
  // el briefing si GA4 falla (credenciales vencidas, etc.) — se ignora.
  let funnelWorstStep = null;
  try {
    const propertyId = slug ? await getGA4PropertyId(slug) : null;
    if (propertyId) {
      const { since, until } = computeDateRangeForPeriod('7d');
      const counts = await fetchGA4FunnelCounts(propertyId, since, until);
      const steps = buildGA4FunnelSteps(counts);
      const labels = { view_item: 'Vista de producto', add_to_cart: 'Agregado al carrito', begin_checkout: 'Checkout iniciado', add_shipping_info: 'Datos de envío', add_payment_info: 'Datos de pago', purchase: 'Compra' };
      const worst = steps.slice(1).reduce((acc, s) => (s.users_lost_pct != null && (!acc || s.users_lost_pct > acc.users_lost_pct)) ? s : acc, null);
      if (worst && worst.users_lost_pct >= 40) {
        const idx = steps.findIndex(s => s.event === worst.event);
        const prevLabel = labels[steps[idx - 1].event] || steps[idx - 1].event;
        funnelWorstStep = { from: prevLabel, to: labels[worst.event] || worst.event, pct: worst.users_lost_pct, lost: worst.users_lost };
        facts.push({ tipo: 'critico', canal: 'Analytics', hecho: `El mayor quiebre del funnel de eCommerce está entre "${prevLabel}" y "${funnelWorstStep.to}": se pierde ${worst.users_lost_pct}% de los usuarios (${worst.users_lost} personas) en los últimos 7 días`, confianza: 'media', impacto_estimado: null });
      }

      const { data: siteRows } = await supabase
        .from('ga4_site_metrics_daily')
        .select('date, total_users, bounce_rate')
        .eq('client_id', clientId)
        .gte('date', fmtDate(daysAgoDate(8)))
        .order('date', { ascending: true });
      if (siteRows && siteRows.length >= 2) {
        const bounceSeries = siteRows.map(r => ({ date: r.date, bounce_rate: r.bounce_rate != null ? Number(r.bounce_rate) : null }));
        const bounceConf = computeTrendConfidence(bounceSeries, 'bounce_rate');
        const lastBounce = [...bounceSeries].reverse().find(p => p.bounce_rate != null);
        if (lastBounce && lastBounce.bounce_rate >= 55 && bounceConf.direction === 'sube') {
          facts.push({ tipo: 'critico', canal: 'Analytics', hecho: `Tasa de rebote del sitio en ${lastBounce.bounce_rate}% y en subida en los últimos días`, confianza: bounceConf.confidence, impacto_estimado: null });
        }
        const usersSeries = siteRows.map(r => ({ date: r.date, total_users: r.total_users != null ? Number(r.total_users) : null }));
        const usersConf = computeTrendConfidence(usersSeries, 'total_users');
        if (usersConf.direction === 'baja' && usersConf.confidence === 'alta') {
          facts.push({ tipo: 'critico', canal: 'Analytics', hecho: `El tráfico del sitio viene en baja sostenida (${usersConf.streakDays} días seguidos)`, confianza: 'alta', impacto_estimado: null });
        } else if (usersConf.direction === 'sube' && usersConf.confidence === 'alta') {
          facts.push({ tipo: 'oportunidad', canal: 'Analytics', hecho: `El tráfico del sitio viene en suba sostenida (${usersConf.streakDays} días seguidos)`, confianza: 'alta', impacto_estimado: null });
        }
      }
    }
  } catch (e) {
    console.warn('[briefing] GA4 facts omitidos:', e.message);
  }

  // Growth Score determinístico (pesos: campañas 35%, ROAS 25%, funnel 15%, creatividades 10%, tracking 15%)
  const roasChannels = [metaRoas7, googleRoas7].filter(v => v != null);
  const campaignsScore = roasChannels.length ? Math.round((roasChannels.filter(r => r >= roasMin).length / roasChannels.length) * 100) : 50;
  let roasScore = 50;
  if (roasChannels.length) {
    const avgRoas = roasChannels.reduce((a, b) => a + b, 0) / roasChannels.length;
    roasScore = Math.max(0, Math.min(100, Math.round((avgRoas / roasMin) * 70)));
  }
  let funnelScore = 60;
  if (funnelWorstStep) {
    // Peor quiebre del funnel en vivo (GA4): a menor % de pérdida en el paso más débil, mejor score.
    funnelScore = Math.max(0, Math.min(100, Math.round(100 - funnelWorstStep.pct)));
  } else if (funnelRows.length >= 2) {
    const rateOf = r => r.landing_views ? (r.purchases || 0) / r.landing_views * 100 : null;
    const rLatest = rateOf(funnelRows[0]), rPrev = rateOf(funnelRows[1]);
    if (rLatest != null && rPrev != null && rPrev > 0) funnelScore = Math.max(0, Math.min(100, Math.round(50 + ((rLatest - rPrev) / rPrev) * 100)));
  }
  let creativeScore = 70;
  if (lastFreq != null) creativeScore = Math.max(0, Math.min(100, Math.round(100 - Math.max(0, lastFreq - freqMax) * 20)));
  const trackingScore = Math.round((Object.values(tracking).filter(v => v.configured && v.fresh).length / 3) * 100);

  const weights = { campaigns: 0.35, roas: 0.25, funnel: 0.15, creative: 0.10, tracking: 0.15 };
  const growth_score = Math.round(campaignsScore * weights.campaigns + roasScore * weights.roas + funnelScore * weights.funnel + creativeScore * weights.creative + trackingScore * weights.tracking);

  const stats = {
    criticos: facts.filter(f => f.tipo === 'critico').length,
    oportunidades: facts.filter(f => f.tipo === 'oportunidad').length,
    listas_escalar: facts.filter(f => f.tipo === 'escalar').length,
  };

  return { growth_score, breakdown: { campaigns: campaignsScore, roas: roasScore, funnel: funnelScore, creative: creativeScore, tracking: trackingScore, weights }, facts, stats, metaSeries, googleSeries };
}

// ── Agente experto de OpenAI: lee los HECHOS ya calculados y redacta
// el storytelling (nunca inventa números — solo los explica y prioriza). ──
async function runBriefingAgent(client, growthInfo) {
  const { facts, growth_score, metaSeries, googleSeries } = growthInfo;
  if (!facts.length) {
    return {
      headline: `Todo en orden: no encontramos problemas críticos ni cambios bruscos en las cuentas de ${client.name}.`,
      resumen: 'Los canales conectados están dentro de los objetivos configurados y no hay señales de alerta en tracking, funnel ni creatividades. Seguimos monitoreando todos los días.',
      stories: [], timeline: [],
    };
  }
  const factsText = facts.map((f, i) => `${i + 1}. [${f.tipo.toUpperCase()}] (${f.canal}) ${f.hecho}${f.impacto_estimado ? ` — Impacto: ${f.impacto_estimado}` : ''} — Confianza: ${f.confianza}`).join('\n');
  const seriesText = [
    metaSeries.length ? `Meta Ads (fecha: roas/frecuencia): ${metaSeries.map(p => `${p.date}: roas ${p.roas ?? 'N/D'}, frec ${p.frequency ?? 'N/D'}`).join(' | ')}` : '',
    googleSeries.length ? `Google Ads (fecha: roas): ${googleSeries.map(p => `${p.date}: roas ${p.roas ?? 'N/D'}`).join(' | ')}` : '',
  ].filter(Boolean).join('\n');

  const prompt = `Sos un agente experto en leer reportes de campañas de marketing digital (Meta Ads, Google Ads, Analytics, eCommerce) para la agencia Docta Nexus. Redactá, en español rioplatense (voseo), un briefing diario para el cliente "${client.name}". Tu tono es el de un growth manager senior explicándole a un cliente qué está pasando y qué hacer — concreto, seguro, sin relleno corporativo, pero con el detalle suficiente para que el cliente entienda el POR QUÉ y no solo el QUÉ.

Growth Score de hoy: ${growth_score}/100 (ya calculado, no lo recalcules).

Hechos YA DETECTADOS Y CALCULADOS (no inventes números ni agregues datos que no estén acá — tu trabajo es explicarlos y priorizarlos, no inventar cifras nuevas):
${factsText}
${seriesText ? `\nSerie histórica de referencia (para narrar la evolución, sin inventar valores):\n${seriesText}\n` : ''}
Con esto, generá:

1. "headline": 1 sola oración, directa, resumiendo lo más importante del día.
2. "resumen": 2-3 oraciones ampliando el headline — el panorama general del día, conectando los hechos más importantes entre sí (ej. si hay un problema en un canal y una oportunidad en otro, decilo).
3. "stories": un objeto por cada hecho de la lista de arriba (mismo orden y misma cantidad — ni de más ni de menos), con:
   - "titulo": corto y directo
   - "motivo": por qué está pasando esto, 1-2 oraciones con hipótesis razonables (sin inventar datos que no estén en los hechos)
   - "analisis": 2-4 oraciones EXPLAYÁNDOTE — contexto adicional, qué implica para el negocio si no se actúa, comparación con lo esperado, matices que un cliente necesita para entender la situación en profundidad
   - "accion": la acción concreta e inmediata más importante, en 1 oración
   - "consejos": array de 2-3 tips o recomendaciones adicionales y accionables, más allá de la acción principal (buenas prácticas, qué revisar, qué probar)
   - "prioridad": "alta" si el hecho es CRITICO, "media" si es OPORTUNIDAD, "baja" si es ESCALAR
   - "confianza": copiá EXACTO el valor de Confianza del hecho, no lo cambies
   - "impacto_texto": frase corta; si el hecho no trae impacto estimado, describilo cualitativamente sin inventar un número
4. "timeline": hasta 4 entradas narrando en 1 oración cada una cómo veníamos los últimos días (usá la serie histórica si está disponible), con "dia" (fecha corta ej "28/07") y "texto".

Respondé SOLO en JSON, sin texto antes ni después, con este formato exacto:
{"headline":"...","resumen":"...","stories":[{"titulo":"...","motivo":"...","analisis":"...","accion":"...","consejos":["...","..."],"prioridad":"alta|media|baja","confianza":"alta|media|baja","impacto_texto":"..."}],"timeline":[{"dia":"...","texto":"..."}]}`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
    body: JSON.stringify({ model: 'gpt-4o', max_tokens: 2500, messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error('Agente de briefing (OpenAI): ' + (d.error?.message || r.status));
  logAiCall({ slug: client.slug, model: 'gpt-4o', callType: 'briefing_openai', inputTokens: d.usage?.prompt_tokens || 0, outputTokens: d.usage?.completion_tokens || 0 }).catch(() => {});
  const parsed = JSON.parse((d.choices?.[0]?.message?.content || '{}').replace(/```json|```/g, '').trim());
  return { headline: parsed.headline || '', resumen: parsed.resumen || '', stories: parsed.stories || [], timeline: parsed.timeline || [] };
}

// Orquestador: calcula el Growth Score + hechos, llama al agente de OpenAI,
// y guarda (upsert) el briefing del día en Supabase.
async function generateDailyBriefing(slug) {
  const client = await loadClient(slug);
  const clientDB = await loadClientDB(slug);
  if (!client || !clientDB) throw new Error('Cliente no encontrado: ' + slug);
  client.slug = slug;

  const growthInfo = await computeGrowthScoreAndFacts(client, clientDB.id, slug);
  const agent = await runBriefingAgent(client, growthInfo);

  const row = {
    client_id: clientDB.id,
    date: today(),
    growth_score: growthInfo.growth_score,
    growth_score_breakdown: growthInfo.breakdown,
    stats: growthInfo.stats,
    stories: agent.stories,
    timeline: agent.timeline,
    headline: agent.headline,
    resumen: agent.resumen,
    generated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase.from('daily_briefing').upsert(row, { onConflict: 'client_id,date' }).select().single();
  if (error) throw new Error(error.message);
  return data;
}

// ── Endpoint: leer el briefing más reciente (lectura instantánea) ──
app.get('/api/:slug/briefing', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const { data, error } = await supabase
      .from('daily_briefing')
      .select('*')
      .eq('client_id', clientDB.id)
      .order('date', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) return res.json({ empty: true });
    res.json(data[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Endpoint: regenerar el briefing manualmente (botón "Actualizar") ──
app.post('/api/:slug/briefing/refresh', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const row = await generateDailyBriefing(slug);
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ── DOCTA NEXUS REPORTE ── informe editorial para el cliente final,
// generado a demanda desde Operador, congelado (fechas y perfil de
// negocio fijos al momento de emitirlo), con link + código de acceso
// que vence a los 7 días. Dos perfiles de negocio: eCommerce y Leads
// Performance — cada uno arma una estructura distinta, pero SIEMPRE
// sobre el mismo menú fijo de gráficos (topline, burbujas por canal,
// funnel, conversión/leads, evolución 12 meses solo eCommerce,
// acciones). La IA nunca inventa un gráfico nuevo ni un número: solo
// prioriza, redacta y arma el orden de las historias.
// ═══════════════════════════════════════════════════════════════

const MESES_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

function computeReportPeriodRange(periodType) {
  const today = new Date();
  const fmt = d => d.toISOString().split('T')[0];
  const y = today.getUTCFullYear(), m = today.getUTCMonth();

  if (periodType === 'semana') {
    const end = new Date(today); end.setUTCDate(today.getUTCDate() - 1);
    const start = new Date(end); start.setUTCDate(end.getUTCDate() - 6);
    const prevEnd = new Date(start); prevEnd.setUTCDate(start.getUTCDate() - 1);
    const prevStart = new Date(prevEnd); prevStart.setUTCDate(prevEnd.getUTCDate() - 6);
    return {
      start: fmt(start), end: fmt(end), prevStart: fmt(prevStart), prevEnd: fmt(prevEnd),
      label: `semana del ${start.getUTCDate()} al ${end.getUTCDate()} de ${MESES_ES[end.getUTCMonth()]}, ${end.getUTCFullYear()}`,
    };
  }
  if (periodType === 'mes_anterior') {
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 0));
    const prevStart = new Date(Date.UTC(y, m - 2, 1));
    const prevEnd = new Date(Date.UTC(y, m - 1, 0));
    return {
      start: fmt(start), end: fmt(end), prevStart: fmt(prevStart), prevEnd: fmt(prevEnd),
      label: `${MESES_ES[start.getUTCMonth()]} ${start.getUTCFullYear()} (1 al ${end.getUTCDate()})`,
    };
  }
  // mes_actual
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(today); end.setUTCDate(today.getUTCDate() - 1);
  const dayCount = end.getUTCDate();
  const prevMonthLastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const prevStart = new Date(Date.UTC(y, m - 1, 1));
  const prevEnd = new Date(Date.UTC(y, m - 1, Math.min(dayCount, prevMonthLastDay)));
  return {
    start: fmt(start), end: fmt(end), prevStart: fmt(prevStart), prevEnd: fmt(prevEnd),
    label: `${MESES_ES[start.getUTCMonth()]} ${start.getUTCFullYear()} (1 al ${end.getUTCDate()}, en curso)`,
  };
}

// Agrega spend/ingresos/conversiones de un canal (meta o google_ads) para un rango
// de fechas — EN VIVO contra la API correspondiente (mismo principio que ya usan
// Meta Ads/Google Ads/Analytics en Operador). Si el cliente no tiene el canal
// conectado, o la API falla, devuelve ceros — nunca inventa un número.
async function aggregateChannelPeriod(slug, source, start, end) {
  const EMPTY = { spend: 0, conversions: 0, revenue: 0, roas: null, cpa: null, reach: 0, impressions: 0, clicks: 0, frequency: null, engagement: 0, messages: 0, cpmsg: null, ctr: null, conversionRate: null };
  try {
    if (source === 'meta') {
      const creds = await getMetaCredentials(slug);
      if (!creds || !creds.access_token || !creds.ad_account_id) return EMPTY;
      const raw = await fetchMetaCampaignMetricsForRange(creds.ad_account_id, creds.access_token, start, end);
      let spend = 0, conversions = 0, revenue = 0, reach = 0, impressions = 0, clicks = 0, engagement = 0, messages = 0, freqWeighted = 0;
      for (const row of raw) {
        const k = calcKpis(row);
        spend += k.spend || 0;
        conversions += k.purchases || 0;
        revenue += k.revenue || 0;
        reach += k.reach || 0;
        impressions += k.impressions || 0;
        clicks += k.clicks || 0;
        engagement += (k.postEngagement || 0);
        messages += (k.messagingConn || k.messagingStarted7d || 0);
        freqWeighted += (k.frequency || 0) * (k.impressions || 0);
      }
      return {
        spend: +spend.toFixed(0), conversions: Math.round(conversions), revenue: +revenue.toFixed(0),
        roas: spend > 0 ? +(revenue / spend).toFixed(2) : null,
        cpa: conversions > 0 ? +(spend / conversions).toFixed(0) : null,
        reach: Math.round(reach), impressions: Math.round(impressions), clicks: Math.round(clicks),
        frequency: impressions > 0 ? +(freqWeighted / impressions).toFixed(2) : null,
        engagement: Math.round(engagement), messages: Math.round(messages),
        cpmsg: messages > 0 ? +(spend / messages).toFixed(0) : null,
        ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(2) : null,
        conversionRate: clicks > 0 ? +((conversions / clicks) * 100).toFixed(2) : null,
      };
    }
    if (source === 'google_ads') {
      const customerId = await getGoogleAdsAccountId(slug);
      if (!customerId) return EMPTY;
      const raw = await fetchCampaignMetricsRange(customerId, start, end);
      const agg = aggregateCampaignRows(raw);
      const impressions = Math.round(agg.impressions || 0), clicks = Math.round(agg.clicks || 0);
      return {
        spend: +agg.spend.toFixed(0), conversions: Math.round(agg.conversions), revenue: +agg.conversion_value.toFixed(0),
        roas: agg.roas, cpa: agg.cpa,
        reach: 0, impressions, clicks,
        frequency: null, engagement: 0, messages: 0, cpmsg: null,
        ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(2) : null,
        conversionRate: clicks > 0 ? +((agg.conversions / clicks) * 100).toFixed(2) : null,
      };
    }
    return EMPTY;
  } catch (e) {
    console.warn(`[reporte] fetch en vivo de ${source} omitido:`, e.message);
    return EMPTY;
  }
}

// ── Clasificación manual de campañas por objetivo (Leads / eCommerce) ──
// Reemplaza al viejo selector de "perfil" del Informe: en vez de elegir un
// perfil único para todo el cliente, cada campaña real (Meta o Google) se
// clasifica una vez, y el Informe arma automáticamente los dos anclajes
// (Leads combinado, eCommerce combinado) sumando solo lo que corresponda.
async function getCampaignObjectiveMap(clientId) {
  const { data } = await supabase.from('campaign_objective_map').select('source, campaign_id, objetivo').eq('client_id', clientId);
  const map = {};
  (data || []).forEach(r => { map[`${r.source}::${r.campaign_id}`] = r.objetivo; });
  return map;
}

// Suma spend/conversiones/revenue de UN canal, filtrando solo las campañas
// clasificadas con el objetivo pedido ('leads' o 'ecommerce'). Las campañas
// sin clasificar no se cuentan en ninguno de los dos (evita mezclar).
async function aggregateChannelByObjective(slug, source, objetivo, objectiveMap, start, end) {
  const EMPTY = { spend: 0, conversions: 0, revenue: 0, roas: null, cpa: null };
  try {
    if (source === 'meta') {
      const creds = await getMetaCredentials(slug);
      if (!creds?.access_token || !creds?.ad_account_id) return EMPTY;
      const raw = await fetchMetaCampaignMetricsForRange(creds.ad_account_id, creds.access_token, start, end);
      let spend = 0, conversions = 0, revenue = 0;
      for (const row of raw) {
        if (objectiveMap[`meta::${row.campaign_id}`] !== objetivo) continue;
        const k = calcKpis(row);
        spend += k.spend || 0; conversions += (k.purchases || k.leads || 0); revenue += k.revenue || 0;
      }
      return { spend: +spend.toFixed(0), conversions: Math.round(conversions), revenue: +revenue.toFixed(0), roas: spend > 0 ? +(revenue / spend).toFixed(2) : null, cpa: conversions > 0 ? +(spend / conversions).toFixed(0) : null };
    }
    if (source === 'google_ads') {
      const customerId = await getGoogleAdsAccountId(slug);
      if (!customerId) return EMPTY;
      const raw = await fetchCampaignMetricsRange(customerId, start, end);
      const filtered = raw.filter(row => objectiveMap[`google_ads::${row.campaign?.id}`] === objetivo);
      const agg = aggregateCampaignRows(filtered);
      return { spend: +agg.spend.toFixed(0), conversions: Math.round(agg.conversions), revenue: +agg.conversion_value.toFixed(0), roas: agg.roas, cpa: agg.cpa };
    }
  } catch (e) {
    console.warn(`[reporte] aggregateChannelByObjective(${source}/${objetivo}) omitido:`, e.message);
  }
  return EMPTY;
}

// Métricas de eCommerce del período: usa business_metrics_weekly para
// 'semana' y business_metrics_monthly para 'mes_anterior'/'mes_actual'
// (son las mismas tablas que ya carga el operador a mano en la solapa eCommerce).
// ── KPI y Objetivos por mes: helpers ──
// 'YYYY-MM' -> {start, end}. Si es el mes en curso, end es hoy (no el último día
// del mes, para no comparar contra días que todavía no pasaron).
function periodToMonthRange(period) {
  const [y, m] = period.split('-').map(Number);
  const start = `${period}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const now = new Date();
  const isCurrentMonth = (now.getUTCFullYear() === y && now.getUTCMonth() + 1 === m);
  const end = isCurrentMonth ? fmtDate(now) : `${period}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

// Trae el resultado REAL de cada KPI de los 4 bloques, para un mes puntual —
// siempre en vivo (mismo criterio que el resto del sistema, nunca se congela).
async function computeMonthlyKpiActuals(slug, clientId, period) {
  const { start, end } = periodToMonthRange(period);
  const [ecom, metaC, googleC, gaChannels] = await Promise.all([
    fetchEcommercePeriodMetrics(clientId, 'mensual_custom', { start, end }).catch(() => null),
    aggregateChannelPeriod(slug, 'meta', start, end),
    aggregateChannelPeriod(slug, 'google_ads', start, end),
    (async () => {
      try {
        const propertyId = await getGA4PropertyId(slug);
        if (!propertyId) return null;
        return await fetchGA4AcquisitionForRange(propertyId, start, end);
      } catch (e) { return null; }
    })(),
  ]);

  let analytics = null;
  if (gaChannels && gaChannels.length) {
    const totalSessions = gaChannels.reduce((s, c) => s + (c.sessions || 0), 0);
    const totalUsers = gaChannels.reduce((s, c) => s + (c.users || 0), 0);
    const weightedEngagement = totalSessions > 0 ? gaChannels.reduce((s, c) => s + (c.avg_engagement_seconds || 0) * (c.sessions || 0), 0) / totalSessions : null;
    const weightedBounce = totalSessions > 0 ? gaChannels.reduce((s, c) => s + (c.bounce_rate || 0) * (c.sessions || 0), 0) / totalSessions : null;
    analytics = { users: totalUsers, engagement_seconds: weightedEngagement != null ? +weightedEngagement.toFixed(1) : null, bounce_rate: weightedBounce != null ? +weightedBounce.toFixed(1) : null };
  }

  const ticketPromedio = ecom?.pedidos ? +(ecom.facturacion / ecom.pedidos).toFixed(0) : null;
  const combSpend = (metaC.spend || 0) + (googleC.spend || 0);
  const combRevenue = (metaC.revenue || 0) + (googleC.revenue || 0);
  const combRoas = combSpend > 0 ? +(combRevenue / combSpend).toFixed(2) : null;

  return {
    ecommerce: (ecom || combRoas != null) ? {
      roas: combRoas,
      pedidos: ecom?.pedidos ?? null, facturacion: ecom?.facturacion ?? null,
      tasa_conversion_ecommerce: ecom?.tasa_conversion_ecommerce ?? null, ticket_promedio: ticketPromedio,
    } : null,
    meta: metaC.spend ? {
      roas: metaC.roas, frequency: metaC.frequency, ctr: metaC.ctr, messages: metaC.messages,
      cpmsg: metaC.cpmsg, cpa: metaC.cpa, conversions: metaC.conversions, revenue: metaC.revenue,
    } : null,
    google: googleC.spend ? {
      roas: googleC.roas, conversions: googleC.conversions, revenue: googleC.revenue,
      ctr: googleC.ctr, cpa: googleC.cpa,
    } : null,
    analytics,
  };
}

async function fetchEcommercePeriodMetrics(clientId, periodType, range) {
  if (periodType === 'semana') {
    const { isoYear, isoWeek } = getIsoWeekOfDate(new Date(range.end + 'T12:00:00Z'));
    const { data } = await supabase.from('business_metrics_weekly').select('*').eq('client_id', clientId).eq('iso_year', isoYear).eq('iso_week', isoWeek).limit(1);
    return data?.[0] || null;
  }
  const d = new Date((periodType === 'mes_anterior' ? range.start : range.start) + 'T12:00:00Z');
  const { data } = await supabase.from('business_metrics_monthly').select('*').eq('client_id', clientId).eq('year', d.getUTCFullYear()).eq('month', d.getUTCMonth() + 1).limit(1);
  return data?.[0] || null;
}

// Últimos 12 meses cargados de business_metrics_monthly, para la evolución anual (solo perfil eCommerce).
async function fetchEcommerce12MonthEvolution(clientId) {
  const { data } = await supabase.from('business_metrics_monthly').select('year, month, facturacion, pedidos, tasa_conversion_ecommerce').eq('client_id', clientId).order('year', { ascending: false }).order('month', { ascending: false }).limit(12);
  return (data || []).reverse();
}

// Funnel de GA4 para el período (mismo motor que ya usa /ga4/funnel y el briefing diario).
// Perfil "leads": hoy no hay eventos de formulario configurados en la plataforma —
// se devuelve null en vez de inventar pasos, y el informe lo muestra honestamente.
async function fetchReportFunnel(slug, start, end) {
  try {
    const propertyId = await getGA4PropertyId(slug);
    if (!propertyId) return null;
    const counts = await fetchGA4FunnelCounts(propertyId, start, end);
    return buildGA4FunnelSteps(counts);
  } catch (e) {
    console.warn('[reporte] funnel GA4 omitido:', e.message);
    return null;
  }
}

// Palabras clave de Google Ads (Search) para el período — perfil "leads".
// Si el cliente no tiene Google Ads conectado, o no corre campañas de Search
// (solo PMax/Display), devuelve null y el informe lo muestra honestamente.
async function fetchReportKeywords(slug, start, end) {
  try {
    const customerId = await getGoogleAdsAccountId(slug);
    if (!customerId) return null;
    const rows = await fetchTopKeywords(customerId, start, end, 15);
    return rows && rows.length ? rows : null;
  } catch (e) {
    console.warn('[reporte] palabras clave omitidas:', e.message);
    return null;
  }
}

// Serie diaria combinada Meta+Google (spend/conversions) del período — usada
// para el sparkline de leads/costo por lead en el perfil "leads".
async function fetchDailyChannelTotals(clientId, start, end) {
  const { data, error } = await supabase
    .from('ad_metrics_daily')
    .select('date, spend, conversions, conversion_value')
    .eq('client_id', clientId).in('source', ['meta', 'google_ads'])
    .neq('campaign_id', '__ACCOUNT__')
    .gte('date', start).lte('date', end)
    .order('date', { ascending: true });
  if (error || !data) return [];
  const byDate = {};
  for (const r of data) {
    const d = byDate[r.date] || (byDate[r.date] = { spend: 0, conversions: 0, revenue: 0 });
    d.spend += Number(r.spend || 0);
    d.conversions += Number(r.conversions || 0);
    d.revenue += Number(r.conversion_value || 0);
  }
  return Object.keys(byDate).sort().map(date => ({
    date, spend: +byDate[date].spend.toFixed(0),
    conversions: Math.round(byDate[date].conversions),
    cpa: byDate[date].conversions > 0 ? +(byDate[date].spend / byDate[date].conversions).toFixed(0) : null,
  }));
}

function pctDelta(current, previous) {
  if (previous == null || previous === 0 || current == null) return null;
  return +(((current - previous) / previous) * 100).toFixed(1);
}

// ── Resuelve qué objetivos usar para el Informe: el KPI MENSUAL (kpi_targets_monthly)
// del mes calendario en el que cae el ÚLTIMO día del rango del informe, traducido a
// los nombres de campo que ya usa el motor de hechos (roas_min_meta, cpa_max, etc.),
// con fallback al KPI global viejo (client.kpi_targets) campo por campo cuando el
// mes no tiene ese valor cargado. Los dos esquemas de nombres son DISTINTOS a
// propósito (kpi_targets_monthly usa target_roas_meta, etc. — mismo formulario que
// ya tiene su propio botón de guardado por bloque), así que esto es una traducción,
// no una migración de datos.
// NOTA para Juan Manuel: "Costo por lead máximo" combinado (costo_lead_max) todavía
// NO tiene un campo equivalente en el formulario mensual — ese valor puntual sigue
// saliendo del KPI global viejo hasta que se agregue un campo mensual para eso.
async function resolveMonthlyKpiTargets(clientId, legacyTargets, range) {
  const legacy = legacyTargets || {};
  try {
    const endDate = new Date(range.end + 'T00:00:00Z');
    const period = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const { data } = await supabase.from('kpi_targets_monthly').select('targets').eq('client_id', clientId).eq('period', period).limit(1);
    const m = data?.[0]?.targets || {};
    return {
      ...legacy,
      roas_min_meta: m.target_roas_meta ?? legacy.roas_min_meta,
      roas_min_google: m.target_roas_google ?? legacy.roas_min_google,
      roas_min_combinado: m.target_roas_ecom ?? legacy.roas_min_combinado,
      roas_min: m.target_roas_ecom ?? legacy.roas_min,
      tasa_conversion_min: m.target_conv_rate_ecom ?? legacy.tasa_conversion_min,
      cpa_max: m.target_cpa_purchases_meta ?? m.target_cpa_purchases_google ?? legacy.cpa_max,
      // costo_lead_max: sin equivalente mensual todavía — se mantiene del KPI global.
    };
  } catch (e) {
    console.warn('[reporte] KPI mensual omitido, se usa el KPI global:', e.message);
    return legacy;
  }
}

// ── Motor determinístico: junta eCommerce + Meta + Google + GA4 en una sola
// estructura de hechos reales, comparando contra el período anterior. ──
async function computeReportFacts(client, clientId, slug, periodType) {
  const range = computeReportPeriodRange(periodType);
  const profile = client.report_profile === 'hibrido' ? 'hibrido' : (client.report_profile === 'leads' ? 'leads' : 'ecommerce');
  const wantsEcom = profile !== 'leads';
  const wantsLeads = profile !== 'ecommerce';

  const [
    metaCur, metaPrev, googleCur, googlePrev,
    ecomCur, ecomPrev, funnel, year12, daily, analyticsDetail, keywords,
  ] = await Promise.all([
    aggregateChannelPeriod(slug, 'meta', range.start, range.end),
    aggregateChannelPeriod(slug, 'meta', range.prevStart, range.prevEnd),
    aggregateChannelPeriod(slug, 'google_ads', range.start, range.end),
    aggregateChannelPeriod(slug, 'google_ads', range.prevStart, range.prevEnd),
    wantsEcom ? fetchEcommercePeriodMetrics(clientId, periodType, range) : Promise.resolve(null),
    wantsEcom ? fetchEcommercePeriodMetrics(clientId, periodType, { start: range.prevStart, end: range.prevEnd }) : Promise.resolve(null),
    wantsEcom ? fetchReportFunnel(slug, range.start, range.end) : Promise.resolve(null),
    wantsEcom ? fetchEcommerce12MonthEvolution(clientId) : Promise.resolve([]),
    fetchDailyChannelTotals(clientId, range.start, range.end),
    fetchAnalyticsDetail(slug, wantsEcom, range.start, range.end),
    wantsLeads ? fetchReportKeywords(slug, range.start, range.end) : Promise.resolve(null),
  ]);

  const targets = await resolveMonthlyKpiTargets(clientId, client.kpi_targets, range);
  const roasMin = Number(targets.roas_min ?? 2);
  const roasMinByChannel = { meta: targets.roas_min_meta != null ? Number(targets.roas_min_meta) : roasMin, google_ads: targets.roas_min_google != null ? Number(targets.roas_min_google) : roasMin };
  const cpaMax = targets.cpa_max != null ? Number(targets.cpa_max) : null;

  const facts = [];
  const channels = [
    { key: 'meta', label: 'Meta Ads', cur: metaCur, prev: metaPrev },
    { key: 'google_ads', label: 'Google Ads', cur: googleCur, prev: googlePrev },
  ];

  // ROAS/CPA por canal — cuenta completa (análisis general, sin separar por objetivo de campaña).
  // Solo aplica si el negocio vende (ecommerce/hibrido): para un cliente 100% leads,
  // ROAS/CPA de venta no tienen objetivo real y ya se cubren con "costo por lead" más abajo.
  if (wantsEcom) {
    for (const ch of channels) {
      if (!ch.cur.spend) continue;
      const chRoasMin = roasMinByChannel[ch.key];
      const roasDelta = pctDelta(ch.cur.roas, ch.prev.roas);
      if (ch.cur.roas != null && ch.cur.roas < chRoasMin) {
        facts.push({ tipo: 'critico', canal: ch.label, orientacion: 'ecommerce', hecho: `ROAS del período: ${ch.cur.roas} (objetivo: ${chRoasMin})${roasDelta != null ? `, ${roasDelta >= 0 ? 'subió' : 'bajó'} ${Math.abs(roasDelta)}% vs. el período anterior` : ''}`, confianza: 'alta', impacto_estimado: null });
      } else if (ch.cur.roas != null && ch.cur.roas >= chRoasMin * 1.3) {
        facts.push({ tipo: 'escalar', canal: ch.label, orientacion: 'ecommerce', hecho: `ROAS del período: ${ch.cur.roas}, muy por encima del objetivo (${chRoasMin})`, confianza: 'alta', impacto_estimado: null });
      }
      if (roasDelta != null && Math.abs(roasDelta) >= 15 && ch.cur.roas >= chRoasMin) {
        facts.push({ tipo: roasDelta > 0 ? 'oportunidad' : 'critico', canal: ch.label, orientacion: 'ecommerce', hecho: `El ROAS ${roasDelta > 0 ? 'mejoró' : 'empeoró'} ${Math.abs(roasDelta)}% vs. el período anterior (${ch.prev.roas ?? 'N/D'} → ${ch.cur.roas})`, confianza: 'media', impacto_estimado: null });
      }
      if (cpaMax != null && ch.cur.cpa != null && ch.cur.cpa > cpaMax) {
        facts.push({ tipo: 'critico', canal: ch.label, orientacion: 'ecommerce', hecho: `CPA del período: $${Math.round(ch.cur.cpa).toLocaleString('es-AR')} (objetivo: $${cpaMax.toLocaleString('es-AR')} máximo)`, confianza: 'alta', impacto_estimado: null });
      }
    }
  }

  // ROAS combinado (cuenta completa) vs. su propio objetivo, si está configurado
  if (wantsEcom && targets.roas_min_combinado != null) {
    const combSpend = (metaCur.spend || 0) + (googleCur.spend || 0);
    const combRevenue = (metaCur.revenue || 0) + (googleCur.revenue || 0);
    const combRoas = combSpend > 0 ? +(combRevenue / combSpend).toFixed(2) : null;
    const roasMinCombinado = Number(targets.roas_min_combinado);
    if (combRoas != null && combRoas < roasMinCombinado) {
      facts.push({ tipo: 'critico', canal: 'General', orientacion: 'ecommerce', hecho: `ROAS combinado del período (Meta+Google): ${combRoas} (objetivo: ${roasMinCombinado})`, confianza: 'alta', impacto_estimado: null });
    } else if (combRoas != null && combRoas >= roasMinCombinado * 1.2) {
      facts.push({ tipo: 'oportunidad', canal: 'General', orientacion: 'ecommerce', hecho: `ROAS combinado del período (Meta+Google): ${combRoas}, por encima del objetivo (${roasMinCombinado})`, confianza: 'media', impacto_estimado: null });
    }
  }

  // Alcance y notoriedad — Meta y Google por separado (cada uno con su propia tabla en el Informe).
  const reachData = {
    meta: { reach: metaCur.reach || 0, impressions: metaCur.impressions || 0, clicks: metaCur.clicks || 0, frequency: metaCur.frequency, ctr: metaCur.ctr },
    google: { impressions: googleCur.impressions || 0, clicks: googleCur.clicks || 0, ctr: googleCur.ctr },
  };
  // Mensajes recibidos (Meta) — se muestra siempre que haya algún mensaje registrado.
  const messagesData = (metaCur.messages || 0) > 0 ? { messages: metaCur.messages || 0, cpmsg: metaCur.cpmsg } : null;

  // Comparación entre canales (para las burbujas + oportunidad de reasignar presupuesto).
  // eCommerce/hibrido: en base a ROAS. Leads puro: en base a costo por conversión, ya
  // que el ROAS no tiene ningún objetivo real para un negocio que no vende directo.
  if (metaCur.spend && googleCur.spend) {
    if (wantsEcom && metaCur.roas != null && googleCur.roas != null) {
      const best = metaCur.roas >= googleCur.roas ? { label: 'Meta Ads', roas: metaCur.roas } : { label: 'Google Ads', roas: googleCur.roas };
      const worst = metaCur.roas >= googleCur.roas ? { label: 'Google Ads', roas: googleCur.roas } : { label: 'Meta Ads', roas: metaCur.roas };
      if (worst.roas > 0 && best.roas >= worst.roas * 1.4) {
        facts.push({ tipo: 'oportunidad', canal: 'Meta Ads vs. Google Ads', orientacion: 'ecommerce', hecho: `${best.label} rinde ${best.roas}x contra ${worst.roas}x de ${worst.label} en el mismo período — hay margen para reasignar presupuesto hacia ${best.label}`, confianza: 'media', impacto_estimado: null });
      }
    } else if (!wantsEcom && metaCur.cpa != null && googleCur.cpa != null && metaCur.cpa > 0 && googleCur.cpa > 0) {
      const best = metaCur.cpa <= googleCur.cpa ? { label: 'Meta Ads', cpa: metaCur.cpa } : { label: 'Google Ads', cpa: googleCur.cpa };
      const worst = metaCur.cpa <= googleCur.cpa ? { label: 'Google Ads', cpa: googleCur.cpa } : { label: 'Meta Ads', cpa: metaCur.cpa };
      if (best.cpa > 0 && worst.cpa >= best.cpa * 1.4) {
        facts.push({ tipo: 'oportunidad', canal: 'Meta Ads vs. Google Ads', orientacion: 'leads', hecho: `${best.label} consigue leads a $${Math.round(best.cpa).toLocaleString('es-AR')} contra $${Math.round(worst.cpa).toLocaleString('es-AR')} de ${worst.label} en el mismo período — hay margen para reasignar presupuesto hacia ${best.label}`, confianza: 'media', impacto_estimado: null });
      }
    }
  }

  // eCommerce del negocio (facturación/pedidos manuales)
  if (ecomCur) {
    const convDelta = pctDelta(ecomCur.tasa_conversion_ecommerce, ecomPrev?.tasa_conversion_ecommerce);
    const facturacionDelta = pctDelta(ecomCur.facturacion, ecomPrev?.facturacion);
    const ticketCur = ecomCur.pedidos ? ecomCur.facturacion / ecomCur.pedidos : null;
    const ticketPrev = ecomPrev?.pedidos ? ecomPrev.facturacion / ecomPrev.pedidos : null;
    const ticketDelta = pctDelta(ticketCur, ticketPrev);
    if (facturacionDelta != null && Math.abs(facturacionDelta) >= 10) {
      facts.push({ tipo: facturacionDelta > 0 ? 'oportunidad' : 'critico', canal: 'eCommerce', orientacion: 'ecommerce', hecho: `Facturación del período: $${Math.round(ecomCur.facturacion).toLocaleString('es-AR')}, ${facturacionDelta > 0 ? 'subió' : 'bajó'} ${Math.abs(facturacionDelta)}% vs. el período anterior`, confianza: 'alta', impacto_estimado: null });
    }
    if (ticketDelta != null && Math.abs(ticketDelta) >= 8) {
      facts.push({ tipo: ticketDelta > 0 ? 'oportunidad' : 'critico', canal: 'eCommerce', orientacion: 'ecommerce', hecho: `Ticket promedio ${ticketDelta > 0 ? 'subió' : 'bajó'} ${Math.abs(ticketDelta)}% (de $${Math.round(ticketPrev).toLocaleString('es-AR')} a $${Math.round(ticketCur).toLocaleString('es-AR')})`, confianza: 'media', impacto_estimado: null });
    }
    if (convDelta != null && Math.abs(convDelta) >= 10) {
      facts.push({ tipo: convDelta > 0 ? 'oportunidad' : 'critico', canal: 'eCommerce', orientacion: 'ecommerce', hecho: `Tasa de conversión del sitio ${convDelta > 0 ? 'mejoró' : 'empeoró'} ${Math.abs(convDelta)}% vs. el período anterior`, confianza: 'media', impacto_estimado: null });
    }
    if (targets.tasa_conversion_min != null && ecomCur.tasa_conversion_ecommerce != null) {
      const convMin = Number(targets.tasa_conversion_min);
      if (ecomCur.tasa_conversion_ecommerce < convMin) {
        facts.push({ tipo: 'critico', canal: 'eCommerce', orientacion: 'ecommerce', hecho: `Tasa de conversión del sitio: ${ecomCur.tasa_conversion_ecommerce}% (objetivo: ${convMin}% mínimo)`, confianza: 'alta', impacto_estimado: null });
      }
    }
  }

  // Costo por lead combinado vs. su propio objetivo (si está configurado) — solo
  // tiene sentido para negocios que también miden leads (leads/hibrido).
  if (wantsLeads && targets.costo_lead_max != null) {
    const combSpend = (metaCur.spend || 0) + (googleCur.spend || 0);
    const combConv = (metaCur.conversions || 0) + (googleCur.conversions || 0);
    const cpl = combConv > 0 ? +(combSpend / combConv).toFixed(0) : null;
    const cplMax = Number(targets.costo_lead_max);
    if (cpl != null && cpl > cplMax) {
      facts.push({ tipo: 'critico', canal: 'General', orientacion: 'leads', hecho: `Costo por lead combinado del período: $${cpl.toLocaleString('es-AR')} (objetivo: $${cplMax.toLocaleString('es-AR')} máximo)`, confianza: 'alta', impacto_estimado: null });
    } else if (cpl != null && cpl <= cplMax * 0.7) {
      facts.push({ tipo: 'oportunidad', canal: 'General', orientacion: 'leads', hecho: `Costo por lead combinado del período: $${cpl.toLocaleString('es-AR')}, muy por debajo del objetivo ($${cplMax.toLocaleString('es-AR')})`, confianza: 'media', impacto_estimado: null });
    }
  }

  // Funnel (eCommerce)
  if (funnel) {
    const worst = funnel.slice(1).reduce((acc, s) => (s.users_lost_pct != null && (!acc || s.users_lost_pct > acc.users_lost_pct)) ? s : acc, null);
    if (worst && worst.users_lost_pct >= 35) {
      const idx = funnel.findIndex(s => s.event === worst.event);
      facts.push({ tipo: 'critico', canal: 'Analytics', orientacion: 'ecommerce', hecho: `El mayor quiebre del funnel está entre el paso ${idx} y "${worst.event}": se pierde ${worst.users_lost_pct}% de los usuarios (${worst.users_lost} personas) en el período`, confianza: 'media', impacto_estimado: null });
    }
  }

  // Palabras clave de Search (perfil "leads"/"hibrido") — hechos accionables: la que más
  // convierte (candidata a escalar) y la de mayor gasto sin ninguna conversión
  // (candidata a pausar o ajustar). Nunca se pausa nada automáticamente, solo
  // se lo señala para que el operador decida.
  if (keywords && keywords.length) {
    const withClicks = keywords.filter(k => k.clicks > 0);
    const bestConv = withClicks.filter(k => k.conversions > 0).sort((a, b) => b.conversions - a.conversions)[0];
    if (bestConv) {
      facts.push({ tipo: 'oportunidad', canal: 'Google Ads', orientacion: 'leads', hecho: `La palabra clave "${bestConv.text}" (${bestConv.match_type}) generó ${bestConv.conversions} conversiones con ${bestConv.clicks} clics — la de mejor desempeño del período`, confianza: 'alta', impacto_estimado: null });
    }
    const wasted = withClicks.filter(k => k.conversions === 0 && k.cost > 0).sort((a, b) => b.cost - a.cost)[0];
    if (wasted && wasted.cost >= (cpaMax || 0) * 0.5 && wasted.clicks >= 5) {
      facts.push({ tipo: 'critico', canal: 'Google Ads', orientacion: 'leads', hecho: `La palabra clave "${wasted.text}" (${wasted.match_type}) gastó $${wasted.cost.toLocaleString('es-AR')} en ${wasted.clicks} clics sin generar ninguna conversión en el período`, confianza: 'media', impacto_estimado: null });
    }
  }

  return { profile, range, facts, metaCur, metaPrev, googleCur, googlePrev, ecomCur, ecomPrev, funnel, year12, daily, analyticsDetail, reachData, messagesData, keywords };
}

// ── Detalle de Analytics para el informe: canales de tráfico, productos
// (solo eCommerce), dispositivo y demografía. Cada pieza se resuelve de
// forma independiente — si una falla (ej. demografía sin Google Signals
// habilitado) no tira abajo el resto, simplemente esa pieza queda null y
// el informe lo muestra honestamente en vez de inventar.
async function fetchAnalyticsDetail(slug, hasEcommerce, start, end) {
  const propertyId = await getGA4PropertyId(slug).catch(() => null);
  if (!propertyId) return null;

  const [channels, topProducts, devices, demographics] = await Promise.all([
    fetchGA4AcquisitionForRange(propertyId, start, end).catch(e => { console.warn('[reporte] canales GA4 omitidos:', e.message); return []; }),
    hasEcommerce ? fetchGA4TopItemsDetailed(propertyId, start, end, 10).catch(e => { console.warn('[reporte] productos GA4 omitidos:', e.message); return []; }) : Promise.resolve([]),
    fetchGA4DeviceBreakdown(propertyId, start, end).catch(e => { console.warn('[reporte] dispositivos GA4 omitidos:', e.message); return []; }),
    fetchGA4Demographics(propertyId, start, end).catch(e => { console.warn('[reporte] demografía GA4 omitida:', e.message); return null; }),
  ]);

  if (!channels.length && !topProducts.length && !devices.length && !demographics) return null;
  return { channels: channels.slice(0, 6), topProducts, devices, demographics };
}

// ── Agente de OpenAI: recibe SOLO los hechos ya calculados (nunca números
// crudos para recalcular) y decide headline, resumen, cuántas historias
// mostrar, su orden y narrativa, y las 4 acciones de cierre. El menú de
// gráficos (topline, burbujas, funnel, conversión/leads, evolución 12m) es
// fijo y ya viene resuelto — el agente nunca elige ni inventa un gráfico. ──
async function runReportAgent(client, factsData, contextNote, panoramaTheme) {
  const { facts, range, metaCur, metaPrev, googleCur, googlePrev, funnel, ecomCur, ecomPrev, reachData, messagesData, keywords } = factsData;

  if (!facts.length) {
    return {
      headline: 'Un período estable, sin sobresaltos.',
      dek: 'No encontramos variaciones importantes en ningún canal durante este período — todo se mantuvo dentro de lo esperado.',
      stories: [],
      channel_narratives: { meta: '', google: '' },
      funnel_narrative: '', conversion_insight: '', reach_narrative: '', messages_narrative: '', keywords_narrative: '',
      actions: [
        { titulo: 'Testear nuevas variantes de creatividad', motivo: 'Renovar el creative set ayuda a sostener el rendimiento antes de que aparezca fatiga.', impacto: '', orientacion: 'general' },
        { titulo: 'Revisar la segmentación activa', motivo: 'Confirmar que los públicos siguen alineados al objetivo del negocio.', impacto: '', orientacion: 'general' },
        { titulo: 'Auditar la velocidad de carga del sitio', motivo: 'Una mejora de performance ayuda a sostener la conversión.', impacto: '', orientacion: 'general' },
        { titulo: 'Revisar el copy de las landing pages', motivo: 'Pequeños ajustes de mensaje pueden mejorar la conversión sin más inversión.', impacto: '', orientacion: 'general' },
        { titulo: 'Mantener el monitoreo semanal', motivo: 'Sostener la cadencia de revisión para detectar cambios apenas aparezcan.', impacto: '', orientacion: 'general' },
      ],
    };
  }
  const factsText = facts.map((f, i) => `${i + 1}. [${f.tipo.toUpperCase()}]${f.orientacion ? ` {${f.orientacion}}` : ''} (${f.canal}) ${f.hecho} — Confianza: ${f.confianza}`).join('\n');

  const chanSummary = (label, cur, prev) => {
    if (!cur || !cur.spend) return `${label}: sin inversión registrada en este período.`;
    const parts = [`spend $${Math.round(cur.spend).toLocaleString('es-AR')}`];
    if (cur.roas != null) parts.push(`ROAS ${cur.roas}x` + (prev?.roas != null ? ` (antes ${prev.roas}x)` : ''));
    if (cur.cpa != null) parts.push(`CPA $${Math.round(cur.cpa).toLocaleString('es-AR')}` + (prev?.cpa != null ? ` (antes $${Math.round(prev.cpa).toLocaleString('es-AR')})` : ''));
    if (cur.conversions != null) parts.push(`${Math.round(cur.conversions)} conversiones`);
    if (cur.ctr != null) parts.push(`CTR ${cur.ctr}%`);
    return `${label}: ${parts.join(', ')}.`;
  };
  const channelMetricsText = [chanSummary('Meta Ads', metaCur, metaPrev), chanSummary('Google Ads', googleCur, googlePrev)].join('\n');

  const FUNNEL_LABELS_ES = { view_item: 'Vista de producto', add_to_cart: 'Agregado al carrito', begin_checkout: 'Checkout iniciado', add_shipping_info: 'Datos de envío', add_payment_info: 'Datos de pago', purchase: 'Compra' };
  const funnelText = (funnel && funnel.length)
    ? funnel.map(s => `${FUNNEL_LABELS_ES[s.event] || s.event}: ${s.count}${s.users_lost_pct != null ? ` (cayó ${s.users_lost_pct}% respecto al paso anterior)` : ''}`).join('\n')
    : null;

  const convText = (ecomCur && ecomCur.tasa_conversion_ecommerce != null)
    ? `Tasa de conversión del sitio: ${ecomCur.tasa_conversion_ecommerce}%${ecomPrev?.tasa_conversion_ecommerce != null ? ` (período anterior: ${ecomPrev.tasa_conversion_ecommerce}%)` : ''}`
    : null;

  const rd = reachData || {};
  const reachText = (rd.meta && (rd.meta.reach || rd.meta.impressions)) || (rd.google && rd.google.impressions)
    ? `Meta — Alcance: ${(rd.meta?.reach||0).toLocaleString('es-AR')} personas, Impresiones: ${(rd.meta?.impressions||0).toLocaleString('es-AR')}, Clics: ${(rd.meta?.clicks||0).toLocaleString('es-AR')}${rd.meta?.ctr!=null?`, CTR: ${rd.meta.ctr}%`:''}${rd.meta?.frequency != null ? `, Frecuencia: ${rd.meta.frequency}` : ''}.\nGoogle — Impresiones: ${(rd.google?.impressions||0).toLocaleString('es-AR')}, Clics: ${(rd.google?.clicks||0).toLocaleString('es-AR')}${rd.google?.ctr!=null?`, CTR: ${rd.google.ctr}%`:''}.`
    : null;

  const messagesText = (messagesData && messagesData.messages)
    ? `Mensajes/conversaciones iniciadas (Meta): ${messagesData.messages.toLocaleString('es-AR')}.${messagesData.cpmsg != null ? ` Costo por mensaje: $${messagesData.cpmsg.toLocaleString('es-AR')}.` : ''}`
    : null;

  const keywordsText = (keywords && keywords.length)
    ? keywords.slice(0, 10).map(k => `"${k.text}" (${k.match_type}): ${k.clicks} clics, ${k.conversions} conversiones, $${k.cost.toLocaleString('es-AR')} invertidos${k.cpa != null ? `, CPA $${k.cpa.toLocaleString('es-AR')}` : ''}`).join('\n')
    : null;

  const prompt = `Sos un agente experto en leer reportes de campañas de marketing digital (Meta Ads, Google Ads, Analytics) para la agencia Docta Nexus. Vas a redactar, en español rioplatense (voseo), el informe de ${range.label} para "${client.name}".

Hechos YA DETECTADOS Y CALCULADOS — no inventes números ni agregues datos que no estén acá; tu trabajo es priorizarlos y explicarlos, no inventar cifras nuevas:
${factsText}

Métricas crudas por canal (para las secciones de storytelling de Meta Ads y Google Ads):
${channelMetricsText}
${funnelText ? `\nFunnel de eCommerce del período (para el análisis de fricción):\n${funnelText}\n` : ''}${convText ? `\nConversión del sitio (para el análisis de conversión):\n${convText}\n` : ''}${reachText ? `\nAlcance y notoriedad del período (para la sección de marca):\n${reachText}\n` : ''}${messagesText ? `\nMensajes recibidos del período (para la sección de mensajería):\n${messagesText}\n` : ''}${keywordsText ? `\nPalabras clave de Search del período, ordenadas por clics (para la sección de palabras clave):\n${keywordsText}\n` : ''}${panoramaTheme ? `\nTEMA A DESTACAR EN EL PANORAMA (headline/dek) — el operador de la agencia pidió específicamente orientar la apertura del informe hacia esto, sin inventar ni forzar un hecho que no esté arriba:\n"${panoramaTheme}"\n` : ''}${contextNote ? `\nCONTEXTO ADICIONAL QUE TE DEJÓ EL OPERADOR DE LA AGENCIA (podés usarlo para decidir qué priorizar, enfatizar o mencionar — pero NUNCA para ocultar o inventar un hecho real de los de arriba; si pide algo que contradice un hecho, priorizá siempre la verdad de los datos):\n"${contextNote}"\n` : ''}
Con esto generá:
1. "headline": 1 sola oración editorial, la más importante del período${panoramaTheme ? ' — priorizá el tema que pidió el operador si hay un hecho real que lo respalde' : ''} — puede ser de cualquiera de los canales, elegí la que más importa, no sigas un orden fijo.
2. "dek": 2-3 oraciones ampliando el headline, conectando los hechos entre sí si corresponde.
3. "channel_narratives": un objeto {"meta":"...", "google":"..."} — para cada canal, 2-4 oraciones contando cómo le fue en el período (usando las métricas crudas de arriba y los hechos que le correspondan a ese canal). Si un canal no tuvo inversión, decilo en una frase corta y honesta, no inventes actividad. No repitas literalmente el mismo texto para los dos.
4. "stories": elegí las 3-5 más relevantes de la lista de hechos (no hace falta usarlas todas si hay muchas, ni inventar si hay pocas), en el orden que vos decidas que tiene más sentido para contar la historia del período. Cada una con: "titulo" (corto), "motivo" (por qué pasó, 1-2 oraciones), "analisis" (2-3 oraciones de contexto/profundidad), "accion" (la acción concreta más importante), "consejos" (array de 2 tips accionables adicionales), "prioridad" ("alta" si el hecho es CRITICO, "media" si es OPORTUNIDAD, "baja" si es ESCALAR), "confianza" (copiá EXACTO el valor de Confianza del hecho), "orientacion" (copiá el valor entre llaves {ecommerce|leads} del hecho del que salió esta historia; si combina hechos de ambos tipos o no aplica ninguno en particular, usá "general" — NUNCA inventes esta clasificación, reflejá de dónde salió el hecho real).
5. "actions": el "Plan de Optimización" — SIEMPRE 5 o más acciones, en orden de impacto. Si hay menos de 5 hechos que ameriten una acción propia, completá con buenas prácticas de optimización relevantes para el negocio (testeo de creatividades, segmentación, landing pages, velocidad del sitio, etc.) — está bien que sean recomendaciones generales de buenas prácticas siempre que no inventes un número o dato que no esté en los hechos. Cada una con "titulo", "motivo" (1 oración), "impacto" (frase corta cualitativa, o con el número si viene de un hecho real — nunca inventada; dejar vacío "" si es una recomendación general sin impacto medible), y "orientacion" (mismo criterio que en "stories": "ecommerce" si la acción apunta a mejorar ventas/ROAS/facturación, "leads" si apunta a mejorar costo por lead/mensajes/conversiones de contacto, "general" si es una buena práctica que aplica para cualquiera de los dos — ej. testeo de creatividades, velocidad del sitio).
${funnelText ? `6. "funnel_narrative": 3-4 oraciones en tono amigable (no técnico, pensado para que lo entienda el dueño del negocio, no un analista) explicando en qué paso del funnel hay más fricción/pérdida de gente y por qué podría estar pasando ahí puntualmente.\n` : ''}${convText ? `${funnelText ? '7' : '6'}. "conversion_insight": 3-4 oraciones explicando qué significa la tasa de conversión del sitio, por qué esa variación importa para el negocio, y 1-2 recomendaciones concretas para mejorarla.\n` : ''}${reachText ? `"reach_narrative": 3-4 oraciones sobre notoriedad de marca — alcance, impresiones, frecuencia y engagement — SIN mezclar con conversión/ROAS, es una historia de "cuánta gente te vio" no de "cuánta gente compró".\n` : ''}${messagesText ? `"messages_narrative": 3-4 oraciones sobre los mensajes/conversaciones recibidas y su costo, en tono orientado a leads/consultas, no a ventas directas.\n` : ''}${keywordsText ? `"keywords_narrative": 3-4 oraciones sobre qué palabras clave están funcionando mejor (por conversiones, no solo por clics) y cuáles conviene revisar o pausar por gastar sin convertir — en tono orientado a leads, sin inventar términos que no estén en la lista.\n` : ''}
Respondé SOLO en JSON, sin texto antes ni después, con este formato exacto:
{"headline":"...","dek":"...","channel_narratives":{"meta":"...","google":"..."},"stories":[{"titulo":"...","motivo":"...","analisis":"...","accion":"...","consejos":["...","..."],"prioridad":"alta|media|baja","confianza":"alta|media|baja","orientacion":"ecommerce|leads|general"}],"actions":[{"titulo":"...","motivo":"...","impacto":"...","orientacion":"ecommerce|leads|general"}]${funnelText ? ',"funnel_narrative":"..."' : ''}${convText ? ',"conversion_insight":"..."' : ''}${reachText ? ',"reach_narrative":"..."' : ''}${messagesText ? ',"messages_narrative":"..."' : ''}${keywordsText ? ',"keywords_narrative":"..."' : ''}}`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
    body: JSON.stringify({ model: 'gpt-4o', max_tokens: 3400, messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error('Agente del informe (OpenAI): ' + (d.error?.message || r.status));
  logAiCall({ slug: client.slug, model: 'gpt-4o', callType: 'report_openai', inputTokens: d.usage?.prompt_tokens || 0, outputTokens: d.usage?.completion_tokens || 0 }).catch(() => {});
  const parsed = JSON.parse((d.choices?.[0]?.message?.content || '{}').replace(/```json|```/g, '').trim());
  const FALLBACK_ACTIONS = [
    { titulo: 'Testear nuevas variantes de creatividad', motivo: 'Renovar el creative set ayuda a sostener el rendimiento antes de que aparezca fatiga.', impacto: '', orientacion: 'general' },
    { titulo: 'Revisar la segmentación activa', motivo: 'Confirmar que los públicos siguen alineados al objetivo del negocio.', impacto: '', orientacion: 'general' },
    { titulo: 'Auditar la velocidad de carga del sitio', motivo: 'Una mejora de performance ayuda a sostener la conversión.', impacto: '', orientacion: 'general' },
    { titulo: 'Revisar el copy de las landing pages', motivo: 'Pequeños ajustes de mensaje pueden mejorar la conversión sin más inversión.', impacto: '', orientacion: 'general' },
    { titulo: 'Mantener el monitoreo semanal', motivo: 'Sostener la cadencia de revisión para detectar cambios apenas aparezcan.', impacto: '', orientacion: 'general' },
  ];
  let actions = (parsed.actions || []).map(a => ({ ...a, orientacion: a.orientacion || 'general' }));
  if (actions.length < 5) actions = actions.concat(FALLBACK_ACTIONS.slice(0, 5 - actions.length));
  const stories = (parsed.stories || []).map(s => ({ ...s, orientacion: s.orientacion || 'general' }));
  return {
    headline: parsed.headline || '', dek: parsed.dek || '',
    channel_narratives: parsed.channel_narratives || { meta: '', google: '' },
    funnel_narrative: parsed.funnel_narrative || '', conversion_insight: parsed.conversion_insight || '',
    reach_narrative: parsed.reach_narrative || '', messages_narrative: parsed.messages_narrative || '',
    keywords_narrative: parsed.keywords_narrative || '',
    stories, actions,
  };
}

// ── Orquestador: calcula los hechos, corre el agente, arma el token +
// código de acceso, y guarda todo en client_reports. ──
const REPORT_ANCHOR_KEYS = [
  'meta_ads', 'google_ads', 'por_canal',
  'historias_ecommerce', 'historias_leads',
  'funnel_ecommerce', 'detalle_ecommerce', 'detalle_leads',
  'canales_trafico', 'dispositivo_demografia', 'top_productos',
  'alcance', 'mensajes', 'palabras_clave',
  'optimizacion_ecommerce', 'optimizacion_leads',
];
// Default: todo prendido — así un informe generado sin mandar "anchors" (o antes
// de que existiera esta feature) se ve exactamente igual que siempre.
function normalizeAnchors(anchors) {
  const out = {};
  for (const k of REPORT_ANCHOR_KEYS) out[k] = !(anchors && anchors[k] === false);
  return out;
}

async function generateClientReport(slug, periodType, options = {}) {
  const { context_note, panorama_theme, manual_headline, anchors, hero_image_url, closing_image_url, recipient_name, business_name_override } = options;
  const client = await loadClient(slug);
  const clientDB = await loadClientDB(slug);
  if (!client || !clientDB) throw new Error('Cliente no encontrado: ' + slug);
  client.slug = slug;

  const factsData = await computeReportFacts(client, clientDB.id, slug, periodType);
  const profile = factsData.profile;
  const agent = await runReportAgent(client, factsData, context_note, panorama_theme);

  const reportData = {
    profile, period_type: periodType, period_label: factsData.range.label,
    anchors: normalizeAnchors(anchors),
    headline: (manual_headline && manual_headline.trim()) || agent.headline,
    headline_is_manual: !!(manual_headline && manual_headline.trim()),
    dek: agent.dek, channel_narratives: agent.channel_narratives, stories: agent.stories, actions: agent.actions,
    funnel_narrative: agent.funnel_narrative, conversion_insight: agent.conversion_insight,
    reach_narrative: agent.reach_narrative, messages_narrative: agent.messages_narrative,
    keywords_narrative: agent.keywords_narrative,
    reach_data: factsData.reachData, messages_data: factsData.messagesData,
    keywords: factsData.keywords || null,
    meta: factsData.metaCur, meta_prev: factsData.metaPrev,
    google: factsData.googleCur, google_prev: factsData.googlePrev,
    ecommerce: factsData.ecomCur, ecommerce_prev: factsData.ecomPrev,
    funnel: factsData.funnel, year12: factsData.year12, daily: factsData.daily,
    analytics_detail: factsData.analyticsDetail,
    hero_image_url: hero_image_url || null, closing_image_url: closing_image_url || null,
    recipient_name: recipient_name || null,
    business_name_override: business_name_override || null,
    data_retrieved_at: new Date().toISOString(),
  };

  const token = crypto.randomBytes(8).toString('hex');
  const accessCode = String(crypto.randomInt(100000, 999999));
  const expiresAt = new Date(); expiresAt.setUTCDate(expiresAt.getUTCDate() + 7);

  const { data, error } = await supabase.from('client_reports').insert({
    client_id: clientDB.id, token, access_code: accessCode, profile,
    period_type: periodType, period_label: factsData.range.label,
    period_start: factsData.range.start, period_end: factsData.range.end,
    report_data: reportData, expires_at: expiresAt.toISOString(),
  }).select().single();
  if (error) throw new Error(error.message);
  return data;
}

// ── Endpoint: generar el informe (Operador, protegido con el password del cliente) ──
// ════════════════════════════════════════════════════════════════════
// ── INFORME FRÍO (Docta Nexus Data) — sistema separado del Informe
// editorial: sin IA en ningún punto, sin headline/dek/historias. Tabla
// propia (client_reports_frio), función propia, endpoint propio, archivo
// de render propio (report-frio.html). No reutiliza computeReportFacts
// ni runReportAgent — comparte solo las funciones de bajo nivel que ya
// usa toda la plataforma para traer números crudos en vivo.
// ════════════════════════════════════════════════════════════════════

const FRIO_ANCHOR_KEYS = [
  'meta_rendimiento', 'meta_alcance', 'meta_funnel', 'meta_mensajeria', 'meta_engagement', 'meta_video', 'meta_campanas',
  'google_rendimiento', 'google_impression_share', 'google_campanas', 'google_pmax_productos', 'google_keywords', 'google_objetivos',
  'analytics_canales', 'analytics_sitio', 'analytics_dispositivo_demografia', 'analytics_funnel_ecommerce',
  'analytics_productos', 'analytics_eventos_clave',
  'ecommerce_resumen',
];
function normalizeFrioAnchors(anchors) {
  const out = {};
  for (const k of FRIO_ANCHOR_KEYS) out[k] = !(anchors && anchors[k] === false);
  return out;
}

// Suma un conjunto de campos numéricos de calcKpis() a través de todas las
// filas de campaña de Meta — usado para armar los totales de cuenta sin
// perder el detalle por campaña (que sí se conserva en metaCampaigns[]).
const META_SUMMABLE_FIELDS = [
  'spend', 'impressions', 'clicks', 'reach', 'uniqueClicks',
  'purchases', 'revenue', 'addToCart', 'initiateCheckout', 'completeReg',
  'leads', 'leadgenLeads', 'landingPageViews', 'linkClicks', 'outboundClicks',
  'messagingConn', 'messagingFirstReply', 'messagingStarted7d',
  'videoViews', 'videoViews10s', 'videoViews15s', 'videoViews30s', 'thruPlays', 'videoP25', 'videoP50', 'videoP75', 'videoP95',
  'postEngagement', 'postReactions', 'postLikes', 'postComments', 'postShares', 'postSaves', 'pageEngagement',
  'newFollowersPage', 'newFollowersIG', 'igProfileVisits',
];

async function computeReportFrioData(client, clientId, slug, periodType) {
  const range = computeReportPeriodRange(periodType);

  // ── Meta: filas crudas por campaña (mismo endpoint que ya usa el Informe
  // editorial para el total de cuenta — acá se conserva el detalle) ──
  const metaCreds = await getMetaCredentials(slug).catch(() => null);
  let metaCampaigns = [], metaTotals = null;
  if (metaCreds?.access_token && metaCreds?.ad_account_id) {
    const [rawRows, statusData] = await Promise.all([
      fetchMetaCampaignMetricsForRange(metaCreds.ad_account_id, metaCreds.access_token, range.start, range.end).catch(e => { console.warn('[frio] meta campañas omitido:', e.message); return []; }),
      metaFetch(`/${metaCreds.ad_account_id}/campaigns?fields=id,name,effective_status,objective&limit=100&`, metaCreds.access_token).catch(e => { console.warn('[frio] estado campañas Meta omitido:', e.message); return { data: [] }; }),
    ]);
    const statusMap = {};
    (statusData.data || []).forEach(c => { statusMap[c.id] = { status: c.effective_status, objective: c.objective }; });
    metaCampaigns = rawRows.map(cm => {
      const k = calcKpis(cm);
      const info = statusMap[cm.campaign_id] || {};
      return { id: cm.campaign_id, name: cm.campaign_name, status: info.status || null, objective: info.objective || null, ...k };
    }).sort((a, b) => (b.spend || 0) - (a.spend || 0));

    const t = {};
    META_SUMMABLE_FIELDS.forEach(f => { t[f] = 0; });
    let freqWeighted = 0;
    for (const c of metaCampaigns) {
      META_SUMMABLE_FIELDS.forEach(f => { t[f] += c[f] || 0; });
      freqWeighted += (c.frequency || 0) * (c.impressions || 0);
    }
    t.frequency = t.impressions > 0 ? +(freqWeighted / t.impressions).toFixed(2) : null;
    t.ctr = t.impressions > 0 ? +(t.clicks / t.impressions * 100).toFixed(2) : null;
    t.cpm = t.impressions > 0 ? +(t.spend / t.impressions * 1000).toFixed(0) : null;
    t.roas = t.spend > 0 ? +(t.revenue / t.spend).toFixed(2) : null;
    t.cpa = t.purchases > 0 ? +(t.spend / t.purchases).toFixed(0) : null;
    t.cpmsg = t.messagingConn > 0 ? +(t.spend / t.messagingConn).toFixed(0) : null;
    t.videoAvgWatchPct = t.videoViews > 0 && t.thruPlays != null ? +((t.thruPlays / t.videoViews) * 100).toFixed(1) : null;
    t.hasVideoActivity = t.videoViews > 0;
    metaTotals = t;
  }

  // ── Google: mismas funciones que ya usa el Informe editorial, pero sin
  // descartar campaigns[] ni la cuota de impresión que aggregateCampaignRows
  // ya calcula (aggregateChannelPeriod las tira, acá se conservan) ──
  const customerId = await getGoogleAdsAccountId(slug).catch(() => null);
  let googleTotals = null, googleCampaigns = [], pmaxProducts = [], keywords = null, conversionActions = null;
  if (customerId) {
    const [rawRows, products, kw, convActions] = await Promise.all([
      fetchCampaignMetricsRange(customerId, range.start, range.end).catch(e => { console.warn('[frio] google campañas omitido:', e.message); return []; }),
      fetchShoppingProducts(customerId, range.start, range.end).catch(e => { console.warn('[frio] PMax productos omitido:', e.message); return []; }),
      fetchTopKeywords(customerId, range.start, range.end, 25).catch(e => { console.warn('[frio] keywords omitido:', e.message); return []; }),
      fetchConversionActionsSummary(customerId, range.start, range.end).catch(e => { console.warn('[frio] objetivos Google omitido:', e.message); return []; }),
    ]);
    const agg = aggregateCampaignRows(rawRows);
    googleTotals = agg;
    googleCampaigns = agg.campaigns || [];
    pmaxProducts = products;
    keywords = kw && kw.length ? kw : null;
    conversionActions = convActions && convActions.length ? convActions : null;
  }

  // ── Analytics (GA4) ──
  const propertyId = await getGA4PropertyId(slug).catch(() => null);
  let analytics = null;
  if (propertyId) {
    const [channels, siteMetrics, topPages, devices, demographics, funnel, topItems, keyEvents] = await Promise.all([
      fetchGA4AcquisitionForRange(propertyId, range.start, range.end).catch(e => { console.warn('[frio] GA4 canales omitido:', e.message); return []; }),
      fetchGA4SiteMetricsForRange(propertyId, range.start, range.end).catch(e => { console.warn('[frio] GA4 comportamiento del sitio omitido:', e.message); return null; }),
      fetchGA4TopPages(propertyId, range.start, range.end, 10).catch(e => { console.warn('[frio] GA4 top páginas omitido:', e.message); return []; }),
      fetchGA4DeviceBreakdown(propertyId, range.start, range.end).catch(e => { console.warn('[frio] GA4 dispositivos omitido:', e.message); return []; }),
      fetchGA4Demographics(propertyId, range.start, range.end).catch(e => { console.warn('[frio] GA4 demografía omitida:', e.message); return null; }),
      fetchGA4FunnelCounts(propertyId, range.start, range.end).catch(e => { console.warn('[frio] GA4 funnel omitido:', e.message); return []; }),
      fetchGA4TopItemsDetailed(propertyId, range.start, range.end, 10).catch(e => { console.warn('[frio] GA4 productos omitido:', e.message); return []; }),
      fetchGA4KeyEventsSummary(propertyId, range.start, range.end).catch(e => { console.warn('[frio] GA4 eventos clave omitido:', e.message); return []; }),
    ]);
    analytics = { channels, site_metrics: siteMetrics, top_pages: topPages, devices, demographics, funnel, top_items: topItems, key_events: keyEvents };
  }

  // ── eCommerce (carga manual) ──
  const ecommerce = await fetchEcommercePeriodMetrics(clientId, periodType, range).catch(() => null);

  return { range, meta: metaTotals, meta_campaigns: metaCampaigns, google: googleTotals, google_campaigns: googleCampaigns, pmax_products: pmaxProducts, keywords, google_objetivos: conversionActions, analytics, ecommerce };
}

async function generateClientReportFrio(slug, periodType, options = {}) {
  const { anchors, intro_title, intro_note, closing_title, closing_note } = options;
  const client = await loadClient(slug);
  const clientDB = await loadClientDB(slug);
  if (!client || !clientDB) throw new Error('Cliente no encontrado: ' + slug);

  const data = await computeReportFrioData(client, clientDB.id, slug, periodType);

  const reportData = {
    period_type: periodType, period_label: data.range.label,
    anchors: normalizeFrioAnchors(anchors),
    intro_title: (intro_title && intro_title.trim()) || null,
    intro_note: (intro_note && intro_note.trim()) || null,
    closing_title: (closing_title && closing_title.trim()) || null,
    closing_note: (closing_note && closing_note.trim()) || null,
    meta: data.meta, meta_campaigns: data.meta_campaigns,
    google: data.google, google_campaigns: data.google_campaigns,
    pmax_products: data.pmax_products, keywords: data.keywords, google_objetivos: data.google_objetivos,
    analytics: data.analytics, ecommerce: data.ecommerce,
    data_retrieved_at: new Date().toISOString(),
  };

  const token = crypto.randomBytes(8).toString('hex');
  const accessCode = String(crypto.randomInt(100000, 999999));
  const expiresAt = new Date(); expiresAt.setUTCDate(expiresAt.getUTCDate() + 7);

  const { data: row, error } = await supabase.from('client_reports_frio').insert({
    client_id: clientDB.id, token, access_code: accessCode,
    period_type: periodType, period_label: data.range.label,
    period_start: data.range.start, period_end: data.range.end,
    report_data: reportData, expires_at: expiresAt.toISOString(),
  }).select().single();
  if (error) throw new Error(error.message);
  return row;
}

app.post('/api/:slug/report-frio/generate', async (req, res) => {
  const slug = req.params.slug;
  const { password, period_type, anchors, intro_title, intro_note, closing_title, closing_note } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  if (!['semana', 'mes_anterior', 'mes_actual'].includes(period_type)) return res.status(400).json({ error: 'Período inválido' });
  try {
    const report = await generateClientReportFrio(slug, period_type, { anchors, intro_title, intro_note, closing_title, closing_note });
    res.json({ token: report.token, access_code: report.access_code, url: `/rf/${report.token}`, expires_at: report.expires_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/rf/:token', async (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'report-frio.html'));
});

app.get('/api/report-frio/:token/meta', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('client_reports_frio')
      .select('token, expires_at, period_label, client_id, clients(name, website_url)')
      .eq('token', req.params.token).limit(1);
    if (error || !data || !data.length) return res.status(404).json({ error: 'Informe no encontrado' });
    const row = data[0];
    const expired = new Date(row.expires_at) < new Date();
    res.json({
      expired, expires_at: row.expires_at, period_label: row.period_label,
      business_name: row.clients?.name || '', business_url: row.clients?.website_url || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/report-frio/:token/unlock', async (req, res) => {
  const { code } = req.body;
  try {
    const { data, error } = await supabase
      .from('client_reports_frio')
      .select('*, clients(name, website_url, color_primary)')
      .eq('token', req.params.token).limit(1);
    if (error || !data || !data.length) return res.status(404).json({ error: 'Informe no encontrado' });
    const row = data[0];
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Este informe ya venció' });
    if (String(code).trim() !== row.access_code) return res.status(401).json({ error: 'Código incorrecto' });

    supabase.from('client_reports_frio').update({ view_count: (row.view_count || 0) + 1, last_viewed_at: new Date().toISOString() }).eq('token', row.token).then(() => {});

    res.json({
      ...row.report_data,
      business_name: row.clients?.name || '', business_url: row.clients?.website_url || null,
      color_primary: row.clients?.color_primary || null, expires_at: row.expires_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/:slug/report/generate', async (req, res) => {
  const slug = req.params.slug;
  const { password, period_type, context_note, panorama_theme, manual_headline, anchors, hero_image_url, closing_image_url, recipient_name, business_name_override } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  if (!['semana', 'mes_anterior', 'mes_actual'].includes(period_type)) return res.status(400).json({ error: 'Período inválido' });
  try {
    const report = await generateClientReport(slug, period_type, { context_note, panorama_theme, manual_headline, anchors, hero_image_url, closing_image_url, recipient_name, business_name_override });
    res.json({
      token: report.token, access_code: report.access_code,
      url: `/r/${report.token}`, expires_at: report.expires_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Endpoint: subir una imagen opcional (hero o cierre) para el informe ──
// Recibe base64, la sube a Supabase Storage (bucket público 'report-images')
// y devuelve la URL — se llama ANTES de /report/generate, desde la pantalla
// de generación en Operador.
app.post('/api/:slug/report/upload-image', async (req, res) => {
  const slug = req.params.slug;
  const { password, image_base64, filename, slot } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  if (!image_base64 || !slot) return res.status(400).json({ error: 'Falta image_base64 o slot' });
  try {
    const matches = image_base64.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Formato de imagen inválido' });
    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    const ext = mimeType.split('/')[1] || 'jpg';
    const path = `${slug}/${slot}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('report-images').upload(path, buffer, { contentType: mimeType, upsert: true });
    if (error) throw new Error(error.message);
    const { data: pub } = supabase.storage.from('report-images').getPublicUrl(path);
    res.json({ url: pub.publicUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ── PLAN DE CAMPAÑAS ── Supabase es la ÚNICA fuente (campaign_plan_periods
// + campaign_plan_items). El Sheet de cada cliente es de SOLO EXPORTACIÓN
// (botón "Exportar a Sheet") — nunca se lee como fuente de datos.
// ═══════════════════════════════════════════════════════════════

function normalizeCampaignName(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Trae las campañas reales recientes (90 días) de un canal, una sola vez —
// reusado tanto por el matching automático como por live-campaigns.
async function fetchLiveCampaignsForChannel(slug, channel) {
  const since = fmtDate(daysAgoDate(90)), until = fmtDate(daysAgoDate(1));
  if (channel === 'meta') {
    const creds = await getMetaCredentials(slug);
    if (!creds?.access_token || !creds?.ad_account_id) return [];
    const raw = await fetchMetaCampaignMetricsForRange(creds.ad_account_id, creds.access_token, since, until);
    const seen = new Set(); const out = [];
    raw.forEach(r => { if (r.campaign_id && !seen.has(r.campaign_id)) { seen.add(r.campaign_id); out.push({ id: String(r.campaign_id), name: r.campaign_name || '(sin nombre)' }); } });
    return out;
  }
  if (channel === 'google_ads') {
    const customerId = await getGoogleAdsAccountId(slug);
    if (!customerId) return [];
    const raw = await fetchCampaignMetricsRange(customerId, since, until);
    const seen = new Set(); const out = [];
    raw.forEach(r => { const c = r.campaign || {}; if (c.id && !seen.has(c.id)) { seen.add(c.id); out.push({ id: String(c.id), name: c.name || '(sin nombre)' }); } });
    return out;
  }
  return [];
}

// Matching por nombre — Nivel 2 (exacto) y Nivel 3 (parecido/fuzzy) de la
// especificación. Nivel 1 (ID exacto) se da cuando el operador lo carga a
// mano directamente. Nunca vincula solo si la confianza es "fuzzy" sin que
// el operador lo confirme en el frontend — esto solo SUGIERE.
// ── Cálculo de días activos y presupuesto mensual — ÚNICA fuente de verdad,
// nunca editable a mano. "Días" no es un número que carga el operador: es el
// resultado de contar cuántas fechas entre start_date y end_date caen en un
// día de semana permitido por el patrón elegido. Budget Mensual SIEMPRE sale
// de Budget Diario × Días Calculados — nunca se acepta un budget_mensual que
// no cierre matemáticamente con eso.
const ACTIVE_DAYS_PATTERNS = {
  todos: [0, 1, 2, 3, 4, 5, 6],
  lunes_viernes: [1, 2, 3, 4, 5],
  lunes_sabado: [1, 2, 3, 4, 5, 6],
  sabado_domingo: [0, 6],
};
function calculateActiveDays(startDate, endDate, pattern) {
  const allowed = ACTIVE_DAYS_PATTERNS[pattern] || ACTIVE_DAYS_PATTERNS.todos;
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  if (isNaN(start) || isNaN(end) || end < start) return 0;
  let count = 0;
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (allowed.includes(d.getUTCDay())) count++;
  }
  return count;
}
// Recalcula calculated_days y budget_mensual a partir de start_date/end_date/
// active_days_pattern/budget_diario — se llama SIEMPRE antes de guardar un
// item, sin importar qué haya mandado el frontend (o la IA) para esos campos.
function computeItemBudgetFields(fields) {
  const out = { ...fields };
  if (fields.start_date && fields.end_date && fields.active_days_pattern) {
    out.calculated_days = calculateActiveDays(fields.start_date, fields.end_date, fields.active_days_pattern);
    out.dias = out.calculated_days; // compatibilidad con el campo "dias" que ya existía
    if (fields.budget_diario != null) out.budget_mensual = +(Number(fields.budget_diario) * out.calculated_days).toFixed(0);
  }
  return out;
}

async function matchCampaignByName(slug, channel, campaignName) {
  const norm = normalizeCampaignName(campaignName);
  if (!norm || !channel) return { campaign_id: null, match_confidence: 'sin_match' };
  try {
    const live = await fetchLiveCampaignsForChannel(slug, channel);
    const exact = live.find(c => normalizeCampaignName(c.name) === norm);
    if (exact) return { campaign_id: exact.id, match_confidence: 'exact_name', matched_name: exact.name };
    const fuzzy = live.find(c => { const n = normalizeCampaignName(c.name); return n.includes(norm) || norm.includes(n); });
    if (fuzzy) return { campaign_id: fuzzy.id, match_confidence: 'fuzzy', matched_name: fuzzy.name };
  } catch (e) { console.warn('[plan] matching omitido:', e.message); }
  return { campaign_id: null, match_confidence: 'sin_match' };
}

async function fetchCampaignActuals(slug, channel, campaignId, since, until) {
  try {
    if (channel === 'meta') {
      const creds = await getMetaCredentials(slug);
      if (!creds?.access_token || !creds?.ad_account_id) return null;
      const raw = await fetchMetaCampaignMetricsForRange(creds.ad_account_id, creds.access_token, since, until);
      const row = raw.find(r => String(r.campaign_id) === String(campaignId));
      if (!row) return null;
      const k = calcKpis(row);
      return { spend: k.spend || 0, conversions: k.purchases || k.leads || 0, revenue: k.revenue || 0 };
    }
    if (channel === 'google_ads') {
      const customerId = await getGoogleAdsAccountId(slug);
      if (!customerId) return null;
      const raw = await fetchCampaignMetricsRange(customerId, since, until);
      const row = raw.find(r => String(r.campaign?.id) === String(campaignId));
      if (!row) return null;
      const m = row.metrics || {};
      return { spend: Number(m.costMicros || 0) / 1_000_000, conversions: Number(m.conversions || 0), revenue: Number(m.conversionsValue || m.conversions_value || 0) };
    }
  } catch (e) {
    console.warn('[plan] fetchCampaignActuals omitido:', e.message);
  }
  return null;
}

// Leer un período: metadata + campañas, con gasto real y pacing por fila
// (pacing solo si el período es el mes calendario en curso).
app.get('/api/:slug/campaign-plans', async (req, res) => {
  const slug = req.params.slug;
  const { password, period } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const targetPeriod = (period && /^\d{4}-\d{2}$/.test(period)) ? period : fmtDate(new Date()).slice(0, 7);
  try {
    const { data: periodRow } = await supabase.from('campaign_plan_periods').select('*').eq('client_id', clientDB.id).eq('period', targetPeriod).limit(1);
    if (!periodRow?.length) return res.json({ period: targetPeriod, exists: false, plan: null, items: [] });
    const plan = periodRow[0];

    const { data: items } = await supabase.from('campaign_plan_items').select('*').eq('plan_period_id', plan.id).order('created_at', { ascending: true });

    const now = new Date();
    const isCurrentPeriod = targetPeriod === fmtDate(now).slice(0, 7);
    const totalDaysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const dayOfMonth = now.getUTCDate();
    const ritmoEsperadoPct = isCurrentPeriod ? +(dayOfMonth / totalDaysInMonth * 100).toFixed(1) : null;
    const range = computeReportPeriodRange('mes_actual');

    const enriched = await Promise.all((items || []).map(async item => {
      if (!item.campaign_id || !item.channel) return item;
      const actual = await fetchCampaignActuals(slug, item.channel, item.campaign_id, range.start, range.end).catch(() => null);
      const result = { ...item, actual_spend: actual?.spend, actual_conversions: actual?.conversions, actual_revenue: actual?.revenue };
      if (isCurrentPeriod && actual && item.budget_mensual && Number(item.budget_mensual) > 0) {
        const gastadoPct = +(actual.spend / Number(item.budget_mensual) * 100).toFixed(1);
        const desvioPct = +(gastadoPct - ritmoEsperadoPct).toFixed(1);
        result.pacing = {
          dia_del_mes: dayOfMonth, dias_totales: totalDaysInMonth,
          ritmo_esperado_pct: ritmoEsperadoPct, gastado_pct: gastadoPct, desvio_pct: desvioPct,
          semaforo: Math.abs(desvioPct) <= 15 ? 'verde' : Math.abs(desvioPct) <= 35 ? 'amarillo' : 'rojo',
        };
      }
      return result;
    }));
    res.json({ period: targetPeriod, exists: true, is_current_period: isCurrentPeriod, plan, items: enriched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Crear un período nuevo (plan "de cero") — DRAFT hasta que se apruebe.
app.post('/api/:slug/campaign-plans/period', async (req, res) => {
  const slug = req.params.slug;
  const { password, period, total_budget, business_objective, primary_kpi, target_value, restrictions } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Falta period en formato YYYY-MM' });
  try {
    const { data, error } = await supabase.from('campaign_plan_periods').insert({
      client_id: clientDB.id, period, status: 'DRAFT',
      total_budget: total_budget ?? null, business_objective: business_objective || null,
      primary_kpi: primary_kpi || null, target_value: target_value ?? null, restrictions: restrictions || null,
    }).select().single();
    if (error) throw new Error(error.message);
    res.json({ plan: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Editar metadata de un período (presupuesto total, objetivo, estado, etc.)
app.put('/api/:slug/campaign-plans/period/:periodId', async (req, res) => {
  const { password, total_budget, business_objective, primary_kpi, target_value, restrictions, status } = req.body;
  if (!(await checkPassword(req.params.slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const update = { updated_at: new Date().toISOString() };
    if (total_budget !== undefined) update.total_budget = total_budget;
    if (business_objective !== undefined) update.business_objective = business_objective;
    if (primary_kpi !== undefined) update.primary_kpi = primary_kpi;
    if (target_value !== undefined) update.target_value = target_value;
    if (restrictions !== undefined) update.restrictions = restrictions;
    if (status !== undefined) { update.status = status; if (status === 'APPROVED') update.approved_at = new Date().toISOString(); }
    const { data, error } = await supabase.from('campaign_plan_periods').update(update).eq('id', req.params.periodId).select().single();
    if (error) throw new Error(error.message);
    res.json({ plan: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Agregar una campaña al período — intenta matchear automáticamente contra
// campañas reales por nombre (Nivel 2/3); el operador puede sobrescribir
// el resultado a mano desde el frontend con otro PUT.
app.post('/api/:slug/campaign-plans/item', async (req, res) => {
  const slug = req.params.slug;
  const { password, plan_period_id, campaign_name, channel, objective, campaign_objective, budget_diario, dias, budget_mensual, kpi_1, kpi_2, kpi_3, notas, restricciones, start_date, end_date, status, plan_code, active_days_pattern, kpi_1_target, kpi_2_target, kpi_3_target } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  if (!plan_period_id || !campaign_name) return res.status(400).json({ error: 'Falta plan_period_id o campaign_name' });
  try {
    const match = await matchCampaignByName(slug, channel, campaign_name);
    const computed = computeItemBudgetFields({ start_date, end_date, active_days_pattern, budget_diario, dias, budget_mensual });
    const { data, error } = await supabase.from('campaign_plan_items').insert({
      plan_period_id, campaign_name, channel: channel || null,
      campaign_id: match.campaign_id, match_confidence: match.campaign_id ? match.match_confidence : 'sin_match',
      plan_code: plan_code || null, active_days_pattern: active_days_pattern || null,
      objective: objective || null, campaign_objective: campaign_objective || null,
      budget_diario: budget_diario ?? null, dias: computed.dias ?? dias ?? null,
      calculated_days: computed.calculated_days ?? null, budget_mensual: computed.budget_mensual ?? budget_mensual ?? null,
      kpi_1: kpi_1 || null, kpi_2: kpi_2 || null, kpi_3: kpi_3 || null,
      kpi_1_target: kpi_1_target ?? null, kpi_2_target: kpi_2_target ?? null, kpi_3_target: kpi_3_target ?? null,
      notas: notas || null, restricciones: restricciones || null,
      start_date: start_date || null, end_date: end_date || null, status: status || 'Proposed',
    }).select().single();
    if (error) throw new Error(error.message);
    res.json({ item: data, match });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Editar una campaña del plan — incluye poder sobrescribir el match a mano
// (campaign_id/channel/match_confidence directo, sin volver a auto-matchear).
app.put('/api/:slug/campaign-plans/item/:itemId', async (req, res) => {
  const { password, ...fields } = req.body;
  if (!(await checkPassword(req.params.slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const allowed = ['campaign_name', 'channel', 'campaign_id', 'match_confidence', 'campaign_role', 'objective', 'campaign_objective', 'budget_diario', 'dias', 'budget_mensual', 'status', 'kpi_1', 'kpi_2', 'kpi_3', 'notas', 'restricciones', 'start_date', 'end_date', 'plan_code', 'active_days_pattern', 'kpi_1_target', 'kpi_2_target', 'kpi_3_target', 'decision', 'decision_reason'];
  const update = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (fields[k] !== undefined) update[k] = fields[k] === '' ? null : fields[k]; });
  // Si vino fecha/patrón/budget diario, se recalcula acá — nunca se confía en
  // un calculated_days/budget_mensual que haya mandado el frontend directo.
  if (update.start_date !== undefined || update.end_date !== undefined || update.active_days_pattern !== undefined || update.budget_diario !== undefined) {
    try {
      const { data: current } = await supabase.from('campaign_plan_items').select('start_date, end_date, active_days_pattern, budget_diario').eq('id', req.params.itemId).single();
      const merged = { ...current, ...update };
      const computed = computeItemBudgetFields(merged);
      if (computed.calculated_days != null) { update.calculated_days = computed.calculated_days; update.dias = computed.dias; update.budget_mensual = computed.budget_mensual; }
    } catch (e) { /* si falla el recálculo, se guarda lo que vino tal cual */ }
  }
  try {
    const { data, error } = await supabase.from('campaign_plan_items').update(update).eq('id', req.params.itemId).select().single();
    if (error) throw new Error(error.message);
    res.json({ item: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Re-intentar el matching automático de una campaña ya cargada (ej. si se
// creó antes de que existiera la campaña real, o el nombre cambió).
app.post('/api/:slug/campaign-plans/item/:itemId/match', async (req, res) => {
  const slug = req.params.slug;
  const { password } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const { data: item } = await supabase.from('campaign_plan_items').select('*').eq('id', req.params.itemId).single();
    if (!item) return res.status(404).json({ error: 'Campaña no encontrada' });
    const match = await matchCampaignByName(slug, item.channel, item.campaign_name);
    const { data, error } = await supabase.from('campaign_plan_items').update({
      campaign_id: match.campaign_id, match_confidence: match.campaign_id ? match.match_confidence : 'sin_match', updated_at: new Date().toISOString(),
    }).eq('id', req.params.itemId).select().single();
    if (error) throw new Error(error.message);
    res.json({ item: data, match });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/:slug/campaign-plans/item/:itemId', async (req, res) => {
  const { password } = req.query;
  if (!(await checkPassword(req.params.slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const { error } = await supabase.from('campaign_plan_items').delete().eq('id', req.params.itemId);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PLAN MASTER — el "molde" de campañas del cliente, independiente de
// cualquier mes puntual. No tiene fechas ni presupuesto mensual real (eso
// solo existe en la instancia de cada período) — solo defaults reusables.
// ── Importación de una sola vez: trae las campañas de la pestaña "Master"
// del Sheet real del cliente y las carga en campaign_plan_master. Es
// explícita y manual (el operador la dispara a mano) — no es una
// sincronización recurrente, sigue valiendo "Supabase manda de acá en
// adelante". Segura de re-correr: si un plan_code ya existe en el Master,
// se actualiza en vez de duplicarse (upsert).
const MASTER_SHEET_COLUMNS = {
  'campaign name': 'campaign_name',
  'campaign_id': 'plan_code', 'plan_code': 'plan_code', 'código': 'plan_code',
  'channel': 'channel',
  'objective': 'objective', 'campaign objective': 'campaign_objective',
  'budget diario': 'budget_diario_default',
  'status': 'status_default',
  'kpi 1': 'kpi_1', 'kpi 2': 'kpi_2', 'kpi 3': 'kpi_3',
  'notas': 'notas_default', 'restricciones': 'restricciones_default',
};
function normalizeChannelFromSheet(v) {
  const s = (v || '').toLowerCase();
  if (s.includes('google')) return 'google_ads';
  if (s.includes('meta')) return 'meta';
  return null;
}
function normalizeCampaignTypeFromSheet(v) {
  const s = (v || '').toLowerCase();
  if (s.includes('always')) return 'ALWAYS_ON';
  if (s.includes('mensual') || s.includes('monthly')) return 'MONTHLY';
  if (s.includes('one shot') || s.includes('oneshot')) return 'ONE_SHOT';
  return null;
}
app.post('/api/:slug/campaign-plans/master/import-from-sheet', async (req, res) => {
  const slug = req.params.slug;
  const { password, tab_name } = req.body; // tab_name opcional — si no viene, se busca una pestaña con "master" en el nombre
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const sheetId = await getSheetsId(slug);
  if (!sheetId) return res.status(400).json({ error: 'Este cliente todavía no tiene una planilla configurada en /admin.' });
  try {
    const sheets = await getSheetsClient();
    if (!sheets) throw new Error('No se pudo autenticar con Google Sheets.');
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const allTabs = (meta.data.sheets || []).map(s => s.properties?.title).filter(Boolean);
    const masterTabName = tab_name || allTabs.find(t => /master/i.test(t));
    if (!masterTabName) return res.status(400).json({ error: `No encontramos ninguna pestaña con "Master" en el nombre. Pestañas disponibles: ${allTabs.join(', ')}` });

    const valuesRes = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${masterTabName}'!A1:R500` });
    const values = valuesRes.data.values || [];
    if (values.length < 2) return res.json({ imported: 0, tab_name: masterTabName, message: 'La pestaña está vacía o solo tiene encabezados.' });

    const headerRow = values[0].map(h => (h || '').trim().toLowerCase());
    // Detecta la columna de "Duración/Tipo" (Always On/Mensual/One Shot) por
    // coincidencia parcial, ya que el nombre exacto de esa columna varía.
    const durationColIdx = headerRow.findIndex(h => h.includes('duración') || h.includes('duracion') || h.includes('type'));
    const colMap = headerRow.map(h => MASTER_SHEET_COLUMNS[h] || null);

    const rowsToUpsert = [];
    for (const r of values.slice(1)) {
      if (!r.some(c => (c || '').trim() !== '')) continue;
      const row = {};
      colMap.forEach((key, j) => { if (key) row[key] = (r[j] || '').trim(); });
      if (!row.plan_code || !row.campaign_name) continue; // fila incompleta, se saltea
      rowsToUpsert.push({
        client_id: clientDB.id, plan_code: row.plan_code, campaign_name: row.campaign_name,
        channel: normalizeChannelFromSheet(row.channel), campaign_type: durationColIdx >= 0 ? normalizeCampaignTypeFromSheet(r[durationColIdx]) : null,
        objective: row.objective || null, campaign_objective: row.campaign_objective || null,
        budget_diario_default: row.budget_diario_default ? Number(String(row.budget_diario_default).replace(/[^0-9.-]/g, '')) || null : null,
        active_days_pattern_default: 'todos', // no viene en el Master del Sheet, default seguro
        status_default: row.status_default || 'Activa',
        kpi_1: row.kpi_1 || null, kpi_2: row.kpi_2 || null, kpi_3: row.kpi_3 || null,
        notas_default: row.notas_default || null, restricciones_default: row.restricciones_default || null,
      });
    }
    if (!rowsToUpsert.length) return res.json({ imported: 0, tab_name: masterTabName, message: 'No encontramos filas con Campaign Name y código completos en esa pestaña.' });

    const { data: upserted, error } = await supabase.from('campaign_plan_master')
      .upsert(rowsToUpsert, { onConflict: 'client_id,plan_code' }).select();
    if (error) throw new Error(error.message);
    res.json({ imported: upserted.length, tab_name: masterTabName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/:slug/campaign-plans/master', async (req, res) => {
  const slug = req.params.slug;
  const { password } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  try {
    const { data, error } = await supabase.from('campaign_plan_master').select('*').eq('client_id', clientDB.id).order('plan_code', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ master: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/:slug/campaign-plans/master', async (req, res) => {
  const slug = req.params.slug;
  const { password, plan_code, campaign_name, channel, campaign_type, objective, campaign_objective, budget_diario_default, active_days_pattern_default, status_default, kpi_1, kpi_2, kpi_3, notas_default, restricciones_default } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  if (!plan_code || !campaign_name) return res.status(400).json({ error: 'Falta plan_code o campaign_name' });
  try {
    const { data, error } = await supabase.from('campaign_plan_master').insert({
      client_id: clientDB.id, plan_code, campaign_name, channel: channel || null, campaign_type: campaign_type || null,
      objective: objective || null, campaign_objective: campaign_objective || null,
      budget_diario_default: budget_diario_default ?? null, active_days_pattern_default: active_days_pattern_default || null,
      status_default: status_default || 'Activa', kpi_1: kpi_1 || null, kpi_2: kpi_2 || null, kpi_3: kpi_3 || null,
      notas_default: notas_default || null, restricciones_default: restricciones_default || null,
    }).select().single();
    if (error) throw new Error(error.message);
    res.json({ master: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/:slug/campaign-plans/master/:masterId', async (req, res) => {
  const { password, ...fields } = req.body;
  if (!(await checkPassword(req.params.slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const allowed = ['plan_code', 'campaign_name', 'channel', 'campaign_type', 'objective', 'campaign_objective', 'budget_diario_default', 'active_days_pattern_default', 'status_default', 'kpi_1', 'kpi_2', 'kpi_3', 'notas_default', 'restricciones_default'];
  const update = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (fields[k] !== undefined) update[k] = fields[k] === '' ? null : fields[k]; });
  try {
    const { data, error } = await supabase.from('campaign_plan_master').update(update).eq('id', req.params.masterId).select().single();
    if (error) throw new Error(error.message);
    res.json({ master: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/:slug/campaign-plans/master/:masterId', async (req, res) => {
  const { password } = req.query;
  if (!(await checkPassword(req.params.slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const { error } = await supabase.from('campaign_plan_master').delete().eq('id', req.params.masterId);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trae todas las campañas del Master a un período puntual como items nuevos
// — fechas por default = el mes calendario completo del período (recortando
// las Always On, como se acordó), presupuesto/días ya calculados server-side.
// No duplica: si un plan_code ya tiene un item en este período, se saltea.
app.post('/api/:slug/campaign-plans/period/:periodId/import-from-master', async (req, res) => {
  const slug = req.params.slug;
  const { password } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  try {
    const { data: plan } = await supabase.from('campaign_plan_periods').select('*').eq('id', req.params.periodId).single();
    if (!plan) return res.status(404).json({ error: 'Período no encontrado' });
    const [y, m] = plan.period.split('-').map(Number);
    const monthStart = `${plan.period}-01`;
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // último día del mes

    const { data: masterRows } = await supabase.from('campaign_plan_master').select('*').eq('client_id', clientDB.id);
    const { data: existingItems } = await supabase.from('campaign_plan_items').select('plan_code').eq('plan_period_id', plan.id);
    const existingCodes = new Set((existingItems || []).map(i => i.plan_code).filter(Boolean));

    const toInsert = [];
    for (const mRow of (masterRows || [])) {
      if (existingCodes.has(mRow.plan_code)) continue; // ya está importada a este período
      const pattern = mRow.active_days_pattern_default || 'todos';
      const calculated_days = calculateActiveDays(monthStart, monthEnd, pattern);
      const budget_diario = mRow.budget_diario_default || 0;
      const match = await matchCampaignByName(slug, mRow.channel, mRow.campaign_name);
      toInsert.push({
        plan_period_id: plan.id, plan_code: mRow.plan_code, campaign_name: mRow.campaign_name, channel: mRow.channel,
        campaign_id: match.campaign_id, match_confidence: match.campaign_id ? match.match_confidence : 'sin_match',
        objective: mRow.objective, campaign_objective: mRow.campaign_objective,
        budget_diario, active_days_pattern: pattern, calculated_days, dias: calculated_days,
        budget_mensual: +(budget_diario * calculated_days).toFixed(0),
        status: mRow.status_default || 'Proposed', kpi_1: mRow.kpi_1, kpi_2: mRow.kpi_2, kpi_3: mRow.kpi_3,
        notas: mRow.notas_default, restricciones: mRow.restricciones_default, start_date: monthStart, end_date: monthEnd,
      });
    }
    if (!toInsert.length) return res.json({ ok: true, imported: 0, message: 'No hay campañas nuevas del Master para importar (ya están todas en este período, o el Master está vacío).' });
    const { data: inserted, error } = await supabase.from('campaign_plan_items').insert(toInsert).select();
    if (error) throw new Error(error.message);
    res.json({ ok: true, imported: inserted.length, items: inserted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Listar campañas reales recientes de Meta/Google, para el desplegable de
// vinculación manual (override del match automático).
app.get('/api/:slug/campaign-plans/live-campaigns', async (req, res) => {
  const slug = req.params.slug;
  const { password } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const out = { meta: [], google_ads: [] };
  try { out.meta = await fetchLiveCampaignsForChannel(slug, 'meta'); } catch (e) { console.warn('[plan] Meta live-campaigns omitido:', e.message); }
  try { out.google_ads = await fetchLiveCampaignsForChannel(slug, 'google_ads'); } catch (e) { console.warn('[plan] Google live-campaigns omitido:', e.message); }
  res.json(out);
});

// Listar campañas reales recientes + su clasificación actual (Leads/eCommerce/sin clasificar) — para el Informe
app.get('/api/:slug/report/campaign-objectives', async (req, res) => {
  const slug = req.params.slug;
  const { password } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const since = fmtDate(daysAgoDate(90));
  const until = fmtDate(daysAgoDate(1));
  const out = { meta: [], google_ads: [] };
  try {
    const creds = await getMetaCredentials(slug);
    if (creds?.access_token && creds?.ad_account_id) {
      const raw = await fetchMetaCampaignMetricsForRange(creds.ad_account_id, creds.access_token, since, until);
      const seen = new Set();
      for (const row of raw) {
        if (row.campaign_id && !seen.has(row.campaign_id)) { seen.add(row.campaign_id); out.meta.push({ id: String(row.campaign_id), name: row.campaign_name || '(sin nombre)' }); }
      }
    }
  } catch (e) { console.warn('[report] campaign-objectives Meta omitido:', e.message); }
  try {
    const customerId = await getGoogleAdsAccountId(slug);
    if (customerId) {
      const raw = await fetchCampaignMetricsRange(customerId, since, until);
      const seen = new Set();
      for (const row of raw) {
        const c = row.campaign || {};
        if (c.id && !seen.has(c.id)) { seen.add(c.id); out.google_ads.push({ id: String(c.id), name: c.name || '(sin nombre)' }); }
      }
    }
  } catch (e) { console.warn('[report] campaign-objectives Google omitido:', e.message); }
  const map = await getCampaignObjectiveMap(clientDB.id);
  out.meta.forEach(c => { c.objetivo = map[`meta::${c.id}`] || null; });
  out.google_ads.forEach(c => { c.objetivo = map[`google_ads::${c.id}`] || null; });
  res.json(out);
});

// Guardar la clasificación de una o más campañas (Leads/eCommerce) — body: { items: [{source, campaign_id, campaign_name, objetivo}] }
app.post('/api/:slug/report/campaign-objectives', async (req, res) => {
  const slug = req.params.slug;
  const { password, items } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Falta items' });
  try {
    const rows = items.filter(it => it.source && it.campaign_id && it.objetivo).map(it => ({
      client_id: clientDB.id, source: it.source, campaign_id: String(it.campaign_id),
      campaign_name: it.campaign_name || null, objetivo: it.objetivo, updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase.from('campaign_objective_map').upsert(rows, { onConflict: 'client_id,source,campaign_id' });
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trae el resultado real (spend/conversiones/revenue) de UNA campaña puntual ya
// vinculada, para un rango de fechas — se usa para comparar planeado vs. real.
// Genera una PROPUESTA para un período (solo preview, no persiste nada
// todavía): lee el período EN CURSO desde Supabase (si existe) + su
// desempeño real (por campaña matcheada) y le pide a la IA que proponga
// el plan del período elegido. El resultado se devuelve para
// previsualizar — recién se persiste cuando el operador confirma
// explícitamente (endpoint /confirm).
app.post('/api/:slug/campaign-plans/generate-next-month', async (req, res) => {
  const slug = req.params.slug;
  const { password, target_period } = req.body; // target_period opcional: "YYYY-MM" — si no viene, es el mes siguiente al actual
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const client = await loadClient(slug);
  const clientDB = await loadClientDB(slug);
  if (!client || !clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  try {
    const currentPeriod = fmtDate(new Date()).slice(0, 7);
    const { data: periodRow } = await supabase.from('campaign_plan_periods').select('*').eq('client_id', clientDB.id).eq('period', currentPeriod).limit(1);
    const { data: currentItems } = periodRow?.length
      ? await supabase.from('campaign_plan_items').select('*').eq('plan_period_id', periodRow[0].id)
      : { data: [] };
    const { data: masterRows } = await supabase.from('campaign_plan_master').select('*').eq('client_id', clientDB.id);
    if (!currentItems?.length && !masterRows?.length) return res.status(400).json({ error: `No hay campañas cargadas todavía (ni en el mes actual ni en el Plan Master) — cargá al menos una antes de generar una propuesta.` });

    const range = computeReportPeriodRange('mes_actual');

    // Base = las campañas del mes en curso (con su desempeño real cruzado).
    const rowsWithActuals = await Promise.all((currentItems || []).map(async r => {
      let actual = null;
      if (r.campaign_id && r.channel) {
        actual = await fetchCampaignActuals(slug, r.channel, r.campaign_id, range.start, range.end);
        if (actual) actual.matched_by = r.match_confidence === 'exact_name' ? 'ID exacto' : r.match_confidence === 'fuzzy' ? 'nombre parecido' : null;
      }
      return { ...r, actual };
    }));

    const planText = rowsWithActuals.map((r, i) => {
      const parts = [`${i + 1}. "${r.campaign_name}" (plan_code ${r.plan_code || 'N/D'}, ${r.channel || 'canal N/D'}, status ${r.status || 'N/D'})`];
      if (r.budget_diario) parts.push(`Budget Diario actual: $${r.budget_diario} × ${r.calculated_days || r.dias || '?'} días activos = $${r.budget_mensual || '?'} mensual`);
      if (r.objective) parts.push(`objetivo: ${r.objective}`);
      const kpisList = [r.kpi_1, r.kpi_2, r.kpi_3].filter(Boolean);
      if (kpisList.length) parts.push(`KPIs: ${kpisList.join(', ')}`);
      if (r.actual) parts.push(`REAL este mes${r.actual.matched_by ? ` (emparejado por ${r.actual.matched_by})` : ''}: gasto $${Math.round(r.actual.spend)}, ${Math.round(r.actual.conversions)} conversiones, ingresos $${Math.round(r.actual.revenue)}`);
      else parts.push('sin datos reales disponibles (sin campaña real vinculada con confianza suficiente)');
      return parts.join(' — ');
    }).join('\n');
    const anyRealData = rowsWithActuals.some(r => r.actual);

    // Campañas del Plan Master que NO están en el plan de este mes — candidatas
    // a sumar (nunca se agregan solas, es una sugerencia que la IA puede tomar
    // o no, y el operador siempre revisa antes de confirmar).
    const currentCodes = new Set(rowsWithActuals.map(r => r.plan_code).filter(Boolean));
    const masterOnly = (masterRows || []).filter(m => !currentCodes.has(m.plan_code));
    const masterText = masterOnly.length
      ? `\nCampañas que existen en el Plan Master del cliente pero NO están activas en el plan de este mes (candidatas a sumar si tiene sentido, nunca obligatorio):\n${masterOnly.map(m => `- "${m.campaign_name}" (plan_code ${m.plan_code}, ${m.channel}, objetivo ${m.objective}, budget diario de referencia $${m.budget_diario_default || 'N/D'})`).join('\n')}\n`
      : '';

    // KPI y Objetivos del mes en curso (si existe) — para que la propuesta
    // también sepa si se está cumpliendo lo que el operador definió como
    // objetivo, no solo la tendencia campaña por campaña.
    let kpiText = '';
    try {
      const { data: kpiRow } = await supabase.from('kpi_targets_monthly').select('targets').eq('client_id', clientDB.id).eq('period', currentPeriod).limit(1);
      if (kpiRow?.[0]?.targets && Object.keys(kpiRow[0].targets).length) {
        const kpiActuals = await computeMonthlyKpiActuals(slug, clientDB.id, currentPeriod);
        const t = kpiRow[0].targets;
        const lines = [];
        if (t.target_roas_meta != null) lines.push(`ROAS Meta — objetivo: ${t.target_roas_meta}x, real: ${kpiActuals.meta?.roas ?? 'N/D'}x`);
        if (t.target_roas_google != null) lines.push(`ROAS Google — objetivo: ${t.target_roas_google}x, real: ${kpiActuals.google?.roas ?? 'N/D'}x`);
        if (t.target_roas_ecom != null) lines.push(`ROAS combinado eCommerce — objetivo: ${t.target_roas_ecom}x, real: ${kpiActuals.ecommerce?.roas ?? 'N/D'}x`);
        if (t.target_cpa_purchases_meta != null) lines.push(`Costo por compra Meta — objetivo: $${t.target_cpa_purchases_meta}, real: $${kpiActuals.meta?.cpa ?? 'N/D'}`);
        if (t.target_cpa_purchases_google != null) lines.push(`Costo por compra Google — objetivo: $${t.target_cpa_purchases_google}, real: $${kpiActuals.google?.cpa ?? 'N/D'}`);
        if (lines.length) kpiText = `\nKPI y Objetivos definidos por el operador para ${currentPeriod}:\n${lines.join('\n')}\n`;
      }
    } catch (e) { console.warn('[plan] KPI del mes para propuesta omitido:', e.message); }

    let nextMonthDate;
    if (target_period && /^\d{4}-\d{2}$/.test(target_period)) {
      const [y, m] = target_period.split('-').map(Number);
      nextMonthDate = new Date(Date.UTC(y, m - 1, 1));
    } else {
      nextMonthDate = new Date(); nextMonthDate.setUTCMonth(nextMonthDate.getUTCMonth() + 1);
    }
    const nextPeriod = `${nextMonthDate.getUTCFullYear()}-${String(nextMonthDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const nextMonthLabel = periodToLabel(nextPeriod);
    const nextMonthStart = `${nextPeriod}-01`;
    const nextMonthEnd = new Date(Date.UTC(nextMonthDate.getUTCFullYear(), nextMonthDate.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

    // La IA NUNCA calcula Budget Mensual — solo propone un % de cambio sobre
    // el Budget Diario actual (o, para campañas nuevas del Master, el
    // budget_diario_default tal cual). El backend hace la matemática después:
    // Budget Diario nuevo → Días Calculados del mes destino → Budget Mensual.
    const prompt = `Sos un estratega de Paid Media de la agencia Docta Nexus. Tenés el plan de campañas actual de "${client.name}" y cómo viene rindiendo cada una este mes (datos reales, no inventes números nuevos). Tu trabajo es proponer el plan de ${nextMonthLabel} — NO es copiar el plan actual tal cual: para cada campaña con datos reales, decidí explícitamente si sube, baja, se pausa o sigue igual, expresando el ajuste como PORCENTAJE de cambio sobre el Budget Diario actual (nunca como un monto mensual directo — eso lo calcula el sistema después). Si falta algo evidente, podés sugerir sumar una de las campañas del Master que no están activas este mes (ver lista abajo), o una campaña nueva de tipo similar a las que ya existen — nunca inventes plataformas o audiencias que no tengan sentido con el resto del plan.
${!anyRealData ? '\nIMPORTANTE: ninguna campaña del plan tiene datos reales disponibles este mes — en ese caso, no tenés base numérica para ajustar presupuestos, así que proponé budget_diario_change_pct: 0 para todas y dejalo explícito en las notas ("sin datos reales para ajustar este mes, se mantiene el plan"). No inventes un ajuste que no podés justificar.\n' : ''}
Plan actual y su desempeño real de este mes:
${planText}
${masterText}${kpiText}
Respondé SOLO en JSON, un array de campañas propuestas para ${nextMonthLabel}. "budget_diario_change_pct" es el cambio porcentual sobre el Budget Diario actual de esa campaña (0 = sin cambio, 15 = subir 15%, -20 = bajar 20%); para una campaña nueva del Master o totalmente nueva, poné el Budget Diario que corresponda directo en "budget_diario_new" en vez de un porcentaje:
[{"campaign_name":"...","plan_code":"...","channel":"meta|google_ads","objective":"...","budget_diario_change_pct":0,"budget_diario_new":null,"active_days_pattern":"todos|lunes_viernes|lunes_sabado|sabado_domingo","kpi_1":"...","kpi_2":"","kpi_3":"","notas":"motivo del ajuste, 1-2 oraciones, basado en el dato real de arriba"}]`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
      body: JSON.stringify({ model: 'gpt-4o', max_tokens: 2500, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error('Agente de Plan de Campañas (OpenAI): ' + (d.error?.message || r.status));
    logAiCall({ slug, model: 'gpt-4o', callType: 'campaign_plan_openai', inputTokens: d.usage?.prompt_tokens || 0, outputTokens: d.usage?.completion_tokens || 0 }).catch(() => {});
    const proposed = JSON.parse((d.choices?.[0]?.message?.content || '[]').replace(/```json|```/g, '').trim());
    const proposedItems = proposed.map(p => {
      // Matemática SIEMPRE del backend: si la IA mandó un % de cambio, se
      // aplica sobre el Budget Diario actual de esa campaña (por plan_code o
      // nombre); si es una campaña nueva, se usa budget_diario_new tal cual.
      const baseline = rowsWithActuals.find(r => (p.plan_code && r.plan_code === p.plan_code) || r.campaign_name === p.campaign_name)
        || masterOnly.find(m => (p.plan_code && m.plan_code === p.plan_code) || m.campaign_name === p.campaign_name);
      const baseBudgetDiario = baseline?.budget_diario ?? baseline?.budget_diario_default ?? 0;
      let budget_diario;
      if (p.budget_diario_new != null && p.budget_diario_new !== '') {
        budget_diario = Number(p.budget_diario_new);
      } else {
        const pct = Number(p.budget_diario_change_pct) || 0;
        budget_diario = +(baseBudgetDiario * (1 + pct / 100)).toFixed(0);
      }
      const active_days_pattern = p.active_days_pattern || baseline?.active_days_pattern || baseline?.active_days_pattern_default || 'todos';
      const calculated_days = calculateActiveDays(nextMonthStart, nextMonthEnd, active_days_pattern);
      return {
        campaign_name: p.campaign_name || '(sin nombre)', plan_code: p.plan_code || baseline?.plan_code || '',
        channel: p.channel || baseline?.channel || '', start_date: nextMonthStart, end_date: nextMonthEnd,
        active_days_pattern, calculated_days, dias: calculated_days,
        objective: p.objective || baseline?.objective || '',
        budget_diario, budget_mensual: +(budget_diario * calculated_days).toFixed(0),
        kpi_1: p.kpi_1 || baseline?.kpi_1 || '', kpi_2: p.kpi_2 || baseline?.kpi_2 || '', kpi_3: p.kpi_3 || baseline?.kpi_3 || '',
        notas: p.notas || '', status: 'Proposed',
      };
    });
    res.json({ next_period: nextPeriod, next_month_label: nextMonthLabel, items: proposedItems, any_real_data: anyRealData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Confirmado por el operador: recién ACÁ se crea el período nuevo en
// Supabase con las campañas previsualizadas (pueden venir editadas
// respecto a lo que propuso la IA — el operador tiene la última palabra).
// Cada campaña pasa por el matching automático al persistirse.
app.post('/api/:slug/campaign-plans/confirm', async (req, res) => {
  const slug = req.params.slug;
  const { password, period, items } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Falta period en formato YYYY-MM' });
  if (!items?.length) return res.status(400).json({ error: 'Falta items' });
  try {
    const { data: plan, error: planError } = await supabase.from('campaign_plan_periods')
      .upsert({ client_id: clientDB.id, period, status: 'PROPOSED' }, { onConflict: 'client_id,period' })
      .select().single();
    if (planError) throw new Error(planError.message);

    const itemsWithMatch = await Promise.all(items.map(async it => {
      const match = await matchCampaignByName(slug, it.channel, it.campaign_name);
      const computed = computeItemBudgetFields(it);
      return {
        plan_period_id: plan.id, campaign_name: it.campaign_name, channel: it.channel || null,
        campaign_id: match.campaign_id, match_confidence: match.campaign_id ? match.match_confidence : 'sin_match',
        plan_code: it.plan_code || null, active_days_pattern: it.active_days_pattern || null,
        objective: it.objective || null, campaign_objective: it.campaign_objective || null, budget_diario: it.budget_diario || null,
        dias: computed.dias ?? it.dias ?? null, calculated_days: computed.calculated_days ?? null,
        budget_mensual: computed.budget_mensual ?? it.budget_mensual ?? null,
        kpi_1: it.kpi_1 || null, kpi_2: it.kpi_2 || null, kpi_3: it.kpi_3 || null,
        kpi_1_target: it.kpi_1_target ?? null, kpi_2_target: it.kpi_2_target ?? null, kpi_3_target: it.kpi_3_target ?? null,
        notas: it.notas || null, restricciones: it.restricciones || null, start_date: it.start_date || null, end_date: it.end_date || null, status: it.status || 'Proposed',
      };
    }));
    const { error: itemsError } = await supabase.from('campaign_plan_items').insert(itemsWithMatch);
    if (itemsError) throw new Error(itemsError.message);
    res.json({ ok: true, plan });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Exportar el plan de un período a una pestaña nueva del Sheet del cliente
// — dirección única Supabase → Sheet, para que el cliente lo vea en un
// formato conocido si lo pide. Nunca se lee de vuelta desde acá.
app.post('/api/:slug/campaign-plans/period/:periodId/export-to-sheet', async (req, res) => {
  const slug = req.params.slug;
  const { password } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const sheetId = await getSheetsId(slug);
  if (!sheetId) return res.status(400).json({ error: 'Este cliente todavía no tiene una planilla configurada en /admin.' });
  try {
    const { data: plan } = await supabase.from('campaign_plan_periods').select('*').eq('id', req.params.periodId).single();
    if (!plan) return res.status(404).json({ error: 'Período no encontrado' });
    const { data: items } = await supabase.from('campaign_plan_items').select('*').eq('plan_period_id', plan.id);
    const tabName = periodToLabel(plan.period);
    await exportPlanToSheet(sheetId, tabName, items || []);
    await supabase.from('campaign_plan_periods').update({ sheet_tab_name: tabName }).eq('id', plan.id);
    res.json({ ok: true, tab_name: tabName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// ── STORYTELLING DEL PLAN — informe público, prospectivo, sin IA en
// el sentido de cálculos críticos (eso ya lo hizo el motor de Supabase),
// solo la narrativa de composición. Mismo patrón token+código+vencimiento
// que el Informe/Informe Frío. SIN pacing ni semáforo — eso es 100%
// interno del dashboard Operador, nunca se muestra al cliente así.
// ══════════════════════════════════════════════════════════════════
app.post('/api/:slug/campaign-plans/period/:periodId/story/generate', async (req, res) => {
  const slug = req.params.slug;
  const { password } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const client = await loadClient(slug);
  const clientDB = await loadClientDB(slug);
  if (!client || !clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  try {
    const { data: plan } = await supabase.from('campaign_plan_periods').select('*').eq('id', req.params.periodId).single();
    if (!plan) return res.status(404).json({ error: 'Período no encontrado' });
    const { data: items } = await supabase.from('campaign_plan_items').select('*').eq('plan_period_id', plan.id).order('created_at', { ascending: true });
    if (!items?.length) return res.status(400).json({ error: 'Este período no tiene campañas cargadas todavía.' });

    // Contexto liviano del mes recién cerrado (el inmediato anterior al de
    // este plan) — agregado total, sin ir a buscar histórico largo.
    const [py, pm] = plan.period.split('-').map(Number);
    const prevDate = new Date(Date.UTC(py, pm - 2, 1));
    const prevPeriod = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, '0')}`;
    let prevContext = null;
    try {
      const { data: prevPlanRow } = await supabase.from('campaign_plan_periods').select('*').eq('client_id', clientDB.id).eq('period', prevPeriod).limit(1);
      if (prevPlanRow?.length) {
        const { data: prevItems } = await supabase.from('campaign_plan_items').select('*').eq('plan_period_id', prevPlanRow[0].id);
        const prevMonthStart = `${prevPeriod}-01`;
        const prevMonthEnd = new Date(Date.UTC(prevDate.getUTCFullYear(), prevDate.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
        let totalSpend = 0, totalConversions = 0, totalRevenue = 0, withData = 0;
        for (const it of (prevItems || [])) {
          if (!it.campaign_id || !it.channel) continue;
          const actual = await fetchCampaignActuals(slug, it.channel, it.campaign_id, prevMonthStart, prevMonthEnd);
          if (actual) { totalSpend += actual.spend; totalConversions += actual.conversions; totalRevenue += actual.revenue; withData++; }
        }
        if (withData > 0) prevContext = { period_label: periodToLabel(prevPeriod), spend: totalSpend, conversions: totalConversions, revenue: totalRevenue, campaigns_with_data: withData };
      }
    } catch (e) { console.warn('[plan-story] contexto del mes anterior omitido:', e.message); }

    // Composición del plan — agrupado por Objective y por Channel.
    const byObjective = {};
    items.forEach(it => { const k = it.objective || 'Sin objetivo definido'; byObjective[k] = (byObjective[k] || 0) + 1; });
    const metaSpend = items.filter(it => it.channel === 'meta').reduce((s, it) => s + (Number(it.budget_mensual) || 0), 0);
    const googleSpend = items.filter(it => it.channel === 'google_ads').reduce((s, it) => s + (Number(it.budget_mensual) || 0), 0);
    const totalBudget = items.reduce((s, it) => s + (Number(it.budget_mensual) || 0), 0);

    const itemsText = items.map((it, i) => `${i + 1}. "${it.campaign_name}" — ${it.channel || 'canal N/D'}, objetivo: ${it.objective || 'N/D'}, presupuesto mensual: $${it.budget_mensual || 0}${it.notas ? `, notas del operador: "${it.notas}"` : ''}${[it.kpi_1, it.kpi_2, it.kpi_3].filter(Boolean).length ? `, KPIs: ${[it.kpi_1, it.kpi_2, it.kpi_3].filter(Boolean).join(', ')}` : ''}`).join('\n');
    const prevText = prevContext
      ? `\nContexto del mes recién cerrado (${prevContext.period_label}, ${prevContext.campaigns_with_data} campañas con datos reales): inversión $${Math.round(prevContext.spend)}, ${Math.round(prevContext.conversions)} conversiones, ingresos $${Math.round(prevContext.revenue)}.\n`
      : '';

    const prompt = `Sos un estratega de Paid Media de la agencia Docta Nexus, escribiendo la presentación del plan de ${periodToLabel(plan.period)} para el cliente "${client.name}". Es un texto PROSPECTIVO (contás lo que se va a hacer y por qué), nunca un reporte de resultados — no inventes números de resultado que no estén en el contexto de abajo, y NO menciones nada de pacing, semáforos ni cumplimiento de presupuesto en curso.

Campañas planificadas para ${periodToLabel(plan.period)}:
${itemsText}
${prevText}
Respondé SOLO en JSON:
{"headline":"1 oración editorial resumiendo el plan del período","dek":"2-3 oraciones ampliando el headline","composition_narrative":"3-5 oraciones contando la MEZCLA de campañas de este plan y por qué — ej. 'planificamos X campañas de conversión (Y en Meta, Z en Google) enfocadas en escalar lo que mejor funciona, y sumamos una de alcance para sostener marca' — basate en los objetivos/notas reales de arriba, no inventes motivos que no estén ahí","campaign_blurbs":[{"campaign_name":"...","blurb":"1-2 oraciones sobre esta campaña puntual, basadas en su objetivo/notas/KPI reales"}]}`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
      body: JSON.stringify({ model: 'gpt-4o', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error('Agente de storytelling del plan (OpenAI): ' + (d.error?.message || r.status));
    logAiCall({ slug, model: 'gpt-4o', callType: 'campaign_plan_story', inputTokens: d.usage?.prompt_tokens || 0, outputTokens: d.usage?.completion_tokens || 0 }).catch(() => {});
    const agent = JSON.parse((d.choices?.[0]?.message?.content || '{}').replace(/```json|```/g, '').trim());

    const reportData = {
      period_label: periodToLabel(plan.period), total_budget: totalBudget,
      business_objective: plan.business_objective, primary_kpi: plan.primary_kpi, target_value: plan.target_value,
      channel_split: { meta: metaSpend, google_ads: googleSpend },
      objective_split: byObjective,
      items: items.map(it => ({ campaign_name: it.campaign_name, channel: it.channel, objective: it.objective, budget_mensual: it.budget_mensual, kpi_1: it.kpi_1, kpi_2: it.kpi_2, kpi_3: it.kpi_3 })),
      headline: agent.headline || '', dek: agent.dek || '', composition_narrative: agent.composition_narrative || '',
      campaign_blurbs: agent.campaign_blurbs || [],
      prev_context: prevContext,
      data_retrieved_at: new Date().toISOString(),
    };

    const token = crypto.randomBytes(8).toString('hex');
    const accessCode = String(crypto.randomInt(100000, 999999));
    const expiresAt = new Date(); expiresAt.setUTCDate(expiresAt.getUTCDate() + 7);
    const { data: row, error } = await supabase.from('campaign_plan_stories').insert({
      client_id: clientDB.id, plan_period_id: plan.id, token, access_code: accessCode,
      report_data: reportData, expires_at: expiresAt.toISOString(),
    }).select().single();
    if (error) throw new Error(error.message);
    res.json({ token: row.token, access_code: row.access_code, url: `/ps/${row.token}`, expires_at: row.expires_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/ps/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'plan-story.html')));

app.get('/api/plan-story/:token/meta', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('campaign_plan_stories')
      .select('token, expires_at, report_data, client_id, clients(name, website_url)')
      .eq('token', req.params.token).limit(1);
    if (error || !data || !data.length) return res.status(404).json({ error: 'No encontrado' });
    const row = data[0];
    const expired = new Date(row.expires_at) < new Date();
    res.json({
      expired, expires_at: row.expires_at, period_label: row.report_data?.period_label,
      business_name: row.clients?.name || '', business_url: row.clients?.website_url || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/plan-story/:token/unlock', async (req, res) => {
  const { code } = req.body;
  try {
    const { data, error } = await supabase
      .from('campaign_plan_stories')
      .select('*, clients(name, website_url, color_primary)')
      .eq('token', req.params.token).limit(1);
    if (error || !data || !data.length) return res.status(404).json({ error: 'No encontrado' });
    const row = data[0];
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Este link ya venció' });
    if (String(code).trim() !== row.access_code) return res.status(401).json({ error: 'Código incorrecto' });
    supabase.from('campaign_plan_stories').update({ view_count: (row.view_count || 0) + 1, last_viewed_at: new Date().toISOString() }).eq('token', row.token).then(() => {});
    res.json({
      ...row.report_data,
      business_name: row.clients?.name || '', business_url: row.clients?.website_url || null,
      color_primary: row.clients?.color_primary || null, expires_at: row.expires_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/report/:token/meta', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('client_reports')
      .select('token, expires_at, period_label, client_id, report_data, clients(name, website_url, client_rubro)')
      .eq('token', req.params.token).limit(1);
    if (error || !data || !data.length) return res.status(404).json({ error: 'Informe no encontrado' });
    const row = data[0];
    const expired = new Date(row.expires_at) < new Date();
    res.json({
      expired, expires_at: row.expires_at, period_label: row.period_label,
      business_name: row.report_data?.business_name_override || row.clients?.name || '', business_url: row.clients?.website_url || null,
      recipient_name: row.report_data?.recipient_name || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Endpoint público: desbloquear el informe con el código de acceso ──
app.post('/api/report/:token/unlock', async (req, res) => {
  const { code } = req.body;
  try {
    const { data, error } = await supabase
      .from('client_reports')
      .select('*, clients(name, website_url, client_rubro)')
      .eq('token', req.params.token).limit(1);
    if (error || !data || !data.length) return res.status(404).json({ error: 'Informe no encontrado' });
    const row = data[0];
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Este informe ya venció' });
    if (String(code).trim() !== row.access_code) return res.status(401).json({ error: 'Código incorrecto' });

    supabase.from('client_reports').update({ view_count: (row.view_count || 0) + 1, last_viewed_at: new Date().toISOString() }).eq('token', row.token).then(() => {});

    res.json({
      ...row.report_data,
      business_name: row.report_data?.business_name_override || row.clients?.name || '', business_url: row.clients?.website_url || null,
      business_rubro: row.clients?.client_rubro || null, expires_at: row.expires_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sirve la página pública del informe en /r/:token (antes del catch-all)
app.get('/r/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'report.html')));

// Nota: se eliminó /api/:slug/intelligence/analyze-meta — no lo llamaba
// ningún botón del frontend (Meta Ads usa su propio pipeline runAgentAnalysis,
// no runIntelligenceAnalysis). Era código muerto que dependía de la
// comparativa WoW/YoY, también eliminada.

// ── Endpoint: análisis IA solapa Google Ads ──
app.post('/api/:slug/intelligence/analyze-google', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, period, iso_year, iso_week } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  if (!ANTHROPIC_KEY || !OPENAI_KEY) return res.status(500).json({ error: 'Faltan API keys de IA configuradas' });

  const customerId = await getGoogleAdsAccountId(slug);
  if (!customerId) return res.status(400).json({ error: 'Este cliente no tiene una cuenta de Google Ads asociada' });

  try {
    const { since, until } = computeDateRangeForPeriod(period || '7d', iso_year, iso_week);
    const raw = await fetchCampaignMetricsRange(customerId, since, until);
    const current = aggregateCampaignRows(raw);
    const periodLabel = periodLabelForPrompt(period || '7d', iso_year, iso_week);
    const contextText = summarizeChannelMetricsForPrompt('Google Ads', periodLabel, current, clientDB.kpi_targets || {});

    const result = await runExpertAnalysis('google_ads', contextText, slug);
    await supabase.from('ai_insights').insert({
      client_id: clientDB.id, period_type: period || '7d',
      iso_year: period === 'week' ? Number(iso_year) : null, iso_week: period === 'week' ? Number(iso_week) : null,
      module: 'google_ads', insight_type: 'diagnosis', source_model: 'synthesis',
      content: result, priority: result.synthesis?.prioridad || null,
    });
    res.json({ context: contextText, ...result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Endpoint: análisis IA solapa eCommerce ──
app.post('/api/:slug/intelligence/analyze-ecommerce', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, year, month } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  if (!ANTHROPIC_KEY || !OPENAI_KEY) return res.status(500).json({ error: 'Faltan API keys de IA configuradas' });

  try {
    const { data: row } = await supabase
      .from('business_metrics_monthly').select('*')
      .eq('client_id', clientDB.id).eq('year', year).eq('month', month).maybeSingle();
    const contextText = summarizeEcommerceForPrompt(row);

    const result = await runExpertAnalysis('ecommerce', contextText, slug);
    await supabase.from('ai_insights').insert({
      client_id: clientDB.id, period_type: 'month', year: Number(year), month: Number(month),
      module: 'ecommerce', insight_type: 'diagnosis', source_model: 'synthesis',
      content: result, priority: result.synthesis?.prioridad || null,
    });
    res.json({ context: contextText, ...result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Endpoint: análisis IA solapa Transversal (todo junto) ──
// ── Endpoint: análisis IA de las métricas de tráfico/comportamiento (Analytics) ──
app.post('/api/:slug/intelligence/analyze-ga4-metrics', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, period, iso_year, iso_week } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  if (!ANTHROPIC_KEY || !OPENAI_KEY) return res.status(500).json({ error: 'Faltan API keys de IA configuradas' });

  try {
    const propertyId = await getGA4PropertyId(slug);
    if (!propertyId) return res.status(400).json({ error: 'Este cliente no tiene una propiedad de Google Analytics asociada.' });

    const { since, until } = computeDateRangeForPeriod(period || '7d', iso_year, iso_week);

    const site = await fetchGA4SiteMetricsForRange(propertyId, since, until);
    const [topPages, topItems] = await Promise.all([
      fetchGA4TopPages(propertyId, since, until, 5),
      fetchGA4TopItems(propertyId, since, until, 5),
    ]);
    const contextText = summarizeGA4MetricsForPrompt(site, topPages, topItems);

    const result = await runExpertAnalysis('ga4_metrics', contextText, slug);
    await supabase.from('ai_insights').insert({
      client_id: clientDB.id, period_type: period || '7d',
      iso_year: period === 'week' ? Number(iso_year) : null, iso_week: period === 'week' ? Number(iso_week) : null,
      module: 'ga4_metrics', insight_type: 'diagnosis', source_model: 'synthesis',
      content: result, priority: result.synthesis?.prioridad || null,
    });
    res.json({ context: contextText, ...result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Endpoint: análisis IA del funnel de eCommerce (Analytics) ──
app.post('/api/:slug/intelligence/analyze-ga4-funnel', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, period, iso_year, iso_week } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  if (!ANTHROPIC_KEY || !OPENAI_KEY) return res.status(500).json({ error: 'Faltan API keys de IA configuradas' });

  try {
    const propertyId = await getGA4PropertyId(slug);
    if (!propertyId) return res.status(400).json({ error: 'Este cliente no tiene una propiedad de Google Analytics asociada.' });

    const { since, until } = computeDateRangeForPeriod(period || '7d', iso_year, iso_week);

    const counts = await fetchGA4FunnelCounts(propertyId, since, until);
    const steps = buildGA4FunnelSteps(counts);
    const contextText = summarizeGA4FunnelForPrompt(steps);

    const result = await runExpertAnalysis('ga4_funnel', contextText, slug);
    await supabase.from('ai_insights').insert({
      client_id: clientDB.id, period_type: period || '7d',
      iso_year: period === 'week' ? Number(iso_year) : null, iso_week: period === 'week' ? Number(iso_week) : null,
      module: 'ga4_funnel', insight_type: 'diagnosis', source_model: 'synthesis',
      content: result, priority: result.synthesis?.prioridad || null,
    });
    res.json({ context: contextText, steps, ...result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/:slug/intelligence/analyze-transversal', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, iso_year, iso_week, year, month } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  if (!ANTHROPIC_KEY || !OPENAI_KEY) return res.status(500).json({ error: 'Faltan API keys de IA configuradas' });

  try {
    const isoYear = Number(iso_year), isoWeek = Number(iso_week);
    const targets = clientDB.kpi_targets || {};
    const periodLabel = `semana ${isoWeek}`;

    // Meta Ads — en vivo (Graph API), misma semana que el resto del panel
    let metaCurrent = null;
    const metaCreds = await getMetaCredentials(slug);
    if (metaCreds) {
      const metaData = await fetchMetricsByPeriod(
        { access_token: metaCreds.access_token, ad_account_id: metaCreds.ad_account_id },
        'week', isoYear, isoWeek
      );
      metaCurrent = metaData.account;
    }

    // Google Ads — en vivo (Google Ads API), misma semana
    let googleCurrent = null;
    const customerId = await getGoogleAdsAccountId(slug);
    if (customerId) {
      const { since, until } = computeDateRangeForPeriod('week', isoYear, isoWeek);
      const raw = await fetchCampaignMetricsRange(customerId, since, until);
      googleCurrent = aggregateCampaignRows(raw);
    }

    const { data: bizRow } = await supabase
      .from('business_metrics_monthly').select('*')
      .eq('client_id', clientDB.id).eq('year', year).eq('month', month).maybeSingle();

    const contextText = [
      summarizeChannelMetricsForPrompt('Meta Ads', periodLabel, metaCurrent, targets),
      summarizeChannelMetricsForPrompt('Google Ads', periodLabel, googleCurrent, targets),
      summarizeEcommerceForPrompt(bizRow),
    ].join('\n');

    const result = await runExpertAnalysis('transversal', contextText, slug);
    await supabase.from('ai_insights').insert({
      client_id: clientDB.id, period_type: 'week', iso_year: isoYear, iso_week: isoWeek,
      module: 'home', insight_type: 'diagnosis', source_model: 'synthesis',
      content: result, priority: result.synthesis?.prioridad || null,
    });
    res.json({ context: contextText, ...result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Nota: se eliminaron /api/:slug/intelligence/halo-signals y
// /api/:slug/intelligence/weekly-correlation a pedido del usuario — no
// quiere análisis de comparación WoW/YoY ni señales de halo entre canales.
// Ver también aggregateAdMetricsForWeek, buildSourceComparison,
// getWeeklySeries y detectLaggedSignal, eliminadas por quedar sin uso.

// Nota: se eliminó /api/:slug/metrics-by-week — Google Ads ahora resuelve
// period=week en vivo dentro de /google-ads/metrics (computeDateRangeForPeriod
// ya soporta 'week'), igual que Meta Ads. Ver aggregateAdMetricsForWeek más
// abajo, que también se eliminó por quedar sin llamadores.

app.get('/api/:slug/business-monthly/history', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, months } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });

  const { data, error } = await supabase
    .from('business_metrics_monthly')
    .select('*')
    .eq('client_id', clientDB.id)
    .order('year', { ascending: false })
    .order('month', { ascending: false })
    .limit(Number(months) || 12);
  if (error) return res.status(500).json({ error: error.message });

  // Cálculos derivados — no se guardan, se devuelven ya resueltos
  // (métricas primero: esto sigue siendo dato, no análisis)
  const history = data.map(row => {
    const inversionTotal = Number(row.inversion_meta_manual ?? row.inversion_meta_auto ?? 0)
                          + Number(row.inversion_google_manual ?? row.inversion_google_auto ?? 0);
    const ticketPromedio = row.pedidos ? +(row.facturacion / row.pedidos).toFixed(2) : null;
    const cacReal = row.clientes_nuevos ? +(inversionTotal / row.clientes_nuevos).toFixed(2) : null;
    return { ...row, ticket_promedio: ticketPromedio, cac_real: cacReal, inversion_total: inversionTotal };
  });

  res.json({ history });
});

// Fase 1 — Google Ads: traer y guardar métricas de campaña (solo métricas,
// sin análisis — el análisis es un paso posterior y separado).
// Se usa el día de AYER (no hoy): a diferencia de Meta, los datos de
// Google Ads del día en curso suelen llegar incompletos/con demora.
app.post('/api/:slug/google-ads/refresh-metrics', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });

  const customerId = await getGoogleAdsAccountId(slug);
  if (!customerId) return res.status(400).json({ error: 'Este cliente no tiene una cuenta de Google Ads asociada' });

  try {
    const dateStr = yesterday();
    const raw = await fetchCampaignMetrics(customerId, dateStr);
    const rows = normalizeToAdMetricsRows(clientDB.id, dateStr, raw);

    if (rows.length > 0) {
      const { error } = await supabase
        .from('ad_metrics_daily')
        .upsert(rows, { onConflict: 'client_id,source,date,campaign_id' });
      if (error) throw new Error('Error guardando en Supabase: ' + error.message);
    }

    res.json({ date: dateStr, campaigns: rows.length, metrics: rows });
  } catch(e) {
    console.error(`[google-ads] Error en ${slug}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Fase 1 — Google Ads: leer historial ya guardado (sin llamar a la API de Google)
app.get('/api/:slug/google-ads/history', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, days } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });

  const { data, error } = await supabase
    .from('ad_metrics_daily')
    .select('*')
    .eq('client_id', clientDB.id)
    .eq('source', 'google_ads')
    .order('date', { ascending: false })
    .limit(Number(days) || 30);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ history: data });
});

// Métricas de Google Ads por período (Ayer/7d/14d/Mes) — mismo criterio de
// fechas que /api/:slug/metrics usa para Meta, pero leyendo de Supabase
// (ad_metrics_daily) en vez de pegarle en vivo a la API de Google Ads.
// Métricas de Google Ads por período (Ayer/7d/14d/Mes/Semana N) — EN VIVO
// contra la API de Google Ads, sin depender de lo guardado por el cron en
// Supabase (que sigue existiendo solo como histórico de referencia).
app.get('/api/:slug/google-ads/metrics', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, period, iso_year, iso_week } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });

  const customerId = await getGoogleAdsAccountId(slug);
  if (!customerId) return res.status(400).json({ error: 'Este cliente no tiene una cuenta de Google Ads asociada' });

  try {
    const { since, until } = computeDateRangeForPeriod(period || '7d', iso_year, iso_week);
    const raw = await fetchCampaignMetricsRange(customerId, since, until);
    const data = aggregateCampaignRows(raw);
    res.json({ period: period || '7d', since, until, data, currency: clientDB.currency || 'ARS' });
  } catch(e) {
    console.error(`[google-ads/metrics] Error en ${slug}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Tarea 3 (fase 1) — Productos de Shopping/PMax con más impresiones/clics para
// el período seleccionado. A diferencia de /google-ads/metrics, esto le pega
// EN VIVO a la API de Google Ads (shopping_performance_view no se guarda en
// Supabase) — mismo criterio que fetchGA4TopPages/TopItems para Analytics.
// El "diagnóstico" es una señal indirecta (impresiones/clics en cero), no el
// estado real de Merchant Center — eso queda para una fase 2 aparte.
app.get('/api/:slug/google-ads/products', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, period, iso_year, iso_week } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });

  const customerId = await getGoogleAdsAccountId(slug);
  if (!customerId) return res.status(400).json({ error: 'Este cliente no tiene una cuenta de Google Ads asociada' });

  try {
    const { since, until } = computeDateRangeForPeriod(period || '7d', iso_year, iso_week);
    const products = await fetchShoppingProducts(customerId, since, until);
    res.json({ period: period || '7d', since, until, products, currency: clientDB.currency || 'ARS' });
  } catch(e) {
    console.error(`[google-ads/products] Error en ${slug}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Guardar KPI targets
app.post('/api/:slug/save-kpis', async (req, res) => {
  const slug = req.params.slug;
  const client = await loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, kpis } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const clientDB = await loadClientDB(slug);
  if (clientDB) {
    const update = { kpi_targets: kpis };
    if (kpis.currency) update.currency = kpis.currency;
    await supabase.from('clients').update(update).eq('id', clientDB.id);
  }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════
// ── KPI Y OBJETIVOS POR MES ── cada mes queda guardado por separado
// (tabla kpi_targets_monthly), con objetivo + resultado real EN VIVO
// comparados uno al lado del otro.
// ═══════════════════════════════════════════════════════════════

// Listar los meses ya generados para un cliente (para las sub-pestañas)
app.get('/api/:slug/kpi-months', async (req, res) => {
  const slug = req.params.slug;
  const { password } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { data, error } = await supabase.from('kpi_targets_monthly').select('period').eq('client_id', clientDB.id).order('period', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ periods: (data || []).map(r => r.period) });
});

// Traer un mes puntual: objetivos guardados + resultados reales en vivo
app.get('/api/:slug/kpi-months/:period', async (req, res) => {
  const slug = req.params.slug;
  const { password } = req.query;
  const { period } = req.params;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Período inválido, formato YYYY-MM' });
  try {
    const { data } = await supabase.from('kpi_targets_monthly').select('*').eq('client_id', clientDB.id).eq('period', period).limit(1);
    const row = data?.[0] || null;
    const actuals = await computeMonthlyKpiActuals(slug, clientDB.id, period);
    res.json({
      period,
      client_profile: row?.client_profile || '', custom_conversions: row?.custom_conversions || '',
      excluded_metrics: row?.excluded_metrics || '', strategic_context: row?.strategic_context || '',
      targets: row?.targets || {}, actuals,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Crear/guardar un mes (targets + las 4 secciones que "quedan igual")
app.post('/api/:slug/kpi-months/:period', async (req, res) => {
  const slug = req.params.slug;
  const { period } = req.params;
  const { password, client_profile, custom_conversions, excluded_metrics, strategic_context, targets } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Período inválido, formato YYYY-MM' });
  try {
    const { error } = await supabase.from('kpi_targets_monthly').upsert(
      { client_id: clientDB.id, period, client_profile: client_profile || null, custom_conversions: custom_conversions || null, excluded_metrics: excluded_metrics || null, strategic_context: strategic_context || null, targets: targets || {}, updated_at: new Date().toISOString() },
      { onConflict: 'client_id,period' }
    );
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Guardar configuración del dashboard (métricas visibles)
app.post('/api/:slug/save-dashboard-config', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, dashConfig } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  await supabase.from('clients').update({ dash_config: dashConfig }).eq('id', clientDB.id);
  res.json({ ok: true });
});

// ── FETCH MÉTRICAS POR PERÍODO (unificado, misma lógica que fetchAccountMetrics) ──
async function fetchMetricsByPeriod(client, period, isoYear, isoWeek) {
  const token     = client.access_token;
  const accountId = client.ad_account_id;

  const fieldsBase = 'spend,impressions,clicks,ctr,cpm,reach,frequency,actions,action_values,unique_clicks,unique_ctr';
  const videoExtra = ',video_10_sec_watched_actions,video_15_sec_watched_actions,video_30_sec_watched_actions,video_avg_time_watched_actions';

  const today    = new Date();
  const fmt      = d => d.toISOString().split('T')[0];
  const daysAgo  = n => { const d = new Date(today); d.setUTCDate(today.getUTCDate()-n); return d; };

  let since, until;
  if (period === 'yesterday') {
    since = until = fmt(daysAgo(1));
  } else if (period === '14d') {
    since = fmt(daysAgo(14)); until = fmt(daysAgo(1));
  } else if (period === 'month') {
    since = fmt(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
    until = fmt(daysAgo(1));
  } else if (period === 'month_prev') {
    const y = today.getUTCFullYear(), m = today.getUTCMonth();
    since = fmt(new Date(Date.UTC(y, m - 1, 1)));
    until = fmt(new Date(Date.UTC(y, m, 0)));
  } else if (period === 'week') {
    // Punto 4 del roadmap post-Fase 5: filtro "Semana N" unificado con Google Ads.
    // Mismo lunes-a-domingo que usa el resto del sistema (isoWeekThursdayDate).
    if (!isoYear || !isoWeek) throw new Error('Falta iso_year o iso_week para period=week');
    const thursday = isoWeekThursdayDate(Number(isoYear), Number(isoWeek));
    const monday = new Date(thursday); monday.setUTCDate(thursday.getUTCDate() - 3);
    const sunday = new Date(thursday); sunday.setUTCDate(thursday.getUTCDate() + 3);
    since = fmt(monday); until = fmt(sunday);
  } else {
    // 7d default
    since = fmt(daysAgo(7)); until = fmt(daysAgo(1));
  }

  const tr   = encodeURIComponent(JSON.stringify({ since, until }));
  const base = '/' + accountId + '/insights';

  // Helper con fallback de video fields
  const fetchLevel = async (extraFields, level, limit=50) => {
    const withVideo = `${base}?fields=${fieldsBase}${videoExtra}${extraFields}&time_range=${tr}&level=${level}&limit=${limit}&`;
    const noVideo   = `${base}?fields=${fieldsBase}${extraFields}&time_range=${tr}&level=${level}&limit=${limit}&`;
    try {
      return await metaFetch(withVideo, token);
    } catch(e) {
      console.log(`[metrics/${period}] video fallback para ${level}`);
      return await metaFetch(noVideo, token).catch(() => ({ data: [] }));
    }
  };

  // Obtener campaign status/objective y adset learning stage en paralelo
  const [accountData, campaignData, adsetData, adData, campaignStatus, adsetStatus] = await Promise.all([
    fetchLevel('', 'account', 1),
    fetchLevel(',campaign_id,campaign_name', 'campaign', 50),
    fetchLevel(',adset_id,adset_name,campaign_name', 'adset', 100),
    fetchLevel(',ad_id,ad_name,adset_id,adset_name,campaign_name', 'ad', 50),
    metaFetch(`/${accountId}/campaigns?fields=id,effective_status,status,objective&limit=100&`, token).catch(() => ({data:[]})),
    metaFetch(`/${accountId}/adsets?fields=id,effective_status,learning_stage_info&limit=100&`, token).catch(() => ({data:[]})),
  ]);

  // Mapas de estado
  const campMap   = {};
  (campaignStatus.data || []).forEach(c => { campMap[c.id] = { status: c.effective_status||c.status||'ACTIVE', objective: c.objective||'' }; });
  const adsetMap  = {};
  (adsetStatus.data   || []).forEach(a => { adsetMap[a.id]  = { status: a.effective_status, learning: a.learning_stage_info }; });

  // Procesar
  const accRaw   = accountData.data?.[0] || {};
  const account  = { ...calcKpis(accRaw), _actions: filterActions(accRaw.actions||[]) };

  const campaigns = (campaignData.data || []).map(c => {
    const kpis    = calcKpis(c);
    const info    = campMap[c.campaign_id] || {};
    return { id: c.campaign_id, name: c.campaign_name, status: info.status||'ACTIVE', objective: info.objective||'',
      _actions: filterActions(c.actions||[]), ...kpis, phase: detectPhase(kpis), fatigueScore: calcFatigue(kpis) };
  });

  const adsets = (adsetData.data || []).map(a => {
    const kpis  = calcKpis(a);
    const info  = adsetMap[a.adset_id] || {};
    return { id: a.adset_id, name: a.adset_name, campaignName: a.campaign_name, status: info.status||'ACTIVE',
      _actions: filterActions(a.actions||[]), ...kpis, phase: detectPhaseReal(kpis, info.learning), fatigueScore: calcFatigue(kpis) };
  });

  const ads = (adData.data || []).map(ad => {
    const kpis = calcKpis(ad);
    return { id: ad.ad_id, name: ad.ad_name, adsetName: ad.adset_name, campaignName: ad.campaign_name,
      _actions: filterActions(ad.actions||[]), ...kpis, fatigueScore: calcFatigue(kpis) };
  });

  console.log(`[metrics/${period}] ✓ account.spend=${account.spend} camps=${campaigns.length} adsets=${adsets.length} ads=${ads.length}`);
  return { account, campaigns, adsets, ads, period };
}

// Métricas por período — endpoint unificado
app.get('/api/:slug/metrics', async (req, res) => {
  const slug   = req.params.slug;
  const client = await loadClientWithCreds(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, period, iso_year, iso_week } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const data = await fetchMetricsByPeriod(client, period || '7d', iso_year, iso_week);
    res.json({ ...data, currency: client.currency || 'ARS' });
  } catch(e) {
    console.error('[metrics] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Analizar solo (sin refrescar métricas de Meta)
app.post('/api/:slug/analyze-only', async (req, res) => {
  const slug = req.params.slug;
  const client = await loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, period } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    // Cargar métricas del snapshot más reciente
    const history = await loadHistoryDB(slug, 1);
    if (!history.length) return res.status(400).json({ error: 'No hay datos. Primero actualizá el dashboard.' });
    const metrics = history[0].metrics;
    client.slug = slug;
    const analysis = await runAnalysis(client, metrics);
    // Guardar resumen en memoria del cliente (async, no bloquea respuesta)
    generateDailySummary(client, metrics, analysis)
      .then(entry => saveClientMemory(slug, entry))
      .catch(e => console.warn('[memory] Error:', e.message));
    // Guardar análisis actualizado en el snapshot (Sub-paso 3.4: en Supabase)
    await patchTodaySnapshotDB(slug, { analysis });
    res.json({ analysis });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Limpiar snapshot del día (fuerza fetch fresco en próxima carga)
app.post('/api/:slug/clear-snapshot', async (req, res) => {
  const slug = req.params.slug;
  const client = await loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const clientDB = await loadClientDB(slug);
    if (clientDB) {
      await supabase
        .from('ad_metrics_daily')
        .delete()
        .eq('client_id', clientDB.id)
        .eq('source', 'meta')
        .eq('date', today())
        .eq('campaign_id', '__ACCOUNT__');
    }
    res.json({ ok: true, message: 'Snapshot eliminado. Actualizá el dashboard.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Ver memoria acumulada del cliente
app.get('/api/:slug/memory', async (req, res) => {
  const slug = req.params.slug;
  const client = await loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const memory = await loadClientMemory(slug);
  res.json({ memory, total: memory.length });
});

// Diagnóstico rápido — ver qué devuelve Meta para esta cuenta
app.get('/api/:slug/diag', async (req, res) => {
  const slug = req.params.slug;
  const client = await loadClientWithCreds(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  const token = client.access_token;
  const accountId = client.ad_account_id;
  const results = {};
  // Test 1: token válido
  try {
    const me = await metaFetch('/me?fields=id,name&', token);
    results.token = { ok: true, user: me.name || me.id };
  } catch(e) { results.token = { ok: false, error: e.message }; }
  // Test 2: cuenta válida
  try {
    const acc = await metaFetch('/' + accountId + '?fields=id,name,account_status&', token);
    results.account = { ok: true, name: acc.name, status: acc.account_status };
  } catch(e) { results.account = { ok: false, error: e.message }; }
  // Test 3: insights básicos
  try {
    const ins = await metaFetch('/' + accountId + '/insights?fields=spend,impressions&date_preset=last_7d&level=account&', token);
    results.insights = { ok: true, rows: ins.data?.length, spend: ins.data?.[0]?.spend };
  } catch(e) { results.insights = { ok: false, error: e.message }; }
  // Test 4: video fields
  try {
    await metaFetch('/' + accountId + '/insights?fields=spend,video_10_sec_watched_actions&date_preset=last_7d&level=account&', token);
    results.video_fields = { ok: true };
  } catch(e) { results.video_fields = { ok: false, error: e.message }; }
  res.json(results);
});
app.get('/api/:slug/debug-actions', async (req, res) => {
  const slug = req.params.slug;
  const client = await loadClientWithCreds(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const data = await metaFetch(
      '/' + client.ad_account_id + '/insights?fields=actions,action_values&date_preset=last_7d&level=account&',
      client.access_token
    );
    const actions = data.data?.[0]?.actions || [];
    const result = actions
      .sort((a,b) => parseFloat(b.value) - parseFloat(a.value))
      .map(a => ({ type: a.action_type, value: parseInt(a.value) }));
    res.json({ total: result.length, actions: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Diagnóstico rápido — verifica que la conexión con Meta funciona
app.get('/api/:slug/ping-meta', async (req, res) => {
  const slug = req.params.slug;
  const client = await loadClientWithCreds(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  try {
    const fields = 'spend,impressions,clicks,actions';
    const data = await metaFetch(
      '/' + client.ad_account_id + '/insights?fields=' + fields + '&date_preset=last_7d&level=account&',
      client.access_token
    );
    res.json({
      ok: true,
      accountId: client.ad_account_id,
      rows: data.data?.length,
      spend: data.data?.[0]?.spend,
      impressions: data.data?.[0]?.impressions,
      actions_count: data.data?.[0]?.actions?.length,
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});



// ── GUARDAR EMAIL DEL CLIENTE ─────────────────────────────────
app.post('/api/:slug/save-email', async (req, res) => {
  const slug = req.params.slug;
  const clientDB = await loadClientDB(slug);
  if (!clientDB) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, email } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  await supabase.from('clients').update({ report_email: email }).eq('id', clientDB.id);
  res.json({ ok: true });
});

// ── ANÁLISIS CREATIVO DUAL (Claude + GPT) ────────────────────
async function analyzeCreativeWithClaude(ad, slug = 'creatives') {
  const prompt = `Analizá este anuncio de Meta Ads desde una perspectiva estratégica y de copy.

Anuncio: "${ad.adName}"
Campaña: "${ad.campaignName}"
Métricas: CTR ${ad.ctr.toFixed(2)}% | CPM $${Math.round(ad.cpm)} | Frecuencia ${ad.frequency.toFixed(1)} | Gasto $${Math.round(ad.spend)}${ad.mainResult ? ' | ' + ad.mainResult.label + ': ' + ad.mainResult.value : ''}
${ad.title ? 'Título: ' + ad.title : ''}
${ad.body ? 'Texto: ' + ad.body : ''}

Respondé SOLO en JSON:
{
  "score": número del 1 al 10,
  "fortaleza": "principal punto fuerte en 1 oración",
  "debilidad": "principal punto débil en 1 oración",
  "tips": ["tip de copy o estrategia 1", "tip 2", "tip 3"]
}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  logAiCall({ slug, model: 'claude-haiku-4-5-20251001', callType: 'creative_analysis_claude', inputTokens: d.usage?.input_tokens || 0, outputTokens: d.usage?.output_tokens || 0, notes: ad.adName?.slice(0,50) }).catch(()=>{});
  return JSON.parse((d.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim());
}

async function analyzeCreativeWithGPT(ad, slug = 'creatives') {
  const prompt = `Analizá este anuncio de Meta Ads desde una perspectiva creativa y visual.

Anuncio: "${ad.adName}"
Campaña: "${ad.campaignName}"
Tipo: ${ad.mediaType === 'video' ? 'Video' : 'Imagen'}
Métricas: CTR ${ad.ctr.toFixed(2)}% | CPM $${Math.round(ad.cpm)} | Frecuencia ${ad.frequency.toFixed(1)}${ad.mainResult ? ' | ' + ad.mainResult.label + ': ' + ad.mainResult.value : ''}
${ad.title ? 'Título: ' + ad.title : ''}

Respondé SOLO en JSON:
{
  "score": número del 1 al 10,
  "fortaleza": "principal punto fuerte visual/creativo en 1 oración",
  "debilidad": "principal punto débil visual/creativo en 1 oración",
  "tips": ["tip visual o creativo 1", "tip 2", "tip 3"]
}`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  logAiCall({ slug, model: 'gpt-4o-mini', callType: 'creative_analysis_gpt', inputTokens: d.usage?.prompt_tokens || 0, outputTokens: d.usage?.completion_tokens || 0, notes: ad.adName?.slice(0,50) }).catch(()=>{});
  return JSON.parse((d.choices?.[0]?.message?.content || '{}').replace(/```json|```/g, '').trim());
}

async function generateAndromedaVerdict(creatives, claudeAnalyses, gptAnalyses, slug = 'creatives') {
  const summary = creatives.slice(0, 8).map((c, i) => {
    const cl = claudeAnalyses[i] || {};
    const gp = gptAnalyses[i] || {};
    return (i+1) + '. "' + c.adName + '" | CTR ' + c.ctr.toFixed(2) + '% | Claude score: ' + (cl.score||'?') + '/10 | GPT score: ' + (gp.score||'?') + '/10 | Gasto $' + Math.round(c.spend);
  }).join('\n');

  const prompt = 'Sos el Agente Andrómeda, experto senior en Meta Ads. Dos analistas (Claude y GPT) evaluaron estas creatividades:\n\n' + summary + '\n\nDá un veredicto final integrado. Respondé SOLO en JSON:\n{"titulo":"Veredicto del Agente Andrómeda","resumen":"análisis ejecutivo en 2-3 oraciones","ganador":"nombre del anuncio ganador y por qué","accion_inmediata":"la 1 acción más importante a tomar ahora","redistribucion":"cómo redistribuir el presupuesto entre estas creatividades","proximo_test":"qué creatividad o formato testear a continuación"}';

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error('Claude andromeda_verdict: ' + (d.error?.message || r.status));
  logAiCall({ slug, model: 'claude-sonnet-5', callType: 'andromeda_verdict', inputTokens: d.usage?.input_tokens || 0, outputTokens: d.usage?.output_tokens || 0 }).catch(()=>{});
  return JSON.parse((d.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim());
}

// ── ENVIAR REPORTE DE CREATIVIDADES POR EMAIL ────────────────
app.post('/api/:slug/send-creatives-email', async (req, res) => {
  const slug = req.params.slug;
  const client = await loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, creatives, aiAnalysis, andromedaVerdict } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });

  const toEmail = client.report_email;
  if (!toEmail) return res.status(400).json({ error: 'No hay email configurado para este cliente' });
  if (!RESEND_KEY) return res.status(500).json({ error: 'Resend no configurado' });

  try {
    const topAds = (creatives || []).slice(0, 5).map((c, i) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb">
          <div style="font-size:13px;font-weight:600;color:#111827">${i+1}. ${c.adName}</div>
          <div style="font-size:11px;color:#6b7280;margin-top:2px">${c.campaignName}</div>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:center;font-size:13px;font-weight:600;color:${c.ctr >= 2 ? '#059669' : c.ctr >= 1 ? '#374151' : '#dc2626'}">${c.ctr.toFixed(2)}%</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:center;font-size:13px;color:#374151">$${Math.round(c.spend).toLocaleString()}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:center;font-size:13px;color:#374151">${c.mainResult ? c.mainResult.value + ' ' + c.mainResult.label : '—'}</td>
      </tr>`).join('');

    const andromedaHtml = andromedaVerdict ? `
      <div style="background:#1e1b4b;border-radius:12px;padding:20px;margin:20px 0">
        <div style="color:#a5b4fc;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-bottom:12px">✦ Agente Andrómeda — Veredicto Final</div>
        <div style="color:#e0e7ff;font-size:14px;line-height:1.7;margin-bottom:12px">${andromedaVerdict.resumen || ''}</div>
        ${andromedaVerdict.ganador ? '<div style="background:#312e81;border-radius:8px;padding:10px 14px;margin-bottom:8px"><span style="color:#a5b4fc;font-size:11px;font-weight:700">🏆 GANADOR</span><div style="color:#e0e7ff;font-size:13px;margin-top:4px">' + andromedaVerdict.ganador + '</div></div>' : ''}
        ${andromedaVerdict.accion_inmediata ? '<div style="background:#312e81;border-radius:8px;padding:10px 14px;margin-bottom:8px"><span style="color:#a5b4fc;font-size:11px;font-weight:700">⚡ ACCIÓN INMEDIATA</span><div style="color:#e0e7ff;font-size:13px;margin-top:4px">' + andromedaVerdict.accion_inmediata + '</div></div>' : ''}
        ${andromedaVerdict.redistribucion ? '<div style="background:#312e81;border-radius:8px;padding:10px 14px"><span style="color:#a5b4fc;font-size:11px;font-weight:700">💰 REDISTRIBUCIÓN</span><div style="color:#e0e7ff;font-size:13px;margin-top:4px">' + andromedaVerdict.redistribucion + '</div></div>' : ''}
      </div>` : '';

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',system-ui,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">

  <!-- Header -->
  <div style="background:#111827;border-radius:12px 12px 0 0;padding:24px;display:flex;align-items:center;gap:12px">
    <div style="width:36px;height:36px;background:#4f46e5;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:16px">N</div>
    <div>
      <div style="color:#fff;font-weight:700;font-size:16px">Nexus Intelligence</div>
      <div style="color:#9ca3af;font-size:12px">Análisis de Creatividades · ${client.name}</div>
    </div>
    <div style="margin-left:auto;color:#9ca3af;font-size:12px">${new Date().toLocaleDateString('es-AR')}</div>
  </div>

  <!-- Body -->
  <div style="background:#fff;padding:24px;border:1px solid #e5e7eb">

    <!-- Andrómeda -->
    ${andromedaHtml}

    <!-- Tabla de anuncios -->
    <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:12px">Top anuncios del período</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;border-collapse:collapse">
      <thead>
        <tr style="background:#f9fafb">
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Anuncio</th>
          <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">CTR</th>
          <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Gasto</th>
          <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Resultado</th>
        </tr>
      </thead>
      <tbody>${topAds}</tbody>
    </table>

    ${aiAnalysis?.winner ? '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;margin-top:16px"><div style="color:#166534;font-size:11px;font-weight:700;margin-bottom:4px">🏆 ANUNCIO GANADOR</div><div style="color:#166534;font-size:13px">' + aiAnalysis.winner + '</div></div>' : ''}
    ${aiAnalysis?.budget_suggestion ? '<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px;margin-top:12px"><div style="color:#1d4ed8;font-size:11px;font-weight:700;margin-bottom:4px">💰 PRESUPUESTO</div><div style="color:#1d4ed8;font-size:13px">' + aiAnalysis.budget_suggestion + '</div></div>' : ''}
  </div>

  <!-- Footer -->
  <div style="background:#111827;border-radius:0 0 12px 12px;padding:16px 24px;text-align:center">
    <div style="color:#6b7280;font-size:11px">Nexus Intelligence · <a href="https://doctanexus.com" style="color:#818cf8;text-decoration:none">Docta Nexus</a></div>
  </div>

</div>
</body></html>`;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RESEND_KEY },
      body: JSON.stringify({
        from: 'Nexus Intelligence <onboarding@resend.dev>',
        to: [toEmail],
        subject: '🎨 Análisis de Creatividades — ' + client.name + ' · ' + new Date().toLocaleDateString('es-AR'),
        html
      })
    });
    const emailData = await emailRes.json();
    if (!emailRes.ok) throw new Error(emailData.message || 'Error enviando email');
    res.json({ ok: true, id: emailData.id });
  } catch(e) {
    console.error('[send-creatives-email]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CREATIVIDADES ─────────────────────────────────────────────

app.get('/api/:slug/creatives', async (req, res) => {
  const slug   = req.params.slug;
  const client = await loadClientWithCreds(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, period, withAnalysis } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });

  try {
    const token     = client.access_token;
    const accountId = client.ad_account_id;
    const preset    = period || 'last_7d';

    // Métricas de anuncios + batch de creatives en paralelo
    const [adsData, batchRes] = await Promise.all([
      metaFetch('/' + accountId + '/insights?fields=ad_id,ad_name,adset_name,campaign_name,spend,impressions,clicks,ctr,cpm,reach,frequency,actions&date_preset=' + preset + '&level=ad&sort=spend_descending&limit=12&', token),
      metaFetch('/' + accountId + '/ads?fields=id,creative{thumbnail_url,image_url,video_id,title,body}&limit=50&', token).catch(() => ({ data: [] }))
    ]);

    const ads = adsData.data || [];
    if (!ads.length) return res.json({ creatives: [], period: preset, total: 0 });

    // Mapa de creatives por ad_id
    const creativeMap = {};
    (batchRes.data || []).forEach(ad => { if (ad.creative) creativeMap[ad.id] = ad.creative; });

    const resultLabels = {
      'onsite_conversion.total_messaging_connection': 'Mensajes',
      'offsite_conversion.fb_pixel_purchase': 'Compras',
      'offsite_conversion.fb_pixel_lead': 'Leads',
      'lead': 'Leads', 'post_engagement': 'Interacciones', 'link_click': 'Clics',
    };

    const creatives = ads.map(ad => {
      const spend = parseFloat(ad.spend || 0);
      const actions = ad.actions || [];
      const c = creativeMap[ad.ad_id] || {};

      let mainResult = null;
      for (const k of Object.keys(resultLabels)) {
        const a = actions.find(x => x.action_type === k);
        if (a && parseInt(a.value) > 0) {
          mainResult = { type: k, label: resultLabels[k], value: parseInt(a.value),
            cpa: spend > 0 ? Math.round(spend / parseInt(a.value) * 100) / 100 : null };
          break;
        }
      }

      return {
        adId: ad.ad_id, adName: ad.ad_name,
        adsetName: ad.adset_name, campaignName: ad.campaign_name,
        spend, impressions: parseInt(ad.impressions || 0),
        clicks: parseInt(ad.clicks || 0),
        ctr: parseFloat(ad.ctr || 0), cpm: parseFloat(ad.cpm || 0),
        reach: parseInt(ad.reach || 0), frequency: parseFloat(ad.frequency || 0),
        imageUrl: c.thumbnail_url || c.image_url || null,
        mediaType: c.video_id ? 'video' : 'image',
        title: c.title || '', body: c.body || '',
        mainResult,
      };
    });

    // Análisis IA general (rápido, siempre)
    let aiAnalysis = null;
    if (ANTHROPIC_KEY && creatives.length > 0) {
      try {
        const summary = creatives.slice(0, 8).map((c, i) =>
          (i+1) + '. "' + c.adName + '" | $' + Math.round(c.spend) + ' | CTR ' + c.ctr.toFixed(2) + '% | Frec ' + c.frequency.toFixed(1) + (c.mainResult ? ' | ' + c.mainResult.label + ': ' + c.mainResult.value : '')
        ).join('\n');
        const prompt = 'Analizá estas creatividades de Meta Ads.\n\n' + summary + '\n\nRespondé SOLO en JSON: {"winner":"anuncio ganador y por qué","loser":"peor anuncio y qué cambiarías","pattern":"patrón detectado","recommendations":["acción 1","acción 2","acción 3"],"budget_suggestion":"sugerencia de presupuesto"}';
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
        });
        const d = await r.json();
        logAiCall({ slug: req.params?.slug || 'creatives', model: 'claude-haiku-4-5-20251001', callType: 'creatives_general_analysis', inputTokens: d.usage?.input_tokens || 0, outputTokens: d.usage?.output_tokens || 0 }).catch(()=>{});
        aiAnalysis = JSON.parse((d.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim());
      } catch(e) { console.warn('[creatives AI]', e.message); }
    }

    // Análisis dual por anuncio (solo si se pide explícitamente)
    let claudeAnalyses = [], gptAnalyses = [], andromedaVerdict = null;
    if (withAnalysis === 'true' && creatives.length > 0) {
      const top = creatives.slice(0, 6);
      [claudeAnalyses, gptAnalyses] = await Promise.all([
        Promise.all(top.map(c => analyzeCreativeWithClaude(c, slug).catch(() => ({})))),
        OPENAI_KEY ? Promise.all(top.map(c => analyzeCreativeWithGPT(c, slug).catch(() => ({})))) : Promise.resolve(top.map(() => ({}))),
      ]);
      andromedaVerdict = await generateAndromedaVerdict(top, claudeAnalyses, gptAnalyses, slug).catch(() => null);
      // Inyectar análisis en cada creative
      top.forEach((c, i) => {
        c.claudeAnalysis = claudeAnalyses[i] || null;
        c.gptAnalysis    = gptAnalyses[i]    || null;
      });
    }

    res.json({ creatives, aiAnalysis, andromedaVerdict, period: preset, total: creatives.length });
  } catch(e) {
    console.error('[creatives]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── SEGUIDORES FB + IG ────────────────────────────────────────
app.get('/api/:slug/followers', async (req, res) => {
  const slug = req.params.slug;
  const client = await loadClientWithCreds(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.query;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });

  try {
    const token = client.access_token;
    const results = { fb: null, ig: null, history: [] };

    // Facebook: fans de la página
    if (client.fb_page_id) {
      try {
        const fbData = await metaFetch('/' + client.fb_page_id + '?fields=fan_count,followers_count&', token);
        results.fb = {
          fans:      fbData.fan_count      || 0,
          followers: fbData.followers_count || fbData.fan_count || 0,
        };
      } catch(e) { console.warn('[followers] FB error:', e.message); }
    }

    // Instagram: followers de la cuenta IG Business
    if (client.ig_account_id) {
      try {
        const igData = await metaFetch('/' + client.ig_account_id + '?fields=followers_count,follows_count,media_count,username&', token);
        results.ig = {
          followers: igData.followers_count || 0,
          following:  igData.follows_count  || 0,
          posts:      igData.media_count    || 0,
          username:   igData.username       || '',
        };
      } catch(e) { console.warn('[followers] IG error:', e.message); }
    }

    // Historial para calcular unfollows (últimos 7 snapshots)
    const history = await loadHistoryDB(slug, 7);
    const followerHistory = history
      .filter(h => h.followers)
      .map(h => ({ date: h.date, fb: h.followers?.fb?.followers || 0, ig: h.followers?.ig?.followers || 0 }));

    // Calcular unfollows estimados (diferencia negativa entre días)
    let fbUnfollows = 0, igUnfollows = 0;
    if (followerHistory.length >= 2) {
      const latest  = followerHistory[0];
      const prev    = followerHistory[1];
      fbUnfollows = Math.max(0, (prev.fb || 0) - (results.fb?.followers || latest.fb || 0));
      igUnfollows = Math.max(0, (prev.ig || 0) - (results.ig?.followers || latest.ig || 0));
    }

    // Guardar snapshot de followers en el data de hoy (Sub-paso 3.4: en Supabase)
    await patchTodaySnapshotDB(slug, { followers: results });

    res.json({ ...results, fbUnfollows, igUnfollows, history: followerHistory });
  } catch(e) {
    console.error('[followers]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── ANÁLISIS CON GPT ─────────────────────────────────────────
app.post('/api/:slug/analyze-gpt', async (req, res) => {
  const slug = req.params.slug;
  const client = await loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, period } = req.body;
  if (!(await checkPassword(slug, password))) return res.status(401).json({ error: 'No autorizado' });
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OpenAI API key no configurada' });

  try {
    const history = await loadHistoryDB(slug, 1);
    if (!history.length) return res.status(400).json({ error: 'No hay datos. Actualizá primero.' });
    const metrics = history[0].metrics;
    const acc = metrics.account || {};
    const camps = (metrics.campaigns || []).slice(0, 8);

    const campsSummary = camps.map(c =>
      `- ${c.name}: CTR ${(c.ctr||0).toFixed(2)}% | $${Math.round(c.spend||0)} | Fase: ${c.phase||'—'} | Frec: ${(c.frequency||0).toFixed(1)}`
    ).join('\n');

    const prompt = `Sos un experto senior en Meta Ads. Analizá estas métricas de la cuenta publicitaria "${client.name}".

MÉTRICAS GENERALES:
- Gasto: $${Math.round(acc.spend||0)} | CTR: ${(acc.ctr||0).toFixed(2)}% | CPM: $${Math.round(acc.cpm||0)} | Frecuencia: ${(acc.frequency||0).toFixed(1)}
- Mensajes: ${acc.messagingConn||0} | Leads: ${acc.leads||0} | Compras: ${acc.purchases||0} | ROAS: ${acc.roas?acc.roas.toFixed(2)+'x':'—'}

CAMPAÑAS:
${campsSummary}

Respondé SOLO en JSON con este formato exacto:
{
  "health_score": número del 1 al 100,
  "summary_items": [{"icon":"emoji","titulo":"título","detalle":"detalle en 1-2 oraciones"}],
  "algorithm_items": [{"icon":"emoji","titulo":"título","detalle":"detalle"}],
  "recommendations": ["recomendación concreta 1","recomendación concreta 2","recomendación concreta 3"],
  "alerts": [],
  "critical_campaigns": [],
  "conclusion_items": [{"icon":"emoji","titulo":"título","detalle":"detalle"}]
}`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Error OpenAI');
    logAiCall({ slug: req.params?.slug || 'dashboard', model: 'gpt-4o-mini', callType: 'dashboard_analysis_gpt', inputTokens: d.usage?.prompt_tokens || 0, outputTokens: d.usage?.completion_tokens || 0 }).catch(()=>{});
    const text = d.choices?.[0]?.message?.content || '{}';
    const analysis = JSON.parse(text.replace(/```json|```/g, '').trim());

    res.json({ analysis, model: 'gpt-4o-mini' });
  } catch(e) {
    console.error('[analyze-gpt]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── TEST de conexión con Google Sheets ───────────────────────
app.get('/api/test-sheets', async (req, res) => {
  try {
    if (!SHEET_ID) return res.json({ ok: false, error: 'GOOGLE_SHEET_ID no configurado' });
    const sheets = await getSheetsClient();
    if (!sheets) return res.json({ ok: false, error: 'Error autenticando con Google' });
    // Intentar leer el sheet
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Hoja 1!A1:A3',
    });
    // Intentar escribir una fila de test
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Hoja 1!A:J',
      valueInputOption: 'USER_ENTERED',
    });
    res.json({ ok: true, rows: result.data.values, sheetId: SHEET_ID });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── COSTOS IA — leer desde Google Sheets ─────────────────────
app.get('/api/costs', async (req, res) => {
  try {
    if (!SHEET_ID) return res.json({ rows: [], error: 'GOOGLE_SHEET_ID no configurado' });
    const sheets = await getSheetsClient();
    if (!sheets) return res.json({ rows: [], error: 'Error de autenticación con Google' });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Hoja 1!A:J',
    });
    const rows = result.data.values || [];
    res.json({ rows });
  } catch(e) {
    console.error('[costs]', e.message);
    res.status(500).json({ rows: [], error: e.message });
  }
});

app.get('/health', async (_, res) => res.json({ status: 'ok', clients: await listClients(), version: '2.0' }));

// Dashboard real (login + las 7 solapas) — vivía en public/index.html antes de
// que ese archivo pasara a ser la Home comercial. Restaurado como dashboard.html
// y servido acá explícitamente, para que /login deje de caer en el catch-all.
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, async () => {
  console.log('\n✦ Growth Intelligence Platform — Docta Nexus');
  console.log('  http://localhost:' + PORT);
  console.log('  Clientes: ' + ((await listClients()).join(', ') || 'ninguno') + '\n');
});
