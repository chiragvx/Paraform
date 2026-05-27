# DOMAIN: ROBOTICS / ACTUATORS / MECHANISMS

## Servo Motor Dimensions & Mounting
- **SG90 micro servo**: 22.5×11.8×22.7mm body, 32.5×11.8mm mounting flange (2.5mm thick). Output spline at [0,0,0], 4.6mm OD. M2 mount holes at (±8.75, ±3.9) mm relative to body center, 5mm below spline.
- **MG90S metal gear**: identical footprint to SG90 (32.5mm flange), same mount pattern.
- **MG996R standard**: 54.0×19.7mm flange, mount holes M3 at (±14, ±6.85) and (±34, ±6.85). 7.6mm below spline.
- **DS3225 high-torque**: 54.5×20.0mm flange, M3 mount holes ±13.5mm. 25 kg·cm torque.

## Bearing Fits (for FDM printing, PLA/PETG)
- Press-fit bearing pocket: subtract **0.1mm from OD** (interference). E.g. 608ZZ (22mm OD) → 21.9mm pocket.
- Slip-fit shaft through bearing bore: **add 0.15mm** to bore. E.g. 608ZZ (8mm bore) → 8.15mm shaft hole.
- Bearing seat depth = bearing width + 0.2mm (extra depth prevents bottoming out).
- Common bearings: 608ZZ (22×8×7mm), 624ZZ (13×4×5mm), 625ZZ (16×5×5mm), MR105ZZ (10×5×4mm).

## Joint & Linkage Design
- **Pin joints**: pin diameter = 2.5 to 4mm (M3 common). Pin-in-hole clearance: +0.2mm per side.
- **Snap fits**: cantilever deflection ≤ 2mm for PLA at 30% infill. Snap-fit hook: 45° entry chamfer, 0.5mm hook depth.
- **Hinge clearance**: 0.3mm per side between hinge leafs. Pin hole through both leafs: M3 + 0.15mm.
- **Servo horn to linkage**: 3mm horn hole for 3mm rod. Use M3 locknut pocket (5.5mm hex, 2.4mm deep).

## Robot Arm Design Rules
- Bracket wall thickness: 3mm minimum for structural members, 2mm for lightweight skins.
- Servo mount channel width = servo body width + 0.4mm clearance each side.
- Cross-section for 1N load at 100mm arm: 3×3mm solid wall sufficient in PLA.
- Moment arm for SG90: max 2 kg·cm = 20N at 10mm. Design for 50% safety margin.

## NEMA17 Stepper Motor
- Face: 42.3×42.3mm square. Bolt pattern: 4×M3 at ±15.25mm (square). Boss: 22mm dia, 2mm tall.
- Shaft: 5mm dia, D-flat at 4.5mm from axis. Shaft extends 22mm.
- Mounting plate thickness: min 3mm for rigidity. Boss relief hole: 23mm dia, 2.5mm deep.
- Typical Z-belt pulley: GT2 16T (bore 5mm), 12mm wide. Pulley face flush with motor face.

## N20 Micro Gear Motor
- Gearbox: 10×12×15mm. Motor body: 10×10×20mm. Shaft: 3mm OD, 9mm exposed.
- Press-fit shaft coupler: 3mm bore + 0.05mm interference. Flat on shaft prevents spin.
- Motor mount: 2×M2 screws through gearbox side, or friction sleeve around motor body.
