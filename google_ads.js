/**
 * google_ads.js — Docta Nexus / Growth Intelligence Platform
 *
 * Conector de Google Ads. Solo trae y normaliza MÉTRICAS — ningún
 * análisis se mezcla acá (principio acordado: el reporte siempre
 * contiene las métricas primero, el análisis es un paso posterior).
 *
 * Autenticación: Developer Token + Client ID/Secret + Refresh Token
 * son A NIVEL AGENCIA (una sola cuenta MCC administra todos los
 * clientes) — van en variables de entorno globales, no por cliente.
 * Lo único que varía por cliente es el Customer ID de su cuenta,
 * que se guarda en client_credentials (source='google_ads').
 *
 * Variables de entorno necesarias:
 *   GOOGLE_ADS_DEVELOPER_TOKEN
 *   GOOGLE_ADS_CLIENT_ID
 *   GOOGLE_ADS_CLIENT_SECRET
 *   GOOGLE_ADS_REFRESH_TOKEN
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID   (el ID de tu cuenta MCC, sin guiones)
 */

const fetch = require('node-fetch');

const API_VERSION = 'v24'; // v19 fue dado de baja por Google en feb-2026
const BASE_URL = `https://googleads.googleapis.com/${API_VERSION}`;

let cachedToken = null;
let cachedTokenExpiresAt = 0;

// ── Intercambiar el refresh_token por un access_token (se cachea en memoria) ──
async function getGoogleAdsAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60000) return cachedToken;

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) {
    throw new Error('Google Ads OAuth: ' + (d.error_description || d.error || 'no se pudo obtener access_token'));
  }
  cachedToken = d.access_token;
  cachedTokenExpiresAt = Date.now() + (d.expires_in || 3600) * 1000;
  return cachedToken;
}

// Campos de cuota de impresión (Search Impression Share) — son agregables
// solo a nivel cuenta/campaña y en algunos casos la API rechaza combinarlos
// con otros campos por la restricción "Selectable With". Se piden aparte
// y si la API los rechaza, se reintenta sin ellos (ver fetchCampaignMetrics).
const IMPRESSION_SHARE_FIELDS = `,
      metrics.search_top_impression_share,
      metrics.search_absolute_top_impression_share,
      metrics.search_budget_lost_impression_share`;

function buildCampaignQuery(dateStr, includeImpressionShare) {
  return `
    SELECT
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type,
      campaign.status,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.average_cpm,
      metrics.conversions,
      metrics.conversions_value${includeImpressionShare ? IMPRESSION_SHARE_FIELDS : ''}
    FROM campaign
    WHERE segments.date = '${dateStr}'
  `.trim();
}

async function runGaqlSearch(customerId, accessToken, query) {
  const cleanCustomerId = customerId.replace(/-/g, '');
  const loginCustomerId = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');
  const r = await fetch(`${BASE_URL}/customers/${cleanCustomerId}/googleAds:search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'login-customer-id': loginCustomerId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const d = await r.json();
  if (!r.ok) {
    const msg = d.error?.message || JSON.stringify(d);
    throw new Error(`Google Ads API (${customerId}): ${msg}`);
  }
  return d.results || [];
}

// ── Query GAQL a nivel campaña para una fecha puntual ──
async function fetchCampaignMetrics(customerId, dateStr) {
  const accessToken = await getGoogleAdsAccessToken();
  try {
    return await runGaqlSearch(customerId, accessToken, buildCampaignQuery(dateStr, true));
  } catch (e) {
    // Si Google rechaza combinar los campos de impression share con el resto
    // (restricción "Selectable With"), reintentamos sin ellos para no romper
    // el resto del pipeline de métricas.
    console.warn(`[google-ads] impression share no disponible para ${customerId}, reintentando sin esos campos:`, e.message);
    return await runGaqlSearch(customerId, accessToken, buildCampaignQuery(dateStr, false));
  }
}

// ── Query GAQL a nivel campaña para un RANGO de fechas — sin `segments.date`
// en el SELECT, la API de Google Ads devuelve las métricas ya agregadas por
// campaña sobre todo el rango (no una fila por día). Se usa para los filtros
// de período (Ayer/7d/14d/Mes/Semana N) en vivo, sin depender de lo guardado
// en Supabase por el cron.
function buildCampaignRangeQuery(since, until, includeImpressionShare) {
  return `
    SELECT
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type,
      campaign.status,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.average_cpm,
      metrics.conversions,
      metrics.conversions_value${includeImpressionShare ? IMPRESSION_SHARE_FIELDS : ''}
    FROM campaign
    WHERE segments.date BETWEEN '${since}' AND '${until}'
  `.trim();
}

// ── Métricas de campaña en vivo para un rango de fechas ──
async function fetchCampaignMetricsRange(customerId, since, until) {
  const accessToken = await getGoogleAdsAccessToken();
  try {
    return await runGaqlSearch(customerId, accessToken, buildCampaignRangeQuery(since, until, true));
  } catch (e) {
    console.warn(`[google-ads] impression share no disponible para ${customerId} (rango), reintentando sin esos campos:`, e.message);
    return await runGaqlSearch(customerId, accessToken, buildCampaignRangeQuery(since, until, false));
  }
}

// ── Agrega el resultado crudo de fetchCampaignMetricsRange a nivel cuenta +
// por campaña, con el mismo shape que antes devolvía la lectura desde
// Supabase (spend/impressions/clicks/ctr/cpc/cpm/roas/cpa/search impression
// share + campaigns[]) — así el resto del código (endpoints, prompts de IA)
// no necesita cambiar su forma de leer estos datos.
function aggregateCampaignRows(rawResults) {
  const campaigns = rawResults.map(r => {
    const c = r.campaign || {};
    const m = r.metrics || {};
    const spend = Number(m.costMicros || 0) / 1_000_000;
    const conversionValue = Number(m.conversionsValue || m.conversions_value || 0);
    const impressions = Number(m.impressions || 0);
    const clicks = Number(m.clicks || 0);
    const conversions = Number(m.conversions || 0);
    return {
      campaign_id: c.id ? String(c.id) : null,
      campaign_name: c.name || '(sin nombre)',
      status: c.status || null,
      spend, impressions, clicks, conversions, conversion_value: conversionValue,
      ctr: impressions > 0 ? +(clicks / impressions * 100).toFixed(3) : null,
      roas: spend > 0 ? +(conversionValue / spend).toFixed(3) : null,
      cpa: conversions > 0 ? +(spend / conversions).toFixed(2) : null,
      _searchTop: m.searchTopImpressionShare != null ? Number(m.searchTopImpressionShare) : null,
      _searchAbsTop: m.searchAbsoluteTopImpressionShare != null ? Number(m.searchAbsoluteTopImpressionShare) : null,
      _searchLostBudget: m.searchBudgetLostImpressionShare != null ? Number(m.searchBudgetLostImpressionShare) : null,
    };
  });

  const s = { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversion_value: 0 };
  let wTop = 0, wTopWeight = 0, wAbs = 0, wAbsWeight = 0, wLost = 0, wLostWeight = 0;
  for (const c of campaigns) {
    s.spend += c.spend; s.impressions += c.impressions; s.clicks += c.clicks;
    s.conversions += c.conversions; s.conversion_value += c.conversion_value;
    if (c._searchTop != null) { wTop += c._searchTop * c.impressions; wTopWeight += c.impressions; }
    if (c._searchAbsTop != null) { wAbs += c._searchAbsTop * c.impressions; wAbsWeight += c.impressions; }
    if (c._searchLostBudget != null) { wLost += c._searchLostBudget * c.impressions; wLostWeight += c.impressions; }
  }
  s.ctr = s.impressions > 0 ? +(s.clicks / s.impressions * 100).toFixed(3) : null;
  s.cpc = s.clicks > 0 ? +(s.spend / s.clicks).toFixed(2) : null;
  s.cpm = s.impressions > 0 ? +(s.spend / s.impressions * 1000).toFixed(2) : null;
  s.roas = s.spend > 0 ? +(s.conversion_value / s.spend).toFixed(3) : null;
  s.cpa = s.conversions > 0 ? +(s.spend / s.conversions).toFixed(2) : null;
  // Fracciones (0.15 = 15%) tal como las devuelve la API — recién se convierten
  // a % acá, ponderadas por impresiones de cada campaña.
  s.search_top_impression_share = wTopWeight > 0 ? +(wTop / wTopWeight * 100).toFixed(1) : null;
  s.search_absolute_top_impression_share = wAbsWeight > 0 ? +(wAbs / wAbsWeight * 100).toFixed(1) : null;
  s.search_budget_lost_impression_share = wLostWeight > 0 ? +(wLost / wLostWeight * 100).toFixed(1) : null;
  s.campaigns = campaigns
    .map(({ _searchTop, _searchAbsTop, _searchLostBudget, ...rest }) => rest)
    .sort((a, b) => b.spend - a.spend);
  return s;
}

// ── Mapear el resultado crudo de GAQL a filas listas para ad_metrics_daily ──
function normalizeToAdMetricsRows(clientId, dateStr, rawResults) {
  return rawResults.map(r => {
    const c = r.campaign || {};
    const m = r.metrics || {};
    const spend = (Number(m.costMicros || 0)) / 1_000_000;
    const conversionValue = Number(m.conversionsValue || m.conversions_value || 0);
    return {
      client_id: clientId,
      source: 'google_ads',
      date: dateStr,
      campaign_id: c.id ? String(c.id) : null,
      campaign_name: c.name || null,
      campaign_type: (c.advertisingChannelType || c.advertising_channel_type || '').toLowerCase() || null,
      spend,
      impressions: Number(m.impressions || 0),
      clicks: Number(m.clicks || 0),
      ctr: m.ctr ? Number(m.ctr) * 100 : null, // Google devuelve ctr como fracción (0.02) → % como Meta
      cpc: m.averageCpc ? Number(m.averageCpc) / 1_000_000 : null,
      cpm: m.averageCpm ? Number(m.averageCpm) / 1_000_000 : null,
      conversions: Number(m.conversions || 0),
      conversion_value: conversionValue,
      roas: spend > 0 ? +(conversionValue / spend).toFixed(3) : null,
      extra_metrics: {
        campaign_status: c.status || null,
        // Fracciones (0.15 = 15%) tal como las devuelve la API — se convierten
        // a % recién al mostrar/agregar. null si la query cayó al fallback
        // sin estos campos (ver fetchCampaignMetrics).
        search_top_impression_share: m.searchTopImpressionShare != null ? Number(m.searchTopImpressionShare) : null,
        search_absolute_top_impression_share: m.searchAbsoluteTopImpressionShare != null ? Number(m.searchAbsoluteTopImpressionShare) : null,
        search_budget_lost_impression_share: m.searchBudgetLostImpressionShare != null ? Number(m.searchBudgetLostImpressionShare) : null,
      },
    };
  });
}

// ── Shopping/PMax: productos con más impresiones/clics para un rango de fechas ──
// Fase 1 (sin Merchant Center): trae el dato en vivo desde shopping_performance_view,
// no se guarda histórico en Supabase — mismo criterio que fetchGA4TopPages/TopItems
// en ga4.js (dato "en vivo" para reportes puntuales, sin necesidad de cron).
// El estado de aprobación real de Merchant Center NO viene de esta API — queda
// para una fase 2 aparte si se decide integrar Content API for Shopping.
async function fetchShoppingProducts(customerId, since, until, limit = 50) {
  const accessToken = await getGoogleAdsAccessToken();
  const query = `
    SELECT
      segments.product_item_id,
      segments.product_title,
      segments.product_brand,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM shopping_performance_view
    WHERE segments.date BETWEEN '${since}' AND '${until}'
    ORDER BY metrics.impressions DESC
    LIMIT ${limit}
  `.trim();
  const results = await runGaqlSearch(customerId, accessToken, query);

  // shopping_performance_view devuelve una fila por combinación producto+segmento
  // (puede repetir el mismo producto varios días) — se agrega acá por product_item_id.
  const byProduct = {};
  for (const r of results) {
    const s = r.segments || {};
    const m = r.metrics || {};
    const id = s.productItemId || s.product_item_id || '(sin id)';
    if (!byProduct[id]) {
      byProduct[id] = {
        product_id: id,
        title: s.productTitle || s.product_title || '(sin título)',
        brand: s.productBrand || s.product_brand || null,
        impressions: 0, clicks: 0, cost: 0, conversions: 0, conversion_value: 0,
      };
    }
    const p = byProduct[id];
    p.impressions += Number(m.impressions || 0);
    p.clicks += Number(m.clicks || 0);
    p.cost += Number(m.costMicros || 0) / 1_000_000;
    p.conversions += Number(m.conversions || 0);
    p.conversion_value += Number(m.conversionsValue || m.conversions_value || 0);
  }

  return Object.values(byProduct)
    .map(p => ({
      ...p,
      ctr: p.impressions > 0 ? +(p.clicks / p.impressions * 100).toFixed(2) : null,
      roas: p.cost > 0 ? +(p.conversion_value / p.cost).toFixed(3) : null,
      // Diagnóstico indirecto (fase 1, sin Merchant Center): 0 impresiones en
      // todo el rango es la señal más común de un producto desaprobado, pausado
      // o sin stock — no es un diagnóstico real de Merchant Center, es una alerta.
      diagnostico: p.impressions === 0 ? 'sin_impresiones' : (p.clicks === 0 ? 'sin_clics' : 'ok'),
    }))
    .sort((a, b) => b.impressions - a.impressions);
}

module.exports = {
  getGoogleAdsAccessToken, fetchCampaignMetrics, normalizeToAdMetricsRows, fetchShoppingProducts,
  fetchCampaignMetricsRange, aggregateCampaignRows,
};
