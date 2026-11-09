import re
from datetime import UTC, date, datetime
from pathlib import Path

import numpy as np
import pandas as pd
import requests


CIRA_25KM_URL = 'https://adelaide.cira.colostate.edu/tc/tcs-25km.txt'
IBTRACS_URL = (
    'https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs'
    '/v04r01/access/csv/ibtracs.since1980.list.v04r01.csv'
)
CIRA_COLUMNS = [
    'storm',
    'basin_flag',
    'granule',
    'date',
    'cira_min_dist_km',
    'wind_ms',
    'pressure_mb',
    'shear_kt',
    'sst_c',
]
CIRA_NUMERIC = ['granule', 'cira_min_dist_km', 'wind_ms', 'pressure_mb', 'shear_kt', 'sst_c']
IBTRACS_COLUMNS = ['SID', 'BASIN', 'NAME', 'ISO_TIME', 'LAT', 'LON', 'USA_WIND', 'WMO_WIND', 'USA_PRES', 'WMO_PRES']
BASIN_NAMES = {
    'NA': 'North Atlantic',
    'EP': 'East Pacific',
    'WP': 'West Pacific',
    'NI': 'North Indian',
    'SI': 'South Indian',
    'SP': 'South Pacific',
    'SA': 'South Atlantic',
}
EARTH_RADIUS_KM = 6371.0
MS_PER_KT = 0.514444
SSHS_LIMITS_KT = [34, 64, 83, 96, 113, 137]
CATEGORIES = ['TD', 'TS', 'C1', 'C2', 'C3', 'C4', 'C5']
UNNAMED = 'NOT_NAMED'
NAME_MATCH_MAX_KM = 300.0
NEAREST_MATCH_MAX_KM = 150.0
ACTIVE_PAD_S = 6 * 3600
A_TRAIN_WINDOWS = [(date(2006, 6, 1), date(2011, 4, 17)), (date(2012, 5, 15), date(2017, 12, 5))]
EPOCH_09 = (date(2019, 7, 11), date(2020, 8, 26))


def download(url: str, path: Path) -> Path:
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + '.part')
    with requests.get(url, stream=True, timeout=600) as response, partial.open('wb') as file:
        response.raise_for_status()
        [file.write(chunk) for chunk in response.iter_content(1 << 20)]
    partial.rename(path)
    return path


def read_cira_overpasses(url: str = CIRA_25KM_URL) -> pd.DataFrame:
    lines = requests.get(url, timeout=60).text.splitlines()[2:]
    rows = [line.split() for line in lines if len(line.split()) == len(CIRA_COLUMNS)]
    table = pd.DataFrame(rows, columns=CIRA_COLUMNS).drop(columns='basin_flag')
    table[CIRA_NUMERIC] = table[CIRA_NUMERIC].astype(float)
    table[CIRA_NUMERIC] = table[CIRA_NUMERIC].where(table[CIRA_NUMERIC] > -999)
    table['granule'] = table['granule'].astype(int)
    table['date'] = [datetime.strptime(d, '%Y/%m/%d').date() for d in table['date']]
    table['id'] = [f'{g:05d}_{re.sub(r"[^A-Z0-9-]", "-", s.upper())}' for g, s in zip(table.granule, table.storm)]
    return table


def read_ibtracs(path: Path, first_year: int = 2005, last_year: int = 2020) -> pd.DataFrame:
    table = pd.read_csv(
        path, usecols=IBTRACS_COLUMNS, skiprows=[1], keep_default_na=False, na_values=['', ' '], low_memory=False
    )
    table['time'] = pd.to_datetime(table['ISO_TIME'], utc=True)
    table = table[table['time'].dt.year.between(first_year, last_year)].copy()
    table['t'] = (table['time'] - pd.Timestamp('1970-01-01', tz='UTC')).dt.total_seconds()
    table['wind_kt'] = table['USA_WIND'].fillna(table['WMO_WIND'])
    table['pressure_mb'] = table['USA_PRES'].fillna(table['WMO_PRES'])
    return table[['SID', 'BASIN', 'NAME', 'time', 't', 'LAT', 'LON', 'wind_kt', 'pressure_mb']]


def storm_tracks(ibtracs: pd.DataFrame) -> dict[str, pd.DataFrame]:
    return {sid: g.drop_duplicates('t').sort_values('t') for sid, g in ibtracs.groupby('SID')}


def wrap_lon(lon: np.ndarray) -> np.ndarray:
    return (lon + 180.0) % 360.0 - 180.0


def haversine_km(lat1: np.ndarray, lon1: np.ndarray, lat2: np.ndarray, lon2: np.ndarray) -> np.ndarray:
    phi1, phi2 = np.deg2rad(lat1), np.deg2rad(lat2)
    dphi, dlam = phi2 - phi1, np.deg2rad(lon2 - lon1)
    a = np.sin(dphi / 2) ** 2 + np.cos(phi1) * np.cos(phi2) * np.sin(dlam / 2) ** 2
    return 2 * EARTH_RADIUS_KM * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def storm_center(track: pd.DataFrame, t: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lon = np.rad2deg(np.unwrap(np.deg2rad(track['LON'].to_numpy())))
    lat_c = np.interp(t, track['t'], track['LAT'], left=np.nan, right=np.nan)
    lon_c = np.interp(t, track['t'], lon, left=np.nan, right=np.nan)
    return lat_c, wrap_lon(lon_c)


def distance_to_storm(track: pd.DataFrame, geolocation: dict[str, np.ndarray]) -> np.ndarray:
    lat_c, lon_c = storm_center(track, geolocation['time'])
    distance = haversine_km(geolocation['lat'], geolocation['lon'], lat_c, lon_c)
    return np.where(np.isfinite(distance), distance, np.inf)


def active_storms(tracks: dict[str, pd.DataFrame], t0: float, t1: float) -> list[str]:
    return [
        sid for sid, g in tracks.items() if g['t'].iloc[0] <= t1 + ACTIVE_PAD_S and g['t'].iloc[-1] >= t0 - ACTIVE_PAD_S
    ]


def match_storm(
    tracks: dict[str, pd.DataFrame], storm: str, geolocation: dict[str, np.ndarray]
) -> tuple[str, np.ndarray]:
    t = geolocation['time']
    distances = {sid: distance_to_storm(tracks[sid], geolocation) for sid in active_storms(tracks, t[0], t[-1])}
    names = {sid: tracks[sid]['NAME'].iloc[0] for sid in distances}
    named = sorted(
        (d.min(), sid) for sid, d in distances.items() if names[sid] == storm and d.min() < NAME_MATCH_MAX_KM
    )
    unnamed = sorted(
        (d.min(), sid) for sid, d in distances.items() if names[sid] == UNNAMED and d.min() < NEAREST_MATCH_MAX_KM
    )
    matches = named or unnamed
    if not matches:
        raise LookupError(f'no IBTrACS fix for {storm} at this time (outside the IBTrACS storm lifetime)')
    return matches[0][1], distances[matches[0][1]]


def along_track_km(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    return np.concatenate([[0.0], np.cumsum(haversine_km(lat[:-1], lon[:-1], lat[1:], lon[1:]))])


def window(distance_km: np.ndarray, center: int, half_width_km: float) -> tuple[int, int]:
    inside = np.flatnonzero(np.abs(distance_km - distance_km[center]) <= half_width_km)
    return int(inside[0]), int(inside[-1]) + 1


def category(wind_kt: float) -> str | None:
    return CATEGORIES[int(np.searchsorted(SSHS_LIMITS_KT, wind_kt, side='right'))] if np.isfinite(wind_kt) else None


def is_daytime(t: float, lon: float) -> bool:
    utc_hours = (t % 86400) / 3600
    return 6 <= (utc_hours + lon / 15) % 24 < 18


def in_a_train(day: date) -> bool:
    return any(start <= day < stop for start, stop in A_TRAIN_WINDOWS)


def in_epoch_09(day: date) -> bool:
    return EPOCH_09[0] <= day <= EPOCH_09[1]


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, UTC).strftime('%Y-%m-%dT%H:%M:%SZ')


def finite_or_none(x: float, digits: int = 1) -> float | None:
    return round(float(x), digits) if np.isfinite(x) else None


def track_points(track: pd.DataFrame) -> list[list]:
    return [
        [iso(t), round(lat, 2), round(lon, 2), finite_or_none(wind, 0)]
        for t, lat, lon, wind in zip(track['t'], track['LAT'], track['LON'], track['wind_kt'])
    ]
