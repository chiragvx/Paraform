# DOMAIN: ELECTRONICS / PCB ENCLOSURES / BOARD MOUNTING

## Board Dimensions (all measurements in mm)
- **Arduino Nano V3**: PCB 18×45mm, thickness 1.6mm. Component height: 10mm above PCB. USB Mini-B at one short edge, protrudes 2mm. Headers at ±7.62mm from long center axis.
- **Arduino Uno R3**: PCB 68.6×53.4mm. Mounting holes (M3): (14.0, 2.54), (66.04, 35.56), (66.04, 5.08), (15.24, 50.8). USB-B at corner, DC jack at opposite corner. Max component height: 15mm.
- **ESP32 DevKit V1** (30-pin): PCB 25.4×48.26mm. Micro-USB at Y-max, antenna protrudes 2mm. No mounting holes — hold by side channels or rail clips.
- **Raspberry Pi Zero 2W**: PCB 30×65mm. Mount holes M2.5 at (3.5,3.5), (26.5,3.5), (3.5,61.5), (26.5,61.5). Micro-USB PWR at X-min edge Y≈10.6, USB OTG at Y≈16.5, Mini-HDMI at Y≈25. GPIO 40-pin at X=1.27 to 6.35, Y=5.25 to 57mm.
- **Raspberry Pi 4B**: PCB 85×56mm. USB-A at X-max edge, USB-C + HDMI at Y-min edge. Mount holes M2.5 at (3.5,3.5), (61.5,3.5), (3.5,52.5), (61.5,52.5). GPIO at X-max top row.

## PCB Standoffs
- M3 standoff: 6mm OD, printed at 5.8mm for clearance. Pillar height = standoff length + 1.6mm (PCB thickness). Standard heights: 6mm, 10mm, 11mm.
- M2.5 standoff: 5mm OD pillar. Snapped-in insert or heat-set insert (M2.5×4mm heat-set).
- PCB support boss: minimum 3mm wall around hole. Boss OD = hole + 2× 2.5mm wall.

## Connector Access Cutouts
- USB Type-A: 12.5×4.5mm cutout, +0.5mm clearance each side → 13.5×5.5mm slot.
- USB Type-C: 9.5×3.3mm cutout + clearance → 10.5×4.3mm slot.
- USB Micro-B: 8.5×3.5mm cutout → 9.5×4.5mm slot.
- USB Mini-B: 8.5×4.0mm cutout → 9.5×5.0mm slot.
- DC barrel jack 5.5/2.1mm: 10.0mm hole in panel. Nut tightens from front.
- RJ45: 16.0×13.5mm cutout + 0.5mm → 17×14mm slot.
- 40-pin GPIO header: 54×5.5mm strip + 1mm clearance → 56×7mm slot.
- HDMI full-size: 15.0×7.0mm + clearance → 16×8mm slot.
- HDMI mini: 11.2×5.1mm + clearance → 12.2×6mm slot.

## Heat & Ventilation
- Pi 4B active cooling: 30×30×10mm fan, mount 4×M3 at ±12.5mm. Min 5mm airflow gap above SoC.
- Passive vent slots: 3mm wide, ≥20mm long, spaced 6mm apart. Total open area ≥ 10% of wall.
- SoC heatsink: 20×20mm footprint, 8mm tall. Clear 3mm all sides for airflow.

## Cable Management
- Cable tie slot: 4×2mm rectangular slot, min 1.5mm wall on all sides.
- JST-XH 2-pin connector: 5.5×8.5mm, clip height 6mm. Allow 5mm pull clearance.
- Ribbon cable slot: width = cable width + 1mm, depth = 1.2mm + 0.3mm.

## ESD / Grounding
- Standoffs should be electrically isolated from board — use nylon standoffs or non-conductive 3D-printed versions.
- Faraday cage shielding: internal copper foil tape on inside of PLA enclosure if needed.
