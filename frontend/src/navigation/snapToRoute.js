// -----------------------------------------------------------------------------
// snapToRoute.js — geometry helpers for live navigation (Phase 2+).
// Phase 1 only needs bearing math for heading-up camera follow.
// -----------------------------------------------------------------------------

const R = 6371000;

export function bearingBetween(lng1, lat1, lng2, lat2) {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function resolveHeading(gpsHeading, prev, curr) {
  if (Number.isFinite(gpsHeading) && gpsHeading >= 0) return gpsHeading;
  if (prev && curr) {
    return bearingBetween(prev.lng, prev.lat, curr.lng, curr.lat);
  }
  return null;
}

export function haversineM([lng1, lat1], [lng2, lat2]) {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
