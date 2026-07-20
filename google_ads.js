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

const API_VERSION = 'v19';
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

// ── Query GAQL a nivel campaña para una fecha puntual ──
async function fetchCampaignMetrics(customerId, dateStr) {
  const accessToken = await getGoogleAdsAccessToken();
  const cleanCustomerId = customerId.replace(/-/g, '');
  const loginCustomerId = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');

  const query = `
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
      metrics.conversions_value
    FROM campaign
    WHERE segments.date = '${dateStr}'
  `.trim();

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
      extra_metrics: { campaign_status: c.status || null },
    };
  });
}

module.exports = { getGoogleAdsAccessToken, fetchCampaignMetrics, normalizeToAdMetricsRows };
