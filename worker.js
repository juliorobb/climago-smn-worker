/**
 * ClimaGo API Worker (Cloudflare Workers, compatible with Free plan)
 * Routes: ?resource=alerts&lat=-31.4&lon=-64.2
 *         ?resource=radar-snapshot&layer=radars|precip
 *         ?resource=radar-tile&layer=radars|precip&snapshot=...&forecast=0&z=...&x=...&y=...
 * Optional secret: RAINBOW_API_KEY (Worker secret). Alerts do not require a key.
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
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}\\s*>`, 'i');
  const m = xml.match(re);
  return m ? decodeXml(m[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}
function blocks(xml, tag) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}\\s*>`, 'gi');
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
  return [...urls].slice(0, 60);
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
function parseCap(xml, lat, lon) {
  const infos = blocks(xml, 'info');
  const out = [];
  for (const info of (infos.length ? infos : [xml])) {
    const areas = blocks(info, 'area').map(area => {
      const polygons = blocks(area, 'polygon').map(p => p.trim().split(/\s+/).map(pair => {
        const [a, b] = pair.split(',').map(Number);
        return Number.isFinite(a) && Number.isFinite(b) ? [b, a] : null;
      }).filter(Boolean));
      const circles = blocks(area, 'circle').map(c => {
        const [coords, radius] = c.trim().split(/\s+/); const [a, b] = (coords || '').split(',').map(Number);
        return { lat: a, lon: b, radiusKm: Number(radius) };
      }).filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon) && Number.isFinite(c.radiusKm));
      const affected = polygons.some(r => r.length >= 3 && insidePolygon(lon, lat, r)) || circles.some(c => distanceKm(lat, lon, c.lat, c.lon) <= c.radiusKm);
      return { description: value(area, 'areaDesc'), affected };
    });
    out.push({
      identifier: value(xml, 'identifier'), sender: value(xml, 'sender'), sent: value(xml, 'sent'), status: value(xml, 'status'),
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
    cf: { cacheTtlByStatus: { '200-299': 120, '400-599': 0 } },
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
  const active = results.filter(a =>
    a.identifier &&
    (!a.expires || (Number.isFinite(Date.parse(a.expires)) && Date.parse(a.expires) >= now)) &&
    a.status.toLowerCase() !== 'cancel'
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

async function rainbow(request, env, q) {
  if (!env.RAINBOW_API_KEY) return json({ error: 'Radar no configurado: falta el secreto RAINBOW_API_KEY.' }, 503);
  const headers = { 'Ocp-Apim-Subscription-Key': env.RAINBOW_API_KEY };

  if (q.resource === 'radar-snapshot') {
    const layer = ['radars', 'precip', 'precip-global', 'clouds'].includes(q.layer)
      ? q.layer
      : 'precip-global';
    const r = await fetch(RAINBOW + '/tiles/v1/snapshot?layer=' + encodeURIComponent(layer), {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return json({ error: 'Rainbow snapshot respondió HTTP ' + r.status }, r.status);
    return new Response(await r.text(), {
      headers: {
        ...CORS,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=120',
      },
    });
  }

  const { snapshot, z, x, y } = q;
  const tileParts = [snapshot, z, x, y];
  if (!tileParts.every(v => v !== undefined && v !== '' && Number.isSafeInteger(Number(v)) && Number(v) >= 0)) {
    return json({ error: 'Parámetros de mosaico inválidos.' }, 400);
  }

  const layer = ['radars', 'precip', 'precip-global', 'clouds'].includes(q.layer)
    ? q.layer
    : 'precip-global';
  const forecast = q.forecast === undefined ? '0' : q.forecast;
  const forecastSeconds = Number(forecast);
  if (forecast === '' || !Number.isSafeInteger(forecastSeconds) ||
      forecastSeconds < 0 || forecastSeconds > 14400 ||
      (['precip', 'precip-global'].includes(layer) && forecastSeconds % 600 !== 0)) {
    return json({ error: 'Pronóstico inválido. Usá segundos entre 0 y 14400, en intervalos de 600.' }, 400);
  }

  let path;
  if (layer === 'precip') {
    path = '/tiles/v1/precip/' + snapshot + '/' + forecastSeconds + '/' + z + '/' + x + '/' + y;
  } else if (layer === 'precip-global') {
    path = '/tiles/v1/precip-global/' + snapshot + '/' + forecastSeconds + '/' + z + '/' + x + '/' + y;
  } else if (layer === 'clouds') {
    path = '/tiles/v1/clouds/' + snapshot + '/' + z + '/' + x + '/' + y;
  } else {
    path = '/tiles/v1/radars/' + snapshot + '/' + z + '/' + x + '/' + y;
  }

  const upstream = await fetch(RAINBOW + path, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!upstream.ok) return json({ error: 'Rainbow tile respondió HTTP ' + upstream.status }, upstream.status);
  return new Response(upstream.body, {
    headers: {
      ...CORS,
      'Content-Type': upstream.headers.get('Content-Type') || 'image/png',
      'Cache-Control': 'public, max-age=180',
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405);
    const url = new URL(request.url), q = Object.fromEntries(url.searchParams.entries());
    try {
      if (q.resource === 'health') return json({ ok: true, service: 'ClimaGo API', time: new Date().toISOString() }, 200, { 'Cache-Control': 'no-store' });
      if (q.resource === 'alerts') {
        const lat = Number(q.lat), lon = Number(q.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: 'Coordenadas lat/lon inválidas.' }, 400);
        const data = await getAlerts(lat, lon);
        const ttl = data.coverageComplete ? 120 : 60;
        return json(data, 200, {
          'Cache-Control': 'public, max-age=' + ttl,
          ...(data.retryAfterSeconds ? { 'Retry-After': String(data.retryAfterSeconds) } : {}),
        });
      }
      if (q.resource === 'radar-snapshot' || q.resource === 'radar-tile') return await rainbow(request, env, q);
      return json({ error: 'Recurso no reconocido. Usá resource=health, alerts, radar-snapshot o radar-tile.' }, 404);
    } catch (e) {
      return json({ error: 'No se pudo completar la consulta meteorológica.', detail: String(e?.message || e) }, 502, { 'Cache-Control': 'no-store' });
    }
  },
};
// ClimaGo - primera compilación desde GitHub
