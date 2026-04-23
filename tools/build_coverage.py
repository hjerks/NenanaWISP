"""
Build a coverage heatmap for Nenana WISP.

Reads tower_config.yaml, fetches a DEM tile via OpenTopography (or uses a
manually-placed GeoTIFF), runs a per-cell path-loss calculation for the
coverage bounding box, and writes:

    docs/coverage/nenana_coverage.png   - transparent RGBA tinted by RSSI
    docs/coverage/nenana_coverage.json  - grid values + bounds + metadata

Propagation model:
  - "itmlogic"  : Longley-Rice (imported if available)
  - "knife_edge": Deygout multiple-knife-edge diffraction over the terrain
                  profile plus free-space path loss. Good enough for
                  5.8 GHz, 5 km, moderate terrain.
  - "auto"      : try itmlogic, fall back to knife_edge.

Re-run after editing tower_config.yaml:
    python tools/build_coverage.py
"""

from __future__ import annotations

import json
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

import numpy as np
import rasterio
import requests
import yaml
import matplotlib
from PIL import Image
from rasterio.transform import rowcol
from tqdm import tqdm

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
CONFIG_PATH = TOOLS_DIR / "tower_config.yaml"
CACHE_DIR = TOOLS_DIR / "cache"
OUT_DIR = REPO_ROOT / "docs" / "coverage"
KEY_FILE = TOOLS_DIR / ".opentopography_key"

CACHE_DIR.mkdir(exist_ok=True)
OUT_DIR.mkdir(parents=True, exist_ok=True)

EARTH_RADIUS_M = 6_371_000.0


# ---------------------------------------------------------------------------
# Config dataclasses
# ---------------------------------------------------------------------------
@dataclass
class Antenna:
    model: str
    peak_gain_dbi: float
    h_beamwidth_deg: float
    v_beamwidth_deg: float
    front_to_back_db: float


@dataclass
class Sector:
    id: str
    azimuth_deg: float
    mech_downtilt_deg: float
    elec_downtilt_deg: float
    tx_power_dbm: float
    antenna: Antenna


@dataclass
class Tower:
    id: str
    lat: float
    lon: float
    ground_elev_m: Optional[float]
    antenna_centerline_agl_m: float
    frequency_mhz: float
    feeder_loss_db: float
    sectors: List[Sector]


@dataclass
class Config:
    radius_km: float
    grid_res_m: float
    bounds_override: Optional[List[float]]
    cpe_gain_dbi: float
    cpe_height_m: float
    cpe_feeder_loss_db: float
    good_dbm: float
    marginal_dbm: float
    clutter_ref_m: float
    clutter_intercept_db: float
    clutter_slope_db_per_decade: float
    model: str
    climate: int
    polarization: str
    ot_dataset: str
    manual_dem_path: str
    towers: List[Tower]


def load_config(path: Path) -> Config:
    with open(path, "r") as fh:
        raw = yaml.safe_load(fh)
    towers = []
    for t in raw["towers"]:
        sectors = [
            Sector(
                id=s["id"],
                azimuth_deg=float(s["azimuth_deg"]),
                mech_downtilt_deg=float(s["mech_downtilt_deg"]),
                elec_downtilt_deg=float(s["elec_downtilt_deg"]),
                tx_power_dbm=float(s["tx_power_dbm"]),
                antenna=Antenna(
                    model=s["antenna"]["model"],
                    peak_gain_dbi=float(s["antenna"]["peak_gain_dbi"]),
                    h_beamwidth_deg=float(s["antenna"]["h_beamwidth_deg"]),
                    v_beamwidth_deg=float(s["antenna"]["v_beamwidth_deg"]),
                    front_to_back_db=float(s["antenna"]["front_to_back_db"]),
                ),
            )
            for s in t["sectors"]
        ]
        towers.append(
            Tower(
                id=t["id"],
                lat=float(t["lat"]),
                lon=float(t["lon"]),
                ground_elev_m=t.get("ground_elev_m"),
                antenna_centerline_agl_m=float(t["antenna_centerline_agl_m"]),
                frequency_mhz=float(t["frequency_mhz"]),
                feeder_loss_db=float(t["feeder_loss_db"]),
                sectors=sectors,
            )
        )
    return Config(
        radius_km=float(raw["coverage"]["radius_km"]),
        grid_res_m=float(raw["coverage"]["grid_res_m"]),
        bounds_override=raw["coverage"].get("bounds_override"),
        cpe_gain_dbi=float(raw["cpe"]["antenna_gain_dbi"]),
        cpe_height_m=float(raw["cpe"]["mount_height_m"]),
        cpe_feeder_loss_db=float(raw["cpe"]["feeder_loss_db"]),
        good_dbm=float(raw["thresholds"]["good_min_dbm"]),
        marginal_dbm=float(raw["thresholds"]["marginal_min_dbm"]),
        clutter_ref_m=float(raw["clutter"]["ref_distance_m"]),
        clutter_intercept_db=float(raw["clutter"]["intercept_db"]),
        clutter_slope_db_per_decade=float(raw["clutter"]["slope_db_per_decade"]),
        model=str(raw["propagation"]["model"]).lower(),
        climate=int(raw["propagation"]["climate"]),
        polarization=str(raw["propagation"]["polarization"]).lower(),
        ot_dataset=str(raw["dem"]["opentopography_dataset"]),
        manual_dem_path=str(raw["dem"]["manual_dem_path"]),
        towers=towers,
    )


# ---------------------------------------------------------------------------
# Geo helpers (local ENU approximation - fine for 5 km)
# ---------------------------------------------------------------------------
def bbox_for(center_lat: float, center_lon: float, radius_km: float) -> Tuple[float, float, float, float]:
    """Return (south, west, north, east) in degrees for a square box of +/-radius_km around center."""
    dlat = (radius_km * 1000.0) / (EARTH_RADIUS_M * math.pi / 180.0)
    dlon = dlat / math.cos(math.radians(center_lat))
    return (center_lat - dlat, center_lon - dlon, center_lat + dlat, center_lon + dlon)


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


# ---------------------------------------------------------------------------
# DEM loading
# ---------------------------------------------------------------------------
def read_opentopo_key() -> Optional[str]:
    if KEY_FILE.exists():
        return KEY_FILE.read_text().strip()
    return None


def fetch_dem(bbox: Tuple[float, float, float, float], dataset: str, manual_path: str) -> Path:
    """Download DEM from OpenTopography, or use manually-placed GeoTIFF."""
    south, west, north, east = bbox
    cached = CACHE_DIR / f"dem_{dataset}_{south:.4f}_{west:.4f}_{north:.4f}_{east:.4f}.tif"
    if cached.exists():
        print(f"[dem] using cached DEM: {cached.name}")
        return cached

    manual = TOOLS_DIR / manual_path
    if manual.exists():
        print(f"[dem] using manual DEM: {manual}")
        return manual

    key = read_opentopo_key()
    if not key:
        print(
            "[dem] ERROR: no OpenTopography key at tools/.opentopography_key and no manual DEM.\n"
            "      Get a free key at https://portal.opentopography.org/ or drop a GeoTIFF\n"
            f"      at {manual}"
        )
        sys.exit(1)

    url = "https://portal.opentopography.org/API/globaldem"
    params = {
        "demtype": dataset,
        "south": south,
        "north": north,
        "west": west,
        "east": east,
        "outputFormat": "GTiff",
        "API_Key": key,
    }
    print(f"[dem] fetching {dataset} from OpenTopography for bbox S={south:.4f} W={west:.4f} N={north:.4f} E={east:.4f} ...")
    r = requests.get(url, params=params, timeout=120)
    if r.status_code != 200 or r.headers.get("Content-Type", "").startswith("text/"):
        print(f"[dem] OpenTopography error {r.status_code}: {r.text[:400]}")
        sys.exit(1)
    cached.write_bytes(r.content)
    print(f"[dem] cached to {cached}")
    return cached


def sample_elevation(dem, lat: float, lon: float) -> float:
    try:
        row, col = rowcol(dem.transform, lon, lat)
        row = int(np.clip(row, 0, dem.height - 1))
        col = int(np.clip(col, 0, dem.width - 1))
        return float(dem.read(1)[row, col])
    except Exception:
        return float("nan")


def sample_terrain_profile(dem, arr: np.ndarray, lat1: float, lon1: float, lat2: float, lon2: float, n: int) -> np.ndarray:
    """Sample n elevation points along the great-circle path (nearest-neighbor on DEM)."""
    lats = np.linspace(lat1, lat2, n)
    lons = np.linspace(lon1, lon2, n)
    rows, cols = rowcol(dem.transform, lons.tolist(), lats.tolist())
    rows = np.clip(np.asarray(rows), 0, dem.height - 1)
    cols = np.clip(np.asarray(cols), 0, dem.width - 1)
    return arr[rows, cols].astype(np.float64)


# ---------------------------------------------------------------------------
# Antenna pattern (ideal sector until a real .msi is dropped in)
# ---------------------------------------------------------------------------
def antenna_gain(ant: Antenna, az_offset_deg: float, el_offset_deg: float) -> float:
    """Approximate 2D gain: peak - max(H-rolloff, V-rolloff), floored at -FTB."""
    # Normalize az offset to [-180, 180]
    a = ((az_offset_deg + 180.0) % 360.0) - 180.0
    h_roll = 12.0 * (a / (ant.h_beamwidth_deg / 2.0)) ** 2 if ant.h_beamwidth_deg > 0 else 0.0
    v_roll = 12.0 * (el_offset_deg / (ant.v_beamwidth_deg / 2.0)) ** 2 if ant.v_beamwidth_deg > 0 else 0.0
    # Classic 3GPP-ish pattern: -min(12(x/BW)^2, floor)
    gain = ant.peak_gain_dbi - min(h_roll + v_roll, ant.front_to_back_db)
    return gain


# ---------------------------------------------------------------------------
# Propagation models
# ---------------------------------------------------------------------------
def fspl_db(distance_m: float, freq_mhz: float) -> float:
    if distance_m < 1.0:
        distance_m = 1.0
    return 20.0 * math.log10(distance_m) + 20.0 * math.log10(freq_mhz) - 27.55


def deygout_diffraction_db(
    d_m: np.ndarray,
    h_m: np.ndarray,
    tx_h_agl: float,
    rx_h_agl: float,
    freq_hz: float,
) -> float:
    """Deygout 3-edge diffraction loss over a terrain profile.

    d_m: cumulative distances along path, length N, d_m[0]=0, d_m[-1]=total
    h_m: ground elevation (m AMSL) along path, length N
    tx_h_agl: transmitter antenna above ground at start
    rx_h_agl: receiver antenna above ground at end
    Returns total diffraction loss in dB (>= 0).
    """
    lam = 299_792_458.0 / freq_hz
    tx_elev = h_m[0] + tx_h_agl
    rx_elev = h_m[-1] + rx_h_agl
    total_d = d_m[-1]
    if total_d <= 0:
        return 0.0

    def edge_loss(i_start: int, i_end: int) -> Tuple[float, int]:
        """Return (loss_db, worst_index). i_start, i_end are inclusive endpoints."""
        if i_end - i_start < 2:
            return 0.0, -1
        hs = h_m[i_start + 1 : i_end]
        ds = d_m[i_start + 1 : i_end]
        d1_arr = ds - d_m[i_start]
        d2_arr = d_m[i_end] - ds
        # Line-of-sight elevation at each intermediate point
        d_total = d_m[i_end] - d_m[i_start]
        if d_total <= 0:
            return 0.0, -1
        h_start_elev = tx_elev if i_start == 0 else h_m[i_start]
        h_end_elev = rx_elev if i_end == len(h_m) - 1 else h_m[i_end]
        los_elev = h_start_elev + (h_end_elev - h_start_elev) * (d1_arr / d_total)
        # Obstruction height above LOS
        h_obs = hs - los_elev
        # Fresnel parameter v = h * sqrt(2(d1+d2)/(lam*d1*d2))
        with np.errstate(divide="ignore", invalid="ignore"):
            v = h_obs * np.sqrt(2.0 * (d1_arr + d2_arr) / (lam * d1_arr * d2_arr))
        # Pick worst edge by v
        if v.size == 0:
            return 0.0, -1
        idx_local = int(np.argmax(v))
        vmax = float(v[idx_local])
        if vmax <= -0.78:
            return 0.0, -1
        # Approximate ITU-R P.526 knife-edge loss for v > -0.78
        loss = 6.9 + 20.0 * math.log10(math.sqrt((vmax - 0.1) ** 2 + 1.0) + vmax - 0.1)
        return loss, i_start + 1 + idx_local

    # Main edge
    main_loss, main_idx = edge_loss(0, len(h_m) - 1)
    if main_idx < 0:
        return 0.0
    # Secondary edges on each side of the main one
    left_loss, _ = edge_loss(0, main_idx)
    right_loss, _ = edge_loss(main_idx, len(h_m) - 1)
    return max(0.0, main_loss + left_loss + right_loss)


# itmlogic is optional. If the import fails, we fall back.
_ITMLOGIC = None


def try_import_itmlogic():
    global _ITMLOGIC
    if _ITMLOGIC is not None:
        return _ITMLOGIC
    try:
        from itmlogic.qkpfl import qkpfl  # type: ignore  # noqa: F401

        _ITMLOGIC = qkpfl
        return _ITMLOGIC
    except Exception as e:
        print(f"[model] itmlogic not available ({e.__class__.__name__}: {e}); falling back to knife_edge")
        _ITMLOGIC = False
        return False


# ---------------------------------------------------------------------------
# Main path-loss calculation for one tx->rx pair
# ---------------------------------------------------------------------------
def rssi_for_path(
    tower: Tower,
    sector: Sector,
    cfg: Config,
    dem,
    dem_arr: np.ndarray,
    rx_lat: float,
    rx_lon: float,
    tx_ground_elev_m: float,
    model: str,
) -> float:
    d_m = haversine_m(tower.lat, tower.lon, rx_lat, rx_lon)
    # Near-field isn't modelled here. Clamp to one grid cell so the on-tower
    # pixel doesn't display a nonsense RSSI of nearly 0 dBm.
    if d_m < cfg.grid_res_m:
        d_m = cfg.grid_res_m
    brg = bearing_deg(tower.lat, tower.lon, rx_lat, rx_lon)
    az_offset = brg - sector.azimuth_deg
    az_offset = ((az_offset + 180.0) % 360.0) - 180.0

    # Terrain profile for diffraction/elevation-geometry
    n_samples = max(16, int(d_m / max(cfg.grid_res_m, 15.0)))
    profile = sample_terrain_profile(dem, dem_arr, tower.lat, tower.lon, rx_lat, rx_lon, n_samples)
    d_axis = np.linspace(0.0, d_m, n_samples)

    tx_h_agl = tower.antenna_centerline_agl_m
    rx_h_agl = cfg.cpe_height_m
    tx_abs = tx_ground_elev_m + tx_h_agl
    rx_ground_elev = float(profile[-1])
    rx_abs = rx_ground_elev + rx_h_agl

    # Elevation angle from tx to rx (positive = rx above tx)
    el_deg = math.degrees(math.atan2(rx_abs - tx_abs, d_m))
    # Downtilt: positive downtilt means beam aimed below horizon. Beam axis elev = -total_downtilt.
    total_downtilt = sector.mech_downtilt_deg + sector.elec_downtilt_deg
    beam_el = -total_downtilt
    el_offset = el_deg - beam_el

    g_tx = antenna_gain(sector.antenna, az_offset, el_offset)

    # Path loss
    freq_hz = tower.frequency_mhz * 1e6
    if model == "itmlogic" and try_import_itmlogic():
        # itmlogic expects profile as list: [num_points_minus_1, res_m, elev0, elev1, ...]
        # Kept minimal: fall back to knife_edge below if it throws.
        try:
            from itmlogic.qkpfl import qkpfl  # type: ignore

            res_m = d_m / (n_samples - 1)
            pfl = [n_samples - 1, res_m] + profile.tolist()
            # Climate, polarization, K-factor etc.
            pol = 0 if cfg.polarization.startswith("h") else 1
            # Reasonable defaults: surface refractivity 301, climate from cfg, permittivity 15, conductivity 0.005
            result = qkpfl(
                pfl=pfl,
                klimx=cfg.climate,
                enc0=301.0,
                ipol=pol,
                dielec=15.0,
                sgm=0.005,
                tht_g1=tx_h_agl,
                tht_g2=rx_h_agl,
                frq=tower.frequency_mhz,
                qc=50.0,
                qt=50.0,
            )
            l_db = float(result) if isinstance(result, (int, float)) else float(result[0])
        except Exception as e:
            # Silent fallback per-cell to knife_edge
            l_db = fspl_db(d_m, tower.frequency_mhz) + deygout_diffraction_db(
                d_axis, profile, tx_h_agl, rx_h_agl, freq_hz
            )
    else:
        l_db = fspl_db(d_m, tower.frequency_mhz) + deygout_diffraction_db(
            d_axis, profile, tx_h_agl, rx_h_agl, freq_hz
        )

    # Clutter: log-distance excess loss calibrated against ground-truth SMs.
    clutter_db = cfg.clutter_intercept_db + cfg.clutter_slope_db_per_decade * math.log10(
        max(d_m, 1.0) / cfg.clutter_ref_m
    )
    clutter_db = max(0.0, clutter_db)

    rssi_dbm = (
        sector.tx_power_dbm
        - tower.feeder_loss_db
        + g_tx
        - l_db
        - clutter_db
        + cfg.cpe_gain_dbi
        - cfg.cpe_feeder_loss_db
    )
    return rssi_dbm


# ---------------------------------------------------------------------------
# Grid sweep
# ---------------------------------------------------------------------------
def build_grid(cfg: Config, dem) -> Tuple[np.ndarray, Tuple[float, float, float, float]]:
    """Return (rssi_array[rows, cols], (sw_lat, sw_lon, ne_lat, ne_lon)).
    rows are ordered north->south (row 0 = north)."""
    primary = cfg.towers[0]
    if cfg.bounds_override:
        south, west, north, east = cfg.bounds_override
    else:
        south, west, north, east = bbox_for(primary.lat, primary.lon, cfg.radius_km)

    # Derive grid dimensions from requested resolution in meters
    mid_lat = 0.5 * (south + north)
    m_per_deg_lat = EARTH_RADIUS_M * math.pi / 180.0
    m_per_deg_lon = m_per_deg_lat * math.cos(math.radians(mid_lat))
    rows = max(2, int(round((north - south) * m_per_deg_lat / cfg.grid_res_m)))
    cols = max(2, int(round((east - west) * m_per_deg_lon / cfg.grid_res_m)))
    print(f"[grid] {rows} rows x {cols} cols ({rows*cols} cells), res~{cfg.grid_res_m:.0f}m")

    dem_arr = dem.read(1)

    # Resolve tower ground elevations from DEM if missing
    for t in cfg.towers:
        if t.ground_elev_m is None:
            t.ground_elev_m = sample_elevation(dem, t.lat, t.lon)
            print(f"[grid] {t.id} ground elev (from DEM) = {t.ground_elev_m:.1f} m AMSL")

    lats = np.linspace(north, south, rows)  # row 0 is north
    lons = np.linspace(west, east, cols)

    rssi = np.full((rows, cols), -200.0, dtype=np.float32)

    t_start = time.time()
    total_cells = rows * cols
    with tqdm(total=total_cells, unit="cell") as pbar:
        for ri, lat in enumerate(lats):
            for ci, lon in enumerate(lons):
                best = -200.0
                for t in cfg.towers:
                    for s in t.sectors:
                        val = rssi_for_path(
                            t, s, cfg, dem, dem_arr, lat, lon, float(t.ground_elev_m), cfg.model
                        )
                        if val > best:
                            best = val
                rssi[ri, ci] = best
                pbar.update(1)
    print(f"[grid] done in {time.time()-t_start:.1f}s")
    return rssi, (south, west, north, east)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------
def render_png(rssi: np.ndarray, cfg: Config, out_path: Path) -> None:
    """Red->yellow->green gradient tinted by RSSI with alpha by signal strength."""
    rgba = np.zeros((rssi.shape[0], rssi.shape[1], 4), dtype=np.uint8)
    # Clamp visualization range: -120 (transparent) ... -50 (full strength)
    vmin, vmax = -120.0, -50.0
    norm = np.clip((rssi - vmin) / (vmax - vmin), 0.0, 1.0)

    # RdYlGn colormap (red->yellow->green) gives us the right semantics
    cmap = matplotlib.colormaps["RdYlGn"]
    colors = cmap(norm)  # (H, W, 4) float 0..1
    rgba[..., :3] = (colors[..., :3] * 255).astype(np.uint8)

    # Alpha: 0 below cutoff, ramping up with signal strength
    alpha = np.zeros_like(rssi, dtype=np.float32)
    below_floor = rssi <= (cfg.marginal_dbm - 10.0)  # fully transparent well below no-signal
    alpha = np.clip((rssi - (cfg.marginal_dbm - 10.0)) / 25.0, 0.0, 0.85)
    alpha[below_floor] = 0.0
    rgba[..., 3] = (alpha * 255).astype(np.uint8)

    Image.fromarray(rgba, mode="RGBA").save(out_path)
    print(f"[render] wrote {out_path}")


def write_json(
    rssi: np.ndarray,
    bounds: Tuple[float, float, float, float],
    cfg: Config,
    out_path: Path,
) -> None:
    south, west, north, east = bounds
    payload = {
        "bounds": [[south, west], [north, east]],
        "grid_res_m": cfg.grid_res_m,
        "rows": int(rssi.shape[0]),
        "cols": int(rssi.shape[1]),
        "row_order": "north_to_south",
        "col_order": "west_to_east",
        "units": "dBm (RSSI at CPE input)",
        "thresholds": {
            "good_min_dbm": cfg.good_dbm,
            "marginal_min_dbm": cfg.marginal_dbm,
        },
        "clutter": {
            "ref_distance_m": cfg.clutter_ref_m,
            "intercept_db": cfg.clutter_intercept_db,
            "slope_db_per_decade": cfg.clutter_slope_db_per_decade,
        },
        "towers": [
            {
                "id": t.id,
                "lat": t.lat,
                "lon": t.lon,
                "ground_elev_m": t.ground_elev_m,
                "antenna_centerline_agl_m": t.antenna_centerline_agl_m,
                "frequency_mhz": t.frequency_mhz,
                "sectors": [
                    {
                        "id": s.id,
                        "azimuth_deg": s.azimuth_deg,
                        "mech_downtilt_deg": s.mech_downtilt_deg,
                        "elec_downtilt_deg": s.elec_downtilt_deg,
                        "tx_power_dbm": s.tx_power_dbm,
                        "antenna": {
                            "model": s.antenna.model,
                            "peak_gain_dbi": s.antenna.peak_gain_dbi,
                            "h_beamwidth_deg": s.antenna.h_beamwidth_deg,
                            "v_beamwidth_deg": s.antenna.v_beamwidth_deg,
                        },
                    }
                    for s in t.sectors
                ],
            }
            for t in cfg.towers
        ],
        "rssi_dbm": np.round(rssi, 1).tolist(),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "model": cfg.model,
    }
    with open(out_path, "w") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    print(f"[render] wrote {out_path}  ({out_path.stat().st_size/1024:.0f} KB)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    cfg = load_config(CONFIG_PATH)
    primary = cfg.towers[0]
    if cfg.bounds_override:
        bbox = tuple(cfg.bounds_override)
    else:
        bbox = bbox_for(primary.lat, primary.lon, cfg.radius_km)
    dem_path = fetch_dem(bbox, cfg.ot_dataset, cfg.manual_dem_path)
    with rasterio.open(dem_path) as dem:
        rssi, bounds = build_grid(cfg, dem)

    render_png(rssi, cfg, OUT_DIR / "nenana_coverage.png")
    write_json(rssi, bounds, cfg, OUT_DIR / "nenana_coverage.json")

    # Quick stats summary
    finite = rssi[rssi > -199]
    if finite.size:
        print(
            f"[stats] RSSI min={finite.min():.1f}  median={np.median(finite):.1f}  "
            f"max={finite.max():.1f}  dBm"
        )
        good = (finite >= cfg.good_dbm).mean() * 100
        marg = ((finite >= cfg.marginal_dbm) & (finite < cfg.good_dbm)).mean() * 100
        bad = (finite < cfg.marginal_dbm).mean() * 100
        print(f"[stats] good {good:.1f}%  marginal {marg:.1f}%  no-signal {bad:.1f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
