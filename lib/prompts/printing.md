# DOMAIN: FDM 3D PRINTING DESIGN RULES

## Overhangs & Supports
- **Overhang limit without support**: 45–50° from vertical for PLA/PETG at 0.2mm layer.
- **Bridge span** (horizontal with no support below): 30–50mm feasible for PLA; 20mm safe for fine detail.
- **Chamfer vs fillet for overhangs**: 45° chamfers are self-supporting; fillets require support above ~30° overhang.
- Design strategy: orient parts so overhangs point upward and are minimized. Add 45° chamfer to bottom of horizontal features.

## Layer Adhesion & Strength
- **Layer height**: 0.2mm standard. 0.1mm for fine detail, 0.3mm for speed (weaker layers).
- **Anisotropy**: printed parts are ~40% weaker in Z (layer-to-layer) than in XY. Orient critical load paths along XY.
- **Perimeter count**: 3 perimeters (walls) = 1.2mm at 0.4mm nozzle. Use 4+ for structural parts.
- **Infill**: 20% gyroid/grid for typical parts. 40–60% for load-bearing. 100% for small critical features.

## Minimum Feature Sizes
- Minimum wall printable: 0.4mm (single extrusion, fragile). Practical minimum: 1.2mm (3 perimeters).
- Minimum hole diameter: 1.5mm for clean through-holes. Below 2mm, holes print undersized — design +0.2mm.
- Minimum text (embossed): 0.6mm stroke width, 1mm height. Debossed text: 0.8mm stroke, 0.3mm depth.
- Minimum pin/peg: 2mm diameter, 3mm tall (prone to snap if thinner).

## Print-in-Place & Moving Parts
- Gap between moving parts when printed together: 0.3mm minimum (0.4mm recommended).
- Bearing-in-place: 0.4mm gap around outer race, bottom gap 0.5mm to clear elephant foot.
- Living hinge: 0.4–0.6mm wall thickness, minimum 5mm arc length. PETG preferred over PLA.

## Surface Finish & Cosmetics
- Bottom surface (build plate contact): smooth but may show brim marks. Chamfer bottom edges 0.5mm.
- Top surface: depends on top layer count (3 recommended). Slight texture at 0.2mm layer.
- Elephant foot compensation: design bottom edges with 0.2–0.3mm inset or bevel to compensate for first-layer squish.
- Text on vertical faces (XY plane): emboss 0.5mm, letter spacing +10%. Deboss works better on vertical walls.

## Structural Design Patterns
- Box corners: add internal corner gussets (45° fillets) to prevent layer delamination cracks.
- Long thin walls: add cross-bracing ribs or egg-crate pattern at 15mm spacing.
- Screw posts: solid fill 100%, at least 3mm wall, countersink from bottom for heat-set.
- Thread engagement: for M3 self-tapping into plastic, minimum 6mm engagement length (2× diameter).

## Material-Specific Notes
- **PLA**: easy, brittle under impact. Poor heat resistance (softens above 60°C). Use for prototypes and rigid enclosures.
- **PETG**: tougher, slightly flexible, better heat (80°C). Slight stringing; expand clearances +0.05mm.
- **TPU 95A**: flexible, abrasion resistant. Print slowly (25mm/s). No supports needed for overhangs. Min wall 1.5mm.
- **ASA/ABS**: UV stable, impact resistant. Warps — needs enclosure. Expand clearances +0.1mm vs PLA.
