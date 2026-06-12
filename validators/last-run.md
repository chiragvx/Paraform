# ParaForm v4 Validation

- kernel: `https://blackberry-gain-handling-nato.trycloudflare.com`
- run at: 2026-05-29T18:51:28.304Z

## booleans

- ✅ **Union · box + cylinder** — 10F / 18E
- ✅ **Cut · box minus drilled cylinder** — 7F / 15E
- ✅ **Intersect · box ∩ cylinder** — 3F / 3E

## box

- ✅ **Box · 10×10×10 centered** — 6F / 12E
- ✅ **Box · 20×10×5 align-to-min** — 6F / 12E
- ✅ **Box · thin slab 50×50×1** — 6F / 12E

## chamfer

- ✅ **Chamfer · all edges 1mm** — 26F / 48E
- ✅ **Chamfer · asymmetric 2×1** — 26F / 54E

## circular-pattern

- ✅ **CircularPattern · 6× around Z** — 36F / 72E
- ✅ **CircularPattern · 4× over 180° around X** — 12F / 12E
- ✅ **CircularPattern · default (4× full sweep around Z)** — 24F / 48E

## composition

- ✅ **Composition · Box + Hole + Fillet** — 26F / 48E
- ✅ **Composition · Cylinder hollowed + chamfered rim** — 5F / 7E
- ✅ **Composition · Union then linear pattern** — 30F / 54E
- ✅ **Composition · Cut + Mirror** — 7F / 15E

## cylinder

- ✅ **Cylinder · r=5 h=10 centered** — 3F / 3E
- ✅ **Cylinder · r=1 h=50 thin shaft** — 3F / 3E
- ✅ **Cylinder · r=20 h=2 disc** — 3F / 3E

## edge-picking

- ✅ **EdgePicker · Box top-front edge resolves to a Box edge descriptor** — 6F / 12E
- ✅ **EdgePicker · Box vertical-corner edge resolves separately from horizontals** — 6F / 12E
- ✅ **EdgePicker · Cylinder click near the lateral seam picks an edge** — 3F / 3E
- ✅ **EdgePicker · query far from any edge returns a far-distance result** — 6F / 12E

## extrude

- ✅ **Extrude · circle r=5 h=10** — 3F / 3E
- ✅ **Extrude · 20×10 rect h=5** — 6F / 12E
- ✅ **Extrude · hex r=8 h=4** — 8F / 18E
- ✅ **Extrude · both directions** — 3F / 3E

## fillet

- ✅ **Fillet · all edges of a 20mm cube** — 26F / 48E
- ✅ **Fillet · all edges of a cylinder (round both circular edges)** — 5F / 7E
- ✅ **Fillet · tiny radius 0.5mm** — 26F / 48E

## helix

- ✅ **Helix · pitch 5 height 20 radius 5** — 0F / 1E
- ✅ **Helix · left-handed coil** — 0F / 1E

## hole

- ✅ **Hole · simple Ø3.2mm depth 10mm** — 8F / 15E
- ✅ **Hole · through-hole (depth=None in python)** — 8F / 15E
- ✅ **Hole · counterbore 6mm head 3mm deep** — 8F / 15E
- ✅ **Hole · countersink Ø6 (angle defaulted in kernel)** — 8F / 15E

## linear-pattern

- ✅ **LinearPattern · 3× along X spacing 15** — 18F / 36E
- ✅ **LinearPattern · 4× along Y spacing 8** — 24F / 48E
- ✅ **LinearPattern · default (2× along X)** — 12F / 24E

## loft

- ✅ **Loft · two circles (emit only)** — 2F / 1E
- ✅ **Loft · ruled=true** — 2F / 1E

## mirror

- ✅ **Mirror · box across XY** — 6F / 12E
- ✅ **Mirror · cylinder across YZ** — 3F / 3E
- ✅ **Mirror · default plane (XY)** — 6F / 12E

## parameters

- ✅ **Parameter · single literal** — 6F / 12E
- ✅ **Parameter · equation references another parameter** — 6F / 12E
- ✅ **Parameter · Box length driven by parameter** — 6F / 12E
- ✅ **Parameter · update propagates** — 6F / 12E

## picking

- ✅ **Picking · Fillet 4 top edges of a 20mm box** — 10F / 20E
- ✅ **Picking · Fillet only 1 vertical edge** — 7F / 15E
- ✅ **Picking · Chamfer 1 specific edge** — 7F / 15E
- ✅ **Picking · Shell with one open face (+Z)** — 11F / 24E
- ⏸️ **Picking · Hole on a picked face — kernel-needs-redeploy**

## revolve

- ⏸️ **Revolve · offset rect 360° about Z (disc) — kernel-fragile**
- ⏸️ **Revolve · offset rect 180° half-rev — kernel-fragile**

## shell

- ✅ **Shell · 1mm wall on a 20mm cube (closed)** — 6F / 12E
- ✅ **Shell · default thickness on default box** — 6F / 12E

## sketch-on-face

- ✅ **SketchOnFace · circle on Box +Z face** — 6F / 12E
- ✅ **SketchOnFace · extrude through face for stepped boss** — 3F / 3E
- ✅ **SketchOnFace · oblique normal emits the right z_dir** — 6F / 12E

## sphere

- ✅ **Sphere · r=5** — 1F / 1E
- ✅ **Sphere · r=20 large** — 1F / 1E

## stubs

- ⏸️ **Thread · M3×10 emit only (stub)** — 3F / 3E
- ⏸️ **Draft · 2° along Z emit only (stub)**
- ⏸️ **PushPullFace · distance=5 emit only (stub)** — 6F / 12E

## sweep

- ⏸️ **Sweep · circle along line (pipe)**
- ⏸️ **Sweep · circle along helix (thread, kernel-fragile)**

## torus

- ❌ **Torus · major=10 minor=2**
    - `kernel`: This operation was aborted
- ❌ **Torus · thin major=30 minor=1**
    - `kernel`: This operation was aborted

## transforms

- ❌ **Move · box translated (10, 0, 0)**
    - `kernel`: This operation was aborted
- ✅ **Move · negative offset** — 6F / 12E
- ✅ **Rotate · 45° about Z** — 6F / 12E
- ✅ **Rotate · 90° about X** — 6F / 12E
- ✅ **Scale · 2× a 10mm cube** — 6F / 12E
