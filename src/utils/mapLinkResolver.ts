import { Coordinates, extractCoordinatesFromText } from './geoUtils';

const asyncResolutionCache = new Map<string, Coordinates | null>();
const pendingResolutions = new Map<string, Promise<Coordinates | null>>();

/**
 * Checks whether a URL is a shortened map link (e.g. maps.app.goo.gl, goo.gl/maps, g.co).
 */
export function isShortenedMapUrl(url?: string | null): boolean {
  if (!url || typeof url !== 'string') return false;
  const lower = url.trim().toLowerCase();
  return (
    lower.includes('maps.app.goo.gl') ||
    lower.includes('goo.gl/maps') ||
    lower.includes('g.co/maps') ||
    lower.includes('g.co/kgs')
  );
}

/**
 * Extracts a searchable place/query name from Google Maps URLs like:
 * - https://www.google.com/maps/place/Some+Place+Name/...
 * - https://maps.google.com/?q=Some+Place+Name
 */
export function extractPlaceQueryFromMapUrl(url?: string | null): string {
  if (!url || typeof url !== 'string') return '';
  try {
    const parsed = new URL(url.trim());
    const qParam = parsed.searchParams.get('q') || parsed.searchParams.get('query');
    if (qParam && !extractCoordinatesFromText(qParam)) {
      return qParam.replace(/\+/g, ' ').trim();
    }
    const placeMatch = decodeURIComponent(parsed.pathname).match(/\/place\/([^/]+)/i);
    if (placeMatch && placeMatch[1]) {
      const name = placeMatch[1].replace(/\+/g, ' ').trim();
      if (name && !extractCoordinatesFromText(name)) {
        return name;
      }
    }
  } catch {
    // ignore malformed URL
  }
  return '';
}

/**
 * Resolves a merchant location link or place/address asynchronously to GPS coordinates
 * using direct parsing first, then optional Cloud Function redirect unshortener (if deployed),
 * and OpenStreetMap Nominatim geocoding for named places.
 */
export async function resolveMapUrlToCoordinates(
  locationUrl?: string | null,
  fallbackAddress?: string | null
): Promise<Coordinates | null> {
  const url = (locationUrl || '').trim();
  const address = (fallbackAddress && fallbackAddress !== '—' ? fallbackAddress : '').trim();
  if (!url && !address) return null;

  // 1. Synchronous coordinate parsing
  if (url) {
    const direct = extractCoordinatesFromText(url);
    if (direct) return direct;
  }

  const cacheKey = `${url}||${address}`;
  if (asyncResolutionCache.has(cacheKey)) {
    return asyncResolutionCache.get(cacheKey) ?? null;
  }

  if (pendingResolutions.has(cacheKey)) {
    return pendingResolutions.get(cacheKey)!;
  }

  const promise = (async (): Promise<Coordinates | null> => {
    try {
      // 2. If shortened URL, check optional configured resolver endpoint (e.g. Cloud Function)
      const resolverEndpoint = import.meta.env.VITE_MAP_URL_RESOLVER_URL as string | undefined;
      if (url && isShortenedMapUrl(url) && resolverEndpoint) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 5000);
          const resp = await fetch(
            `${resolverEndpoint}?url=${encodeURIComponent(url)}`,
            { signal: ctrl.signal }
          );
          clearTimeout(timer);
          if (resp.ok) {
            const payload = await resp.json();
            if (typeof payload?.lat === 'number' && typeof payload?.lng === 'number') {
              const resolved = { lat: payload.lat, lng: payload.lng };
              asyncResolutionCache.set(cacheKey, resolved);
              return resolved;
            }
            if (payload?.resolvedUrl) {
              const parsed = extractCoordinatesFromText(payload.resolvedUrl);
              if (parsed) {
                asyncResolutionCache.set(cacheKey, parsed);
                return parsed;
              }
            }
          }
        } catch {
          // Silently continue to Nominatim / manual fallback if Cloud Function is unavailable
        }
      }

      // 3. Extract place query from Google Maps URL (e.g. /maps/place/Name or ?q=Name) and geocode via OpenStreetMap Nominatim
      const placeQuery = extractPlaceQueryFromMapUrl(url);
      if (placeQuery) {
        try {
          const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
            placeQuery
          )}`;
          const resp = await fetch(nominatimUrl, {
            headers: { Accept: 'application/json' },
          });
          if (resp.ok) {
            const items = await resp.json();
            if (Array.isArray(items) && items.length > 0) {
              const lat = parseFloat(items[0].lat);
              const lng = parseFloat(items[0].lon);
              if (!isNaN(lat) && !isNaN(lng)) {
                const coords = { lat, lng };
                asyncResolutionCache.set(cacheKey, coords);
                return coords;
              }
            }
          }
        } catch {
          // ignore network errors
        }
      }

      asyncResolutionCache.set(cacheKey, null);
      return null;
    } finally {
      pendingResolutions.delete(cacheKey);
    }
  })();

  pendingResolutions.set(cacheKey, promise);
  return promise;
}
