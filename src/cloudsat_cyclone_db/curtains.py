import json
from pathlib import Path

import numpy as np


HALF_WIDTH_KM = 1000.0
HEIGHT_STEP_KM = 0.24
N_HEIGHTS = 84
DBZ_LO = -35.0
DBZ_STEP = 0.25
DBZ100_VALID = (-4000, 5000)
CLOUD_MASK_MIN = 20
HEIGHT_FILL = -9999


def target_heights_m() -> np.ndarray:
    return np.arange(N_HEIGHTS) * HEIGHT_STEP_KM * 1000.0


def nearest_bins(height_m: np.ndarray, target_m: np.ndarray) -> np.ndarray:
    bins = np.arange(height_m.shape[1], dtype=float)
    fractional = [np.interp(target_m, h[::-1], bins[::-1], left=-1, right=-1) for h in height_m.astype(float)]
    index = np.rint(np.array(fractional)).astype(int)
    return np.where((height_m == HEIGHT_FILL).any(axis=1, keepdims=True), -1, index)


def quantize_dbz(dbz: np.ndarray, keep: np.ndarray) -> np.ndarray:
    q = np.clip(np.rint((dbz - DBZ_LO) / DBZ_STEP) + 1, 1, 255)
    return np.where(keep, q, 0).astype(np.uint8)


def dequantize_dbz(q: np.ndarray) -> np.ndarray:
    return np.where(q > 0, DBZ_LO + DBZ_STEP * (q.astype(float) - 1), np.nan)


def curtain_grid(profiles: dict[str, np.ndarray]) -> np.ndarray:
    index = nearest_bins(profiles['height_m'], target_heights_m())
    dbz100 = np.take_along_axis(profiles['dbz100'], index.clip(0), axis=1)
    cloud_mask = np.take_along_axis(profiles['cloud_mask'], index.clip(0), axis=1)
    valid = (dbz100 >= DBZ100_VALID[0]) & (dbz100 <= DBZ100_VALID[1])
    keep = (index >= 0) & (cloud_mask >= CLOUD_MASK_MIN) & valid
    return quantize_dbz(dbz100 / 100.0, keep).T.copy()


def curtain_header(record: dict, lat: np.ndarray, lon: np.ndarray, t: np.ndarray, dist_km: np.ndarray) -> dict:
    return {
        'id': record['id'],
        'n_profiles': int(lat.size),
        'height_km': {'start': 0.0, 'step': HEIGHT_STEP_KM, 'n': N_HEIGHTS},
        'dbz': {'lo': DBZ_LO, 'step': DBZ_STEP, 'nodata': 0},
        'layout': 'uint8 [n_heights, n_profiles], row 0 = lowest height',
        't_closest': record['t_closest'],
        't_s': np.round(t, 2).tolist(),
        'lat': np.round(lat, 3).tolist(),
        'lon': np.round(lon, 3).tolist(),
        'dist_km': np.round(dist_km, 2).tolist(),
        'overpass': record,
    }


def write_curtain(folder: Path, header: dict, grid: np.ndarray) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f'{header["id"]}.u8').write_bytes(grid.astype(np.uint8).tobytes())
    (folder / f'{header["id"]}.json').write_text(json.dumps(header, separators=(',', ':')))


def read_curtain(folder: Path, overpass_id: str) -> tuple[dict, np.ndarray]:
    header = json.loads((folder / f'{overpass_id}.json').read_text())
    grid = np.frombuffer((folder / f'{overpass_id}.u8').read_bytes(), np.uint8)
    return header, grid.reshape(header['height_km']['n'], header['n_profiles'])
