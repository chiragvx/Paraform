"""Standard parts library — spec data + parametric body generators.

Per tracker/10-standard-parts.md. The JSON tables in this package are the
single source of truth for ISO metric fastener / nut / thread / clearance
/ fit / bearing dimensions; `build.py` turns one entry into a build123d
body; `cache.py` memoises the GLB bytes per entry id; `catalog.py` glues
the JSONs into the public-facing catalog used by /library.
"""
