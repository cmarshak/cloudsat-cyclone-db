import re
import urllib.parse
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from pathlib import Path

import numpy as np
import requests


THREDDS = 'https://dpc-thredds.cira.colostate.edu/thredds'
GEOPROF = '2B-GEOPROF.P1_R05'
N_BINS = 125
XDR_DTYPES = {
    'Byte': '>u1',
    'Int16': '>i4',
    'UInt16': '>u4',
    'Int32': '>i4',
    'UInt32': '>u4',
    'Float32': '>f4',
    'Float64': '>f8',
}


def read_env(path: str | Path = '.env') -> dict[str, str]:
    lines = [line.strip() for line in Path(path).read_text().splitlines()]
    return dict(line.split('=', 1) for line in lines if '=' in line and not line.startswith('#'))


def opendap_session(env: dict[str, str]) -> requests.Session:
    session = requests.Session()
    session.auth = (env['CLOUDSAT_OPENDAP_EMAIL'], env['CLOUDSAT_OPENDAP_PSWD'])
    return session


@lru_cache(maxsize=8192)
def day_granules(product: str, day: date) -> tuple[str, ...]:
    url = f'{THREDDS}/catalog/cloudsat-data/{product}/{day:%Y}/{day:%j}/catalog.xml'
    response = requests.get(url, timeout=60)
    if response.status_code == 404:
        return ()
    response.raise_for_status()
    return tuple(re.findall(r'<dataset name="([^"]+\.hdf)"', response.text))


def granule_path(product: str, granule: int, day: date) -> str:
    candidates = [(d, name) for d in (day, day - timedelta(days=1)) for name in day_granules(product, d)]
    hits = [(d, name) for d, name in candidates if f'_{granule:05d}_' in name]
    if not hits:
        raise LookupError(f'granule {granule} not in {product} catalogs for {day} or the day before')
    d, name = hits[0]
    return f'{product}/{d:%Y}/{d:%j}/{name}'


def granule_start(path: str) -> datetime:
    return datetime.strptime(Path(path).name[:13], '%Y%j%H%M%S').replace(tzinfo=UTC)


def hyperslab(*ranges: tuple[int, int]) -> str:
    return ''.join(f'[{start}:{stop - 1}]' for start, stop in ranges)


def read_variable(session: requests.Session, path: str, variable: str, index: str = '') -> np.ndarray:
    swath = path.split('/')[0].split('.')[0]
    constraint = urllib.parse.quote(f'/{swath}/{variable}{index}', safe='/[]:')
    response = session.get(f'{THREDDS}/dodsC/cloudsat-data/{path}.dods?{constraint}', timeout=300)
    response.raise_for_status()
    dds, _, body = response.content.partition(b'\nData:\n')
    declaration = dds.decode().split('{', 1)[1].strip().splitlines()[0]
    dtype = XDR_DTYPES[declaration.split()[0]]
    shape = [int(n) for n in re.findall(r'=\s*(\d+)\]', declaration)]
    if not shape:
        return np.frombuffer(body, dtype, count=1)
    return np.frombuffer(body, dtype, count=int(np.prod(shape)), offset=8).reshape(shape)


def read_geolocation(session: requests.Session, path: str) -> dict[str, np.ndarray]:
    lat, lon, profile_time, utc_start = [
        read_variable(session, path, f'Geolocation_Fields/{name}')
        for name in ('Latitude', 'Longitude', 'Profile_time', 'UTC_start')
    ]
    midnight = granule_start(path).replace(hour=0, minute=0, second=0).timestamp()
    return {
        'lat': lat.astype(np.float64),
        'lon': lon.astype(np.float64),
        'time': midnight + float(utc_start[0]) + profile_time.astype(np.float64),
    }


def read_profiles(session: requests.Session, path: str, start: int, stop: int) -> dict[str, np.ndarray]:
    index = hyperslab((start, stop), (0, N_BINS))
    return {
        'dbz100': read_variable(session, path, 'Data_Fields/Radar_Reflectivity', index).astype(np.int16),
        'cloud_mask': read_variable(session, path, 'Data_Fields/CPR_Cloud_mask', index).astype(np.int8),
        'height_m': read_variable(session, path, 'Geolocation_Fields/Height', index).astype(np.int16),
    }
