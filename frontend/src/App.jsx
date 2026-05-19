import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const DETOUR_LEVELS = {
  light: { corridorKm: 4, maxWaypoints: 1, label: "Light" },
  medium: { corridorKm: 10, maxWaypoints: 2, label: "Medium" },
  heavy: { corridorKm: 22, maxWaypoints: 5, label: "Heavy" },
};

const SCENIC_FEATURE_WEIGHTS = {
  viewpoint: 4,
  scenic: 3.5,
  national_park: 3,
  water: 2,
  park: 1.2,
};

function formatDuration(sec) {
  const totalMin = Math.max(1, Math.round(sec / 60));
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  const parts = [];
  if (days) parts.push({ value: days, unit: "d" });
  if (hours) parts.push({ value: hours, unit: "h" });
  if (mins && !days) parts.push({ value: mins, unit: "min" });
  return parts;
}

function toLocalMeters(lat, lng, refLat, refLng) {
  const R = 6371000;
  const x = (R * Math.cos((refLat * Math.PI) / 180) * (lng - refLng) * Math.PI) / 180;
  const y = (R * (lat - refLat) * Math.PI) / 180;
  return [x, y];
}

function projectOntoSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { dist: Math.hypot(p[0] - a[0], p[1] - a[1]), t: 0 };
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  const tc = Math.max(0, Math.min(1, t));
  const px = a[0] + tc * dx, py = a[1] + tc * dy;
  return { dist: Math.hypot(p[0] - px, p[1] - py), t };
}

function decodePolyline(encoded) {
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lng / 1e6, lat / 1e6]);
  }
  return coords;
}

const scenicCache = new Map();
const SCENIC_CACHE_MAX = 32;

async function findScenicWaypoints(origin, dest, level) {
  const cacheKey = `${level}:${origin.lat.toFixed(3)},${origin.lng.toFixed(3)}->${dest.lat.toFixed(3)},${dest.lng.toFixed(3)}`;
  if (scenicCache.has(cacheKey)) return scenicCache.get(cacheKey);
  const { corridorKm, maxWaypoints } = DETOUR_LEVELS[level];
  const pad = corridorKm / 111;
  const south = Math.min(origin.lat, dest.lat) - pad;
  const north = Math.max(origin.lat, dest.lat) + pad;
  const west = Math.min(origin.lng, dest.lng) - pad;
  const east = Math.max(origin.lng, dest.lng) + pad;
  const bbox = `${south},${west},${north},${east}`;

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
    });
    if (!res.ok) throw new Error("overpass " + res.status);
    const json = await res.json();
    elements = json.elements || [];
  } catch {
    return [];
  }

  const refLat = (origin.lat + dest.lat) / 2;
  const refLng = (origin.lng + dest.lng) / 2;
  const a = toLocalMeters(origin.lat, origin.lng, refLat, refLng);
  const b = toLocalMeters(dest.lat, dest.lng, refLat, refLng);
  const corridorM = corridorKm * 1000;
  const minT = level === "heavy" ? 0.1 : 0.15;
  const maxT = level === "heavy" ? 0.9 : 0.85;

  const candidates = [];
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    const tags = el.tags || {};
    let type;
    if (tags.tourism === "viewpoint") type = "viewpoint";
    else if (tags.scenic === "yes") type = "scenic";
    else if (tags.boundary === "national_park") type = "national_park";
    else if (tags.natural === "water") type = "water";
    else if (tags.leisure === "park") type = "park";
    else continue;

    const p = toLocalMeters(lat, lng, refLat, refLng);
    const { dist, t } = projectOntoSegment(p, a, b);
    if (t < minT || t > maxT) continue;
    if (dist > corridorM) continue;

    const weight = SCENIC_FEATURE_WEIGHTS[type];
    const score = weight / (1 + dist / 1500);
    candidates.push({ lat, lng, type, dist, t, score, name: tags.name });
  }

  candidates.sort((x, y) => y.score - x.score);

  const picked = [];
  const minSpacing = level === "heavy" ? 0.13 : 0.25;
  for (const c of candidates) {
    if (picked.length >= maxWaypoints) break;
    if (picked.some((p) => Math.abs(p.t - c.t) < minSpacing)) continue;
    picked.push(c);
  }
  picked.sort((x, y) => x.t - y.t);
  if (scenicCache.size >= SCENIC_CACHE_MAX) {
    scenicCache.delete(scenicCache.keys().next().value);
  }
  scenicCache.set(cacheKey, picked);
  return picked;
}

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

function SearchBox({ label, icon, value, onChange, onSelect, onClear, inputRef, onFocus: onFocusProp, biasLat, biasLng }) {
  const [results, setResults] = useState([]);
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const abortRef = useRef(null);
  const debounceRef = useRef(null);
  const reqIdRef = useRef(0);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
  }, []);

  function runSearch(val) {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const myId = ++reqIdRef.current;
    const bias = biasLat != null && biasLng != null
      ? `&lat=${biasLat}&lon=${biasLng}`
      : "";
    fetch(`/photon/api?q=${encodeURIComponent(val)}&limit=5${bias}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((data) => {
        if (myId !== reqIdRef.current) return;
        setResults(Array.isArray(data.features) ? data.features : []);
        setHighlight(-1);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setResults([]);
      });
  }

  function handleChange(e) {
    const val = e.target.value;
    onChange(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (val.length < 3) {
      abortRef.current?.abort();
      setResults([]);
      setHighlight(-1);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(val), 200);
  }

  function formatName(props) {
    return [props.name, props.street, props.city, props.state]
      .filter(Boolean)
      .join(", ");
  }

  function handleSelect(feature) {
    const [lng, lat] = feature.geometry.coordinates;
    const name = formatName(feature.properties);
    setResults([]);
    setHighlight(-1);
    onSelect({ lng, lat, name });
  }

  function handleKeyDown(e) {
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? results.length - 1 : h - 1));
    } else if (e.key === "Enter") {
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
        {onClear && value && (
          <button
            type="button"
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

function App() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markers = useRef([]);
  const [origin, setOrigin] = useState(null);
  const [destination, setDestination] = useState(null);
  const [originQuery, setOriginQuery] = useState("");
  const [destQuery, setDestQuery] = useState("");
  const [routeInfo, setRouteInfo] = useState(null);
  const [routeMode, setRouteMode] = useState("normal");
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("Calculating route…");
  const [routeError, setRouteError] = useState(null);
  const [showOrigin, setShowOrigin] = useState(false);
  const [detourLevel, setDetourLevel] = useState("medium");
  const [prefs, setPrefs] = useState({
    highways: true,
    tolls: true,
    ferries: true,
  });
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [geoError, setGeoError] = useState(null);
  const scenicMarkers = useRef([]);
  const routeBounds = useRef(null);
  const recenterTarget = useRef("user");
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" && window.innerWidth <= 640,
  );

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const userLocation = useRef(null);

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
      return "Current location";
    }
  }

  useEffect(() => {
    if (map.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [-79.383184, 43.653226],
      zoom: 9,
      pitchWithRotate: false,
    });

    map.current.scrollZoom.setZoomRate(1 / 50);
    map.current.scrollZoom.setWheelZoomRate(1 / 200);

    const recenter = {
      onAdd: () => {
        const container = document.createElement("div");
        container.className = "maplibregl-ctrl maplibregl-ctrl-group";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.title = "Recenter on your location";
        btn.className = "maplibregl-ctrl-recenter";
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
        const flyToUser = () => {
          if (userLocation.current) {
            const { lng, lat } = userLocation.current;
            map.current?.flyTo({ center: [lng, lat], zoom: 15, duration: 600 });
          } else if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition((pos) => {
              const { latitude: lat, longitude: lng } = pos.coords;
              userLocation.current = { lng, lat };
              map.current?.flyTo({
                center: [lng, lat],
                zoom: 15,
                duration: 600,
              });
            });
          }
        };
        btn.onclick = () => {
          if (routeBounds.current && recenterTarget.current === "user") {
            map.current?.fitBounds(routeBounds.current, {
              padding: window.innerWidth <= 640
                ? { top: 120, bottom: 80, left: 40, right: 40 }
                : { top: 80, bottom: 80, left: 340, right: 80 },
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
    map.current.addControl(
      new maplibregl.NavigationControl({
        showCompass: false,
        visualizePitch: false,
      }),
      "bottom-right",
    );

    map.current.on("movestart", (e) => {
      if (e.originalEvent) setMobileExpanded(false);
    });

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude: lat, longitude: lng } = pos.coords;
          userLocation.current = { lng, lat };
          setGeoError(null);
          map.current.jumpTo({ center: [lng, lat], zoom: 15 });

          const el = document.createElement("div");
          el.style.cssText = `
            width: 16px; height: 16px; border-radius: 50%;
            background: #4285f4;
            border: 3px solid white;
            box-shadow: 0 0 0 6px rgba(66,133,244,0.25), 0 2px 8px rgba(0,0,0,0.3);
          `;
          new maplibregl.Marker({ element: el })
            .setLngLat([lng, lat])
            .addTo(map.current);

          const name = await reverseGeocode(lat, lng);
          setOrigin({ lng, lat, name, isCurrent: true });
          setOriginQuery(name);
        },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) {
            setGeoError("Location access denied — set a starting point manually.");
          } else if (err.code === err.TIMEOUT) {
            setGeoError("Couldn't get your location — set a starting point manually.");
          } else {
            setGeoError("Location unavailable — set a starting point manually.");
          }
          setShowOrigin(true);
        },
        { enableHighAccuracy: true, timeout: 8000 },
      );
    } else {
      setGeoError("Geolocation not supported — set a starting point manually.");
      setShowOrigin(true);
    }
  }, []);

  useEffect(() => {
    if (!map.current) return;
    markers.current.forEach((m) => m.remove());
    markers.current = [];

    const pts = [origin, destination]
      .map((p, i) => (p && !(i === 0 && p.isCurrent) ? p : null))
      .filter(Boolean);
    pts.forEach((p) => {
      const isOrigin = p === origin;
      const gradId = isOrigin ? "gradA" : "gradB";
      const top = isOrigin ? "#374151" : "#ef4444";
      const bot = isOrigin ? "#111827" : "#991b1b";
      const el = document.createElement("div");
      el.style.cssText = "width: 28px; height: 38px; cursor: pointer;";
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
      const marker = new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([p.lng, p.lat])
        .addTo(map.current);
      markers.current.push(marker);
    });
  }, [origin, destination]);

  useEffect(() => {
    if (!map.current) return;
    if (origin && destination) fetchRoute(origin, destination);
    else clearRoute();
  }, [origin, destination, routeMode, detourLevel, prefs]);

  function clearRoute() {
    if (map.current?.getSource("route")) {
      map.current.removeLayer("route-line");
      map.current.removeSource("route");
    }
    scenicMarkers.current.forEach((m) => m.remove());
    scenicMarkers.current = [];
    routeBounds.current = null;
    recenterTarget.current = "user";
    setRouteInfo(null);
  }

  function clearScenicMarkers() {
    scenicMarkers.current.forEach((m) => m.remove());
    scenicMarkers.current = [];
  }

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

  async function fetchRoute(o, d) {
    const baseCosting = {
      normal: {},
      newDriver: { use_highways: 0, use_tolls: 0, turn_penalty_factor: 100 },
      scenic: { use_living_streets: 0.7 },
    };
    const overrides = {
      ...(prefs.highways ? {} : { use_highways: 0 }),
      ...(prefs.tolls ? {} : { use_tolls: 0 }),
      ...(prefs.ferries ? {} : { use_ferry: 0 }),
    };
    const costingOptions = {
      [routeMode]: { auto: { ...baseCosting[routeMode], ...overrides } },
    };
    const routeColors = {
      normal: "#3b82f6",
      newDriver: "#f59e0b",
      scenic: "#22c55e",
    };

    setLoading(true);
    setRouteError(null);
    try {
      let scenicWaypoints = [];
      if (routeMode === "scenic") {
        setLoadingMsg("Finding scenic detour…");
        scenicWaypoints = await findScenicWaypoints(o, d, detourLevel);
      }
      setLoadingMsg("Calculating route…");

      async function callValhalla(waypoints, endpointRadius) {
        const locations = [
          { lon: o.lng, lat: o.lat, radius: endpointRadius },
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
            directions_options: { units: "kilometres" },
          }),
        });
        return { res: r, body: await r.json() };
      }

      let { res, body: data } = await callValhalla(scenicWaypoints, 100);
      if ((!res.ok || !data.trip?.legs?.[0]) && scenicWaypoints.length > 0) {
        scenicWaypoints = [];
        ({ res, body: data } = await callValhalla([], 100));
      }
      if (!res.ok && /no suitable edges|no edges? near/i.test(typeof data?.error === "string" ? data.error : "")) {
        ({ res, body: data } = await callValhalla(scenicWaypoints, 1000));
      }
      if (!res.ok || !data.trip?.legs?.[0]) {
        const raw = typeof data?.error === "string" ? data.error : "";
        const friendly = res.status >= 500 || /graphtile|out of bounds|assert|\.h:\d+/i.test(raw)
          ? "Couldn't route to that location — try a nearby address."
          : raw || "No route found between these points.";
        throw new Error(friendly);
      }
      const { length, time } = data.trip.summary;
      setRouteInfo({
        distance: length.toFixed(1),
        durationSec: time,
        waypointCount: scenicWaypoints.length,
      });
      setMobileExpanded(false);

      const coords = data.trip.legs.flatMap((leg) => decodePolyline(leg.shape));
      const geojson = {
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords },
      };
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

      if (routeMode === "scenic") drawScenicMarkers(scenicWaypoints);
      else clearScenicMarkers();

      const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new maplibregl.LngLatBounds(coords[0], coords[0]),
      );
      routeBounds.current = bounds;
      recenterTarget.current = "route";
      map.current.fitBounds(bounds, {
        padding: isMobile
          ? { top: 240, bottom: 80, left: 40, right: 40 }
          : { top: 80, bottom: 80, left: 340, right: 80 },
        duration: 600,
      });
    } catch (err) {
      setRouteError(err.message || "Couldn't fetch route");
      setRouteInfo(null);
      clearScenicMarkers();
      if (map.current?.getSource("route")) {
        map.current.removeLayer("route-line");
        map.current.removeSource("route");
      }
    } finally {
      setLoading(false);
    }
  }

  function handleSwap() {
    setOrigin(destination);
    setDestination(origin);
    setOriginQuery(destQuery);
    setDestQuery(originQuery);
  }

  function handleReset() {
    setDestination(null);
    setDestQuery("");
    setRouteInfo(null);
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

  const activeMode = MODES.find((m) => m.id === routeMode);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <div
        ref={mapContainer}
        style={{ position: "absolute", inset: 0 }}
      />

      <div
        style={{
          position: "absolute",
          top: isMobile ? "0.5rem" : "1rem",
          left: isMobile ? "0.5rem" : "1rem",
          right: isMobile ? "0.5rem" : "auto",
          width: isMobile ? "auto" : "300px",
          maxHeight: isMobile ? "calc(100dvh - 1rem)" : "calc(100vh - 2rem)",
          background: "rgba(18, 18, 20, 0.72)",
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

        <div
          className="mobile-collapsible"
          data-expanded={mobileExpanded ? "true" : "false"}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: isMobile ? "0.4rem" : "0.65rem",
            order: isMobile ? 3 : 0,
          }}
        >
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
                <span style={{ fontSize: "0.9rem", textDecoration: "none" }}>
                  {opt.icon}
                </span>
                {!isMobile && opt.label}
              </button>
            );
          })}
        </div>

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

        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            gap: "0.4rem",
            order: isMobile ? 1 : 0,
          }}
        >
          {showOrigin && (
            <SearchBox
              label="Starting point"
              icon="🟢"
              value={originQuery}
              biasLat={userLocation.current?.lat}
              biasLng={userLocation.current?.lng}
              onFocus={() => setMobileExpanded(true)}
              onChange={(v) => {
                setOriginQuery(v);
                if (origin?.isCurrent) setOrigin(null);
              }}
              onSelect={(p) => {
                setOrigin(p);
                setOriginQuery(p.name);
              }}
            />
          )}
          <SearchBox
            label="Where to?"
            icon="🔴"
            value={destQuery}
            biasLat={origin?.lat ?? userLocation.current?.lat}
            biasLng={origin?.lng ?? userLocation.current?.lng}
            onFocus={() => setMobileExpanded(true)}
            onChange={setDestQuery}
            onSelect={(p) => {
              setDestination(p);
              setDestQuery(p.name);
            }}
            onClear={
              routeMode === "scenic" && loading ? undefined : handleReset
            }
          />
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
                <div
                  style={{
                    width: "1px",
                    alignSelf: "stretch",
                    background: "rgba(255,255,255,0.08)",
                  }}
                />
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

        {routeInfo && !loading && routeMode === "scenic" && (
          <div
            style={{
              fontSize: "0.7rem",
              opacity: 0.6,
              textAlign: "center",
              marginTop: "-0.3rem",
            }}
          >
            {routeInfo.waypointCount > 0
              ? `via ${routeInfo.waypointCount} scenic stop${routeInfo.waypointCount > 1 ? "s" : ""}`
              : "No scenic detours found — using back-road bias"}
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .maplibregl-ctrl-bottom-right { margin-right: 1rem !important; margin-bottom: 1rem !important; }
        .maplibregl-ctrl-group {
          background: rgba(18,18,20,0.85) !important;
          backdrop-filter: blur(16px) saturate(140%);
          -webkit-backdrop-filter: blur(16px) saturate(140%);
          border: 1px solid rgba(255,255,255,0.1) !important;
          border-radius: 8px !important;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3) !important;
          overflow: hidden;
        }
        .maplibregl-ctrl-group button {
          background: transparent !important;
          width: 36px !important;
          height: 36px !important;
        }
        .maplibregl-ctrl-group button + button {
          border-top: 1px solid rgba(255,255,255,0.08) !important;
        }
        .maplibregl-ctrl-group button:hover {
          background: rgba(255,255,255,0.08) !important;
        }
        .maplibregl-ctrl-group button .maplibregl-ctrl-icon {
          filter: invert(1) brightness(1.2) opacity(0.85);
        }
        .maplibregl-ctrl-recenter {
          color: rgba(255,255,255,0.85);
          display: flex !important;
          align-items: center;
          justify-content: center;
        }
        .maplibregl-ctrl-recenter:hover {
          color: #a5b4fc;
        }
        .maplibregl-ctrl-attrib { display: none !important; }
        @media (max-width: 640px) {
          .maplibregl-ctrl-bottom-right {
            margin-right: 0.5rem !important;
            margin-bottom: calc(0.5rem + env(safe-area-inset-bottom, 0px)) !important;
          }
          .maplibregl-ctrl-group button { width: 42px !important; height: 42px !important; }
          input { font-size: 16px !important; }
          .searchbox-wrap { padding: 0.45rem 0.6rem !important; }
          .mobile-collapsible {
            overflow: hidden;
            transition: max-height 0.25s ease, opacity 0.18s ease, transform 0.22s ease;
            transform-origin: top center;
          }
          .mobile-collapsible[data-expanded="false"] {
            max-height: 0 !important;
            opacity: 0;
            transform: translateY(-8px);
            pointer-events: none;
            gap: 0 !important;
          }
          .mobile-collapsible[data-expanded="true"] {
            max-height: 320px;
            opacity: 1;
            transform: translateY(0);
          }
          .maplibregl-ctrl-group:has(.maplibregl-ctrl-zoom-in) {
            display: none !important;
          }
        }
      `}</style>
    </div>
  );
}

export default App;
