#!/usr/bin/env python3
"""Step 1 of the preprocessor, CONTRACTS.md §4: .pbf -> intermediate JSON.

Parses protobuf and nothing else. Every decision that can be got wrong -- geometry
collapsing, direction, lanes, exits, population -- is made in tools/preprocess.ts, where it
is covered by tests. What comes out of here is what was in the file.

    tools/.venv/bin/python tools/osm_extract.py mercer
"""

import json
import os
import sys

import osmium

HIGHWAY = {
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "residential", "unclassified",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
}

# What counts as a house. An allow-list, not a deny-list: OSM invents building values faster
# than anyone maintains an exclusion list, and `building=yes` -- the majority -- has to be in
# whichever list it lands in, so it is named here on purpose.
BUILDING = {
    "house", "residential", "apartments", "detached", "semidetached_house",
    "terrace", "yes", "bungalow", "dormitory",
}

# Only tags §4 actually reads. Carrying the rest would multiply the intermediate file by ten.
KEEP_TAGS = (
    "highway", "oneway", "junction", "lanes", "lanes:forward", "lanes:backward",
    "maxspeed", "name", "ref", "bridge", "tunnel",
)


def wanted(tags) -> bool:
    if tags.get("highway") not in HIGHWAY:
        return False
    if tags.get("access") in ("no", "private"):
        return False
    return tags.get("area") != "yes"


def centroid(nodes) -> tuple[float, float] | None:
    """Mean of the outline's vertices. The closing node repeats the first one and would weight
    that corner twice."""
    lat = lon = 0.0
    k = 0
    last = len(nodes) - 1
    for i, n in enumerate(nodes):
        if not n.location.valid():
            continue
        if i == last and nodes[0].ref == n.ref:
            continue
        lat += n.location.lat
        lon += n.location.lon
        k += 1
    if k == 0:
        return None
    return lat / k, lon / k


def scan_buildings(pbf, bbox) -> tuple[list[int], list[int], int]:
    """Second pass over the same file (§4). Multipolygon buildings arrive as relations and are
    skipped here -- a minority, and named in docs/LIMITATIONS.md rather than lost quietly."""
    min_lat, min_lon, max_lat, max_lon = bbox
    lats: list[int] = []
    lons: list[int] = []
    seen = 0
    fp = osmium.FileProcessor(pbf).with_locations().with_filter(
        osmium.filter.KeyFilter("building")
    )
    for obj in fp:
        if not obj.is_way():
            continue
        seen += 1
        if obj.tags.get("building") not in BUILDING:
            continue
        c = centroid(obj.nodes)
        if c is None:
            continue
        lat, lon = c
        if not (min_lat <= lat <= max_lat and min_lon <= lon <= max_lon):
            continue
        lats.append(round(lat * 1e7))
        lons.append(round(lon * 1e7))
    return lats, lons, seen


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: osm_extract.py <cityId>", file=sys.stderr)
        return 2
    city_id = sys.argv[1]
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, "tools", "cities", city_id + ".json")) as f:
        cfg = json.load(f)

    min_lat, min_lon, max_lat, max_lon = cfg["bbox"]
    pbf = os.path.join(root, cfg["pbf"])

    node_lat: dict[int, int] = {}
    node_lon: dict[int, int] = {}
    ways = []
    seen = 0

    fp = osmium.FileProcessor(pbf).with_locations().with_filter(
        osmium.filter.KeyFilter("highway")
    )
    for obj in fp:
        if not obj.is_way():
            continue
        seen += 1
        if not wanted(obj.tags):
            continue

        refs = []
        coords = []
        inside = False
        for n in obj.nodes:
            if not n.location.valid():
                continue
            lat, lon = n.location.lat, n.location.lon
            refs.append(n.ref)
            coords.append((lat, lon))
            if min_lat <= lat <= max_lat and min_lon <= lon <= max_lon:
                inside = True
        # A way with a single node inside still matters: it is how a road leaves the bbox,
        # and §4 step 7 finds the exits exactly there.
        if not inside or len(refs) < 2:
            continue

        for ref, (lat, lon) in zip(refs, coords):
            node_lat[ref] = round(lat * 1e7)
            node_lon[ref] = round(lon * 1e7)
        ways.append({
            "i": obj.id,
            "r": refs,
            "t": {k: obj.tags[k] for k in KEEP_TAGS if k in obj.tags},
        })

    bld_lat, bld_lon, bld_seen = scan_buildings(pbf, cfg["bbox"])

    ids = sorted(node_lat)
    out = {
        "id": city_id,
        "bbox": cfg["bbox"],
        "nodes": {
            "id": ids,
            "lat": [node_lat[i] for i in ids],
            "lon": [node_lon[i] for i in ids],
        },
        "ways": ways,
        "buildings": {"lat": bld_lat, "lon": bld_lon},
    }
    dest = os.path.join(root, "data", "extract", city_id + ".json")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w") as f:
        json.dump(out, f, separators=(",", ":"))

    print(f"{city_id}: {seen} highway ways scanned, {len(ways)} kept, "
          f"{len(ids)} nodes, {bld_seen} buildings scanned, {len(bld_lat)} kept "
          f"-> {dest} ({os.path.getsize(dest) / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
