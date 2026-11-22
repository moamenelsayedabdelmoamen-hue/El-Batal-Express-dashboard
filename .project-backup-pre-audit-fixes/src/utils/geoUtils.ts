/**
 * Utilities for geolocation calculations and coordinate handling
 * for El Batal Express Live Map dashboard.
 */

export interface Coordinates {
  lat: number;
  lng: number;
}

function isValidCoordPair(lat?: number, lng?: number): boolean {
  return (
    lat !== undefined &&
    lng !== undefined &&
    !isNaN(lat) &&
    !isNaN(lng) &&
    !(lat === 0 && lng === 0) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

function dmsToDecimal(deg: number, min: number, sec: number, hemi: string): number {
  const abs = Math.abs(deg) + min / 60 + sec / 3600;
  const h = hemi.toUpperCase();
  return h === 'S' || h === 'W' ? -abs : abs;
}

/**
 * Extracts latitude and longitude from a Google Maps / OpenStreetMap / Apple Maps / Waze URL or plain "lat, lng" string.
 */
export function extractCoordinatesFromText(input?: string | null): Coordinates | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    decoded = trimmed;
  }

  // First try explicit URL / embed / parameter patterns (most accurate pin location first)
  const patterns: RegExp[] = [
    // Google Maps embed / place URLs: !3d30.0444!4d31.2357 (pin lat/lng)
    /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/i,
    // Google Maps pb embed format: !2d31.2357!3d30.0444 (note: 2d is lng, 3d is lat)
    /!2d(-?\d{1,3}\.\d+)!3d(-?\d{1,2}\.\d+)/i,
    // Query params: q=lat,lng | query=lat,lng | ll=lat,lng | center=lat,lng | destination=lat,lng | sll=lat,lng | viewpoint=lat,lng
    /[?&](?:q|query|ll|sll|center|destination|daddr|saddr|origin|viewpoint)=(?:loc:)?(-?\d{1,2}\.\d+)[,\s+]+(-?\d{1,3}\.\d+)/i,
    // Path segment: /search/lat,lng or /dir//lat,lng or /place/lat,lng
    /\/(?:search|place|dir\/[^/]*)\/@?(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/i,
    // Google Maps @lat,lng
    /@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/,
    // OpenStreetMap query params: mlat=..&mlon=..
    /[?&]mlat=(-?\d{1,2}\.\d+)&mlon=(-?\d{1,3}\.\d+)/i,
    // OpenStreetMap hash: #map=zoom/lat/lng
    /#map=\d+\/(-?\d{1,2}\.\d+)\/(-?\d{1,3}\.\d+)/i,
    // geo:lat,lng
    /geo:(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/i,
    // Plain "lat, lng" (strict full string or standalone decimal pair)
    /^\s*(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)\s*$/,
  ];

  for (let i = 0; i < patterns.length; i++) {
    const match = decoded.match(patterns[i]);
    if (match) {
      // Index 1 is !2d(lng)!3d(lat), so swap lat/lng
      const lat = parseFloat(i === 1 ? match[2] : match[1]);
      const lng = parseFloat(i === 1 ? match[1] : match[2]);
      if (isValidCoordPair(lat, lng)) {
        return { lat, lng };
      }
    }
  }

  // DMS format: e.g. 30°02'39.8"N 31°14'08.5"E
  const dmsRegex =
    /(\d{1,2})°\s*(\d{1,2})['′]\s*(\d{1,2}(?:\.\d+)?)["″]?\s*([NS])[,\s]+(\d{1,3})°\s*(\d{1,2})['′]\s*(\d{1,2}(?:\.\d+)?)["″]?\s*([EW])/i;
  const dmsMatch = decoded.match(dmsRegex);
  if (dmsMatch) {
    const lat = dmsToDecimal(
      parseFloat(dmsMatch[1]),
      parseFloat(dmsMatch[2]),
      parseFloat(dmsMatch[3]),
      dmsMatch[4]
    );
    const lng = dmsToDecimal(
      parseFloat(dmsMatch[5]),
      parseFloat(dmsMatch[6]),
      parseFloat(dmsMatch[7]),
      dmsMatch[8]
    );
    if (isValidCoordPair(lat, lng)) {
      return { lat, lng };
    }
  }

  // Fallback: extract embedded "lat, lng" inside descriptive strings if decimals are >= 3 digits
  const embeddedPair = decoded.match(/(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/);
  if (embeddedPair) {
    const lat = parseFloat(embeddedPair[1]);
    const lng = parseFloat(embeddedPair[2]);
    if (isValidCoordPair(lat, lng)) {
      return { lat, lng };
    }
  }

  return null;
}

const IMAGE_URL_REGEX = /\.(?:jpe?g|png|webp|gif|svg|bmp)(?:\?|$)/i;

function isLikelyMapUrl(str: string): boolean {
  const lower = str.toLowerCase();
  if (lower.includes('firebasestorage.googleapis.com') || IMAGE_URL_REGEX.test(lower)) {
    return false;
  }
  return (
    lower.startsWith('geo:') ||
    lower.includes('google.com/maps') ||
    lower.includes('maps.google.') ||
    lower.includes('maps.app.goo.gl') ||
    lower.includes('goo.gl/maps') ||
    lower.includes('g.co/maps') ||
    lower.includes('openstreetmap.org') ||
    lower.includes('maps.apple.com') ||
    lower.includes('waze.com') ||
    lower.includes('bing.com/maps') ||
    lower.includes('yandex.')
  );
}

function deepScanForMapUrl(obj: unknown, depth = 0): string {
  if (!obj || depth > 3) return '';
  if (typeof obj === 'string') {
    const s = obj.trim();
    if (!s) return '';
    const match = s.match(/(https?:\/\/[^\s"'<>]+|geo:[^\s"'<>]+)/i);
    if (match && isLikelyMapUrl(match[1])) {
      return match[1];
    }
    return '';
  }
  if (typeof obj === 'object' && !Array.isArray(obj)) {
    // Skip Firestore Timestamp / GeoPoint internals
    const rec = obj as Record<string, any>;
    if (typeof rec.toDate === 'function' || ('seconds' in rec && 'nanoseconds' in rec)) {
      return '';
    }
    for (const [key, value] of Object.entries(rec)) {
      const kLower = key.toLowerCase();
      if (kLower.includes('logo') || kLower.includes('image') || kLower.includes('avatar') || kLower.includes('photo')) {
        continue;
      }
      const found = deepScanForMapUrl(value, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function deepScanForCoordinates(obj: unknown, depth = 0): Coordinates | null {
  if (!obj || depth > 3) return null;
  if (typeof obj === 'string') {
    const s = obj.trim();
    if (!s || s.includes('firebasestorage.googleapis.com') || IMAGE_URL_REGEX.test(s)) return null;
    if (isLikelyMapUrl(s) || extractCoordinatesFromText(s)) {
      return extractCoordinatesFromText(s);
    }
    return null;
  }
  if (typeof obj === 'object') {
    const rec = obj as Record<string, any>;
    if (typeof rec.toDate === 'function' || ('seconds' in rec && 'nanoseconds' in rec)) {
      return null;
    }

    let lat: number | undefined;
    let lng: number | undefined;
    if (rec.latitude !== undefined && rec.longitude !== undefined) {
      lat = Number(rec.latitude);
      lng = Number(rec.longitude);
    } else if (rec.lat !== undefined && rec.lng !== undefined) {
      lat = Number(rec.lat);
      lng = Number(rec.lng);
    } else if (rec._lat !== undefined && rec._long !== undefined) {
      lat = Number(rec._lat);
      lng = Number(rec._long);
    }
    if (isValidCoordPair(lat, lng)) {
      return { lat: lat!, lng: lng! };
    }

    for (const [key, value] of Object.entries(rec)) {
      const kLower = key.toLowerCase();
      if (kLower.includes('logo') || kLower.includes('image') || kLower.includes('avatar') || kLower.includes('photo')) {
        continue;
      }
      const found = deepScanForCoordinates(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Extracts a merchant / location URL from various Firestore fields.
 * If no explicit URL exists, optionally generates a Google Maps URL from valid coordinates.
 */
export function extractLocationUrl(raw: any, fallbackCoords?: Coordinates | null): string {
  if (raw && typeof raw === 'object') {
    const locObj = typeof raw.location === 'object' && raw.location ? raw.location : null;
    const candidateFields = [
      raw.locationUrl,
      raw.location_url,
      raw.locationLink,
      raw.location_link,
      raw.mapUrl,
      raw.map_url,
      raw.mapLink,
      raw.map_link,
      raw.googleMapsUrl,
      raw.google_maps_url,
      raw.googleMapsLink,
      raw.google_maps_link,
      raw.googleMapUrl,
      raw.google_map_url,
      raw.mapsUrl,
      raw.maps_url,
      raw.mapsLink,
      raw.maps_link,
      raw.shareLocationUrl,
      raw.storeLocationUrl,
      raw.merchantLocationUrl,
      raw.storeMapUrl,
      raw.merchantMapUrl,
      raw.shopLocationUrl,
      raw.shopLink,
      raw.storeLink,
      raw.gpsUrl,
      raw.gps_url,
      raw.gpsLink,
      raw.branchLocationUrl,
      raw.coordinatesUrl,
      raw.addressLink,
      raw.addressUrl,
      raw.map,
      locObj?.url,
      locObj?.link,
      locObj?.mapUrl,
      locObj?.locationUrl,
      typeof raw.location === 'string' ? raw.location : undefined,
      typeof raw.address === 'string' && raw.address.includes('http') ? raw.address : undefined,
    ];

    for (const val of candidateFields) {
      if (typeof val === 'string') {
        const s = val.trim();
        if (!s) continue;
        // Extract URL if text contains surrounding labels
        const urlMatch = s.match(/(https?:\/\/[^\s"'<>]+|geo:[^\s"'<>]+)/i);
        if (urlMatch) {
          return urlMatch[1];
        }
      }
    }

    // Fallback: deep scan all fields in the Firestore doc for any map URL
    const scannedUrl = deepScanForMapUrl(raw);
    if (scannedUrl) {
      return scannedUrl;
    }
  }

  if (fallbackCoords && isValidCoordPair(fallbackCoords.lat, fallbackCoords.lng)) {
    return `https://www.google.com/maps?q=${fallbackCoords.lat},${fallbackCoords.lng}`;
  }

  return '';
}

/**
 * Extracts valid latitude and longitude from various Firestore data structures.
 * Supports:
 * - Firestore GeoPoint ({ latitude, longitude } or { _lat, _long })
 * - Nested objects: item.location, item.coordinates, item.coords, item.position, item.storeLocation
 * - Top level: item.lat & item.lng, item.latitude & item.longitude (numbers or numeric strings)
 * - Google Maps / OpenStreetMap / Apple Maps URLs or "lat, lng" strings in locationUrl / mapUrl / location
 * - Deep scan across any custom nested or flat fields in the Firestore doc
 */
export function extractCoordinates(raw: any): Coordinates | null {
  if (!raw) return null;

  if (typeof raw === 'string') {
    return extractCoordinatesFromText(raw);
  }

  // Direct target or nested location objects
  const locCandidates = [
    raw.location,
    raw.coordinates,
    raw.coords,
    raw.position,
    raw.geo,
    raw.geoLocation,
    raw.storeLocation,
    raw.merchantLocation,
    raw.branchLocation,
    raw.gps,
    raw.point,
    raw,
  ];

  for (const loc of locCandidates) {
    if (!loc) continue;
    if (typeof loc === 'string') {
      const parsedFromLocStr = extractCoordinatesFromText(loc);
      if (parsedFromLocStr) return parsedFromLocStr;
      continue;
    }

    if (typeof loc === 'object') {
      let lat: number | undefined;
      let lng: number | undefined;

      if (loc.latitude !== undefined && loc.longitude !== undefined) {
        lat = Number(loc.latitude);
        lng = Number(loc.longitude);
      } else if (loc.lat !== undefined && loc.lng !== undefined) {
        lat = Number(loc.lat);
        lng = Number(loc.lng);
      } else if (loc._lat !== undefined && loc._long !== undefined) {
        lat = Number(loc._lat);
        lng = Number(loc._long);
      } else if (Array.isArray(loc) && loc.length >= 2) {
        lat = Number(loc[0]);
        lng = Number(loc[1]);
      }

      if (isValidCoordPair(lat, lng)) {
        return { lat: lat!, lng: lng! };
      }

      // Check nested URL inside location object
      const nestedUrl = loc.url || loc.link || loc.mapUrl || loc.locationUrl;
      if (typeof nestedUrl === 'string') {
        const parsedNested = extractCoordinatesFromText(nestedUrl);
        if (parsedNested) return parsedNested;
      }
    }
  }

  // Fallback to parsing coordinates from location URL / map link fields
  const urlCandidates = [
    raw.locationUrl,
    raw.location_url,
    raw.locationLink,
    raw.location_link,
    raw.mapUrl,
    raw.map_url,
    raw.mapLink,
    raw.map_link,
    raw.googleMapsUrl,
    raw.google_maps_url,
    raw.googleMapsLink,
    raw.google_maps_link,
    raw.googleMapUrl,
    raw.google_map_url,
    raw.mapsUrl,
    raw.maps_url,
    raw.mapsLink,
    raw.maps_link,
    raw.shareLocationUrl,
    raw.storeLocationUrl,
    raw.merchantLocationUrl,
    raw.storeMapUrl,
    raw.merchantMapUrl,
    raw.shopLocationUrl,
    raw.shopLink,
    raw.storeLink,
    raw.gpsUrl,
    raw.gps_url,
    raw.gpsLink,
    raw.branchLocationUrl,
    raw.coordinatesUrl,
    raw.addressLink,
    raw.addressUrl,
    raw.map,
    raw.address,
  ];

  for (const candidate of urlCandidates) {
    if (typeof candidate === 'string') {
      const parsed = extractCoordinatesFromText(candidate);
      if (parsed) return parsed;
    }
  }

  // Final deep scan across any unexpected field names inside Firestore doc
  return deepScanForCoordinates(raw);
}

/**
 * Calculates straight-line geographical distance between two points in kilometers
 * using the Haversine formula.
 */
export function haversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const d = R * c;

  return Math.round(d * 100) / 100; // 2 decimal places
}

/**
 * Formats a distance in kilometers to a human-friendly Arabic string.
 * Example: 0.8 كم or 850 م
 */
export function formatDistanceArabic(km: number): string {
  if (km < 1) {
    const meters = Math.round(km * 1000);
    return `${meters} م`;
  }
  return `${km.toFixed(1)} كم`;
}

/**
 * Evaluates whether a location timestamp is fresh based on a threshold (default: 3 minutes).
 */
export function isLocationFresh(
  rawTimestamp: any,
  thresholdMinutes: number = 3
): {
  isFresh: boolean;
  minutesAgo: number;
  formattedTime: string;
} {
  if (!rawTimestamp) {
    return {
      isFresh: false,
      minutesAgo: 9999,
      formattedTime: 'غير متوفر',
    };
  }

  let date: Date;

  if (typeof rawTimestamp === 'object' && typeof rawTimestamp.toDate === 'function') {
    date = rawTimestamp.toDate();
  } else if (rawTimestamp instanceof Date) {
    date = rawTimestamp;
  } else if (typeof rawTimestamp === 'number') {
    const ms = rawTimestamp < 10000000000 ? rawTimestamp * 1000 : rawTimestamp;
    date = new Date(ms);
  } else if (typeof rawTimestamp === 'string') {
    date = new Date(rawTimestamp);
  } else {
    return {
      isFresh: false,
      minutesAgo: 9999,
      formattedTime: 'غير معروف',
    };
  }

  const now = Date.now();
  const diffMs = Math.max(0, now - date.getTime());
  const minutesAgo = Math.floor(diffMs / 60000);
  const secondsAgo = Math.floor(diffMs / 1000);

  let formattedTime = '';
  if (secondsAgo < 60) {
    formattedTime = 'منذ ثوانٍ';
  } else if (minutesAgo < 60) {
    formattedTime = `منذ ${minutesAgo} دقيقة`;
  } else {
    const hoursAgo = Math.floor(minutesAgo / 60);
    formattedTime = `منذ ${hoursAgo} ساعة`;
  }

  return {
    isFresh: minutesAgo <= thresholdMinutes,
    minutesAgo,
    formattedTime,
  };
}
