require('dotenv').config();
const express    = require('express');
const fetch      = require('node-fetch');
const path       = require('path');
const fs         = require('fs');
const cron       = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const META_API_VER   = 'v19.0';
const TZ             = process.env.TIMEZONE || 'America/Argentina/Buenos_Aires';

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── HELPERS ───────────────────────────────────────────────────
function loadClient(slug) {
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return null;
  const fp = path.join(__dirname, 'clients', slug + '.json');
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function listClients() {
  const dir = path.join(__dirname, 'clients');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
}

function saveData(slug, data) {
  const dir = path.join(__dirname, 'data', slug);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, date + '.json'), JSON.stringify(data, null, 2));
}

function loadHistory(slug, days = 14) {
  const dir = path.join(__dirname, 'data', slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .sort().reverse().slice(0, days)
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

function today() { return new Date().toISOString().slice(0, 10); }

// ── META API ──────────────────────────────────────────────────
async function metaFetch(path, token) {
  const r = await fetch('https://graph.facebook.com/' + META_API_VER + path + '&access_token=' + token);
  const d = await r.json();
  if (d.error) throw new Error('Meta API: ' + d.error.message);
  return d;
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

// ── AGENTE CLAUDE — EXPERTO META ANDROMEDA ────────────────────
async function runAnalysis(client, metricsData) {
  const history = loadHistory(client.slug || 'demo', 7);
  const targets = client.kpi_targets || {};

  // KPIs principales definidos por el cliente
  const mainKpis = targets.main_kpis || [];
  const analysisBase = targets.analysis_base || '';

  const system = `Sos un experto en Paid Media con especialización profunda en Meta Ads y el algoritmo Andromeda/Advantage+.

## Algoritmo Meta Andromeda
- Fases: Aprendizaje (<50 conv/semana), Estabilización, Fatiga
- Advantage+: Meta optimiza automáticamente audiencias, placements y creatividades
- Fatiga creativa: frecuencia >3.5 señal temprana, >4.5 crítico. Impacta CPM y ROAS
- Subasta: bid + presupuesto + calidad del anuncio determinan el delivery
- En aprendizaje: NO pausar ni editar — el algoritmo necesita explorar

## Relaciones entre métricas
- CPM alto + CTR bajo → creatividad débil o audiencia saturada
- Muchos clics + pocas conversiones → problema post-click (landing, tracking, proceso comercial)
- Frecuencia alta + CTR cayendo → fatiga creativa avanzada
- ROAS bajo en aprendizaje → normal, esperar 50 conversiones antes de juzgar
- CTR saludable: feed 1-3%, stories/reels >1.5%

## Formato de respuesta
Respondé SIEMPRE en JSON válido, sin markdown, sin texto fuera del JSON.
Cada campo de análisis debe ser un ARRAY DE ITEMS, no un texto largo.
Esto es crítico para el renderizado visual del dashboard.`;

  // Construir sección de KPIs principales
  const mainKpisSection = mainKpis.length > 0
    ? `\nKPIs PRINCIPALES PARA ESTE CLIENTE (ordenados por prioridad):\n${mainKpis.map((k, i) => `  ${i+1}. ${k}`).join('\n')}\nAnalizá y evaluá estas métricas con prioridad sobre las demás.\n`
    : '';

  // Base de análisis del cliente
  const analysisBaseSection = analysisBase
    ? `\nBASE DE ANÁLISIS — instrucciones específicas del cliente:\n${analysisBase}\nTené en cuenta este contexto en todo el análisis.\n`
    : '';

  const acc = metricsData.account || {};
  const camps = metricsData.campaigns || [];
  const adsets = metricsData.adsets || [];
  const ads = metricsData.ads || [];

  const prompt = `Analizá las campañas de Meta Ads para el cliente "${client.name}".
${mainKpisSection}${analysisBaseSection}
OBJETIVOS DEFINIDOS:
${targets.target_roas ? '- ROAS mínimo: ' + targets.target_roas + 'x' : ''}
${targets.target_ctr ? '- CTR mínimo: ' + targets.target_ctr + '%' : ''}
${targets.target_cpm ? '- CPM máximo: $' + targets.target_cpm : ''}
${targets.target_frequency ? '- Frecuencia máxima: ' + targets.target_frequency : ''}
${targets.target_cpmsg ? '- Costo por mensaje máximo: $' + targets.target_cpmsg : ''}

MÉTRICAS CUENTA (últimos 7 días):
Gasto: $${Math.round(acc.spend||0)} | Impresiones: ${acc.impressions||0} | Alcance: ${acc.reach||0}
CTR: ${(acc.ctr||0).toFixed(2)}% | CPM: $${Math.round(acc.cpm||0)} | Frecuencia: ${(acc.frequency||0).toFixed(1)}
ROAS: ${acc.roas ? acc.roas.toFixed(2)+'x' : 'N/A'}
Mensajería: ${acc.messagingConn||0} conexiones | ${acc.messagingFirstReply||0} primeras respuestas | Costo x msg: $${Math.round(acc.cpmsg||0)}
Leads: ${acc.leads||0} | Compras: ${acc.purchases||0} | Valor: $${Math.round(acc.purchaseValue||0)}
Nuevos seguidores: ${acc.newFollowersPage||0} (pág) + ${acc.newFollowersIG||0} (IG)
Compartidos: ${acc.postShares||0} | Guardados: ${acc.postSaves||0}
Engagement posts: ${acc.postEngagement||0} | Video views: ${acc.videoViews||0}

CAMPAÑAS (${camps.length}):
${JSON.stringify(camps.slice(0,12).map(c=>({
  nombre: c.name, fase: c.phase,
  gasto: '$'+Math.round(c.spend||0), ctr: (c.ctr||0).toFixed(2)+'%', cpm: '$'+Math.round(c.cpm||0),
  freq: (c.frequency||0).toFixed(1), roas: c.roas?c.roas.toFixed(2)+'x':'N/A',
  mensajes: c.messagingConn||0, leads: c.leads||0, compras: c.purchases||0
})), null, 2)}

CONJUNTOS DE ANUNCIOS / AUDIENCIAS (${adsets.length}):
${JSON.stringify(adsets.slice(0,15).map(a=>({
  nombre: a.name, campana: a.campaignName, fase: a.phase, fatiga: a.fatigueScore,
  gasto: '$'+Math.round(a.spend||0), ctr: (a.ctr||0).toFixed(2)+'%', cpm: '$'+Math.round(a.cpm||0),
  freq: (a.frequency||0).toFixed(1), mensajes: a.messagingConn||0, leads: a.leads||0
})), null, 2)}

ANUNCIOS TOP (${ads.length}):
${JSON.stringify(ads.slice(0,12).map(a=>({
  nombre: a.name, conjunto: a.adsetName, fatiga: a.fatigueScore,
  gasto: '$'+Math.round(a.spend||0), ctr: (a.ctr||0).toFixed(2)+'%', freq: (a.frequency||0).toFixed(1),
  mensajes: a.messagingConn||0, compartidos: a.postShares||0, guardados: a.postSaves||0
})), null, 2)}

${history.length > 1 ? 'TENDENCIA (' + history.length + ' días):\n' + JSON.stringify(history.map(h => ({ date: h.date, spend: h.metrics?.account?.spend, roas: h.metrics?.account?.roas, mensajes: h.metrics?.account?.messagingConn })), null, 2) : ''}

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
  const client = loadClient(slug);
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
  const result = { date: today(), metrics, analysis };
  saveData(slug, result);
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

async function renewTokenIfNeeded(slug) {
  if (!META_APP_ID || !META_APP_SECRET) return;
  const client = loadClient(slug);
  if (!client || !client.access_token) return;

  try {
    // Verificar estado del token con Meta Debug API
    const debugUrl = `https://graph.facebook.com/debug_token?input_token=${client.access_token}&access_token=${META_APP_ID}|${META_APP_SECRET}`;
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
      if (daysLeft > 15) return;
      console.log(`[TOKEN] ${slug}: renovando token (${daysLeft} días restantes)...`);
    }

    // Renovar token
    const renewUrl = `https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${client.access_token}`;
    const rr = await fetch(renewUrl);
    const rd = await rr.json();

    if (!rr.ok || !rd.access_token) {
      throw new Error(rd.error?.message || 'No se pudo renovar el token');
    }

    // Guardar token nuevo en el JSON del cliente
    const fp = path.join(__dirname, 'clients', slug + '.json');
    client.access_token = rd.access_token;
    client.token_renewed_at = new Date().toISOString();
    fs.writeFileSync(fp, JSON.stringify(client, null, 2));
    console.log(`[TOKEN] ${slug}: token renovado exitosamente ✓`);

    // Notificar por email
    if (client.email_alerts?.length && process.env.EMAIL_USER) {
      const transporter = createTransporter();
      await transporter.sendMail({
        from: `"Meta Intelligence | Docta Nexus" <${process.env.EMAIL_USER}>`,
        to: client.email_alerts.join(','),
        subject: `✓ Token Meta renovado automáticamente — ${client.name}`,
        html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0b0b0d;color:#edeef0;border-radius:12px;padding:24px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
            <div style="width:32px;height:32px;background:#c8f135;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#0b0b0d">D</div>
            <div style="font-weight:600">Meta Intelligence · Docta Nexus</div>
          </div>
          <div style="background:#151518;border-radius:8px;padding:16px;border-left:3px solid #5de8a0">
            <div style="color:#5de8a0;font-weight:600;margin-bottom:8px">✓ Token renovado automáticamente</div>
            <div style="color:#9a9aaa;font-size:13px;line-height:1.6">
              El token de acceso de <strong style="color:#edeef0">${client.name}</strong> fue renovado automáticamente.<br>
              Válido por aproximadamente 60 días más.<br>
              Fecha: ${new Date().toLocaleDateString('es-AR')}
            </div>
          </div>
          <div style="text-align:center;margin-top:16px;font-size:11px;color:#52525c">
            Meta Intelligence · <a href="https://doctanexus.com" style="color:#c8f135;text-decoration:none">Docta Nexus</a>
          </div>
        </div>`
      }).catch(e => console.error('[TOKEN] Error enviando email:', e.message));
    }

  } catch(e) {
    console.error(`[TOKEN] Error renovando token de ${slug}:`, e.message);
    // Notificar el error por email
    const clientFresh = loadClient(slug);
    if (clientFresh?.email_alerts?.length && process.env.EMAIL_USER) {
      const transporter = createTransporter();
      await transporter.sendMail({
        from: `"Meta Intelligence | Docta Nexus" <${process.env.EMAIL_USER}>`,
        to: clientFresh.email_alerts.join(','),
        subject: `⚠️ Error renovando token Meta — ${clientFresh.name} — acción requerida`,
        html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0b0b0d;color:#edeef0;border-radius:12px;padding:24px">
          <div style="background:#151518;border-radius:8px;padding:16px;border-left:3px solid #f26d6d">
            <div style="color:#f26d6d;font-weight:600;margin-bottom:8px">⚠️ Token de Meta requiere renovación manual</div>
            <div style="color:#9a9aaa;font-size:13px;line-height:1.6">
              No se pudo renovar automáticamente el token de <strong style="color:#edeef0">${clientFresh.name}</strong>.<br>
              Error: ${e.message}<br><br>
              Renovalo manualmente desde <a href="https://developers.facebook.com/tools/explorer/" style="color:#c8f135">Graph API Explorer</a>.
            </div>
          </div>
          <div style="text-align:center;margin-top:16px;font-size:11px;color:#52525c">
            Meta Intelligence · <a href="https://doctanexus.com" style="color:#c8f135;text-decoration:none">Docta Nexus</a>
          </div>
        </div>`
      }).catch(() => {});
    }
  }
}

// ── CRON: renovación de tokens cada 12 horas ──────────────────
cron.schedule('0 */12 * * *', async () => {
  console.log('[CRON] Verificando tokens de Meta...');
  for (const slug of listClients()) {
    await renewTokenIfNeeded(slug).catch(e =>
      console.error('[CRON] Error verificando token de ' + slug + ':', e.message)
    );
  }
}, { timezone: TZ });

// ── ENDPOINTS ─────────────────────────────────────────────────
// Auth middleware
function authMiddleware(req, res, next) {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.body || req.query;
  if (password !== client.password) return res.status(401).json({ error: 'Contraseña incorrecta' });
  req.client = client;
  req.clientSlug = slug;
  next();
}

// Login
app.post('/api/:slug/login', (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.body;
  if (password !== client.password) return res.status(401).json({ error: 'Contraseña incorrecta' });
  res.json({
    ok: true,
    name: client.name,
    colorPrimary: client.colorPrimary || '#c8f135',
    colorAccent: client.colorAccent || '#a3c72c',
    colorBtnText: client.colorBtnText || '#0b0b0d',
    objective: client.objective,
    kpi_targets: client.kpi_targets,
    alert_config: client.alert_config,
    dash_config: client.dash_config,
    currency: client.currency || 'ARS'
  });
});

// Obtener datos del dashboard (requiere auth via query param)
app.get('/api/:slug/dashboard', async (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.query;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });

  try {
    // Intentar cargar datos de hoy
    const dir = path.join(__dirname, 'data', slug);
    const todayFile = path.join(dir, today() + '.json');
    let result;
    if (fs.existsSync(todayFile)) {
      result = JSON.parse(fs.readFileSync(todayFile, 'utf8'));
    } else {
      // Generar datos nuevos
      result = await runPipeline(slug);
    }
    const history = loadHistory(slug, 14);
    res.json({ ...result, history });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Refrescar análisis manualmente
app.post('/api/:slug/refresh', async (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.body;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });
  try {
    const result = await runPipeline(slug);
    const history = loadHistory(slug, 14);
    res.json({ ...result, history });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Refresh solo métricas (sin correr el agente — más rápido)
app.post('/api/:slug/refresh-metrics', async (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.body;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });
  try {
    client.slug = slug;
    const metrics = await fetchAccountMetrics(client);
    // Cargar análisis previo si existe
    const history = loadHistory(slug, 1);
    const prevAnalysis = history[0]?.analysis || {};
    const result = { date: today(), metrics, analysis: prevAnalysis };
    saveData(slug, result);
    res.json({ ...result, history: loadHistory(slug, 14) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Guardar KPI targets
app.post('/api/:slug/save-kpis', (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, kpis } = req.body;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });
  const fp = path.join(__dirname, 'clients', slug + '.json');
  client.kpi_targets = kpis;
  fs.writeFileSync(fp, JSON.stringify(client, null, 2));
  res.json({ ok: true });
});

// Guardar configuración del dashboard (métricas visibles)
app.post('/api/:slug/save-dashboard-config', (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, dashConfig } = req.body;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });
  const fp = path.join(__dirname, 'clients', slug + '.json');
  client.dash_config = dashConfig;
  fs.writeFileSync(fp, JSON.stringify(client, null, 2));
  res.json({ ok: true });
});

// Métricas por período (ayer / 7d / 30d) con comparativa vs período anterior
app.get('/api/:slug/metrics', async (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, period } = req.query;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });
  try {
    const token = client.access_token;
    const accountId = client.ad_account_id;
    const fields = 'spend,impressions,clicks,ctr,cpm,reach,frequency,actions,action_values,unique_clicks,unique_ctr';

    // Calcular fechas exactas — Meta usa YYYY-MM-DD en zona del ad account
    // Usamos fecha local del servidor que corre en UTC
    const today = new Date();
    const fmt = d => {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth()+1).padStart(2,'0');
      const day = String(d.getUTCDate()).padStart(2,'0');
      return `${y}-${m}-${day}`;
    };
    const daysAgo = n => { const d = new Date(today); d.setUTCDate(today.getUTCDate()-n); return d; };

    let currentTimeRange, prevTimeRange;

    if (period === 'yesterday') {
      // Ayer = hace 1 día. Anterior = hace 2 días
      currentTimeRange = encodeURIComponent(JSON.stringify({ since: fmt(daysAgo(1)), until: fmt(daysAgo(1)) }));
      prevTimeRange    = encodeURIComponent(JSON.stringify({ since: fmt(daysAgo(2)), until: fmt(daysAgo(2)) }));
    } else if (period === '30d') {
      // Últimos 30 días completos vs 30 días anteriores
      currentTimeRange = encodeURIComponent(JSON.stringify({ since: fmt(daysAgo(30)), until: fmt(daysAgo(1)) }));
      prevTimeRange    = encodeURIComponent(JSON.stringify({ since: fmt(daysAgo(60)), until: fmt(daysAgo(31)) }));
    } else {
      // Últimos 7 días completos vs 7 días anteriores
      currentTimeRange = encodeURIComponent(JSON.stringify({ since: fmt(daysAgo(7)), until: fmt(daysAgo(1)) }));
      prevTimeRange    = encodeURIComponent(JSON.stringify({ since: fmt(daysAgo(14)), until: fmt(daysAgo(8)) }));
    }

    const base = '/' + accountId + '/insights?fields=' + fields;

    const [data, prevData, campaigns, prevCampaigns] = await Promise.all([
      metaFetch(base + '&time_range=' + currentTimeRange + '&level=account&', token),
      metaFetch(base + '&time_range=' + prevTimeRange    + '&level=account&', token).catch(()=>({data:[]})),
      metaFetch(base + ',campaign_id,campaign_name&time_range=' + currentTimeRange + '&level=campaign&limit=50&', token),
      metaFetch(base + ',campaign_id,campaign_name&time_range=' + prevTimeRange    + '&level=campaign&limit=50&', token).catch(()=>({data:[]})),
    ]);

    // Log para debug
    console.log(`[metrics] ${period} | current: ${data.data?.length} rows | prev: ${prevData.data?.length} rows`);
    console.log(`[metrics] current spend: ${data.data?.[0]?.spend} | prev spend: ${prevData.data?.[0]?.spend}`);

    res.json({
      account:       data.data?.[0]        || {},
      prevAccount:   prevData.data?.[0]    || {},
      campaigns:     campaigns.data        || [],
      prevCampaigns: prevCampaigns.data    || [],
      period,
      prevPeriodLabel: period === 'yesterday' ? 'anteayer'
                     : period === '30d'       ? `${fmt(prevSince)} – ${fmt(prevUntil)}`
                     :                          `${fmt(prevSince)} – ${fmt(prevUntil)}`,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Analizar solo (sin refrescar métricas de Meta)
app.post('/api/:slug/analyze-only', async (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, period } = req.body;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });
  try {
    // Cargar métricas del snapshot más reciente
    const history = loadHistory(slug, 1);
    if (!history.length) return res.status(400).json({ error: 'No hay datos. Primero actualizá el dashboard.' });
    const metrics = history[0].metrics;
    client.slug = slug;
    const analysis = await runAnalysis(client, metrics);
    // Guardar análisis actualizado en el snapshot
    const dir = path.join(__dirname, 'data', slug);
    const todayFile = path.join(dir, today() + '.json');
    if (fs.existsSync(todayFile)) {
      const snap = JSON.parse(fs.readFileSync(todayFile, 'utf8'));
      snap.analysis = analysis;
      fs.writeFileSync(todayFile, JSON.stringify(snap, null, 2));
    }
    res.json({ analysis });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Diagnóstico rápido — ver qué devuelve Meta para esta cuenta
app.get('/api/:slug/diag', async (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.query;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });
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
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.query;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });
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
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.query;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });
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

app.get('/health', (_, res) => res.json({ status: 'ok', clients: listClients(), version: '2.0' }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('\n✦ Meta Ads Intelligence — Docta Nexus');
  console.log('  http://localhost:' + PORT);
  console.log('  Clientes: ' + (listClients().join(', ') || 'ninguno') + '\n');
});
