// =============================================================================
// App.jsx — the entire Manvir Map application in one file.
//
// What this file does, at a glance:
//   1. Renders a full-screen MapLibre map.
//   2. Lets the user search for an origin and destination using Photon (a
//      self-hosted geocoder reachable at `/photon/...`).
//   3. Asks Valhalla (a self-hosted routing engine reachable at `/api/route`)
//      for a driving route between those two points.
//   4. Optionally finds "scenic" detour waypoints by querying the public
//      Overpass API for nearby parks, viewpoints, etc., and feeds those
//      waypoints back into Valhalla as `through` locations to bend the route.
//   5. Draws the resulting route line plus markers on the map and shows
//      distance + duration in a glassmorphic control panel.
//
// The file is intentionally a single component tree so a beginner can read it
// top to bottom. The order is: constants → pure helpers → SearchBox component
// → main App component → JSX → embedded <style> block.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { DirectionsList } from "./navigation/DirectionsList.jsx";
import { NavigationBar } from "./navigation/NavigationBar.jsx";
import { StartNavigationButton } from "./navigation/StartNavigationButton.jsx";
import { formatDuration, parseDirections } from "./navigation/parseDirections.js";
import { useNavigation } from "./navigation/useNavigation.js";

// -----------------------------------------------------------------------------
// DETOUR_LEVELS — how aggressively to look for scenic stops when the user
// picks Scenic mode.
//   corridorKm    : how far (km) off the straight line between origin and
//                   destination we'll consider a candidate scenic feature.
//   maxWaypoints  : how many scenic stops to insert into the route at most.
//   label         : text shown on the Light / Medium / Heavy toggle buttons.
// -----------------------------------------------------------------------------
const DETOUR_LEVELS = {
  light: { corridorKm: 4, maxWaypoints: 1, label: "Light" },
  medium: { corridorKm: 10, maxWaypoints: 2, label: "Medium" },
  heavy: { corridorKm: 22, maxWaypoints: 5, label: "Heavy" },
};

// -----------------------------------------------------------------------------
// SCENIC_FEATURE_WEIGHTS — scoring weights for different kinds of scenic
// features returned by Overpass. Higher = more desirable as a detour. A
// dedicated viewpoint beats a generic city park.
// -----------------------------------------------------------------------------
const SCENIC_FEATURE_WEIGHTS = {
  viewpoint: 4,
  scenic: 3.5,
  national_park: 3,
  water: 2,
  park: 1.2,
};

// -----------------------------------------------------------------------------
// toLocalMeters — convert a (lat,lng) pair into a flat (x,y) in metres,
// centered on a reference point. This is an "equirectangular" projection that
// is fine for short distances (tens of km) because the curvature of the earth
// is negligible at that scale. We use it so segment-distance math becomes
// simple Euclidean geometry instead of great-circle calculations.
// -----------------------------------------------------------------------------
function toLocalMeters(lat, lng, refLat, refLng) {
  const R = 6371000; // mean radius of Earth in metres
  const x = (R * Math.cos((refLat * Math.PI) / 180) * (lng - refLng) * Math.PI) / 180;
  const y = (R * (lat - refLat) * Math.PI) / 180;
  return [x, y];
}

// -----------------------------------------------------------------------------
// projectOntoSegment — given a point `p` and a line segment from `a` to `b`
// (all in local meters), return:
//   dist : perpendicular distance from p to the line containing a→b
//   t    : how far along the segment the projection lands (0=at a, 1=at b,
//          values outside [0,1] mean the projection falls beyond the endpoints)
//
// We use `t` to filter out scenic candidates that would force the driver to
// double back behind the origin or overshoot the destination, and `dist` to
// require candidates to lie within the corridor width.
// -----------------------------------------------------------------------------
function projectOntoSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { dist: Math.hypot(p[0] - a[0], p[1] - a[1]), t: 0 };
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  // tc is t clamped to [0,1] so the foot of the perpendicular is on the
  // segment itself when computing the actual distance.
  const tc = Math.max(0, Math.min(1, t));
  const px = a[0] + tc * dx, py = a[1] + tc * dy;
  return { dist: Math.hypot(p[0] - px, p[1] - py), t };
}

// -----------------------------------------------------------------------------
// decodePolyline — Valhalla returns each route leg's shape as a "polyline6"
// encoded string (Google's polyline format with 6 decimal places of precision
// instead of the usual 5). This decoder walks the string and rebuilds an
// array of [lng, lat] pairs that MapLibre can render as a LineString.
//
// The format packs each lat/lng delta as a variable-length base-64 integer,
// using 5 bits per character and the high bit as a "more chunks coming" flag.
// -----------------------------------------------------------------------------
function decodePolyline(encoded) {
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  const len = encoded.length;
  while (index < len) {
    let b, shift = 0, result = 0;
    // Decode latitude delta. Bounds-check `index` and cap `shift` so a
    // truncated or malformed polyline can never spin into an infinite loop
    // — return whatever we've decoded so far.
    do {
      if (index >= len) return coords;
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (shift > 35) return coords;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    // Decode longitude delta. Same guards as above.
    shift = 0;
    result = 0;
    do {
      if (index >= len) return coords;
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (shift > 35) return coords;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    // MapLibre wants [lng, lat]; precision is 1e-6 because Valhalla uses
    // polyline6.
    coords.push([lng / 1e6, lat / 1e6]);
  }
  return coords;
}

// -----------------------------------------------------------------------------
// scenicCache — in-memory LRU-ish cache for findScenicWaypoints. Overpass
// queries are slow (1–20s) and the user often retries the same origin/dest
// with different routing toggles, so caching the heavy network call lets the
// route refresh feel snappy.
//
// The Map preserves insertion order; we drop the oldest key once we hit
// SCENIC_CACHE_MAX. Cache survives only for the current page load.
// -----------------------------------------------------------------------------
const scenicCache = new Map();
const SCENIC_CACHE_MAX = 32;

// -----------------------------------------------------------------------------
// findScenicWaypoints — query Overpass for candidate scenic features in a
// rectangle around the straight-line corridor between origin and dest, score
// them, and pick the best ones to use as routing waypoints.
//
// Returns: array of { lat, lng, type, name } in route order (smallest t to
//          largest t along the origin→dest segment).
//
// Why this is non-trivial:
//   - Overpass is a shared public service so we keep the query tight.
//   - We have to project candidates onto the origin→dest segment to make sure
//     they actually lie *between* the endpoints, not behind or beyond them.
//   - We enforce a minimum spacing along the segment so we don't pick 5 parks
//     all clustered in the same town.
// -----------------------------------------------------------------------------
async function findScenicWaypoints(origin, dest, level, signal) {
  // Cache key includes the level (corridor width) and rounded coords so trips
  // that start "basically here" reuse the same result.
  const cacheKey = `${level}:${origin.lat.toFixed(3)},${origin.lng.toFixed(3)}->${dest.lat.toFixed(3)},${dest.lng.toFixed(3)}`;
  if (scenicCache.has(cacheKey)) return scenicCache.get(cacheKey);

  const { corridorKm, maxWaypoints } = DETOUR_LEVELS[level];
  // 1° of latitude is ~111 km. Padding the bbox by corridorKm/111 degrees in
  // each direction approximates the corridor width without doing real
  // projection math. Good enough at Ontario latitudes.
  const pad = corridorKm / 111;
  const south = Math.min(origin.lat, dest.lat) - pad;
  const north = Math.max(origin.lat, dest.lat) + pad;
  const west = Math.min(origin.lng, dest.lng) - pad;
  const east = Math.max(origin.lng, dest.lng) + pad;
  const bbox = `${south},${west},${north},${east}`;

  // Overpass QL query — fetch tourism viewpoints, scenic-tagged ways, parks,
  // and national parks inside the bbox. `out center 300` asks for at most 300
  // results with a single centerpoint per way/relation (we don't need full
  // geometry, just a representative coordinate).
  const query = `
[out:json][timeout:20];
(
  node["tourism"="viewpoint"](${bbox});
  way["scenic"="yes"](${bbox});
  way["leisure"="park"](${bbox});
  rel["leisure"="park"](${bbox});
  way["boundary"="national_park"](${bbox});
  rel["boundary"="national_park"](${bbox});
);
out center 300;
`.trim();

  let elements;
  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
      signal,
    });
    if (!res.ok) throw new Error("overpass " + res.status);
    const json = await res.json();
    elements = json.elements || [];
  } catch (e) {
    // Caller aborted (e.g. newer request superseded this one) — rethrow so
    // the calling fetchRoute can bail before touching state.
    if (e?.name === "AbortError") throw e;
    // Network or server error — silently fall back to "no detours" so the
    // main route still gets calculated.
    return [];
  }

  // Set up a local-meter coordinate system centered on the midpoint of the
  // trip so segment math stays accurate for trips up to a few hundred km.
  const refLat = (origin.lat + dest.lat) / 2;
  const refLng = (origin.lng + dest.lng) / 2;
  const a = toLocalMeters(origin.lat, origin.lng, refLat, refLng);
  const b = toLocalMeters(dest.lat, dest.lng, refLat, refLng);
  const corridorM = corridorKm * 1000;
  // Reject candidates too close to the endpoints. Heavy mode is more
  // permissive because the user explicitly asked for big detours.
  const minT = level === "heavy" ? 0.1 : 0.15;
  const maxT = level === "heavy" ? 0.9 : 0.85;

  const candidates = [];
  for (const el of elements) {
    // Overpass nodes carry lat/lon directly; ways/relations carry .center.
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;

    // Classify the element into one of our weighted types.
    const tags = el.tags || {};
    let type;
    if (tags.tourism === "viewpoint") type = "viewpoint";
    else if (tags.scenic === "yes") type = "scenic";
    else if (tags.boundary === "national_park") type = "national_park";
    else if (tags.natural === "water") type = "water";
    else if (tags.leisure === "park") type = "park";
    else continue;

    // Project onto the origin→dest segment and filter by position + offset.
    const p = toLocalMeters(lat, lng, refLat, refLng);
    const { dist, t } = projectOntoSegment(p, a, b);
    if (t < minT || t > maxT) continue;
    if (dist > corridorM) continue;

    // Score = type weight, penalized by how far off the line we'd have to
    // drive (1500m softens the falloff).
    const weight = SCENIC_FEATURE_WEIGHTS[type];
    const score = weight / (1 + dist / 1500);
    candidates.push({ lat, lng, type, dist, t, score, name: tags.name });
  }

  // Best-scoring candidates first.
  candidates.sort((x, y) => y.score - x.score);

  // Greedy pick with spacing constraint so the waypoints aren't piled on top
  // of each other along the route.
  const picked = [];
  const minSpacing = level === "heavy" ? 0.13 : 0.25;
  for (const c of candidates) {
    if (picked.length >= maxWaypoints) break;
    if (picked.some((p) => Math.abs(p.t - c.t) < minSpacing)) continue;
    picked.push(c);
  }
  // Hand them back to Valhalla in route order (origin → ... → dest).
  picked.sort((x, y) => x.t - y.t);

  // Trim cache to avoid unbounded growth across a long session.
  if (scenicCache.size >= SCENIC_CACHE_MAX) {
    scenicCache.delete(scenicCache.keys().next().value);
  }
  scenicCache.set(cacheKey, picked);
  return picked;
}

// -----------------------------------------------------------------------------
// MODES — the three routing presets shown as a segmented control at the top
// of the panel. `id` matches keys in baseCosting{} inside fetchRoute().
// -----------------------------------------------------------------------------
const MODES = [
  {
    id: "normal",
    label: "Normal",
    icon: "🗺️",
    color: "#3b82f6",
    desc: "Fastest route",
  },
  {
    id: "newDriver",
    label: "New Driver",
    icon: "🚗",
    color: "#f59e0b",
    desc: "Avoids highways & tolls",
  },
  {
    id: "scenic",
    label: "Scenic",
    icon: "🌲",
    color: "#22c55e",
    desc: "Prefers scenic roads",
  },
];

// =============================================================================
// SearchBox — autocomplete input bound to the Photon geocoder.
//
// Props:
//   label, icon         : placeholder + (unused) icon for the input
//   value, onChange     : controlled-input glue
//   onSelect            : called with { lng, lat, name } when user picks a row
//   onClear             : optional; if provided, an "×" button appears
//   inputRef            : optional ref to the underlying <input>
//   onFocus             : extra side-effect to run when the input gains focus
//                         (used to expand the mobile panel)
//   biasLat, biasLng    : optional location bias for Photon — results closer
//                         to this point are preferred
//
// Network behavior:
//   - Debounces 200ms before firing a request.
//   - Aborts the in-flight request when a new keystroke arrives.
//   - Uses a monotonic request id to ignore late responses that arrive out of
//     order (in case AbortController didn't quite win the race).
// =============================================================================
function SearchBox({ label, icon, value, onChange, onSelect, onClear, inputRef, onFocus: onFocusProp, biasLat, biasLng }) {
  // Dropdown rows from Photon.
  const [results, setResults] = useState([]);
  // Whether the input has focus — controls dropdown visibility + border color.
  const [focused, setFocused] = useState(false);
  // Index of the keyboard-highlighted row (-1 = none).
  const [highlight, setHighlight] = useState(-1);
  // Ref to the AbortController for the currently in-flight Photon request.
  const abortRef = useRef(null);
  // Ref to the pending debounce timeout.
  const debounceRef = useRef(null);
  // Monotonic counter so older fetches can be discarded if they resolve late.
  const reqIdRef = useRef(0);

  // Cleanup on unmount: cancel any pending debounce + in-flight fetch.
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
  }, []);

  // Fire the actual Photon search for the given query value.
  function runSearch(val) {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const myId = ++reqIdRef.current;
    // Photon supports `lat`/`lon` for biasing search results toward a point.
    // Defense-in-depth: coerce to Number so any non-numeric prop value can't
    // smuggle extra query-string syntax (`&foo=bar`) into the URL.
    const bLat = Number(biasLat);
    const bLng = Number(biasLng);
    const bias = Number.isFinite(bLat) && Number.isFinite(bLng)
      ? `&lat=${bLat}&lon=${bLng}`
      : "";
    fetch(`/photon/api?q=${encodeURIComponent(val)}&limit=5${bias}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((data) => {
        // Drop the response if a newer request started after this one.
        if (myId !== reqIdRef.current) return;
        setResults(Array.isArray(data.features) ? data.features : []);
        setHighlight(-1);
      })
      .catch((e) => {
        // Ignore aborts (those are intentional); reset on real errors.
        if (e.name !== "AbortError") setResults([]);
      });
  }

  // Input onChange handler. Debounces and short-circuits on tiny queries.
  function handleChange(e) {
    const val = e.target.value;
    onChange(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (val.length < 3) {
      // Don't pester Photon with single- or two-letter queries — they return
      // too much noise anyway.
      abortRef.current?.abort();
      setResults([]);
      setHighlight(-1);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(val), 200);
  }

  // Format a Photon feature's properties into a single human-readable line.
  function formatName(props) {
    return [props.name, props.street, props.city, props.state]
      .filter(Boolean)
      .join(", ");
  }

  // Commit the chosen result back up to the parent.
  function handleSelect(feature) {
    const [lng, lat] = feature.geometry.coordinates;
    const name = formatName(feature.properties);
    setResults([]);
    setHighlight(-1);
    onSelect({ lng, lat, name });
  }

  // Keyboard navigation in the dropdown: arrows, Enter, Escape.
  function handleKeyDown(e) {
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? results.length - 1 : h - 1));
    } else if (e.key === "Enter") {
      // If nothing's highlighted yet, default to the first result.
      const idx = highlight >= 0 ? highlight : 0;
      if (results[idx]) {
        e.preventDefault();
        handleSelect(results[idx]);
      }
    } else if (e.key === "Escape") {
      setResults([]);
      setHighlight(-1);
    }
  }

  return (
    <div style={{ position: "relative" }}>
      {/* The pill-shaped input container. Border lights up on focus. */}
      <div
        className="searchbox-wrap"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.6rem",
          background: "rgba(255,255,255,0.06)",
          border: `1px solid ${focused ? "rgba(99,102,241,0.6)" : "rgba(255,255,255,0.1)"}`,
          borderRadius: "10px",
          padding: "0.6rem 0.8rem",
          transition: "border-color 0.15s",
        }}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            setFocused(true);
            onFocusProp?.();
          }}
          // 150ms delay on blur lets a click on a dropdown row register
          // before we hide the dropdown.
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder={label}
          aria-label={label}
          autoComplete="off"
          spellCheck="false"
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "#f3f4f6",
            fontSize: "0.9rem",
            fontFamily: "inherit",
            minWidth: 0,
          }}
        />
        {/* Clear button — shown only if onClear was passed AND there's text. */}
        {onClear && value && (
          <button
            type="button"
            // preventDefault on mousedown stops the input from losing focus
            // before the click handler runs.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setResults([]);
              onClear();
            }}
            title="Clear"
            aria-label="Clear search"
            style={{
              background: "rgba(255,255,255,0.08)",
              color: "rgba(255,255,255,0.7)",
              border: "none",
              borderRadius: "50%",
              width: "18px",
              height: "18px",
              cursor: "pointer",
              fontSize: "11px",
              lineHeight: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              padding: 0,
            }}
          >
            ×
          </button>
        )}
      </div>
      {/* Dropdown of geocoder results, only when input is focused and has
          results to show. */}
      {focused && results.length > 0 && (
        <ul
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            background: "#1f2937",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "10px",
            padding: "0.25rem",
            margin: 0,
            listStyle: "none",
            zIndex: 1000,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}
        >
          {results.map((f, i) => {
            const [lng, lat] = f.geometry?.coordinates || [];
            const coordStr = lat != null && lng != null
              ? `${lat.toFixed(5)}, ${lng.toFixed(5)}`
              : "";
            return (
              <li
                // osm_id is unique-per-feature when available; index is a
                // fallback so React still gets a stable key.
                key={f.properties?.osm_id ?? i}
                title={coordStr}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleSelect(f)}
                onMouseEnter={() => setHighlight(i)}
                style={{
                  padding: "0.5rem 0.6rem",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                  color: "#e5e7eb",
                  borderRadius: "6px",
                  background: highlight === i ? "rgba(255,255,255,0.08)" : "transparent",
                }}
              >
                <div>{formatName(f.properties)}</div>
                {coordStr && (
                  <div style={{ fontSize: "0.68rem", opacity: 0.45, marginTop: "2px" }}>
                    {coordStr}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// =============================================================================
// App — the root component. Owns:
//   - the MapLibre map instance (created exactly once)
//   - origin/destination state and their search-box text
//   - the current routing mode + preference toggles
//   - the active route's geometry, distance, and duration
//   - all of the marker DOM nodes (held in refs because MapLibre owns them
//     imperatively, not via React).
// =============================================================================
function App() {
  // -------------------- map + DOM refs --------------------
  const mapContainer = useRef(null); // <div> the map paints into
  const map = useRef(null);          // the MapLibre Map instance
  const markers = useRef([]);        // origin + destination marker objects
  const userMarker = useRef(null);   // blue "you are here" dot (updated during nav)
  const routeCoords = useRef(null); // decoded [lng,lat][] for snap-to-route (Phase 2)

  // -------------------- routing state --------------------
  const [origin, setOrigin] = useState(null);          // { lng, lat, name, isCurrent? }
  const [destination, setDestination] = useState(null);
  const [originQuery, setOriginQuery] = useState("");  // text in origin SearchBox
  const [destQuery, setDestQuery] = useState("");      // text in dest SearchBox
  const [routeInfo, setRouteInfo] = useState(null);    // { distance, durationSec, waypointCount }
  const [directions, setDirections] = useState(null);  // null | parseDirections() steps
  const [routeMode, setRouteMode] = useState("normal");// "normal" | "newDriver" | "scenic"
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("Calculating route…");
  const [routeError, setRouteError] = useState(null);

  // -------------------- UI toggles --------------------
  // Whether the origin input row is exposed (false = origin is locked to
  // "Your location" with a Change button).
  const [showOrigin, setShowOrigin] = useState(false);
  // Light/Medium/Heavy detour intensity, only meaningful in scenic mode.
  const [detourLevel, setDetourLevel] = useState("medium");
  // Booleans for whether each road type is allowed.
  const [prefs, setPrefs] = useState({
    highways: true,
    tolls: true,
    ferries: true,
  });
  // Whether the collapsible controls section is expanded on mobile.
  const [mobileExpanded, setMobileExpanded] = useState(false);
  // Friendly error message when geolocation fails.
  const [geoError, setGeoError] = useState(null);

  // Markers for scenic stops (separate ref so they can be cleared without
  // touching the origin/dest markers).
  const scenicMarkers = useRef([]);
  // Cached LngLatBounds for the active route, used by the recenter button.
  const routeBounds = useRef(null);
  // What the recenter button should fly to next: "user" or "route".
  // Toggles each time the button is pressed.
  const recenterTarget = useRef("user");
  // ---- async race protection refs -----------------------------------------
  // Monotonic counter for fetchRoute calls. We compare against the value at
  // call-time before applying state so a late-resolving stale fetch can't
  // overwrite the UI with a wrong route.
  const routeReqIdRef = useRef(0);
  // AbortController for the currently in-flight route+overpass request set.
  const routeAbortRef = useRef(null);
  // Pending debounce timer for the route effect (collapses rapid pref/mode
  // toggles into a single Valhalla call).
  const routeDebounceRef = useRef(null);
  // Becomes true the first time the user types/clears in the origin input
  // (or selects a result). Initial reverse-geocode refuses to write origin
  // state once this is set, so user input is never clobbered by a late
  // geolocation resolve.
  const originTouchedRef = useRef(false);
  // Endpoint signature of the last route we actually drew, so we can tell
  // whether the current fetchRoute is a brand-new trip (collapse the mobile
  // panel to show the map) or a refetch triggered by a pref/mode toggle
  // (leave the panel alone so the user can keep tweaking).
  const lastRouteEndpointsRef = useRef("");

  // ---------------------------------------------------------------------------
  // abortRoute — cancel any in-flight fetchRoute AND invalidate its request
  // id so the catch handler treats the abort as "superseded" (silent) rather
  // than as a timeout. Call this from any code path that wants to throw away
  // the current route fetch (handleReset, clearing endpoints, etc.).
  // ---------------------------------------------------------------------------
  function abortRoute() {
    routeAbortRef.current?.abort();
    // Bumping the id means stillCurrent() in any pending catch returns false.
    routeReqIdRef.current++;
  }

  // Mobile vs desktop layout flag, driven by viewport width.
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" && window.innerWidth <= 640,
  );

  // Listen for window resize so the layout responds to rotation / window
  // dragging across the 640px breakpoint.
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The user's current geolocation, in a ref because it doesn't need to
  // trigger re-renders on its own.
  const userLocation = useRef(null);

  const {
    setNavState,
    isNavigating,
    navError,
    startNavigation,
    endNavigation,
  } = useNavigation({
    mapRef: map,
    userMarkerRef: userMarker,
    userLocationRef: userLocation,
  });

  // Keep navigation state in sync with whether a route is on screen.
  useEffect(() => {
    if (isNavigating) {
      if (routeError) endNavigation();
      return;
    }
    if (routeInfo && !routeError) setNavState("preview");
    else setNavState("idle");
  }, [routeInfo, routeError, isNavigating, setNavState, endNavigation]);

  // ---------------------------------------------------------------------------
  // reverseGeocode — ask Photon for a human-readable name for a coordinate.
  // Used after geolocation to label the "Your location" pill, and when the
  // user toggles back to "Use my current location".
  // ---------------------------------------------------------------------------
  async function reverseGeocode(lat, lng) {
    try {
      const res = await fetch(`/photon/api/reverse?lat=${lat}&lon=${lng}`);
      const data = await res.json();
      const props = data.features?.[0]?.properties || {};
      return (
        [props.name, props.street, props.city].filter(Boolean).join(", ") ||
        "Current location"
      );
    } catch {
      // If Photon is unreachable, fall back to a generic label.
      return "Current location";
    }
  }

  // ---------------------------------------------------------------------------
  // Mount effect — build the map exactly once. The empty dep array + the
  // `if (map.current) return` guard make this safe under React StrictMode's
  // double-invoke in development.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (map.current) return;

    // Create the MapLibre map. Centered on Toronto until geolocation lands.
    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://tiles.openfreemap.org/styles/liberty", // free vector tiles
      center: [-79.383184, 43.653226],
      zoom: 9,
      pitchWithRotate: false, // we don't want pitch shifting on rotate gesture
    });

    // Slow the trackpad/wheel zoom way down so a small wheel motion doesn't
    // fling the user from a street view to a continent view.
    map.current.scrollZoom.setZoomRate(1 / 50);
    map.current.scrollZoom.setWheelZoomRate(1 / 200);

    // -------------------------------------------------------------------------
    // Custom MapLibre control: "recenter" button.
    //   First press  → frame the active route (if any) or fly to the user.
    //   Next press   → toggle to the other target.
    // MapLibre's IControl interface requires onAdd/onRemove that return DOM.
    // -------------------------------------------------------------------------
    const recenter = {
      onAdd: () => {
        const container = document.createElement("div");
        container.className = "maplibregl-ctrl maplibregl-ctrl-group";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.title = "Recenter on your location";
        btn.className = "maplibregl-ctrl-recenter";
        // Inline SVG so we don't need an icon font/library.
        btn.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="3.5" fill="currentColor"/>
            <circle cx="12" cy="12" r="7" stroke="currentColor" stroke-width="1.8" fill="none"/>
            <line x1="12" y1="1.5" x2="12" y2="4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            <line x1="12" y1="19.5" x2="12" y2="22.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            <line x1="1.5" y1="12" x2="4.5" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            <line x1="19.5" y1="12" x2="22.5" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        `;
        // Helper: fly the camera to the user's geolocation. Always asks for
        // a fresh position if the geolocation API is available, so the dot
        // tracks them if they've moved since page load. Falls back to the
        // cached value (or does nothing) if the API is unavailable or
        // permission was denied.
        const flyToUser = () => {
          const useCoords = (lng, lat) => {
            userLocation.current = { lng, lat };
            map.current?.flyTo({ center: [lng, lat], zoom: 15, duration: 600 });
          };
          if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
              (pos) => useCoords(pos.coords.longitude, pos.coords.latitude),
              () => {
                // Permission denied or timeout — fall back to last known.
                if (userLocation.current) {
                  useCoords(userLocation.current.lng, userLocation.current.lat);
                }
              },
              { enableHighAccuracy: true, timeout: 5000 },
            );
          } else if (userLocation.current) {
            useCoords(userLocation.current.lng, userLocation.current.lat);
          }
        };
        btn.onclick = () => {
          // If a route is on screen and we last centered on the user, the
          // next press frames the whole route. Otherwise, fly to the user.
          if (routeBounds.current && recenterTarget.current === "user") {
            map.current?.fitBounds(routeBounds.current, {
              padding: window.innerWidth <= 640
                ? { top: 120, bottom: 80, left: 40, right: 40 }
                : { top: 80, bottom: 80, left: 340, right: 80 }, // leave room for the side panel
              duration: 600,
            });
            recenterTarget.current = "route";
          } else {
            flyToUser();
            recenterTarget.current = "user";
          }
        };
        container.appendChild(btn);
        return container;
      },
      onRemove: () => {},
    };

    map.current.addControl(recenter, "bottom-right");
    // Built-in zoom in/out buttons (compass + pitch hidden — pitch is off).
    map.current.addControl(
      new maplibregl.NavigationControl({
        showCompass: false,
        visualizePitch: false,
      }),
      "bottom-right",
    );

    // When the user starts panning/dragging the map, collapse the mobile
    // panel so it doesn't obscure the map. `e.originalEvent` is only present
    // for user-initiated movements (not programmatic flyTo/fitBounds).
    map.current.on("movestart", (e) => {
      if (e.originalEvent) setMobileExpanded(false);
    });

    // Tap-to-collapse on mobile: same idea, but for taps that don't pan.
    map.current.on("click", () => {
      if (window.innerWidth <= 640) setMobileExpanded(false);
    });

    // Try to grab the user's geolocation. On success, place a blue "you are
    // here" dot and set the origin to current location.
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude: lat, longitude: lng } = pos.coords;
          userLocation.current = { lng, lat };
          setGeoError(null);
          // jumpTo skips the flyTo animation since this is the initial load.
          map.current.jumpTo({ center: [lng, lat], zoom: 15 });

          // Build the blue-dot marker with a glow ring.
          const el = document.createElement("div");
          el.style.cssText = `
            width: 16px; height: 16px; border-radius: 50%;
            background: #4285f4;
            border: 3px solid white;
            box-shadow: 0 0 0 6px rgba(66,133,244,0.25), 0 2px 8px rgba(0,0,0,0.3);
          `;
          userMarker.current = new maplibregl.Marker({ element: el })
            .setLngLat([lng, lat])
            .addTo(map.current);

          // Reverse-geocode for a friendly origin label.
          const name = await reverseGeocode(lat, lng);
          // Bail if the user has already interacted with the origin input
          // while we were waiting on Photon. Otherwise we would overwrite
          // their typed/selected origin with the geolocation result.
          if (originTouchedRef.current) return;
          // `isCurrent` flag lets later code know this origin came from
          // geolocation (so we suppress its pin and clear it if the user
          // starts typing a new origin).
          setOrigin({ lng, lat, name, isCurrent: true });
          setOriginQuery(name);
        },
        (err) => {
          // Translate browser geolocation error codes into friendly text.
          if (err.code === err.PERMISSION_DENIED) {
            setGeoError("Location access denied — set a starting point manually.");
          } else if (err.code === err.TIMEOUT) {
            setGeoError("Couldn't get your location — set a starting point manually.");
          } else {
            setGeoError("Location unavailable — set a starting point manually.");
          }
          // Reveal the manual origin input so the user has a path forward.
          setShowOrigin(true);
        },
        { enableHighAccuracy: true, timeout: 8000 },
      );
    } else {
      // Browser doesn't even support geolocation API.
      setGeoError("Geolocation not supported — set a starting point manually.");
      setShowOrigin(true);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Marker effect — re-draws origin + destination teardrop markers whenever
  // either endpoint changes. We tear all markers down and rebuild because
  // MapLibre markers carry their own DOM and it's simpler than diffing.
  //
  // We skip drawing the origin marker when origin.isCurrent is true — the
  // blue "you are here" dot covers that visually.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!map.current) return;
    markers.current.forEach((m) => m.remove());
    markers.current = [];

    // Build the list of points to render. The map((p,i) => …) keeps the
    // index so we can check "is this the origin pin?" without an extra prop.
    const pts = [origin, destination]
      .map((p, i) => (p && !(i === 0 && p.isCurrent) ? p : null))
      .filter(Boolean);
    pts.forEach((p) => {
      const isOrigin = p === origin;
      // Two different teardrop color palettes: dark grey for origin, red
      // gradient for destination.
      const gradId = isOrigin ? "gradA" : "gradB";
      const top = isOrigin ? "#374151" : "#ef4444";
      const bot = isOrigin ? "#111827" : "#991b1b";
      const el = document.createElement("div");
      el.style.cssText = "width: 28px; height: 38px; cursor: pointer;";
      // SVG teardrop with a gradient fill and a soft drop shadow.
      el.innerHTML = `
        <svg width="28" height="38" viewBox="0 0 28 38" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="${top}"/>
              <stop offset="100%" stop-color="${bot}"/>
            </linearGradient>
            <filter id="shadow-${gradId}" x="-50%" y="-20%" width="200%" height="160%">
              <feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.4"/>
            </filter>
          </defs>
          <path d="M14 1 C6.82 1 1 6.82 1 14 C1 23.5 14 36 14 36 C14 36 27 23.5 27 14 C27 6.82 21.18 1 14 1 Z"
                fill="url(#${gradId})" stroke="rgba(255,255,255,0.9)" stroke-width="1.5"
                filter="url(#shadow-${gradId})"/>
          <circle cx="14" cy="14" r="4.5" fill="white" opacity="0.95"/>
        </svg>
      `;
      // anchor: "bottom" makes the pointy tip of the teardrop sit on the
      // actual coordinate, which is what users expect.
      const marker = new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([p.lng, p.lat])
        .addTo(map.current);
      markers.current.push(marker);
    });
  }, [origin, destination]);

  // ---------------------------------------------------------------------------
  // Routing trigger — whenever either endpoint, the mode, the detour level,
  // or the preference toggles change, refetch the route. If either endpoint
  // is missing, clear any drawn route instead.
  //
  // Debounced 150ms so rapid pref-button mashing collapses into a single
  // Valhalla call instead of firing one per click.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!map.current) return;
    if (routeDebounceRef.current) clearTimeout(routeDebounceRef.current);
    if (!origin || !destination) {
      // Cancel any in-flight request (and invalidate its id) before clearing
      // so a late resolve from the aborted call can't redraw a stale route.
      abortRoute();
      clearRoute();
      return;
    }
    routeDebounceRef.current = setTimeout(() => {
      fetchRoute(origin, destination);
    }, 150);
    return () => {
      if (routeDebounceRef.current) clearTimeout(routeDebounceRef.current);
    };
  }, [origin, destination, routeMode, detourLevel, prefs]);

  // ---------------------------------------------------------------------------
  // clearRoute — wipe the route line layer + source + scenic markers, reset
  // the cached bounds, and clear the displayed distance/duration.
  // ---------------------------------------------------------------------------
  function clearRoute() {
    if (map.current?.getSource("route")) {
      map.current.removeLayer("route-line");
      map.current.removeSource("route");
    }
    scenicMarkers.current.forEach((m) => m.remove());
    scenicMarkers.current = [];
    routeBounds.current = null;
    routeCoords.current = null;
    recenterTarget.current = "user";
    // Forget the last endpoint signature so re-entering the same trip
    // after a reset counts as "brand new" and re-collapses the mobile panel.
    lastRouteEndpointsRef.current = "";
    setRouteInfo(null);
    setDirections(null);
    endNavigation();
  }

  // ---------------------------------------------------------------------------
  // clearScenicMarkers — remove just the scenic-stop green dots. Used when
  // switching out of scenic mode without clearing the whole route.
  // ---------------------------------------------------------------------------
  function clearScenicMarkers() {
    scenicMarkers.current.forEach((m) => m.remove());
    scenicMarkers.current = [];
  }

  // ---------------------------------------------------------------------------
  // drawScenicMarkers — render a small green badge with a type-specific
  // emoji at each scenic waypoint along the route.
  // ---------------------------------------------------------------------------
  function drawScenicMarkers(waypoints) {
    clearScenicMarkers();
    const icons = {
      viewpoint: "👁",
      scenic: "✦",
      national_park: "🌲",
      water: "💧",
      park: "🌳",
    };
    waypoints.forEach((w) => {
      const el = document.createElement("div");
      // Hover tooltip — either the OSM name plus type, or just the type.
      el.title = w.name ? `${w.name} (${w.type})` : w.type;
      el.style.cssText = `
        width: 22px; height: 22px; border-radius: 50%;
        background: rgba(34,197,94,0.95);
        border: 2px solid white;
        box-shadow: 0 2px 6px rgba(0,0,0,0.35);
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; color: white; cursor: pointer;
      `;
      el.textContent = icons[w.type] || "·";
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([w.lng, w.lat])
        .addTo(map.current);
      scenicMarkers.current.push(marker);
    });
  }

  // ---------------------------------------------------------------------------
  // fetchRoute — the big one. Talks to Valhalla, optionally with scenic
  // waypoints, draws the resulting line, fits the camera to it, and updates
  // the distance/duration display.
  //
  // Flow:
  //   1. Build a Valhalla costing object based on mode + prefs.
  //   2. If scenic, look up waypoints via Overpass.
  //   3. POST to /api/route. Retry without waypoints if that fails.
  //   4. Retry with bigger snap radius if Valhalla complains it can't find
  //      a road near the click point.
  //   5. Decode the polyline, render as a line layer, fit bounds.
  // ---------------------------------------------------------------------------
  async function fetchRoute(o, d) {
    // ---- abort any in-flight request, then start a fresh tracking session
    // (request id + AbortController + 25s client-side timeout). Late
    // resolves from a superseded fetch are detected via myId mismatch and
    // dropped without touching React state.
    //
    // Note: we call abort() directly here instead of abortRoute() because
    // we're about to assign a brand-new id ourselves via ++routeReqIdRef;
    // abortRoute() would bump it once more and de-sync.
    routeAbortRef.current?.abort();
    const ctrl = new AbortController();
    routeAbortRef.current = ctrl;
    const myId = ++routeReqIdRef.current;
    // Helper: true only while THIS fetchRoute call is still the latest one.
    const stillCurrent = () => myId === routeReqIdRef.current;
    // Distinguish "we aborted because of our own 25s timeout" from "aborted
    // because someone superseded us". A timeout still owns the UI and
    // should show an error; a supersession should stay silent.
    let timedOut = false;
    // 25s wall-clock cap — beyond this we abort even if the network hasn't
    // errored, so the spinner can never get stuck forever.
    const timeoutId = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, 25000);

    // Mode-specific Valhalla costing tuning. These keys are documented in
    // the Valhalla "auto" costing options.
    const baseCosting = {
      normal: {},
      newDriver: { use_highways: 0, use_tolls: 0, turn_penalty_factor: 100 },
      scenic: { use_living_streets: 0.7 },
    };
    // Layer the user's manual highway/toll/ferry toggles on top. 0 = avoid.
    const overrides = {
      ...(prefs.highways ? {} : { use_highways: 0 }),
      ...(prefs.tolls ? {} : { use_tolls: 0 }),
      ...(prefs.ferries ? {} : { use_ferry: 0 }),
    };
    // Valhalla expects costing options nested under the costing name.
    const costingOptions = {
      [routeMode]: { auto: { ...baseCosting[routeMode], ...overrides } },
    };
    // Route polyline color per mode — matches the segmented control accent.
    const routeColors = {
      normal: "#3b82f6",
      newDriver: "#f59e0b",
      scenic: "#22c55e",
    };

    setLoading(true);
    setRouteError(null);
    try {
      // Step 1: find scenic detour waypoints, if applicable.
      let scenicWaypoints = [];
      if (routeMode === "scenic") {
        setLoadingMsg("Finding scenic detour…");
        scenicWaypoints = await findScenicWaypoints(o, d, detourLevel, ctrl.signal);
      }
      if (!stillCurrent()) return;
      setLoadingMsg("Calculating route…");

      // Inner helper that builds + POSTs the Valhalla request. `endpointRadius`
      // tells Valhalla how far it may snap the origin/dest to the nearest
      // routable road (metres). A bigger radius is the rescue path for
      // addresses that geocoded to a non-road location.
      async function callValhalla(waypoints, endpointRadius) {
        const locations = [
          { lon: o.lng, lat: o.lat, radius: endpointRadius },
          // `type: "through"` makes Valhalla pass *through* the waypoint
          // without treating it as a stop. radius:2000 lets it snap up to
          // 2 km because parks/viewpoints rarely sit on a road.
          ...waypoints.map((w) => ({
            lon: w.lng,
            lat: w.lat,
            type: "through",
            radius: 2000,
          })),
          { lon: d.lng, lat: d.lat, radius: endpointRadius },
        ];
        const r = await fetch("/api/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            locations,
            costing: "auto",
            costing_options: costingOptions[routeMode],
            directions_options: { units: "kilometres", language: "en-US" },
          }),
          signal: ctrl.signal,
        });
        return { res: r, body: await r.json() };
      }

      // First attempt: include scenic waypoints (if any), tight snap radius.
      let { res, body: data } = await callValhalla(scenicWaypoints, 100);
      if (!stillCurrent()) return;

      // Fallback 1: if Valhalla failed and we had waypoints, retry without
      // them. Some waypoints just can't be routed through.
      if ((!res.ok || !data.trip?.legs?.[0]) && scenicWaypoints.length > 0) {
        scenicWaypoints = [];
        ({ res, body: data } = await callValhalla([], 100));
        if (!stillCurrent()) return;
      }
      // Fallback 2: if Valhalla complains about "no suitable edges", retry
      // with a much bigger snap radius so it can find *any* routable road.
      if (!res.ok && /no suitable edges|no edges? near/i.test(typeof data?.error === "string" ? data.error : "")) {
        ({ res, body: data } = await callValhalla(scenicWaypoints, 1000));
        if (!stillCurrent()) return;
      }
      // If we still don't have a usable trip, surface a friendly error.
      if (!res.ok || !data.trip?.legs?.[0]) {
        const raw = typeof data?.error === "string" ? data.error : "";
        // Internal Valhalla errors look like file:line traces — sanitize
        // those into a generic "try a nearby address" hint.
        const friendly = res.status >= 500 || /graphtile|out of bounds|assert|\.h:\d+/i.test(raw)
          ? "Couldn't route to that location — try a nearby address."
          : raw || "No route found between these points.";
        throw new Error(friendly);
      }

      // Pull distance + duration from the trip summary.
      const { length, time } = data.trip.summary;
      setRouteInfo({
        distance: length.toFixed(1),
        durationSec: time,
        waypointCount: scenicWaypoints.length,
      });
      setDirections(parseDirections(data.trip));
      // Auto-collapse the mobile panel ONLY when the endpoints just changed
      // (a brand-new trip), not on a pref/mode refetch — otherwise tweaking
      // toggles yanks the panel closed under the user's finger.
      const endpointSig = `${o.lng.toFixed(6)},${o.lat.toFixed(6)}->${d.lng.toFixed(6)},${d.lat.toFixed(6)}`;
      if (endpointSig !== lastRouteEndpointsRef.current) {
        setMobileExpanded(false);
        lastRouteEndpointsRef.current = endpointSig;
      }

      // Decode each leg and concatenate into one continuous coord array.
      const coords = data.trip.legs.flatMap((leg) => decodePolyline(leg.shape));
      // Defensive: if decoding produced nothing usable, bail with a clean
      // error instead of crashing on the empty-bounds path below.
      if (coords.length === 0) {
        throw new Error("Route returned no geometry.");
      }
      routeCoords.current = coords;
      const geojson = {
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords },
      };
      // Update the existing line in place if present, otherwise add new
      // source + layer. In-place update avoids a brief flicker.
      const existing = map.current.getSource("route");
      if (existing) {
        existing.setData(geojson);
        if (map.current.getLayer("route-line")) {
          map.current.setPaintProperty("route-line", "line-color", routeColors[routeMode]);
        }
      } else {
        map.current.addSource("route", { type: "geojson", data: geojson });
        map.current.addLayer({
          id: "route-line",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": routeColors[routeMode], "line-width": 5 },
        });
      }

      // Drop or clear scenic markers depending on the mode.
      if (routeMode === "scenic") drawScenicMarkers(scenicWaypoints);
      else clearScenicMarkers();

      // Compute the bounding box of all route coordinates so we can frame
      // the whole route on screen.
      const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new maplibregl.LngLatBounds(coords[0], coords[0]),
      );
      routeBounds.current = bounds;
      recenterTarget.current = "route";
      // Don't reframe the map while the user is actively navigating.
      if (!isNavigating) {
        map.current.fitBounds(bounds, {
          padding: isMobile
            ? { top: 240, bottom: 80, left: 40, right: 40 }
            : { top: 80, bottom: 80, left: 340, right: 80 },
          duration: 600,
        });
      }
    } catch (err) {
      // Supersession: a newer fetchRoute (or abortRoute) invalidated our
      // id. The newer call (or the reset that cancelled us) owns the UI —
      // stay completely silent here.
      if (!stillCurrent()) return;
      // From here on, we're still the live request. An AbortError can only
      // come from our own 25s timeout, since any other cancel path would
      // have bumped the id first via abortRoute().
      const msg = (err?.name === "AbortError" || timedOut)
        ? "Route request timed out — try again."
        : err.message || "Couldn't fetch route";
      setRouteError(msg);
      setRouteInfo(null);
      setDirections(null);
      routeCoords.current = null;
      clearScenicMarkers();
      if (map.current?.getSource("route")) {
        map.current.removeLayer("route-line");
        map.current.removeSource("route");
      }
    } finally {
      clearTimeout(timeoutId);
      // Only the latest in-flight request should toggle the spinner off,
      // otherwise a stale finally{} can hide the spinner of the live one.
      if (stillCurrent()) setLoading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // handleSwap — swap origin and destination. The text inputs swap too so
  // the displayed names follow the swap.
  // ---------------------------------------------------------------------------
  function handleSwap() {
    setOrigin(destination);
    setDestination(origin);
    setOriginQuery(destQuery);
    setDestQuery(originQuery);
  }

  // ---------------------------------------------------------------------------
  // handleReset — clear the destination + any drawn route and fly the camera
  // back to either the origin, the user's location, or the default Toronto
  // view, in that priority order.
  // ---------------------------------------------------------------------------
  function handleReset() {
    // Cancel any in-flight route fetch AND invalidate its id so its late
    // catch handler treats the abort as "superseded" (silent) rather than
    // as a timeout, and can't redraw a route we just cleared.
    abortRoute();
    endNavigation();
    setDestination(null);
    setDestQuery("");
    setRouteInfo(null);
    setDirections(null);
    // Clear any error banner left over from the prior route — otherwise the
    // red banner persists with no route on screen and confuses the user.
    setRouteError(null);
    const home = userLocation.current;
    const target = origin
      ? [origin.lng, origin.lat]
      : home
      ? [home.lng, home.lat]
      : [-79.383184, 43.653226];
    map.current?.flyTo({
      center: target,
      zoom: origin || home ? 15 : 9,
      duration: 600,
    });
  }

  // Currently-selected mode's metadata, used for accent color + spinner.
  const activeMode = MODES.find((m) => m.id === routeMode);

  // ===========================================================================
  // JSX render tree.
  //
  // Layout overview:
  //   <div fixed inset:0>
  //     <div ref=mapContainer>           ← map paints behind everything
  //     <div absolute top/left panel>    ← controls + search + route info
  //       <h1>                            (desktop only)
  //       <div mobile-collapsible>        ← mode toggles, prefs, detour
  //       <div search row>                ← origin + dest inputs
  //       <one-of>                        current-location pill or "←"
  //       {geoError && ...}
  //       {routeError && ...}
  //       {(loading || routeInfo) && ...} ← distance/duration summary
  //       {scenic & no waypoints note}
  //     <style> embedded CSS (keyframes + maplibre overrides + media queries)
  // ===========================================================================
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      {/* The map canvas itself. inset:0 fills the whole viewport. */}
      <div
        ref={mapContainer}
        style={{ position: "absolute", inset: 0 }}
      />

      {/* Floating glass control panel. Slightly different geometry on mobile
          (full-width, smaller paddings) vs desktop (fixed 300px sidebar). */}
      <div
        style={{
          position: "absolute",
          top: isMobile ? "0.5rem" : "1rem",
          left: isMobile ? "0.5rem" : "1rem",
          right: isMobile ? "0.5rem" : "auto",
          width: isMobile ? "auto" : "300px",
          maxHeight: isMobile ? "calc(100dvh - 1rem)" : "calc(100vh - 2rem)",
          background: "rgba(18, 18, 20, 0.72)",
          // backdrop-filter creates the frosted glass look. Both spellings
          // are needed for cross-browser support.
          backdropFilter: "blur(28px) saturate(160%)",
          WebkitBackdropFilter: "blur(28px) saturate(160%)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "14px",
          color: "#f3f4f6",
          display: "flex",
          flexDirection: "column",
          padding: isMobile ? "0.5rem" : "0.85rem",
          gap: isMobile ? "0.4rem" : "0.65rem",
          boxShadow: "0 12px 40px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.25)",
          overflow: "visible",
        }}
      >
        {isNavigating ? (
          <NavigationBar
            destinationName={destQuery || destination?.name}
            routeInfo={routeInfo}
            onEnd={endNavigation}
            accentColor={activeMode.color}
            navError={navError}
          />
        ) : (
        <>
        {/* App title — desktop only; mobile hides it to save vertical space. */}
        {!isMobile && (
          <div
            style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
          >
            <h1
              style={{
                margin: 0,
                fontSize: "0.9rem",
                fontWeight: 600,
                letterSpacing: "-0.01em",
                flex: 1,
              }}
            >
              Manvir Maps
            </h1>
          </div>
        )}

        {/* mobile-collapsible: the whole "extra controls" block — mode
            tabs, prefs toggles, detour intensity. Collapsed by default on
            mobile, animates open when the user focuses a search input or
            taps anywhere inside the panel. CSS for the animation is in the
            <style> block at the bottom of the file. */}
        <div
          className="mobile-collapsible"
          data-expanded={mobileExpanded ? "true" : "false"}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: isMobile ? "0.4rem" : "0.65rem",
            order: isMobile ? 3 : 0, // on mobile, push this below search inputs
          }}
        >
        {/* MODE SEGMENTED CONTROL — Normal / New Driver / Scenic */}
        <div
          style={{
            display: "flex",
            background: "rgba(255,255,255,0.04)",
            borderRadius: "8px",
            padding: "3px",
            gap: "2px",
          }}
        >
          {MODES.map((m) => {
            const active = routeMode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => setRouteMode(m.id)}
                title={m.desc}
                style={{
                  flex: 1,
                  background: active ? "rgba(255,255,255,0.08)" : "transparent",
                  border: "none",
                  borderRadius: "6px",
                  padding: isMobile ? "0.3rem 0.2rem" : "0.4rem 0.3rem",
                  cursor: "pointer",
                  color: active ? m.color : "rgba(255,255,255,0.6)",
                  fontSize: isMobile ? "0.68rem" : "0.72rem",
                  fontWeight: active ? 600 : 500,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "0.25rem",
                  transition: "all 0.15s",
                }}
              >
                <span style={{ fontSize: "0.85rem" }}>{m.icon}</span>
                {m.label}
              </button>
            );
          })}
        </div>

        {/* PREFERENCE TOGGLES — highways / tolls / ferries.
            Allowed = subtle white background, disallowed = red strikethrough. */}
        <div style={{ display: "flex", gap: "4px" }}>
          {[
            { id: "highways", icon: "🛣️", label: "Highways" },
            { id: "tolls", icon: "💰", label: "Tolls" },
            { id: "ferries", icon: "⛴️", label: "Ferries" },
          ].map((opt) => {
            const on = prefs[opt.id];
            return (
              <button
                key={opt.id}
                onClick={() =>
                  setPrefs((p) => ({ ...p, [opt.id]: !p[opt.id] }))
                }
                title={`${on ? "Allow" : "Avoid"} ${opt.label.toLowerCase()}`}
                style={{
                  flex: 1,
                  background: on
                    ? "rgba(255,255,255,0.06)"
                    : "rgba(239,68,68,0.08)",
                  border: `1px solid ${on ? "rgba(255,255,255,0.08)" : "rgba(239,68,68,0.25)"}`,
                  borderRadius: "6px",
                  padding: isMobile ? "0.3rem 0.2rem" : "0.35rem 0.3rem",
                  cursor: "pointer",
                  color: on ? "rgba(255,255,255,0.75)" : "#fca5a5",
                  fontSize: "0.68rem",
                  fontWeight: 500,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "0.25rem",
                  textDecoration: on ? "none" : "line-through",
                  textDecorationThickness: "1px",
                }}
              >
                {/* Inner span resets textDecoration so the emoji never gets
                    a strikethrough line drawn through it. */}
                <span style={{ fontSize: "0.9rem", textDecoration: "none" }}>
                  {opt.icon}
                </span>
                {/* Hide the text label on mobile to keep buttons compact. */}
                {!isMobile && opt.label}
              </button>
            );
          })}
        </div>

        {/* DETOUR INTENSITY — only visible in scenic mode. Disabled during
            an in-flight route fetch to avoid spamming Overpass. */}
        {routeMode === "scenic" && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            {!isMobile && (
              <span style={{ fontSize: "0.7rem", opacity: 0.55, marginRight: "0.1rem" }}>
                Detour
              </span>
            )}
            <div
              style={{
                flex: 1,
                display: "flex",
                background: "rgba(255,255,255,0.04)",
                borderRadius: "6px",
                padding: "2px",
                gap: "2px",
              }}
            >
              {Object.entries(DETOUR_LEVELS).map(([id, cfg]) => {
                const active = detourLevel === id;
                return (
                  <button
                    key={id}
                    onClick={() => setDetourLevel(id)}
                    disabled={loading}
                    style={{
                      flex: 1,
                      background: active ? "rgba(34,197,94,0.18)" : "transparent",
                      border: "none",
                      borderRadius: "4px",
                      padding: "0.3rem 0.2rem",
                      cursor: loading ? "not-allowed" : "pointer",
                      color: active ? "#22c55e" : "rgba(255,255,255,0.55)",
                      fontSize: "0.7rem",
                      fontWeight: active ? 600 : 500,
                      opacity: loading && !active ? 0.4 : 1,
                    }}
                  >
                    {cfg.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        </div>
        {/* /mobile-collapsible */}

        {/* SEARCH INPUTS — origin (conditional) + destination, with the
            circular swap button overlapping their right edge. */}
        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            gap: "0.4rem",
            order: isMobile ? 1 : 0, // first on mobile
          }}
        >
          {/* Origin SearchBox is only shown when the user explicitly toggles
              "Change" from the current-location pill below. */}
          {showOrigin && (
            <SearchBox
              label="Starting point"
              icon="🟢"
              value={originQuery}
              biasLat={userLocation.current?.lat}
              biasLng={userLocation.current?.lng}
              onFocus={() => setMobileExpanded(true)}
              onChange={(v) => {
                // Mark origin as user-touched so a late initial reverse-
                // geocode resolve can't clobber what they're typing.
                originTouchedRef.current = true;
                setOriginQuery(v);
                // Once the user starts editing, drop the geolocation origin
                // so we don't keep their old position around in state.
                if (origin?.isCurrent) setOrigin(null);
              }}
              onSelect={(p) => {
                originTouchedRef.current = true;
                setOrigin(p);
                setOriginQuery(p.name);
              }}
            />
          )}
          <SearchBox
            label="Where to?"
            icon="🔴"
            value={destQuery}
            // Bias destination results toward the origin if known, otherwise
            // toward the user's location.
            biasLat={origin?.lat ?? userLocation.current?.lat}
            biasLng={origin?.lng ?? userLocation.current?.lng}
            onFocus={() => setMobileExpanded(true)}
            onChange={setDestQuery}
            onSelect={(p) => {
              setDestination(p);
              setDestQuery(p.name);
            }}
            // Clear button is suppressed during a scenic route fetch so the
            // user can't yank the destination mid-Overpass-call.
            onClear={
              routeMode === "scenic" && loading ? undefined : handleReset
            }
          />
          {/* Circular swap button. Only meaningful when origin row is shown.
              Disabled when there's nothing to swap. */}
          {showOrigin && (
            <button
              onClick={handleSwap}
              disabled={!origin && !destination}
              title="Swap"
              style={{
                position: "absolute",
                right: "-6px",
                top: "calc(50% - 4px)",
                transform: "translateY(-50%)",
                width: "26px",
                height: "26px",
                borderRadius: "50%",
                background: "#374151",
                color: "#f3f4f6",
                border: "2px solid rgba(18,18,20,0.95)",
                cursor: origin || destination ? "pointer" : "not-allowed",
                opacity: origin || destination ? 1 : 0.4,
                fontSize: "0.75rem",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ⇅
            </button>
          )}
        </div>

        {/* Current-location pill (when origin row is hidden) OR a
            "← Use my current location" link (when it's shown). */}
        {!showOrigin ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
              fontSize: "0.72rem",
              opacity: 0.75,
              order: isMobile ? 2 : 0,
            }}
          >
            {/* Mini blue dot matching the "you are here" marker. */}
            <span
              style={{
                width: "7px",
                height: "7px",
                borderRadius: "50%",
                background: "#4285f4",
                boxShadow: "0 0 0 2px rgba(66,133,244,0.25)",
                flexShrink: 0,
              }}
            />
            <span
              style={{
                flex: 1,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {origin?.name || "Your location"}
            </span>
            <button
              onClick={() => setShowOrigin(true)}
              style={{
                background: "transparent",
                color: "#a5b4fc",
                border: "none",
                cursor: "pointer",
                fontSize: "0.72rem",
                fontWeight: 500,
                padding: 0,
              }}
            >
              Change
            </button>
          </div>
        ) : (
          // Back to current location: collapse the origin row and reseed
          // origin from the cached userLocation if we have one.
          <button
            onClick={() => {
              setShowOrigin(false);
              if (userLocation.current) {
                const { lng, lat } = userLocation.current;
                reverseGeocode(lat, lng).then((name) => {
                  setOrigin({ lng, lat, name, isCurrent: true });
                  setOriginQuery(name);
                });
              }
            }}
            style={{
              background: "transparent",
              color: "#a5b4fc",
              border: "none",
              cursor: "pointer",
              fontSize: "0.72rem",
              fontWeight: 500,
              padding: 0,
              textAlign: "left",
              alignSelf: "flex-start",
              order: isMobile ? 2 : 0,
            }}
          >
            ← Use my current location
          </button>
        )}

        {/* GEO ERROR BANNER — orange warning shown when geolocation fails and
            we don't have an origin yet. Dismissable with the × button. */}
        {geoError && !origin && (
          <div
            role="status"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              padding: "0.5rem 0.7rem",
              background: "rgba(245,158,11,0.1)",
              border: "1px solid rgba(245,158,11,0.3)",
              borderRadius: "10px",
              color: "#fcd34d",
              fontSize: "0.75rem",
              order: isMobile ? 4 : 0,
            }}
          >
            <span style={{ flex: 1 }}>{geoError}</span>
            <button
              type="button"
              onClick={() => setGeoError(null)}
              aria-label="Dismiss"
              style={{
                background: "transparent",
                border: "none",
                color: "inherit",
                cursor: "pointer",
                padding: 0,
                fontSize: "0.9rem",
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        )}
        {/* ROUTE ERROR BANNER — red, shown when fetchRoute throws. */}
        {routeError && (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              padding: "0.6rem 0.75rem",
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: "10px",
              color: "#fca5a5",
              fontSize: "0.78rem",
              order: isMobile ? 4 : 0,
            }}
          >
            <span>⚠️</span>
            <span style={{ flex: 1 }}>{routeError}</span>
          </div>
        )}
        {/* SUMMARY ROW — either a spinner with status text (loading) or
            distance + duration columns (success). Hidden when there's an
            error so we don't show stale data next to it. */}
        {(loading || routeInfo) && !routeError && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.4rem 0.6rem",
              order: isMobile ? 4 : 0,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: "8px",
            }}
          >
            {loading ? (
              <>
                {/* Spinner — keyframes defined in the <style> block below.
                    Border color matches the active mode's accent. */}
                <div
                  style={{
                    width: "14px",
                    height: "14px",
                    border: "2px solid rgba(255,255,255,0.15)",
                    borderTopColor: activeMode.color,
                    borderRadius: "50%",
                    animation: "spin 0.8s linear infinite",
                  }}
                />
                <span style={{ fontSize: "0.78rem", opacity: 0.8 }}>
                  {loadingMsg}
                </span>
              </>
            ) : (
              <>
                {/* Distance column. */}
                <div
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    gap: "1px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.55rem",
                      opacity: 0.5,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    Distance
                  </div>
                  <div
                    style={{
                      fontSize: "0.78rem",
                      fontWeight: 700,
                      color: activeMode.color,
                      lineHeight: 1.1,
                    }}
                  >
                    {routeInfo.distance}
                    <span
                      style={{
                        fontSize: "0.58rem",
                        opacity: 0.7,
                        marginLeft: "2px",
                        fontWeight: 500,
                      }}
                    >
                      km
                    </span>
                  </div>
                </div>
                {/* Vertical separator between Distance and Duration columns. */}
                <div
                  style={{
                    width: "1px",
                    alignSelf: "stretch",
                    background: "rgba(255,255,255,0.08)",
                  }}
                />
                {/* Duration column — uses formatDuration() to split into
                    day/hour/minute chunks. */}
                <div
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    gap: "1px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.55rem",
                      opacity: 0.5,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    Duration
                  </div>
                  <div
                    style={{
                      fontSize: "0.78rem",
                      fontWeight: 700,
                      color: activeMode.color,
                      lineHeight: 1.1,
                    }}
                  >
                    {formatDuration(routeInfo.durationSec).map((p, i) => (
                      <span key={i} style={{ marginRight: "4px" }}>
                        {p.value}
                        <span
                          style={{
                            fontSize: "0.7rem",
                            opacity: 0.7,
                            marginLeft: "2px",
                            fontWeight: 500,
                          }}
                        >
                          {p.unit}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {navError && !isNavigating && (
          <div className="navigation-bar__error" role="alert">
            {navError}
          </div>
        )}

        {routeInfo && !loading && !routeError && (
          <StartNavigationButton
            onStart={startNavigation}
            disabled={loading}
            accentColor={activeMode.color}
          />
        )}

        {/* Scenic mode footer note: tell the user whether we actually
            inserted detour waypoints or just used the back-road bias. */}
        {routeInfo && !loading && routeMode === "scenic" && (
          <div
            style={{
              fontSize: "0.7rem",
              opacity: 0.6,
              textAlign: "center",
              marginTop: "-0.3rem",
              order: isMobile ? 4 : 0,
            }}
          >
            {routeInfo.waypointCount > 0
              ? `via ${routeInfo.waypointCount} scenic stop${routeInfo.waypointCount > 1 ? "s" : ""}`
              : "No scenic detours found — using back-road bias"}
          </div>
        )}

        {/* Turn-by-turn directions — hidden while loading or when route errored. */}
        {directions && !routeError && (
          <DirectionsList
            steps={directions}
            accentColor={activeMode.color}
            isMobile={isMobile}
          />
        )}
        </>
        )}
      </div>

      {/* NOTE: spinner keyframes, MapLibre control overrides, and the mobile
          media query that drives `.mobile-collapsible` all live in
          src/index.css now. */}
    </div>
  );
}

export default App;
