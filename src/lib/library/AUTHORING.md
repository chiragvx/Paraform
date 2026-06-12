# Part-authoring pipeline (Phase 4)

How the component library grows from ~12 → ~100+ parts via a repeatable,
AI-friendly path. The library is **data, not code**: drop a validated JSON
record under `src/lib/library/parts/**` and the loader
([`index.js`](./index.js), via `import.meta.glob`) picks it up — no
registration. The only "code" a part needs is an optional kernel builder when
its geometry matters (`source: "standard-part"`).

## The loop

```
datasheet dims + connector intents
        │
        ▼
  scripts/author_part.mjs  ──►  validatePartRecord()  ──►  parts/<category>s.json
        │                              (refuses to write invalid records)
        ▼
  (standard-part only) prints kernel builder + catalog stub
        │
        ▼
  b123d_server/standard_parts/{<family>.json, mechatronic.py, catalog.py}
        │
        ▼
  pytest test_new_parts.py  ──►  built bbox vs declared datasheet bbox  ──►  commit on green
```

## 1. Write a spec

A spec is a compact JSON object (or array of them). See an example:

```bash
node scripts/author_part.mjs --example
```

Key fields: `id`, `name`, `category` (closed set in
[`schema.js`](./schema.js) `PART_CATEGORIES`), `source`
(`parametric` | `standard-part` | `glb` | `composite`), `boundingBox`,
`tags`, `keywords`, and `connectors[]`.

**Every connector must carry** `kind`, `gender`, `axis`, `origin`, `size`,
`mates_with`, and — new in Phase 2 and required for high-quality swaps —
`role` and `interfaceId`. The script auto-fills `parent` (= part id),
`metadata`, and sensible defaults.

## 2. Generate the record

```bash
node scripts/author_part.mjs my_spec.json                 # writes parts/<category>s.json
node scripts/author_part.mjs my_spec.json --file servos.json
node scripts/author_part.mjs my_spec.json --dry-run       # print, don't write
```

The script runs `validatePartRecord` (the **same** validator the loader uses)
and **refuses to write** an invalid record. It appends to the target file
(creating it if absent) and skips ids already present.

## 3. (standard-part) add the kernel builder

For `source: "standard-part"` the script prints the catalog entry + which
`build.py`/`mechatronic.py` builder to map. The kernel-side flow:

- **Builders** live in `b123d_server/standard_parts/build.py` (screws, nuts,
  bearings, extrusions, t-nuts) and `mechatronic.py` (servos, standoffs,
  horns, keep-out boxes). Each `build_*(entry)` reads `entry["dims"]` and
  returns a build123d `Part`, MIN-aligned on Z (bottom on z=0), Z-up, mm.
- **Dispatch** is by `entry["category"]` in `build.py` `_BUILDERS`.
- **Catalog** JSONs are listed in `catalog.py` `_JSON_FILES`; each entry has
  `id`, `category`, `dims`, and a declared `bbox` (the datasheet envelope).
- `build_from_id("servo-sg90")` resolves the entry and invokes its builder —
  this is what `emit.js` calls for a placed standard part.

Keep builders **parametric**: a servo builder takes body L/W/H + flange +
shaft dims so one function covers SG90 → MG996R → DS3218.

## 4. Verify against datasheet numbers

```bash
python -m pytest b123d_server/standard_parts/__tests__/test_new_parts.py -q
```

For every new `build_from_id` id, the eval asserts the built solid is
non-empty with a finite bbox **matching the catalog's declared `bbox` within
tolerance** (`BBOX_TOL_MM`). This is the guardrail that keeps the model
honest — change a dim and forget the bbox, the test goes red.

Also re-validate the JS side (0 warnings expected):

```bash
node --import ./src/lib/commands/__tests__/_register.mjs \
     src/lib/__tests__/spec18_component_library.mjs
```

## interfaceId vocabulary

Standardized `interfaceId`s let `replaceComponent` rebind a swapped part by
**physical interchangeability** (id equality wins over kind/gender/size). Use
these established ids so parts from different families still mate:

| Family | interfaceId | role(s) |
|---|---|---|
| 9g servo mount (SG90/MG90S) | `servo-mount-9g` | `servo-mount` |
| standard servo mount (MG996R/DS3218) | `servo-mount-standard` | `servo-mount` |
| Dynamixel frame | `dynamixel-fr05` | `servo-mount` |
| SG90/MG90S output spline | `spline-SG90` | `output-shaft` / `horn-spline` |
| 25T output spline | `spline-25T` | `output-shaft` / `horn-spline` |
| Dynamixel AX horn | `dynamixel-horn-ax` | `output-shaft` |
| screw/standoff threads | `thread-M2.5` … `thread-M8` | `screw-thread` / `thread-top` / `thread-bottom` |
| shaft bores | `bore-3mm`, `bore-4mm`, `bore-6mm`, `bore-8mm`, `bore-10mm` | `shaft-bore` |
| bearing outer races | `race-10mm`, `race-13mm`, `race-19mm`, `race-22mm` | `outer-race` |
| extrusion profiles | `profile-2020`, `profile-2040`, `profile-4040`, `profile-4080`, `profile-8080` | `extrusion-end` / `t-slot` |
| t-slot rail | `rail-2020`, `rail-4040` | `rail-slide` |
| linear rail | `rail-mgn12` | `linear-rail` |
| PCB mounts | `pcb-pololu-carrier`, `pcb-nano`, `pcb-esp32-devkit` | `pcb-mount` |
| panel ports | `port-mini-usb`, `port-micro-usb`, `port-xt60` | `panel-port` |
| panel switch cutouts | `panel-cutout-rocker-19x13`, `panel-cutout-toggle-m6` | `panel-switch` |
| battery bay | `battery-lipo-2s` | `battery-bay` |

A `role: "panel-switch"` connector tells the Phase-5 casing generator to cut a
hole for the switch; its `interfaceId` encodes the cutout size.
