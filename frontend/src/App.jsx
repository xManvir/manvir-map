import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

function SearchBox({ label, onSelect }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])

  async function handleChange(e) {
    const val = e.target.value
    setQuery(val)
    if (val.length < 3) { setResults([]); return }

    const res = await fetch(`/photon/api?q=${encodeURIComponent(val)}&limit=5&lat=43.7315&lon=-79.7624`)
    const data = await res.json()
    setResults(data.features)
  }

  function handleSelect(feature) {
    const [lng, lat] = feature.geometry.coordinates
    const name = formatName(feature.properties)
    setQuery(name)
    setResults([])
    onSelect({ lng, lat, name })
  }

  function formatName(props) {
    return [props.name, props.street, props.city, props.state]
      .filter(Boolean).join(', ')
  }

  return (
    <div style={{ position: 'relative', flex: 1 }}>
      <input
        value={query}
        onChange={handleChange}
        placeholder={label}
        style={{
          width: '100%',
          padding: '0.5rem 0.75rem',
          borderRadius: '8px',
          border: '1px solid #ddd',
          fontSize: '0.9rem',
          boxSizing: 'border-box'
        }}
      />
      {results.length > 0 && (
        <ul style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          background: 'white',
          border: '1px solid #ddd',
          borderRadius: '8px',
          marginTop: '4px',
          padding: 0,
          listStyle: 'none',
          zIndex: 1000,
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
        }}>
          {results.map((f, i) => (
            <li
              key={i}
              onClick={() => handleSelect(f)}
              style={{
                padding: '0.5rem 0.75rem',
                cursor: 'pointer',
                borderBottom: i < results.length - 1 ? '1px solid #f0f0f0' : 'none',
                fontSize: '0.85rem'
              }}
              onMouseEnter={e => e.target.style.background = '#f5f5f5'}
              onMouseLeave={e => e.target.style.background = 'white'}
            >
              {formatName(f.properties)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function App() {
  const mapContainer = useRef(null)
  const map = useRef(null)
  const markers = useRef([])
  const [points, setPoints] = useState([])
  const [routeInfo, setRouteInfo] = useState(null)
  const [resetKey, setResetKey] = useState(0)

  useEffect(() => {
    if (map.current) return
    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [-79.7624, 43.7315],
      zoom: 10
    })
  }, [])

  useEffect(() => {
    markers.current.forEach(m => m.remove())
    markers.current = []

    points.forEach(({ lng, lat }) => {
      const marker = new maplibregl.Marker()
        .setLngLat([lng, lat])
        .addTo(map.current)
      markers.current.push(marker)
    })

    if (points.length === 2) fetchRoute(points[0], points[1])
  }, [points])

  async function fetchRoute(origin, destination) {
    const body = {
      locations: [
        { lon: origin.lng, lat: origin.lat },
        { lon: destination.lng, lat: destination.lat }
      ],
      costing: 'auto',
      directions_options: { units: 'kilometres' }
    }

    const res = await fetch('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })

    const data = await res.json()
    const { length, time } = data.trip.summary
    setRouteInfo({ distance: length.toFixed(1), duration: Math.round(time / 60) })

    const coords = decodePolyline(data.trip.legs[0].shape)

    if (map.current.getSource('route')) {
      map.current.removeLayer('route-line')
      map.current.removeSource('route')
    }

    map.current.addSource('route', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } }
    })

    map.current.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      paint: { 'line-color': '#3b82f6', 'line-width': 4 }
    })

    // Fit map to route
    const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]))
    map.current.fitBounds(bounds, { padding: 60 })
  }

  function handleReset() {
    markers.current.forEach(m => m.remove())
    markers.current = []
    setPoints([])
    setRouteInfo(null)
    setResetKey(k => k + 1)
    if (map.current.getSource('route')) {
      map.current.removeLayer('route-line')
      map.current.removeSource('route')
    }
  }

  function decodePolyline(encoded) {
    let index = 0, lat = 0, lng = 0
    const coords = []
    while (index < encoded.length) {
      let b, shift = 0, result = 0
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
      lat += result & 1 ? ~(result >> 1) : result >> 1
      shift = 0; result = 0
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
      lng += result & 1 ? ~(result >> 1) : result >> 1
      coords.push([lng / 1e6, lat / 1e6])
    }
    return coords
  }

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

      <div style={{
        position: 'absolute',
        top: '1rem',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'white',
        borderRadius: '12px',
        padding: '0.75rem 1rem',
        boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        width: '400px',
        fontFamily: 'sans-serif'
      }}>
        <SearchBox key={`origin-${resetKey}`} label="Origin" onSelect={(p) => setPoints(prev => [p, prev[1]].filter(Boolean))} />
        <SearchBox key={`destination-${resetKey}`} label="Destination" onSelect={(p) => setPoints(prev => [prev[0], p].filter(Boolean))} />
        {routeInfo && (
          <div style={{ display: 'flex', gap: '1rem', fontSize: '0.9rem', paddingTop: '0.25rem' }}>
            <span>🛣️ <strong>{routeInfo.distance} km</strong></span>
            <span>⏱️ <strong>{routeInfo.duration} min</strong></span>
          </div>
        )}

        {points.length > 0 && (
          <button onClick={handleReset} style={{
            background: '#ef4444',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            padding: '0.4rem',
            cursor: 'pointer',
            fontWeight: 'bold',
            fontSize: '0.85rem'
          }}>
            Reset
          </button>
        )}
      </div>
    </div>
  )
}

export default App
