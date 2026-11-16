/**
 * ClimaGo API Worker (Cloudflare Workers, compatible with Free plan)
 * Routes: ?resource=alerts&lat=-31.4&lon=-64.2
 *         ?resource=radar-snapshot&layer=radars|precip
 *         ?resource=radar-tile (respuesta informativa; el visor oficial se incrusta en la app)
 * Alertas CAP del SMN sin claves privadas. Radar servido mediante visor oficial SMN.
 */
const CAP_FEED = 'https://ssl.smn.gob.ar/CAP/AR.php';
const RAINBOW = 'https://api.rainbow.ai';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
});
const decodeXml = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
function value(xml, tag) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\s[^>]*)?>([\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}\s*>`, 'i');
  const m = xml.match(re);
  return m ? decodeXml(m[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}
function blocks(xml, tag) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\s[^>]*)?>([\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}\s*>`, 'gi');
  return [...xml.matchAll(re)].map(m => m[1]);
}
function extractCapUrls(feed) {
  const candidates = [];
  const attributes = /(?:href|url)[ \t\r\n]*=[ \t\r\n]*["']([^"']+)["']/gi;
  for (const match of feed.matchAll(attributes)) candidates.push(match[1]);

  // Algunos índices publican enlaces como texto o rutas relativas, no como URL absoluta.
  for (const token of feed.split(/[ \t\r\n"'<>]+/)) {
    if (token.toLowerCase().includes('.xml')) candidates.push(token);
  }

  const urls = new Set();
  for (const raw of candidates) {
    try {
      const clean = decodeXml(String(raw).replace(/&amp;/g, '&')).trim().replace(/[),;]+$/, '');
      const parsed = new URL(clean, CAP_FEED);
      if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
          parsed.hostname === 'ssl.smn.gob.ar' &&
          parsed.pathname.toLowerCase().endsWith('.xml')) {
        urls.add(parsed.href);
      }
    } catch {}
  }
  return [...urls];
}

function insidePolygon(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) && lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
function distanceKm(a, b, c, d) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (c - a) * rad, dLon = (d - b) * rad;
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
}
function circleRing(lon, lat, radiusKm, steps = 48) {
  const earthRadiusKm = 6371;
  const angularRadius = radiusKm / earthRadiusKm;
  const latRad = lat * Math.PI / 180;
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const bearing = 2 * Math.PI * i / steps;
    const nextLat = Math.asin(
      Math.sin(latRad) * Math.cos(angularRadius) +
      Math.cos(latRad) * Math.sin(angularRadius) * Math.cos(bearing)
    );
    const nextLon = lon * Math.PI / 180 + Math.atan2(
      Math.sin(bearing) * Math.sin(angularRadius) * Math.cos(latRad),
      Math.cos(angularRadius) - Math.sin(latRad) * Math.sin(nextLat)
    );
    points.push([nextLon * 180 / Math.PI, nextLat * 180 / Math.PI]);
  }
  return points;
}
function parseCap(xml, lat, lon) {
  const infos = blocks(xml, 'info');
  const out = [];
  for (const info of (infos.length ? infos : [xml])) {
    const areas = blocks(info, 'area').map(area => {
      const polygons = blocks(area, 'polygon').map(p => p.trim().split(/\s+/).map(pair => {
        const [a, b] = pair.split(',').map(Number);
        return Number.isFinite(a) && Number.isFinite(b) ? [b, a] : null;
      }).filter(Boolean)).filter(ring => ring.length >= 3);

      const circles = blocks(area, 'circle').map(c => {
        const [coords, radius] = c.trim().split(/\s+/);
        const [a, b] = (coords || '').split(',').map(Number);
        return { lat: a, lon: b, radiusKm: Number(radius) };
      }).filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon) &&
        Number.isFinite(c.radiusKm) && c.radiusKm > 0);

      const affected = polygons.some(ring => insidePolygon(lon, lat, ring)) ||
        circles.some(c => distanceKm(lat, lon, c.lat, c.lon) <= c.radiusKm);

      const rings = [
        ...polygons.map(ring => {
          const closed = ring.map(point => [...point]);
          const first = closed[0], last = closed[closed.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) closed.push([...first]);
          return closed;
        }),
        ...circles.map(c => circleRing(c.lon, c.lat, c.radiusKm)),
      ];
      const geometry = rings.length
        ? { type: 'MultiPolygon', coordinates: rings.map(ring => [ring]) }
        : null;

      return { description: value(area, 'areaDesc'), affected, geometry };
    });
    out.push({
      identifier: value(xml, 'identifier'), sender: value(xml, 'sender'), sent: value(xml, 'sent'),
      status: value(xml, 'status'), msgType: value(xml, 'msgType'), scope: value(xml, 'scope'),
      references: value(xml, 'references'),
      event: value(info, 'event'), headline: value(info, 'headline'), description: value(info, 'description'),
      instruction: value(info, 'instruction'), severity: value(info, 'severity'), urgency: value(info, 'urgency'),
      certainty: value(info, 'certainty'), effective: value(info, 'effective'), onset: value(info, 'onset'), expires: value(info, 'expires'),
      areas, affectsLocation: areas.some(a => a.affected), source: 'Servicio Meteorológico Nacional',
    });
  }
  return out;
}

async function getAlerts(lat, lon) {
  const generatedAt = new Date().toISOString();
  const emptyResult = (extra = {}) => ({
    source: 'SMN / CAP',
    generatedAt,
    location: { lat, lon },
    feedItemsFound: 0,
    attemptedDocuments: 0,
    downloadedDocuments: 0,
    failedDocuments: 0,
    coverageComplete: false,
    rateLimited: false,
    status: 'unavailable',
    alerts: [],
    activeForLocation: [],
    ...extra,
  });

  const feedResponse = await fetch(CAP_FEED, {
    headers: { 'User-Agent': 'ClimaGo/1.0' },
    cf: { cacheTtlByStatus: { '200-299': 600, '400-599': 0 } },
    signal: AbortSignal.timeout(15000),
  });
  if (feedResponse.status === 429) {
    return emptyResult({
      rateLimited: true,
      status: 'temporarily-limited',
      message: 'El SMN limitó temporalmente la consulta del índice CAP.',
      retryAfterSeconds: 60,
    });
  }
  if (!feedResponse.ok) throw new Error('El índice CAP del SMN respondió HTTP ' + feedResponse.status);

  const feed = await feedResponse.text();
  const urls = extractCapUrls(feed);
  if (!urls.length) {
    return emptyResult({
      status: 'index-without-xml-links',
      message: 'El índice del SMN respondió, pero no se detectaron enlaces XML CAP válidos.',
    });
  }

  const results = [];
  let attemptedDocuments = 0;
  let downloadedDocuments = 0;
  let failedDocuments = 0;
  let rateLimited = false;

  // Dos descargas simultáneas como máximo: evita ráfagas contra el servidor del SMN.
  for (let i = 0; i < urls.length; i += 2) {
    const batch = await Promise.all(urls.slice(i, i + 2).map(async url => {
      attemptedDocuments++;
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': 'ClimaGo/1.0' },
          cf: { cacheTtlByStatus: { '200-299': 600, '400-599': 0 } },
          signal: AbortSignal.timeout(10000),
        });
        if (r.status === 429) return { rateLimited: true, alerts: [] };
        if (!r.ok) return { failed: true, alerts: [] };
        downloadedDocuments++;
        return { alerts: parseCap(await r.text(), lat, lon) };
      } catch {
        return { failed: true, alerts: [] };
      }
    }));

    for (const item of batch) {
      results.push(...item.alerts);
      if (item.failed) failedDocuments++;
      if (item.rateLimited) rateLimited = true;
    }
    // No seguir descargando documentos una vez que el SMN informa HTTP 429.
    if (rateLimited) break;
  }

  const now = Date.now();
  // Los mensajes CAP Cancel contienen referencias al aviso original.
  // Se eliminan del conjunto activo los identificadores cancelados, aunque el
  // documento original siga apareciendo temporalmente en el índice del SMN.
  const cancelledIdentifiers = new Set(
    results.filter(a => String(a.msgType || '').toLowerCase() === 'cancel')
      .flatMap(a => referencedIdentifiers(a.references))
  );
  const active = results.filter(a =>
    a.identifier &&
    String(a.status || '').toLowerCase() === 'actual' &&
    String(a.msgType || '').toLowerCase() !== 'cancel' &&
    !cancelledIdentifiers.has(a.identifier) &&
    (!a.expires || (Number.isFinite(Date.parse(a.expires)) && Date.parse(a.expires) >= now))
  );
  const unique = [...new Map(active.map(a => [a.identifier, a])).values()];
  unique.sort((a, b) => Number(b.affectsLocation) - Number(a.affectsLocation));

  const coverageComplete = attemptedDocuments === urls.length &&
    downloadedDocuments === urls.length &&
    failedDocuments === 0 &&
    !rateLimited;

  return {
    source: 'SMN / CAP',
    generatedAt,
    location: { lat, lon },
    feedItemsFound: urls.length,
    attemptedDocuments,
    downloadedDocuments,
    failedDocuments,
    coverageComplete,
    rateLimited,
    status: coverageComplete ? 'complete' : (rateLimited ? 'partial-rate-limited' : 'partial'),
    alerts: unique,
    activeForLocation: unique.filter(a => a.affectsLocation),
    ...(rateLimited ? { retryAfterSeconds: 60 } : {}),
  };
}


const SUBSCRIPTION_PREFIX = 'subscription:';
const SENT_PREFIX = 'sent:';
const MAX_SUBSCRIPTIONS = 1000;
const MAX_PUSH_HISTORY = 500;

function isAllowedAppOrigin(origin, env) {
  if (!origin) return false;
  if (env.APP_ORIGIN && origin === env.APP_ORIGIN) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'https:' &&
      (parsed.hostname === 'climago.pages.dev' || parsed.hostname.endsWith('.climago.pages.dev'));
  } catch { return false; }
}

function jsonForOrigin(data, status, request, env, extra = {}) {
  const origin = request.headers.get('Origin') || '';
  const allowed = isAllowedAppOrigin(origin, env);
  return json(data, status, {
    ...extra,
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
}

function validCoordinates(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function validSubscription(value) {
  return value && typeof value === 'object' &&
    typeof value.endpoint === 'string' &&
    value.endpoint.startsWith('https://') &&
    value.keys && typeof value.keys.p256dh === 'string' &&
    typeof value.keys.auth === 'string';
}

function isEffectiveNow(alert, now = Date.now()) {
  const rawStart = alert.effective || alert.onset || '';
  const start = Date.parse(rawStart);
  // Sin fecha de inicio verificable, no enviar Push por anticipado.
  return Number.isFinite(start) && start <= now;
}

// Nivel interno ClimaGo: prevalece el color SAT explícito del SMN.
// Si no está escrito, se usa una equivalencia conservadora con CAP severity.
export function getAlertLevel(alert) {
  const text = [alert.headline, alert.event, alert.description].filter(Boolean).join(' ').toLowerCase();
  const explicit = text.match(/(?:alerta|nivel)\s+(rojo|naranja|amarillo)/i);
  if (explicit) return explicit[1].toLowerCase();
  const severity = String(alert.severity || '').toLowerCase();
  if (severity === 'extreme') return 'rojo';
  if (severity === 'severe') return 'naranja';
  if (severity === 'moderate' || severity === 'minor') return 'amarillo';
  return 'desconocido';
}

export function referencedIdentifiers(references) {
  return String(references || '').trim().split(/\s+/).filter(Boolean)
    .map(item => item.split(',')[1] || '').filter(Boolean);
}

// Solo Naranja/Rojo generan Push. Amarillo permanece visible dentro de ClimaGo.
export function isRelevantForPush(alert, now = Date.now()) {
  const status = String(alert.status || '').toLowerCase();
  const msgType = String(alert.msgType || '').toLowerCase();
  const scope = String(alert.scope || '').toLowerCase();
  const urgency = String(alert.urgency || '').toLowerCase();
  const certainty = String(alert.certainty || '').toLowerCase();
  const expires = Date.parse(alert.expires || '');

  if (status !== 'actual' || !['alert', 'update'].includes(msgType) || scope !== 'public') return false;
  if (!alert.identifier || !alert.affectsLocation || !isEffectiveNow(alert, now)) return false;
  if (Number.isFinite(expires) && expires <= now) return false;
  if (!['immediate', 'expected'].includes(urgency)) return false;
  if (!['observed', 'likely'].includes(certainty)) return false;
  return ['naranja', 'rojo'].includes(getAlertLevel(alert));
}

async function saveSubscription(request, env) {
  if (!env.ALERTS_KV) return jsonForOrigin({ error: 'El almacenamiento de suscripciones no está configurado.' }, 503, request, env);
  const origin = request.headers.get('Origin') || '';
  if (!isAllowedAppOrigin(origin, env)) return jsonForOrigin({ error: 'Origen no autorizado.' }, 403, request, env);
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > 12000) return jsonForOrigin({ error: 'Solicitud demasiado grande.' }, 413, request, env);
  let body;
  try { body = await request.json(); } catch { return jsonForOrigin({ error: 'JSON inválido.' }, 400, request, env); }
  const subscription = body?.subscription;
  const lat = Number(body?.lat), lon = Number(body?.lon);
  if (!validSubscription(subscription) || !validCoordinates(lat, lon)) {
    return jsonForOrigin({ error: 'Se requiere una suscripción Push válida y coordenadas lat/lon válidas.' }, 400, request, env);
  }
  const id = await sha256Hex(subscription.endpoint);
  const record = {
    id, subscription, lat, lon,
    locationName: String(body.locationName || 'Ubicación guardada').slice(0, 100),
    updatedAt: new Date().toISOString(),
  };
  await env.ALERTS_KV.put(SUBSCRIPTION_PREFIX + id, JSON.stringify(record));
  return jsonForOrigin({ ok: true, id }, 201, request, env);
}


async function sendTestPush(request, env) {
  if (!env.ALERTS_KV) return jsonForOrigin({ error: 'El almacenamiento de suscripciones no está configurado.' }, 503, request, env);
  const origin = request.headers.get('Origin') || '';
  if (!isAllowedAppOrigin(origin, env)) return jsonForOrigin({ error: 'Origen no autorizado.' }, 403, request, env);
  let body;
  try { body = await request.json(); } catch { return jsonForOrigin({ error: 'JSON inválido.' }, 400, request, env); }
  if (typeof body?.endpoint !== 'string' || !body.endpoint.startsWith('https://')) return jsonForOrigin({ error: 'Endpoint de suscripción inválido.' }, 400, request, env);
  const id = await sha256Hex(body.endpoint);
  const raw = await env.ALERTS_KV.get(SUBSCRIPTION_PREFIX + id);
  if (!raw) return jsonForOrigin({ error: 'No encontramos esta suscripción guardada. Volvé a activar las notificaciones.' }, 404, request, env);
  let record;
  try { record = JSON.parse(raw); } catch { return jsonForOrigin({ error: 'La suscripción guardada está dañada.' }, 500, request, env); }
  const testKey = 'test:' + id;
  const previous = Number(await env.ALERTS_KV.get(testKey) || 0);
  if (Date.now() - previous < 60000) return jsonForOrigin({ error: 'Esperá un minuto antes de enviar otra prueba.' }, 429, request, env);
  if (!env.VAPID_SERVER_PUBLIC_KEY || !env.VAPID_SERVER_PRIVATE_KEY) return jsonForOrigin({ error: 'Faltan las claves VAPID del Worker.' }, 503, request, env);
  const { buildPushPayload } = await import('@block65/webcrypto-web-push');
  const payload = await buildPushPayload({
    data: JSON.stringify({ title: 'Prueba de notificación · ClimaGo', body: 'La conexión Push de este teléfono está funcionando correctamente.', tag: 'climago-push-test', url: '/?page=alerts' }),
    options: { ttl: 120, urgency: 'high' },
  }, record.subscription, {
    subject: env.VAPID_SUBJECT || 'mailto:soporte@climago.app',
    publicKey: env.VAPID_SERVER_PUBLIC_KEY,
    privateKey: env.VAPID_SERVER_PRIVATE_KEY,
  });
  const response = await fetch(record.subscription.endpoint, payload);
  if (response.status === 404 || response.status === 410) {
    await env.ALERTS_KV.delete(SUBSCRIPTION_PREFIX + id);
    return jsonForOrigin({ error: 'El servicio Push informó que la suscripción venció. Hay que registrarla nuevamente.' }, 410, request, env);
  }
  if (!response.ok) return jsonForOrigin({ error: 'El servicio Push respondió HTTP ' + response.status + '.' }, 502, request, env);
  await env.ALERTS_KV.put(testKey, String(Date.now()), { expirationTtl: 300 });
  return jsonForOrigin({ ok: true, status: response.status }, 200, request, env);
}

async function removeSubscription(request, env) {
  if (!env.ALERTS_KV) return jsonForOrigin({ error: 'El almacenamiento de suscripciones no está configurado.' }, 503, request, env);
  const origin = request.headers.get('Origin') || '';
  if (!isAllowedAppOrigin(origin, env)) return jsonForOrigin({ error: 'Origen no autorizado.' }, 403, request, env);
  let body;
  try { body = await request.json(); } catch { return jsonForOrigin({ error: 'JSON inválido.' }, 400, request, env); }
  if (typeof body?.endpoint !== 'string' || !body.endpoint.startsWith('https://')) {
    return jsonForOrigin({ error: 'Endpoint de suscripción inválido.' }, 400, request, env);
  }
  const id = await sha256Hex(body.endpoint);
  await Promise.all([
    env.ALERTS_KV.delete(SUBSCRIPTION_PREFIX + id),
    env.ALERTS_KV.delete(SENT_PREFIX + id),
  ]);
  return jsonForOrigin({ ok: true }, 200, request, env);
}

async function listSubscriptions(kv) {
  const records = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: SUBSCRIPTION_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
      const raw = await kv.get(key.name);
      if (!raw) continue;
      try { records.push(JSON.parse(raw)); } catch { await kv.delete(key.name); }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && records.length < MAX_SUBSCRIPTIONS);
  return records.slice(0, MAX_SUBSCRIPTIONS);
}

async function sendAlertPush(record, alert, env) {
  const sentKey = SENT_PREFIX + record.id;
  let history = {};
  try { history = JSON.parse(await env.ALERTS_KV.get(sentKey) || '{}'); } catch {}
  if (history[alert.identifier]) return { skipped: true };

  const { buildPushPayload } = await import('@block65/webcrypto-web-push');
  const vapid = {
    subject: env.VAPID_SUBJECT || 'mailto:soporte@climago.app',
    publicKey: env.VAPID_SERVER_PUBLIC_KEY,
    privateKey: env.VAPID_SERVER_PRIVATE_KEY,
  };
  if (!vapid.publicKey || !vapid.privateKey) throw new Error('Faltan las claves VAPID del Worker.');

  const payload = await buildPushPayload({
    data: JSON.stringify({
      title: alert.headline || alert.event || 'Alerta meteorológica',
      body: alert.description || alert.instruction || 'El SMN emitió un aviso para una zona que tenés guardada.',
      tag: 'smn-' + await sha256Hex(alert.identifier).then(x => x.slice(0, 24)),
      url: '/?page=alerts',
      event: alert.event || '',
      severity: alert.severity || 'Unknown',
      expires: alert.expires || null,
    }),
    options: { ttl: 900, urgency: 'high' },
  }, record.subscription, vapid);

  const response = await fetch(record.subscription.endpoint, payload);
  if (response.status === 404 || response.status === 410) {
    await Promise.all([
      env.ALERTS_KV.delete(SUBSCRIPTION_PREFIX + record.id),
      env.ALERTS_KV.delete(sentKey),
    ]);
    return { removed: true, status: response.status };
  }
  if (!response.ok) throw new Error('Push endpoint respondió HTTP ' + response.status);

  history[alert.identifier] = new Date().toISOString();
  const entries = Object.entries(history).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, MAX_PUSH_HISTORY);
  await env.ALERTS_KV.put(sentKey, JSON.stringify(Object.fromEntries(entries)));
  return { sent: true, status: response.status };
}

async function runScheduledAlerts(env) {
  if (!env.ALERTS_KV) throw new Error('Falta el binding KV ALERTS_KV.');
  if (!env.VAPID_SERVER_PUBLIC_KEY || !env.VAPID_SERVER_PRIVATE_KEY) throw new Error('Faltan las claves VAPID.');
  const subscriptions = await listSubscriptions(env.ALERTS_KV);
  if (!subscriptions.length) return { subscriptions: 0, locations: 0, sent: 0 };

  // Una sola consulta CAP por ubicación única, aunque haya varios teléfonos suscriptos allí.
  const locations = new Map();
  for (const record of subscriptions) {
    if (!validCoordinates(Number(record.lat), Number(record.lon)) || !validSubscription(record.subscription)) continue;
    const key = Number(record.lat).toFixed(5) + ',' + Number(record.lon).toFixed(5);
    if (!locations.has(key)) locations.set(key, { lat: Number(record.lat), lon: Number(record.lon), records: [] });
    locations.get(key).records.push(record);
  }

  let sent = 0;
  for (const location of locations.values()) {
    const result = await getAlerts(location.lat, location.lon);
    // No declarar ausencia de riesgo ni enviar avisos automáticos con catálogo incompleto.
    if (!result.coverageComplete) {
      console.warn('Push omitido: catálogo CAP incompleto', {
        lat: location.lat, lon: location.lon,
        found: result.feedItemsFound, downloaded: result.downloadedDocuments,
        failed: result.failedDocuments, rateLimited: result.rateLimited,
      });
      continue;
    }
    const active = result.activeForLocation.filter(alert => isRelevantForPush(alert));
    for (const record of location.records) {
      for (const alert of active) {
        try {
          const outcome = await sendAlertPush(record, alert, env);
          if (outcome.sent) sent++;
        } catch (error) {
          console.error('No se pudo enviar Push', record.id, alert.identifier, String(error));
        }
      }
    }
  }
  return { subscriptions: subscriptions.length, locations: locations.size, sent };
}

async function officialRadar(q) {
  const viewer = 'https://www.smn.gob.ar/radar/responsiveFrame';
  if (q.resource === 'radar-snapshot') {
    return json({
      provider: 'Servicio Meteorológico Nacional',
      mode: 'official-interactive-viewer',
      viewer,
      note: 'El SMN entrega el radar mediante su visor oficial interactivo; no se dispone aquí de una URL pública y estable de teselas para Leaflet.',
      updatedAt: new Date().toISOString(),
    }, 200, { 'Cache-Control': 'public, max-age=300' });
  }
  return json({
    error: 'No hay un endpoint público de teselas de radar SMN verificado para servir esta solicitud.',
    provider: 'Servicio Meteorológico Nacional',
    viewer,
    use: 'Incrustar el visor oficial SMN en la pantalla Radar de ClimaGo.',
  }, 410);
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url), q = Object.fromEntries(url.searchParams.entries());
    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin') || '';
      const allowed = isAllowedAppOrigin(origin, env);
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': allowed ? origin : 'null',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin',
      }});
    }

    try {
      if (q.resource === 'push-public-key' && request.method === 'GET') {
        if (!env.VAPID_SERVER_PUBLIC_KEY) return json({ error: 'La clave pública VAPID todavía no está configurada.' }, 503);
        return jsonForOrigin({ publicKey: env.VAPID_SERVER_PUBLIC_KEY }, 200, request, env, { 'Cache-Control': 'public, max-age=3600' });
      }
      if (q.resource === 'subscribe' && request.method === 'POST') return await saveSubscription(request, env);
      if (q.resource === 'unsubscribe' && request.method === 'POST') return await removeSubscription(request, env);
      if (q.resource === 'push-test' && request.method === 'POST') return await sendTestPush(request, env);
      if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405);

      if (q.resource === 'health') return json({
        ok: true, service: 'ClimaGo API', time: new Date().toISOString(),
        pushStorageConfigured: Boolean(env.ALERTS_KV),
        pushKeysConfigured: Boolean(env.VAPID_SERVER_PUBLIC_KEY && env.VAPID_SERVER_PRIVATE_KEY),
      }, 200, { 'Cache-Control': 'no-store' });

      if (q.resource === 'alerts') {
        const lat = Number(q.lat), lon = Number(q.lon);
        if (!validCoordinates(lat, lon)) return json({ error: 'Coordenadas lat/lon inválidas.' }, 400);
        const data = await getAlerts(lat, lon);
        const dataStatus = data.coverageComplete ? 'ok' :
          data.rateLimited ? 'rate_limited' :
          data.status === 'unavailable' || data.status === 'index-without-xml-links' ? 'unavailable' : 'partial';
        const cap = {
          ...data, dataStatus,
          diagnostics: {
            documentsFound: data.feedItemsFound || 0,
            documentsAttempted: data.attemptedDocuments || 0,
            documentsDownloaded: data.downloadedDocuments || 0,
            documentsFailed: data.failedDocuments || 0,
            coverageComplete: data.coverageComplete === true,
          },
        };
        const ttl = data.coverageComplete ? 120 : 60;
        return json({ cap, testedAt: data.generatedAt, location: data.location }, 200, {
          'Cache-Control': 'public, max-age=' + ttl,
          ...(data.retryAfterSeconds ? { 'Retry-After': String(data.retryAfterSeconds) } : {}),
        });
      }
      if (q.resource === 'radar-snapshot' || q.resource === 'radar-tile') return await officialRadar(q);
      return json({ error: 'Recurso no reconocido. Usá resource=health, alerts, radar-snapshot, radar-tile o push-public-key.' }, 404);
    } catch (e) {
      console.error('ClimaGo Worker error:', e);
      return json({ error: 'No se pudo completar la solicitud.', detail: String(e?.message || e) }, 502, { 'Cache-Control': 'no-store' });
    }
  },

  async scheduled(controller, env) {
    try {
      const result = await runScheduledAlerts(env);
      console.log('ClimaGo Push schedule completado:', JSON.stringify({
        cron: controller.cron, scheduledTime: controller.scheduledTime, ...result,
      }));
    } catch (error) {
      console.error('ClimaGo Push schedule falló:', String(error?.stack || error));
      throw error;
    }
  },
};
