# firestorm-adsb-proxy

5-second cached ADS-B proxy for [FIRESTORM](https://github.com/Deasus/Firestorm).

## Why

[airplanes.live](https://airplanes.live) rate-limits (HTTP 429) aggressive browser polling within ~30 min at UAT scale. This proxy sits in front of it: browsers poll this proxy every 5s, the proxy caches responses for 5s, so N concurrent UAT users collapse to **1 upstream request per 5s** regardless of user count.

Complements [firestorm-aircraft-data](https://github.com/Deasus/firestorm-aircraft-data) — that pipeline does 5-min global snapshots, this proxy serves the live-radar experience.

## Usage

```
GET /api/point?lat=40&lng=-115&radius=500
```

Returns the same JSON shape as `api.airplanes.live/v2/point/{lat}/{lng}/{radius}`. CORS is wide open (`*`) so the FIRESTORM HTML can call it directly.

Response headers:

- `X-Cache: HIT | MISS | STALE` — whether we served cached, fetched fresh, or fell back to stale on upstream error
- `X-Cache-Age-Ms: <number>` — age of served data when HIT/STALE
- `X-Upstream: primary | failover` — which upstream we used (airplanes.live / adsb.lol)

## Failover

- **Primary:** airplanes.live
- **Failover:** adsb.lol (same schema)
- On primary HTTP 429: cool for 5 min, use failover
- On any upstream error with a stale cache available: serve the stale cache
- On any upstream error with no cache: return 502

## Deploy

Linked to Vercel. Pushing to `main` auto-deploys.

```
vercel                    # preview deploy
vercel --prod             # production deploy
```

Local dev:

```
vercel dev                # runs at localhost:3000
curl 'http://localhost:3000/api/point?lat=40&lng=-115&radius=500'
```

## License

Proxy code: MIT.  
Upstream data: CC0 (adsb.lol) and feeder-network open (airplanes.live).
