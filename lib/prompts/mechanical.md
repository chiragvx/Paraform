# DOMAIN: MECHANICAL DESIGN / GEARS / FASTENERS / STRUCTURAL

## Fastener Reference (all metric, FDM printed holes)
- **Clearance hole** (bolt passes through): nominal + 0.4mm. M3 clearance = 3.4mm. M4 = 4.4mm. M2 = 2.4mm.
- **Tapped hole** (self-tap plastic thread): nominal − 0.2mm. M3 self-tap = 2.8mm. M4 = 3.8mm.
- **Heat-set insert (M3)**: OD 4.5mm, length 6mm. Printed pocket: 4.3mm dia, 6.2mm deep.
- **Heat-set insert (M4)**: OD 5.6mm, length 8mm. Printed pocket: 5.4mm dia, 8.2mm deep.
- **Hex nut pocket (M3)**: 5.5mm AF hex → 6.0mm across-flats pocket, 2.4mm deep.
- **Hex nut pocket (M4)**: 7.0mm AF hex → 7.5mm pocket, 3.2mm deep.
- **Countersunk M3**: 6.8mm dia at surface, 60° cone. Recess = head height 1.7mm.

## Socket-Cap Bolt Head Sizes
| Size | Shank D | Head D | Head H | Hex key |
|------|---------|--------|--------|---------|
| M2   | 2.0     | 3.8    | 2.0    | 1.5mm   |
| M3   | 3.0     | 5.5    | 3.0    | 2.5mm   |
| M4   | 4.0     | 7.0    | 4.0    | 3.0mm   |
| M5   | 5.0     | 8.5    | 5.0    | 4.0mm   |
| M6   | 6.0     | 10.0   | 6.0    | 5.0mm   |

## Wall & Structural Thickness Rules
- Minimum structural wall (FDM): 1.2mm (1 perimeter at 0.4mm nozzle), prefer 2.4mm (2 perimeters).
- Load-bearing bracket wall: 3–4mm minimum. Gussets at 45° improve stiffness 3×.
- Minimum boss wall around a hole: 1.5× hole diameter for self-tapping, 1.0× for heat-set.
- Rib thickness: 60% of wall it reinforces. Rib height: max 3× wall thickness.

## Gear Design
- Spur gear: module 1 = teeth pitch 3.14mm arc, tooth height 2.25mm. FDM printable above module 0.8 (prefer 1.5+).
- Clearance between mating gears: 0.1mm per side on FDM. Gear center distance = (T1+T2)/2 × module + 0.2mm.
- Helical gears: 15–20° helix angle improves mesh, reduces noise. Must be printed as separate halves if helix > 45°.
- Gear ratio: R = teeth_driven / teeth_driver. Stack compound ratios for large reductions.

## Springs & Snap Features
- Cantilever snap arm: length-to-thickness ratio 5:1 minimum. PLA yield strain ≈ 2%, PETG ≈ 3%.
- Compression spring pocket: OD + 0.4mm clearance. Seat pocket depth = spring solid height + 1mm.
- Wave spring washer: OD = shaft + 2×wall. Stack 2× for higher preload.

## Tolerances & Fits (FDM, 0.4mm nozzle, PLA)
- Tight fit (press-fit): −0.1 to −0.15mm interference on radius.
- Sliding fit (moving part): +0.15 to +0.2mm clearance on radius.
- Loose fit (free assembly): +0.3mm clearance.
- Through-hole diagonal tolerance: add 0.1mm per 10mm print height (thermal shrinkage).

## Shaft Coupling & Power Transmission
- D-flat shaft connection: flat face at shaft_d / 2 − 0.5mm from center. Use M2 or M3 set screw.
- Friction-fit hub on smooth shaft: interference 0.05mm + 2× 1.5mm wall around bore.
- GT2 belt tension: 3–5N. Idler pulley: smooth bearing + 1mm wider than belt.
- Timing pulley bore: shaft nominal + 0.05mm (press-fit). Flanges prevent belt walkoff.
