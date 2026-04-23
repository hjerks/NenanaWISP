# Coverage model (offline)

Builds a translucent coverage heatmap over Nenana from the tower config and a
terrain model. Outputs land in `docs/coverage/` and are served by the admin
portal at runtime.

## One-time setup

```bash
cd tools
pip install -r requirements.txt
```

OpenTopography API key (for the DEM):

1. Get a free key: https://portal.opentopography.org/
2. Save it on one line in `tools/.opentopography_key` (git-ignored).

Already done on this machine.

## Run

```bash
python tools/build_coverage.py
```

Writes:

- `docs/coverage/nenana_coverage.png` — transparent RGBA, red/yellow/green
- `docs/coverage/nenana_coverage.json` — grid values + bounds + metadata

The first run downloads a DEM tile into `tools/cache/` (~1 MB). Subsequent
runs reuse it.

Typical runtime on a laptop: ~30–90 s for a 5 km × 5 km box at 30 m grid
(≈110k cells) with the knife-edge model.

## Editing the tower config

Everything tunable lives in `tower_config.yaml`:

- Tower position, height, frequency, TX power
- Sector azimuth and tilt
- Antenna pattern (peak gain + 3 dB beamwidths)
- CPE gain + height
- Classification thresholds (Good / Marginal / No-signal)
- Propagation model: `auto` | `knife_edge` | `itmlogic`

Re-run the script to regenerate both artifacts.

## Propagation model

- **knife_edge** (default fallback): terrain-aware Deygout 3-edge diffraction
  over the SRTM/Cop30 profile + free-space path loss + antenna pattern.
  Fast, pure-Python, no native deps. Good to ~±3 dB vs. Longley-Rice at
  5.8 GHz over 5 km in moderate terrain.
- **itmlogic**: Longley-Rice ITM. Uncomment `itmlogic` in
  `requirements.txt` and `pip install` it. If the import fails, the script
  prints a warning and falls back to knife_edge per cell.

## DEM

We use Copernicus GLO-30 via OpenTopography. Nenana is at ~64.56 °N, which is
outside SRTM's 60 °N coverage limit, so COP30 is the right choice.

Cached tiles live in `tools/cache/` keyed by bounding box. If OpenTopography
is down, drop any GeoTIFF DEM covering the bbox at `tools/cache/dem.tif` and
the script will use it instead.

## Calibration

Sanity-check against a known SM after the first run:

- Baker SM (`SM-102/Baker`): reports DL RSSI ≈ −83 dBm and has good LOS to
  Nenana_4500. Drop a pin at that address (Part B) and the modeled RSSI at
  that grid cell should land within a few dB.
- If the model is systematically optimistic/pessimistic, adjust
  `peak_gain_dbi` or `tx_power_dbm` in the config and re-run — don't hack
  around it in code.
