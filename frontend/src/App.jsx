import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

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

function SearchBox({ label, icon, value, onChange, onSelect, inputRef }) {
  const [results, setResults] = useState([]);
  const [focused, setFocused] = useState(false);

  async function handleChange(e) {
    const val = e.target.value;
    onChange(val);
    if (val.length < 3) {
      setResults([]);
      return;
    }
    const res = await fetch(
      `/photon/api?q=${encodeURIComponent(val)}&limit=5&lat=43.7315&lon=-79.7624`,
    );
    const data = await res.json();
    setResults(data.features);
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
    onSelect({ lng, lat, name });
  }

  return (
    <div style={{ position: "relative" }}>
      <div
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
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder={label}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "#f3f4f6",
            fontSize: "0.9rem",
            fontFamily: "inherit",
          }}
        />
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
          {results.map((f, i) => (
            <li
              key={i}
              onClick={() => handleSelect(f)}
              style={{
                padding: "0.5rem 0.6rem",
                cursor: "pointer",
                fontSize: "0.85rem",
                color: "#e5e7eb",
                borderRadius: "6px",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "rgba(255,255,255,0.06)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              {formatName(f.properties)}
            </li>
          ))}
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
  const [showOrigin, setShowOrigin] = useState(false);
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

    const cached = (() => {
      try {
        return JSON.parse(localStorage.getItem("lastLocation"));
      } catch {
        return null;
      }
    })();
    const initialCenter = cached
      ? [cached.lng, cached.lat]
      : [-79.383184, 43.653226];
    const initialZoom = cached ? 15 : 9;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: initialCenter,
      zoom: initialZoom,
      pitchWithRotate: false,
    });

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
        btn.onclick = () => {
          if (userLocation.current) {
            const { lng, lat } = userLocation.current;
            map.current?.flyTo({ center: [lng, lat], zoom: 15, duration: 800 });
          } else if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition((pos) => {
              const { latitude: lat, longitude: lng } = pos.coords;
              userLocation.current = { lng, lat };
              map.current?.flyTo({
                center: [lng, lat],
                zoom: 15,
                duration: 800,
              });
            });
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

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude: lat, longitude: lng } = pos.coords;
          userLocation.current = { lng, lat };
          try {
            localStorage.setItem("lastLocation", JSON.stringify({ lng, lat }));
          } catch {}
          if (!cached) {
            map.current.jumpTo({ center: [lng, lat], zoom: 15 });
          } else {
            map.current.setCenter([lng, lat]);
          }

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
        () => {},
        { enableHighAccuracy: true, timeout: 8000 },
      );
    }
  }, []);

  useEffect(() => {
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

    if (origin && destination) fetchRoute(origin, destination);
    else clearRoute();
  }, [origin, destination, routeMode]);

  function clearRoute() {
    if (map.current?.getSource("route")) {
      map.current.removeLayer("route-line");
      map.current.removeSource("route");
    }
    setRouteInfo(null);
  }

  async function fetchRoute(o, d) {
    const costingOptions = {
      normal: {},
      newDriver: {
        auto: { use_highways: 0, use_tolls: 0, turn_penalty_factor: 100 },
      },
      scenic: { auto: { use_scenic: 1 } },
    };
    const routeColors = {
      normal: "#3b82f6",
      newDriver: "#f59e0b",
      scenic: "#22c55e",
    };

    setLoading(true);
    try {
      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locations: [
            { lon: o.lng, lat: o.lat, radius: 10 },
            { lon: d.lng, lat: d.lat, radius: 10 },
          ],
          costing: "auto",
          costing_options: costingOptions[routeMode],
          directions_options: { units: "kilometres" },
        }),
      });
      const data = await res.json();
      const { length, time } = data.trip.summary;
      setRouteInfo({
        distance: length.toFixed(1),
        duration: Math.round(time / 60),
      });

      const coords = decodePolyline(data.trip.legs[0].shape);
      if (map.current.getSource("route")) {
        map.current.removeLayer("route-line");
        map.current.removeSource("route");
      }
      map.current.addSource("route", {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords },
        },
      });
      map.current.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": routeColors[routeMode], "line-width": 5 },
      });
      const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new maplibregl.LngLatBounds(coords[0], coords[0]),
      );
      map.current.fitBounds(bounds, {
        padding: isMobile
          ? { top: 240, bottom: 80, left: 40, right: 40 }
          : { top: 80, bottom: 80, left: 340, right: 80 },
      });
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
    setOrigin(null);
    setDestination(null);
    setOriginQuery("");
    setDestQuery("");
    setRouteInfo(null);
    const home = userLocation.current;
    map.current?.flyTo({
      center: home ? [home.lng, home.lat] : [-79.383184, 43.653226],
      zoom: home ? 15 : 9,
      duration: 1000,
    });
  }

  function decodePolyline(encoded) {
    let index = 0,
      lat = 0,
      lng = 0;
    const coords = [];
    while (index < encoded.length) {
      let b,
        shift = 0,
        result = 0;
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
          padding: "0.85rem",
          gap: "0.65rem",
          boxShadow: "0 12px 40px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.25)",
          overflow: "visible",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
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
          {(origin?.isCurrent === false || destination) && (
            <button
              onClick={handleReset}
              title="Reset"
              style={{
                background: "transparent",
                color: "rgba(255,255,255,0.5)",
                border: "none",
                cursor: "pointer",
                fontSize: "1rem",
                padding: "0.15rem 0.4rem",
                borderRadius: "6px",
                lineHeight: 1,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(255,255,255,0.08)";
                e.currentTarget.style.color = "#ef4444";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "rgba(255,255,255,0.5)";
              }}
            >
              ✕
            </button>
          )}
        </div>

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
                  padding: "0.4rem 0.3rem",
                  cursor: "pointer",
                  color: active ? m.color : "rgba(255,255,255,0.6)",
                  fontSize: "0.72rem",
                  fontWeight: active ? 600 : 500,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "0.3rem",
                  transition: "all 0.15s",
                }}
              >
                <span style={{ fontSize: "0.85rem" }}>{m.icon}</span>
                {m.label}
              </button>
            );
          })}
        </div>

        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            gap: "0.4rem",
          }}
        >
          {showOrigin && (
            <SearchBox
              label="Starting point"
              icon="🟢"
              value={originQuery}
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
            onChange={setDestQuery}
            onSelect={(p) => {
              setDestination(p);
              setDestQuery(p.name);
            }}
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
            }}
          >
            ← Use my current location
          </button>
        )}

        {(loading || routeInfo) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              padding: "0.6rem 0.75rem",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: "10px",
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
                  Calculating route…
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
                      fontSize: "0.62rem",
                      opacity: 0.5,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    Distance
                  </div>
                  <div
                    style={{
                      fontSize: "1rem",
                      fontWeight: 700,
                      color: activeMode.color,
                      lineHeight: 1.1,
                    }}
                  >
                    {routeInfo.distance}
                    <span
                      style={{
                        fontSize: "0.7rem",
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
                      fontSize: "0.62rem",
                      opacity: 0.5,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    Duration
                  </div>
                  <div
                    style={{
                      fontSize: "1rem",
                      fontWeight: 700,
                      color: activeMode.color,
                      lineHeight: 1.1,
                    }}
                  >
                    {routeInfo.duration}
                    <span
                      style={{
                        fontSize: "0.7rem",
                        opacity: 0.7,
                        marginLeft: "2px",
                        fontWeight: 500,
                      }}
                    >
                      min
                    </span>
                  </div>
                </div>
              </>
            )}
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
        @media (max-width: 640px) {
          .maplibregl-ctrl-bottom-right {
            margin-right: 0.5rem !important;
            margin-bottom: calc(0.5rem + env(safe-area-inset-bottom, 0px)) !important;
          }
          .maplibregl-ctrl-group button { width: 42px !important; height: 42px !important; }
          input { font-size: 16px !important; }
        }
      `}</style>
    </div>
  );
}

export default App;
