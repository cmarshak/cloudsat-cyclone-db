# cloudsat-cyclone-db

> **Source.** This repository builds on the **CloudSat Tropical Cyclone (2D-TC) product** and its overpass database, produced by Natalie Tourville at CIRA, Colorado State University:
>
> - **CloudSat Tropical Cyclone Product:** <https://www.cloudsat.cira.colostate.edu/community-products/cloudsat-tropical-cyclone-product>
> - **CloudSat Tropical Cyclone overpass database:** <https://adelaide.cira.colostate.edu/tc/>
>
> The overpasses shown here come from that database's list of passes within 25 km of a storm center ([tcs-25km.txt](https://adelaide.cira.colostate.edu/tc/tcs-25km.txt)). For each one, this repo cuts the curtain from the standard CloudSat 2B-GEOPROF R05 product. Primary reference: Tourville et al. (2015), see [References](#references).

An interactive viewer for CloudSat radar curtains through tropical cyclones. It shows a globe with one dot per overpass (hover for metadata, click to load), the IBTrACS best track, Aqua MODIS imagery for that day, and the 94 GHz reflectivity curtain in a linked panel. Hovering the curtain moves a marker on the globe, and hovering the ground track moves a cursor on the curtain.

- **Overpasses:** 174 overpasses (2006-2019) from CIRA's list of CloudSat passes within 25 km of a storm center.
- **Reflectivity:** CloudSat 2B-GEOPROF R05, read over OPeNDAP.
- **Size:** all viewer data is about 35 MB of static files in `site/data/`.

## Setup

Install [pixi](https://pixi.sh) if you don't have it:

```bash
curl -fsSL https://pixi.sh/install.sh | bash
pixi install
```

## View locally

```bash
pixi run serve
```

Open <http://127.0.0.1:8000>. Deep links work, e.g. `http://127.0.0.1:8000/#40693_AMARA`.

The page has to be served over HTTP: browsers block the data loads on `file://`. `site/` is plain HTML, CSS and JS with no build step, so it can also be published as-is (for example on GitHub Pages).

## Rebuild the data

You need a CloudSat DPC THREDDS account (email cloudsat@colostate.edu). Put the credentials in `.env`, which is gitignored:

```bash
CLOUDSAT_OPENDAP_EMAIL=you@example.org
CLOUDSAT_OPENDAP_PSWD=...
```

```bash
pixi run build                    # all overpasses; skips curtains already on disk
pixi run build --only EARL        # by storm name or id (23094_EARL); repeatable
pixi run build --force --limit 5  # rebuild the first five
```

A full build takes a few minutes with 6 workers. The first run downloads IBTrACS (145 MB) into `data/raw/`, which is gitignored. Each run prints a QA table comparing our closest-approach distance with CIRA's.

## How it works

1. **Overpass list.** Read `tcs-25km.txt` (CIRA): storm name, granule, date, and best-track intensity.
2. **Granule file.** Find it in the public THREDDS catalog; filenames encode the orbit start time.
3. **Geolocation.** Read latitude, longitude and time for the whole orbit over OPeNDAP. These are small 1-D fields.
4. **Closest approach.** Interpolate the IBTrACS centre to each profile's own time and take the closest approach.
5. **Window.** Read only the ±1000 km slice of `Radar_Reflectivity`, `CPR_Cloud_mask` and `Height`.
6. **Regrid and quantize.** Regrid each profile onto a fixed 0-20 km, 240 m grid. Keep echoes with `CPR_Cloud_mask >= 20`, then store dBZ as uint8 (`dBZ = -35 + 0.25 (q - 1)`, `q = 0` = no echo), with at most 0.125 dB rounding error.
7. **Write.** `site/data/curtains/<id>.json` holds per-profile lat, lon, time and distance plus the overpass record. `<id>.u8` is the 84 × n_profiles grid.

[notebooks/01_earl_overpass.ipynb](notebooks/01_earl_overpass.ipynb) walks through these steps for Hurricane Earl, using the same functions:

```bash
pixi run jupyter lab
```

The OPeNDAP reader in [cloudsat_opendap.py](src/cloudsat_cyclone_db/cloudsat_opendap.py) requests `.dods?var[a:b][c:d]` with `requests` and decodes the DAP2 binary directly (big-endian; Int16 is sent as 4 bytes). We don't use pydap because it did not keep the DPC's login through the server's redirect.

## Findings and caveats

- **102 of 276 listed overpasses have no curtain.**
  - 97 fall outside the storm's IBTrACS lifetime. CIRA's list includes pre-genesis disturbances and post-tropical stages that the official best tracks don't cover.
  - 5 granules are missing from the R05 archive.
- **CIRA's distances are not comparable to ours.** For the first 19 overpasses, CIRA's min-distance column matched the storm position at the granule start time (median error 4.4 km) better than at the actual crossing time (14.8 km). Example: Earl is 0.5 km in CIRA's list but 50 km from the official track at the crossing time. The viewer shows both numbers.
- **2019-2020 geolocation error.** These R05 data have a known pointing/timing error of up to 10 km; the viewer flags them.
- **MODIS timing.** The imagery is a daily Aqua MODIS composite. It is within about 1 minute of CloudSat only while CloudSat flew in the A-Train with Aqua (to April 2011, and May 2012 to December 2017).
- **W-band attenuation.** At 94 GHz, heavy rain attenuates the signal strongly, so echoes fade toward the surface under eyewalls.

## Credits

- **Overpass database and product:** [CloudSat Tropical Cyclone Product](https://www.cloudsat.cira.colostate.edu/community-products/cloudsat-tropical-cyclone-product) and the [CloudSat TC overpass database](https://adelaide.cira.colostate.edu/tc/), CIRA, Colorado State University (Tourville et al. 2015).
- **Reflectivity:** CloudSat 2B-GEOPROF R05, CloudSat Data Processing Center, CIRA, Colorado State University.
- **Best tracks:** IBTrACS v04r01 (Knapp et al. 2010).
- **Imagery:** NASA GIBS.

## Linting

```bash
pixi run lint     # ruff check .
pixi run format   # ruff format .
```

## References

### Product and data

- Tourville, N., G. Stephens, M. DeMaria, and D. Vane, 2015: Remote Sensing of Tropical Cyclones: Observations from CloudSat and A-Train Profilers. Bull. Amer. Meteor. Soc., 96, 609-622. [doi:10.1175/BAMS-D-13-00282.1](https://doi.org/10.1175/BAMS-D-13-00282.1)
- Knapp, K. R., M. C. Kruk, D. H. Levinson, H. J. Diamond, and C. J. Neumann, 2010: The International Best Track Archive for Climate Stewardship (IBTrACS): Unifying Tropical Cyclone Best Track Data. Bull. Amer. Meteor. Soc., 91, 363-376. [doi:10.1175/2009BAMS2755.1](https://doi.org/10.1175/2009BAMS2755.1)

### CloudSat tropical cyclone studies

- Mitrescu, Cristian, Steven Miller, Jeffrey Hawkins, Tristan L'Ecuyer, Joseph Turk, Philip Partain, Graeme Stephens, 2008: Near-Real-Time Applications of CloudSat Data. J. Appl. Meteor. Climatol., 47, 1982-1994. [doi:10.1175/2007JAMC1794.1](https://doi.org/10.1175/2007JAMC1794.1)
- Luo Z., Stephens G. L., Emanuel K. A., Vane D. G., Tourville N. D., Haynes J.M., 2008: On the use of CloudSat and MODIS data for estimating hurricane intensity. IEEE Geosci Remote Sens Lett; 5(1): 13-6.
- Durden, Stephen L., Simone Tanelli and Gregg Dobrowalski, 2009: CloudSat and A-Train Observations of Tropical Cyclones, The Open Atmospheric Science Journal, 3, 80-92.
- Schubert, W. H. and B. D. McNoldy, 2010: Application of the Concepts of Rossby Length and Rossby Depth to Tropical Cyclone Dynamics. J. Adv. Model. Earth Syst., Vol. 2, Art. #7, 13 pp. [doi:10.3894/JAMES.2010.2.7](https://doi.org/10.3894/JAMES.2010.2.7)
- Matrosov, S. Y., 2011: CloudSat measurements of landfalling hurricanes Gustav and Ike (2008), J. Geophys. Res., 116, D01203. [doi:10.1029/2010JD014506](https://doi.org/10.1029/2010JD014506)
