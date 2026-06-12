/**
 * Studio Library catalog — the canonical list of stock "Quickstart" assets
 * surfaced by `LibraryDialog`. Each entry's `build(v4)` constructs the
 * feature(s) in the live v4 document by calling the high-level operations
 * re-exported from `lib/document/index.js`. Keep build functions short (1–4
 * add calls) — the library is a quick-start palette, not a parametric
 * assembly engine.
 *
 * As of spec 10 these entries are the "Quickstart" category in the dialog,
 * sitting alongside the real standard parts (Fasteners, Bearings) fetched
 * from the kernel's `/library` endpoint. The per-entry `subCategory` field
 * (Primitives, Brackets, etc.) is retained for documentation but is not
 * surfaced as a chip in the dialog.
 *
 * Adding a new entry: pick a stable `id`, leave `category: 'Quickstart'`,
 * give it a `dims` label for the card chip, and a one-line `description`
 * shown beneath the card title.
 */

export const LIBRARY_ITEMS = [
  // ── Primitives ──────────────────────────────────────────────────────────
  {
    id: 'prim-cube-20',
    name: 'Cube 20mm',
    category: 'Quickstart',
    subCategory: 'Primitives',
    dims: '20 x 20 x 20 mm',
    description: 'Plain 20 mm cube — handy starting block.',
    build: (v4) => v4.addBox({ length: 20, width: 20, height: 20 }),
  },
  {
    id: 'prim-cyl-10x20',
    name: 'Cylinder 10x20',
    category: 'Quickstart',
    subCategory: 'Primitives',
    dims: 'Ø20 x 20 mm',
    description: 'Round bar segment, radius 10 mm, height 20 mm.',
    build: (v4) => v4.addCylinder({ radius: 10, height: 20 }),
  },
  {
    id: 'prim-sphere-10',
    name: 'Sphere r10',
    category: 'Quickstart',
    subCategory: 'Primitives',
    dims: 'Ø20 mm',
    description: 'Unit sphere, radius 10 mm.',
    build: (v4) => v4.addSphere({ radius: 10 }),
  },
  {
    id: 'prim-torus-20-4',
    name: 'Torus 20/4',
    category: 'Quickstart',
    subCategory: 'Primitives',
    dims: 'R20 / r4 mm',
    description: 'Torus, major 20 mm, minor 4 mm.',
    build: (v4) => v4.addTorus({ majorRadius: 20, minorRadius: 4 }),
  },

  // ── Brackets ────────────────────────────────────────────────────────────
  {
    id: 'bracket-l-small',
    name: 'L-Bracket Small',
    category: 'Quickstart',
    subCategory: 'Brackets',
    dims: '20 x 20 x 20 mm',
    description: 'Small L-bracket: cube with inner corner removed.',
    build: (v4) => {
      const base = v4.addBox({ length: 20, width: 20, height: 20 });
      const cut = v4.addBox({ length: 16, width: 20, height: 16 });
      v4.addMove(cut.id, [2, 0, 4]);
      return v4.addCut(base.id, [cut.id]);
    },
  },
  {
    id: 'bracket-l-large',
    name: 'L-Bracket Large',
    category: 'Quickstart',
    subCategory: 'Brackets',
    dims: '40 x 30 x 40 mm',
    description: 'Large L-bracket for heavier joins.',
    build: (v4) => {
      const base = v4.addBox({ length: 40, width: 30, height: 40 });
      const cut = v4.addBox({ length: 32, width: 30, height: 32 });
      v4.addMove(cut.id, [4, 0, 8]);
      return v4.addCut(base.id, [cut.id]);
    },
  },

  // ── Enclosures ──────────────────────────────────────────────────────────
  {
    id: 'enc-box-60x40x20',
    name: 'Box Enclosure',
    category: 'Quickstart',
    subCategory: 'Enclosures',
    dims: '60 x 40 x 20 mm',
    description: 'Hollow rectangular shell, wall 1.5 mm, open top.',
    build: (v4) => {
      const body = v4.addBox({ length: 60, width: 40, height: 20 });
      return v4.addShell(body.id, { thickness: 1.5 });
    },
  },
  {
    id: 'enc-cyl-30x40',
    name: 'Cylinder Enclosure',
    category: 'Quickstart',
    subCategory: 'Enclosures',
    dims: 'Ø30 x 40 mm',
    description: 'Hollow tube shell, wall 1.5 mm.',
    build: (v4) => {
      const body = v4.addCylinder({ radius: 15, height: 40 });
      return v4.addShell(body.id, { thickness: 1.5 });
    },
  },

  // ── Fasteners (Quickstart approximations) ───────────────────────────────
  // Real fasteners come from the kernel `/library` catalog under the
  // 'Fastener' category. These Quickstart entries are quick approximations
  // useful before the kernel is wired up.
  {
    id: 'fast-m3-standoff',
    name: 'M3 Standoff',
    category: 'Quickstart',
    subCategory: 'Fasteners',
    dims: 'Ø4.5 x 15 mm',
    description: 'M3 standoff: 4.5 mm outer shell with 1.6 mm through hole.',
    build: (v4) => {
      const outer = v4.addCylinder({ radius: 2.25, height: 15 });
      const hole = v4.addCylinder({ radius: 1.6, height: 15 });
      return v4.addCut(outer.id, [hole.id]);
    },
  },
  {
    id: 'fast-washer',
    name: 'M4 Washer',
    category: 'Quickstart',
    subCategory: 'Fasteners',
    dims: 'Ø9 x 1 mm',
    description: 'Flat washer, 4.5 mm bore, 9 mm OD, 1 mm thick.',
    build: (v4) => {
      const outer = v4.addCylinder({ radius: 4.5, height: 1 });
      const hole = v4.addCylinder({ radius: 2.25, height: 1 });
      return v4.addCut(outer.id, [hole.id]);
    },
  },

  // ── Joints ──────────────────────────────────────────────────────────────
  {
    id: 'joint-corner-3way',
    name: '90 deg Corner Joiner',
    category: 'Quickstart',
    subCategory: 'Joints',
    dims: 'Ø6 x 20 mm arms',
    description: 'Three perpendicular cylindrical arms unioned at the origin.',
    build: (v4) => {
      const armZ = v4.addCylinder({ radius: 3, height: 20 });
      const armX = v4.addCylinder({ radius: 3, height: 20 });
      v4.addRotate(armX.id, 'Y', 90);
      const armY = v4.addCylinder({ radius: 3, height: 20 });
      v4.addRotate(armY.id, 'X', 90);
      return v4.addUnion([armZ.id, armX.id, armY.id]);
    },
  },
  {
    id: 'joint-tee',
    name: 'Tee Joiner',
    category: 'Quickstart',
    subCategory: 'Joints',
    dims: 'Ø6 x 30 mm',
    description: 'Two cylinders unioned at right angles to form a tee.',
    build: (v4) => {
      const stem = v4.addCylinder({ radius: 3, height: 30 });
      const cross = v4.addCylinder({ radius: 3, height: 30 });
      v4.addRotate(cross.id, 'Y', 90);
      return v4.addUnion([stem.id, cross.id]);
    },
  },
];
