# Test fixtures

- `tomtom-flow-austin-12-935-1686.pbf` — one real TomTom traffic-flow vector
  tile (Mapbox Vector Tile protobuf, layer `"Traffic flow"`), downtown Austin
  z12 x935 y1686, captured 2026-07-16 from
  `api.tomtom.com/traffic/map/4/tile/flow/relative/12/935/1686.pbf`
  (22,980 bytes). Used by offline decode/source tests and the explicit `qa-traffic --fixtures`
  browser mode — it is a point-in-time congestion snapshot, not a bundled
  data layer, and is never loaded by ordinary application startup. © TomTom.
- `ofm-austin-{14-3743-6745,12-935-1686}.pbf` — OpenFreeMap / OpenMapTiles tiles from
  `https://tiles.openfreemap.org/planet/20260913_164504_pt/{z}/{x}/{y}.pbf`,
  retrieved 2026-09-23. Trimmed to one transportation feature per class/direction,
  preserving original geometry and dictionaries.
  OpenFreeMap © OpenMapTiles Data from OpenStreetMap; © OpenStreetMap
  contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).
  These modified data fixtures retain ODbL attribution and database share-alike;
  commercial use and redistribution are permitted under that license. Test-only.

- `traffic-road-access.json` — representative transportation properties and two
  original vertices per feature near the Texas Capitol, Camp Mabry greenbelt,
  and Austin commercial car parks, from OpenFreeMap z14 tiles, retrieved
  2026-09-25. Each record names its XYZ tile and expected traffic eligibility.
  Modified, test-only OpenStreetMap data; same ODbL attribution and database
  share-alike terms as the OpenFreeMap fixtures above.
- `level3-KTLX-{N0S,N0K,EET}-20261002-0109.bin` — three real NEXRAD Level III
  product files from KTLX (Oklahoma City), volume scan 2026-10-02 01:09:25Z,
  downloaded unmodified from NOAA's public `unidata-nexrad-level3` bucket
  (AWS Open Data; U.S. public domain). One per encoding the decoder handles:
  N0S storm-relative velocity (uncompressed, run-length radials), N0K
  specific differential phase (bzip2, float32 scale/offset) and EET echo
  tops (bzip2, masked levels). Used ONLY by `src/layers/nexrad/level3.test.mjs`.
