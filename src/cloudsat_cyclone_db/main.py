import json
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path

import click
import numpy as np
import pandas as pd
import requests

from cloudsat_cyclone_db.cloudsat_opendap import (
    GEOPROF,
    granule_path,
    opendap_session,
    read_env,
    read_geolocation,
    read_profiles,
)
from cloudsat_cyclone_db.curtains import HALF_WIDTH_KM, curtain_grid, curtain_header, write_curtain
from cloudsat_cyclone_db.overpasses import (
    BASIN_NAMES,
    IBTRACS_URL,
    MS_PER_KT,
    along_track_km,
    category,
    download,
    finite_or_none,
    in_a_train,
    in_epoch_09,
    is_daytime,
    iso,
    match_storm,
    read_cira_overpasses,
    read_ibtracs,
    storm_center,
    storm_tracks,
    track_points,
    window,
)


TRUNCATION_TOLERANCE_KM = 5.0
IBTRACS_FILE = 'ibtracs.since1980.list.v04r01.csv'


def overpass_record(row: tuple, path: str, sid: str, track: pd.DataFrame, closest: dict) -> dict:
    t_c, lat, lon, distance_km, rel_km = (closest[k] for k in ('t', 'lat', 'lon', 'distance_km', 'rel_km'))
    lat_c, lon_c = (round(float(v[0]), 3) for v in storm_center(track, np.array([t_c])))
    fix = track.iloc[int(np.argmin(np.abs(track['t'].to_numpy() - t_c)))]
    wind_kt = row.wind_ms / MS_PER_KT
    return {
        'id': row.id,
        'storm': row.storm,
        'ibtracs_name': fix['NAME'],
        'sid': sid,
        'basin': fix['BASIN'],
        'basin_name': BASIN_NAMES.get(fix['BASIN'], fix['BASIN']),
        'granule': int(row.granule),
        'file': path,
        'date': row.date.isoformat(),
        't_closest': iso(t_c),
        'lat': round(lat, 3),
        'lon': round(lon, 3),
        'storm_lat': lat_c,
        'storm_lon': lon_c,
        'min_dist_km': round(distance_km, 1),
        'cira_min_dist_km': finite_or_none(row.cira_min_dist_km),
        'wind_ms': finite_or_none(row.wind_ms),
        'wind_kt': finite_or_none(wind_kt, 0),
        'category': category(wind_kt),
        'pressure_mb': finite_or_none(row.pressure_mb, 0),
        'shear_kt': finite_or_none(row.shear_kt),
        'sst_c': finite_or_none(row.sst_c),
        'daytime': is_daytime(t_c, lon),
        'a_train': in_a_train(row.date),
        'epoch_09': in_epoch_09(row.date),
        'n_profiles': int(rel_km.size),
        'dist_min_km': round(float(rel_km[0]), 1),
        'dist_max_km': round(float(rel_km[-1]), 1),
        'truncated': bool(min(-rel_km[0], rel_km[-1]) < HALF_WIDTH_KM - TRUNCATION_TOLERANCE_KM),
    }


def build_overpass(row: tuple, env: dict, tracks: dict, folder: Path, force: bool) -> dict:
    cached = folder / f'{row.id}.json'
    if cached.exists() and not force:
        return json.loads(cached.read_text())['overpass']
    session = opendap_session(env)
    path = granule_path(GEOPROF, row.granule, row.date)
    geolocation = read_geolocation(session, path)
    sid, distance = match_storm(tracks, row.storm, geolocation)
    center = int(np.argmin(distance))
    along = along_track_km(geolocation['lat'], geolocation['lon'])
    start, stop = window(along, center, HALF_WIDTH_KM)
    grid = curtain_grid(read_profiles(session, path, start, stop))
    t = geolocation['time']
    closest = {
        't': float(t[center]),
        'lat': float(geolocation['lat'][center]),
        'lon': float(geolocation['lon'][center]),
        'distance_km': float(distance[center]),
        'rel_km': along[start:stop] - along[center],
    }
    record = overpass_record(row, path, sid, tracks[sid], closest) | {
        'echo_fraction': round(float((grid > 0).mean()), 3)
    }
    lat, lon = geolocation['lat'][start:stop], geolocation['lon'][start:stop]
    write_curtain(folder, curtain_header(record, lat, lon, t[start:stop] - t[center], closest['rel_km']), grid)
    return record


def build_or_error(row: tuple, env: dict, tracks: dict, folder: Path, force: bool) -> dict:
    try:
        return build_overpass(row, env, tracks, folder, force)
    except (requests.RequestException, LookupError, ValueError) as error:
        return {'id': row.id, 'error': f'{type(error).__name__}: {error}'}


def select_rows(rows: pd.DataFrame, only: tuple[str, ...], limit: int | None) -> pd.DataFrame:
    wanted = {o.upper() for o in only}
    picked = rows[rows['id'].isin(wanted) | rows['storm'].str.upper().isin(wanted)] if wanted else rows
    return picked.head(limit) if limit else picked


def write_site_index(site_dir: Path, tracks: dict) -> list[dict]:
    folder = site_dir / 'data' / 'curtains'
    records = sorted(
        (json.loads(p.read_text())['overpass'] for p in folder.glob('*.json')), key=lambda r: r['t_closest']
    )
    storms = {
        sid: {
            'name': tracks[sid]['NAME'].iloc[0],
            'basin': tracks[sid]['BASIN'].iloc[0],
            'points': track_points(tracks[sid]),
        }
        for sid in sorted({r['sid'] for r in records})
    }
    (site_dir / 'data' / 'overpasses.json').write_text(json.dumps(records, separators=(',', ':')))
    (site_dir / 'data' / 'storm_tracks.json').write_text(json.dumps(storms, separators=(',', ':')))
    return records


def qa_table(records: list[dict]) -> pd.DataFrame:
    columns = [
        'id',
        'date',
        'basin',
        'category',
        'min_dist_km',
        'cira_min_dist_km',
        'n_profiles',
        'truncated',
        'echo_fraction',
    ]
    table = pd.DataFrame(records)[columns]
    return table.assign(dist_diff_km=(table['min_dist_km'] - table['cira_min_dist_km']).round(1))


@click.group()
def cli() -> None:
    pass


@cli.command()
@click.option('--site', 'site_dir', default='site', type=click.Path(path_type=Path), show_default=True)
@click.option('--raw', 'raw_dir', default='data/raw', type=click.Path(path_type=Path), show_default=True)
@click.option('--env', 'env_path', default='.env', type=click.Path(path_type=Path), show_default=True)
@click.option('--only', multiple=True, help='Overpass id (e.g. 23094_EARL) or storm name; repeatable.')
@click.option('--limit', type=int, help='Build at most this many overpasses.')
@click.option('--workers', default=6, show_default=True, help='Concurrent OPeNDAP overpass fetches.')
@click.option('--force', is_flag=True, help='Rebuild curtains that already exist.')
def build(
    site_dir: Path, raw_dir: Path, env_path: Path, only: tuple, limit: int | None, workers: int, force: bool
) -> None:
    env = read_env(env_path)
    rows = select_rows(read_cira_overpasses(), only, limit)
    tracks = storm_tracks(read_ibtracs(download(IBTRACS_URL, raw_dir / IBTRACS_FILE)))
    folder = site_dir / 'data' / 'curtains'
    click.echo(f'building {len(rows)} overpasses with {workers} workers')
    with ThreadPoolExecutor(workers) as pool:
        results = list(
            pool.map(partial(build_or_error, env=env, tracks=tracks, folder=folder, force=force), rows.itertuples())
        )
    failures = [r for r in results if 'error' in r]
    records = write_site_index(site_dir, tracks)
    size_mb = sum(p.stat().st_size for p in (site_dir / 'data').rglob('*') if p.is_file()) / 1e6
    with pd.option_context('display.max_rows', 400, 'display.width', 200):
        click.echo(qa_table(records).to_string(index=False))
    click.echo(f'{len(records)} overpasses in site index, {len(failures)} failed, site/data = {size_mb:.1f} MB')
    [click.echo(f'FAILED {f["id"]}: {f["error"]}') for f in failures]


if __name__ == '__main__':
    cli()
