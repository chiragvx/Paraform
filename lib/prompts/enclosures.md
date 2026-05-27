# DOMAIN: ENCLOSURES / BOXES / HOUSINGS

## Standard Enclosure Architecture
- **Two-piece box** (most common): base + lid. Lid sits inside base on a 1.2mm lip (stepped joint). OR lid slides over base with 0.3mm side clearance.
- **Gasket channel**: 2.5mm wide × 1.5mm deep groove on mating face for IP54+ sealing.
- **Snap clip** on lid: 1.5mm hook, 45° entry chamfer, at 30–40mm intervals on each long side.
- **Lid registration**: 4× corner alignment pins (3mm dia, 4mm tall on base), 3.15mm holes in lid.

## Wall Thickness by Use Case
| Use Case | Wall (mm) |
|----------|-----------|
| Decorative / display | 1.5 |
| Light-duty (electronics) | 2.0–2.5 |
| Portable / handheld | 2.5–3.0 |
| Field / outdoor | 3.0–4.0 |
| Heavy-duty (waterproof, IP67) | 4.0+ |

## Lid-to-Base Joint Options
1. **Stepped rim** (most printable): inner rim 1.2mm tall, 1.5mm wide. Lid inner wall drops over it. 0.2mm clearance.
2. **Tongue-and-groove**: 3mm wide groove × 2.5mm deep on base. Tongue 2.7mm wide on lid.
3. **Hinge + latch**: live hinge at Y-min edge (0.6mm PETG wall). Latch tabs at Y-max, 2mm hook.

## PCB / Component Mounting Inside Enclosure
- Boss height = standoff length (min 6mm). Boss OD = 3× M3 hole OD = 9mm.
- PCB clearance above boss top: 0.5mm gap (PCB sits on standoff shoulder, not pressed).
- Side clearance for PCB: 1.0mm per side minimum (for insertion/removal).
- Bottom clearance under PCB: 3.5mm for solder joints / through-hole pins.

## Connector Panel Cutouts
- Group connectors on one face for cable management.
- USB cutout height from base interior floor: match connector center height.
- Add 0.5mm chamfer around all panel cutouts (improves insertion feel).
- Strain relief slot for cable exit: 5mm × cable OD + 1mm, minimum 1.5mm wall each side.

## Ventilation
- Fan mounting: 30×30 at ±12.5mm, 40×40 at ±16mm, 60×60 at ±25mm (M3 holes).
- Passive vent pattern: 3mm slots, 6mm pitch, angled 15° downward (rain resistance).
- Inlet below, outlet above: natural convection path. 25% open area on each vent face.

## DIN Rail / Panel Mount
- DIN rail clip: 35mm rail width standard. Clip body 7.5mm deep. Fixed tab + spring tab 15mm apart.
- Panel mount: 4×M3 countersunk at corners, 3mm inset from edge. Countersink depth 1.7mm.
- Rack-mount (19"/1U): 44.45mm tall, 482.6mm wide. Ear flanges: 9.5mm × 44.5mm, 2× M5 holes at ±11.5mm.

## Label & Identification
- Embossed label panel: 0.5mm raise, 1.2mm minimum character stroke.
- Debossed infill pocket for label: 1.5mm deep, flat bottom, 1mm chamfer entry.
- Orientation arrow: 15mm arrow molded onto top face for assembly reference.
