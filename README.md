# Manvir Map 🗺️

A fully self-hosted routing and geocoding web app — no Google Maps, no Mapbox, no API keys.

**Live demo: [map.manvir.stream](https://map.manvir.stream)**

## Features

- 🔍 **Address search** with autocomplete, powered by Photon and Canadian OSM data
- 🛣️ **Turn-by-turn routing** between any two points in Ontario
- 📏 **Distance and duration** displayed for every route
- 🗺️ **Interactive map** rendered with MapLibre GL
- 🔒 **HTTPS** via Let's Encrypt
- 💰 **Zero ongoing cost** — everything is open source and self-hosted

## Stack

| Layer | Technology |
|---|---|
| Routing engine | [Valhalla](https://github.com/valhalla/valhalla) |
| Geocoder | [Photon](https://github.com/komoot/photon) |
| Map data | [OpenStreetMap](https://www.openstreetmap.org/) |
| Frontend | React + [MapLibre GL](https://maplibre.org/) |
| Build tool | Vite |
| Container runtime | Docker Compose |
| Reverse proxy | nginx + SWAG |

## Architecture

```
Internet → SWAG (HTTPS, reverse proxy)
               ├── / → nginx (React frontend)
               ├── /api/* → Valhalla (routing engine)
               └── /photon/* → Photon (geocoder)
```

Everything runs on a self-hosted Linux server. The OSM tile data, geocoding index, and routing engine are all local — no external API calls at runtime.

## Running Locally

### Prerequisites
- Docker and Docker Compose
- ~15GB free disk space (for Ontario OSM tiles + Canada geocoding index)

### Setup

**1. Download Ontario OSM data**
```bash
wget https://download.geofabrik.de/north-america/canada/ontario-latest.osm.pbf
```

**2. Build Valhalla routing tiles**
```bash
docker compose up valhalla-build
```
This takes 30–60 minutes depending on your hardware.

**3. Start all services**
```bash
docker compose up -d
```

**4. Open the app**

Navigate to `http://localhost:8082`

## Data Sources

- **Routing tiles** — Built from [Geofabrik Ontario extract](https://download.geofabrik.de/north-america/canada.html)
- **Geocoding index** — Canada extract from [GraphHopper Photon downloads](https://download1.graphhopper.com/public/extracts/by-country-code/ca/)

## Roadmap

- [ ] Kubernetes deployment with Longhorn persistent storage
- [ ] Multiple routing profiles (walking, cycling, transit)
- [ ] Rate limiting
- [ ] Turn-by-turn directions panel

## License

MIT
