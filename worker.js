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
  const diagnostics = {
    feedHttpStatus: null,
    feedContentType: '',
    feedBytes: 0,
    candidateUrlsFound: 0,
    documentsAttempted: 0,
    documentsDownloaded: 0,
    documentsWithInfoBlocks: 0,
    documentsParsed: 0,
    documentsWithoutInfoBlocks: 0,
    httpErrors: 0,
    fetchErrors: 0,
    parseErrors: 0,
    errors: [],
  };
  const addError = (kind, detail) => {
    if (diagnostics.errors.length < 8) diagnostics.errors.push({ kind, detail: String(detail).slice(0, 220) });
  };
  const feedResponse = await fetch(CAP_FEED, {
    headers: { 'User-Agent': 'ClimaGo/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  diagnostics.feedHttpStatus = feedResponse.status;
  diagnostics.feedContentType = feedResponse.headers.get('content-type') || '';
  if (!feedResponse.ok) throw new Error(`El feed CAP del SMN respondió HTTP ${feedResponse.status}`);
  const feed = await feedResponse.text();
  diagnostics.feedBytes = new TextEncoder().encode(feed).length;

  // La página CAP del SMN publica enlaces XML; se cuentan antes de limitar el lote.
  const candidates = [...feed.matchAll(/https?:[^\\s"'<>]+?\\.xml(?:\\?[^\\s"'<>]*)?/gi)]
    .map(m => decodeXml(m[0]).replace(/&amp;/g, '&'));
  const urls = [...new Set(candidates)].filter(u => /smn\\.gob\\.ar/i.test(u));
  diagnostics.candidateUrlsFound = urls.length;
  const selectedUrls = urls.slice(0, 60);
  const results = [];

  for (let i = 0; i < selectedUrls.length; i += 6) {
    const batch = await Promise.all(selectedUrls.slice(i, i + 6).map(async url => {
      diagnostics.documentsAttempted++;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) {
          diagnostics.httpErrors++;
          addError('http', `HTTP ${response.status} al descargar un aviso CAP`);
          return [];
        }
        diagnostics.documentsDownloaded++;
        const xml = await response.text();
        const infoBlocks = blocks(xml, 'info');
        if (!infoBlocks.length) {
          diagnostics.documentsWithoutInfoBlocks++;
          addError('sin-info', `Documento descargado sin bloques <info>; content-type: ${response.headers.get('content-type') || 'desconocido'}; inicio: ${xml.slice(0, 100)}`);
          return [];
        }
        diagnostics.documentsWithInfoBlocks++;
        const parsed = parseCap(xml, lat, lon);
        if (!parsed.length || parsed.some(item => !item.identifier)) {
          diagnostics.parseErrors++;
          addError('parseo', 'El documento contiene <info>, pero no se pudo extraer su identificador CAP.');
          return [];
        }
        diagnostics.documentsParsed++;
        return parsed;
      } catch (error) {
        diagnostics.fetchErrors++;
        addError('fetch', error?.message || error);
        return [];
      }
    }));
    results.push(...batch);
  }

  const now = Date.now();
  const active = results.flat().filter(a =>
    a.identifier &&
    (!a.expires || Date.parse(a.expires) >= now) &&
    a.status.toLowerCase() !== 'cancel'
  );
  const unique = [...new Map(active.map(a => [a.identifier, a])).values()];
  unique.sort((a, b) => Number(b.affectsLocation) - Number(a.affectsLocation));
  const alerts = unique;
  const activeForLocation = unique.filter(a => a.affectsLocation);

  return {
    source: 'SMN / CAP',
    generatedAt: new Date().toISOString(),
    location: { lat, lon },
    feedItemsFound: selectedUrls.length,
    alerts,
    activeForLocation,
    diagnostics,
  };
}
async function rainbow(request, env, q) {
  if (!env.RAINBOW_API_KEY) return json({ error: 'Radar no configurado: falta el secreto RAINBOW_API_KEY.' }, 503);
  const headers = { 'Ocp-Apim-Subscription-Key': env.RAINBOW_API_KEY };
  if (q.resource === 'radar-snapshot') {
    const layer = ['radars', 'precip', 'precip-global', 'clouds'].includes(q.layer) ? q.layer : 'radars';
    const r = await fetch(`${RAINBOW}/tiles/v1/snapshot?layer=${encodeURIComponent(layer)}`, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return json({ error: `Rainbow snapshot respondió HTTP ${r.status}` }, r.status);
    return new Response(await r.text(), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=180' } });
  }
  const { snapshot, z, x, y } = q;
  if (![snapshot, z, x, y].every(v => /^\d+$/.test(v || ''))) return json({ error: 'Parámetros de mosaico inválidos.' }, 400);
  const layer = q.layer === 'precip' ? 'precip' : 'radars';
  const forecast = q.forecast || '0';
  if (!/^\d+$/.test(forecast)) return json({ error: 'Pronóstico inválido.' }, 400);
  const path = layer === 'precip'
    ? `/tiles/v1/precip/${snapshot}/${forecast}/${z}/${x}/${y}`
    : `/tiles/v1/radars/${snapshot}/${z}/${x}/${y}`;
  const upstream = await fetch(`${RAINBOW}${path}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!upstream.ok) return json({ error: `Rainbow tile respondió HTTP ${upstream.status}` }, upstream.status);
  return new Response(upstream.body, { headers: { ...CORS, 'Content-Type': upstream.headers.get('Content-Type') || 'image/png', 'Cache-Control': 'public, max-age=180' } });
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
        return json(data, 200, { 'Cache-Control': 'public, max-age=120' });
      }
      if (q.resource === 'radar-snapshot' || q.resource === 'radar-tile') return await rainbow(request, env, q);
      return json({ error: 'Recurso no reconocido. Usá resource=health, alerts, radar-snapshot o radar-tile.' }, 404);
    } catch (e) {
      return json({ error: 'No se pudo completar la consulta meteorológica.', detail: String(e?.message || e) }, 502, { 'Cache-Control': 'no-store' });
    }
  },
};
// ClimaGo - primera compilación desde GitHub
