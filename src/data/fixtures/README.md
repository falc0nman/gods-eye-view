# Test fixtures

- `tomtom-flow-austin-12-935-1686.pbf` — one real TomTom traffic-flow vector
  tile (Mapbox Vector Tile protobuf, layer `"Traffic flow"`), downtown Austin
  z12 x935 y1686, captured 2026-07-16 from
  `api.tomtom.com/traffic/map/4/tile/flow/relative/12/935/1686.pbf`
  (22,980 bytes). Used ONLY by `src/data/flowTiles.test.mjs` to pin MVT
  decoding offline — it is a point-in-time congestion snapshot, not a bundled
  data layer, and is never served to the app. © TomTom.

- `level3-KTLX-{N0S,N0K,EET}-20261002-0109.bin` — three real NEXRAD Level III
  product files from KTLX (Oklahoma City), volume scan 2026-10-02 01:09:25Z,
  downloaded unmodified from NOAA's public `unidata-nexrad-level3` bucket
  (AWS Open Data; U.S. public domain). One per encoding the decoder handles:
  N0S storm-relative velocity (uncompressed, run-length radials), N0K
  specific differential phase (bzip2, float32 scale/offset) and EET echo
  tops (bzip2, masked levels). Used ONLY by `src/data/level3.test.mjs`.
