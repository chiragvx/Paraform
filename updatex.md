# Architecture & System Specification: Hybrid AI-to-OpenSCAD Engineering Platform

An architectural blueprint for an autonomous, self-correcting engineering workflow that leverages LLMs as high-level geometric coordinators, backed by deterministic, non-AI python validation scripts and immutable hardware libraries.

---

## 1. The Gated 4-Phase Pipeline

To prevent mathematical divergence and keep code generation within strict boundaries, execution is controlled by a structured state machine. The system blocks progression until each phase satisfies its gatekeepers.

```
[Phase 1: Plan & Assets] ---> [Phase 2: Layout Options] ---> [Phase 3: Core Skeleton] ---> [Phase 4: Detailing]

```

### Phase 1: Planning, Constraints & Hardware Selection

* **Behavior:** The prompt interface remains completely blank of CAD code. The AI acts strictly as a requirements engineer.
* **Deliverable:** A markdown or JSON specification sheet capturing bounding dimensions, mating hardware selections from the library, material budgets, and target clearances.
* **Gate:** User confirmation of constraints and locked hardware components.

### Phase 2: Architectural Layout Options

* **Behavior:** The AI proposes exactly three distinct mechanical design frameworks based on Phase 1 variables (e.g., *Option A: Flat-pack slide-lock*, *Option B: Unibody print-in-place*, *Option C: Multi-part bolt assembly*).
* **Deliverable:** Structural trade-offs, estimated printability notes, and assembly considerations.
* **Gate:** Explicit selection of a single design path by the user.

### Phase 3: Parametric Skeleton (Low-Fidelity)

* **Behavior:** The core geometry engine initializes. The AI generates macro-volume envelopes and basic structural shapes using placeholder sub-modules.
* **Deliverable:** A highly parameterized script focusing entirely on global variable bindings and coordinate tracking.
* **Rule:** No fine details (fillets, screw holes, internal chamfers) or boolean cuts are executed. The AI must define the structural tree layout with empty container modules (e.g., `module detail_cuts() {}`).

### Phase 4: Detailed Feature Generation (High-Fidelity)

* **Behavior:** The AI injects local mounting features, custom patterns, and aesthetic adjustments into the pre-allocated sub-modules.
* **Deliverable:** The finalized production script prepared for automated testing, compilation, and export.

---

## 2. Hierarchical Multi-Agent Orchestration

To build complex multi-part systems (like a jointed robotic arm) without exceeding token limits or triggering code drift, the platform rejects monolithic code blocks in favor of an agent tree structure.

```
                  [Lead Architect Agent]
               (Phase 1 & 2 / Interface Mates)
                             |
         +-------------------+-------------------+
         v                   v                   v
 [Component Agent 1] [Component Agent 2] [Component Agent 3]
    (Base Mount)          (Link Link)         (Gripper Assembly)
         |                   |                   |
         +-------------------+-------------------+
                             v
                  [Assembly Master Agent]
                   (assembly.scad Layout)

```

1. **Lead Architect Agent:** Resolves interface boundaries between moving components. It locks down the spatial link constraints (e.g., *"Component 2 must accept a servo mating plate at its local origin and output a hinge axle exactly 150mm away on the local Y-axis"*).
2. **Worker Component Agents:** Isolated, parallel LLM threads that design exactly one single component. Because their scope is tightly constrained, they maintain perfect parametric syntax without experiencing code degradation.
3. **Assembly Master Agent:** Takes the fully validated individual part files and constructs the overarching `assembly.scad` script using purely structural layout logic, keeping part geometry decoupled from global orientation transforms.

---

## 3. Semantic Design System & Immutable Asset Library

To eliminate spatial hallucinations, rotational vector drift, and Z-fighting, the platform bans raw primitives (`cube`, `cylinder`) and replaces them with a **Standardized Component API**.

### A. The No-Primitives Wrapper

The system wraps basic geometry inside functional macros fed to the AI via the system prompt:

| Semantic Module Command | Encapsulated Logic | Structural Purpose |
| --- | --- | --- |
| `ai_plate(w, d, h)` | Standardized cube declaration centered at the local origin. | Guarantees bounding box uniformity. |
| `ai_drill_clearance(d, thickness)` | `cylinder(d=d, h=thickness+2, center=false);` wrapped in a local translation of `z=-1`. | Eliminates Z-fighting artifacts and ensures a clean, predictable through-hole. |

### B. The Standardized Component API & Origin Anchor Rule

Pre-existing commercial hardware components (servos, bearings, bolts) are never modeled by the AI. They are imported directly from a read-only platform directory using a strict two-module definition file:

```openscad
// Pre-made, validated asset file: assets/servos/sg90.scad
module sg90_mesh() { ... }       // 3D visual render of the exact servo body
module sg90_clearance() { ... }  // Slightly oversized subtractive carving tool volume

```

> **The Origin Anchor Rule:** Every asset file must place its local coordinate origin `[0,0,0]` at the **exact primary center of physical rotation** (e.g., the center of the output spline/gear shaft). When a user changes a servo size via the UI, the Python backend swaps the file string injection path, and the assembly automatically resizes outward symmetrically from the axle anchor point without losing joint tracking.

### C. Local Space Isolation & 2D Profile Sketching

* Components must be modeled perfectly square and flat at their local origin. Global placement matrices are handled exclusively by the assembly script.
* For complex organic contours, the AI is restricted to flat 2D coordinate matrices using `polygon(points=[...]);`, which is immediately driven by a deterministic `linear_extrude()`. This minimizes multi-axis projection mistakes.

---

## 4. Fastener & Tool Access Clearance Engine

To prevent users from printing parts that are impossible to assemble due to obstructed screw paths, the system implements a non-AI **Fastener Clearance Library** (`fasteners.scad`).

Every fastener cutout features a 3-layer subtractive clearance profile:

1. **Thread Core:** The exact dimension path for the bolt thread.
2. **Head Pocket:** The counterbore cavity allowing a socket cap screw or nut to sit flush or sub-surface.
3. **Tool Access Corridor:** An extended cylinder projecting completely out of the part's bounding envelope, carving an unobstructed line-of-sight path for a screwdriver or hex key.

```openscad
// Deterministic Fastener Cutout Profile
module fastener_m3_cap(screw_length=12, access_depth=80) {
    cylinder(d=3.4, h=screw_length+2, center=false, $fn=16); // Thread Core
    translate([0, 0, -1]) 
        cylinder(d=6.5, h=3.5, center=false, $fn=16);       // Head Pocket
    translate([0, 0, -access_depth]) 
        cylinder(d=7.0, h=access_depth, center=false, $fn=16); // Tool Access Corridor
}

```

---

## 5. Non-AI Headless Validation Framework

The platform runs a programmatic testing sequence in the background via the OpenSCAD CLI and Python middleware. It functions entirely independent of the AI's internal evaluation.

```
               [Finalized Script Code]
                          |
                          v
               [Phase 1: Semantic Linter]
            (Fails if raw primitives found)
                          |
                          v
             [Phase 2: Headless CLI Compile]
          (Captures OpenSCAD assert() errors)
                          |
                          v
            [Phase 3: Interference Checking]
           (Runs 3D intersection mesh test)
                          |
                          v
             [Phase 4: Kinematic Sweeper]
         (Tests extreme ranges of joint motion)

```

### A. Headless Interference & Clash Detection

The Python middleware triggers a background compilation forced into intersection mode to look for overlapping parts:

```bash
openscad -o clash_output.stl -D "mode=\"clash_test\"" main_assembly.scad

```

* **The Script Rule:** If `mode == "clash_test"`, the script outputs `intersection() { part_a(); part_b(); }`.
* **The Determination:** If the parts fit correctly, the resulting `clash_output.stl` contains 0 vertices and yields a file size of **0 bytes**. If the file size exceeds 0 bytes, a structural clash exists, and the mesh data is sent directly to the feedback loop or the user interface.

### B. Tool Access Verification

During the headless clash test, the Tool Access Corridors of all fasteners are rendered as active solid elements inside a dedicated validation environment. If a structural component or arm wall blocks a screw head path, the intersection test returns a positive byte size, throwing an instant **"Tool Path Blocked"** error.

### C. Kinematic Range-of-Motion Sweeper

To verify multi-axis moving assemblies, Python sweeps the joint parameters through an array of extreme physical ranges:

```python
joint_angles = [-45, 0, 45, 90]
for angle in joint_angles:
    run_cmd(f'openscad -o sweep_check.stl -D "elbow_pitch={angle}" -D "mode=\"clash_test\"" arm.scad')
    if get_file_size("sweep_check.stl") > 0:
        flag_kinematic_error(angle)

```

If a collision occurs at any position in the trajectory sweep, the pipeline pauses and identifies the specific structural blockage point.

---

## 6. Real-Time Feedback Loop & User Reassurance Timeline

### The Confidence Scoreboard

The system quantifies build safety using an objective checklist. The software will not unlock the final STL file download until the score reaches **100%**.

| Validation Milestone | Confidence Weight | Target Objective |
| --- | --- | --- |
| **1. Semantic Linter Pass** | +20% | No banned primitive syntax found; absolute adherence to `ai_*` modules. |
| **2. CLI Compilation Pass** | +40% | Core files compile cleanly with zero programmatic syntax or `assert()` failures. |
| **3. Zero-Clash Verification** | +10% | Static `intersection()` test yields an empty 0-byte file. |
| **4. Tool Path Verification** | +10% | All tool access corridors pass completely through the assembly without structural intrusion. |
| **5. Kinematic Sweep Pass** | +20% | Dynamic rotation sweep checks evaluate with zero part-on-part collisions. |

### The Triage UI & Live User Timeline

Rather than leaving the user in a "black box" waiting loop, the platform provides a live mission-control log. If an unresolvable thin-wall or structural collision occurs, the platform stops the automated loop and presents an interactive parametric slider for the user to resolve the clearance manually.

```
[15:10:02] 📋 System: Constraints locked. Base bracket size set to 40mm x 30mm.
[15:10:05] 📐 Phase 3: Constructing parametric skeleton envelopes...
[15:10:08] 🔄 Iteration 1 (Confidence: 20%): Submitting draft to headless compiler...
[15:10:10] 🛑 Iteration 1 Failure: OpenSCAD engine rejected compilation. 
           -> Reason: Assertion Failed - Wall thickness drop below minimum 2.0mm threshold.
[15:10:11] 🧠 Agent Correction: AI is expanding bracket outer wall bounds to clear the larger servo footprint.
[15:10:14] 🔄 Iteration 2 (Confidence: 60%): Re-compiling updated geometry... Success!
[15:10:16] 📐 Phase 4: Injecting fastener channels and Tool Access Corridors...
[15:10:18] ⚠️ Tool Path Blocked Warning: Fastener M3 tool corridor collides with Link 2 outer housing.
[15:10:19] 🛠️ User Intervention Required: Hovering flashing red zone on screen. 
           [SLIDER: Adjust Clearance Offset (+2.5mm)] --> Applied.
[15:10:22] 🔄 Iteration 3 (Confidence: 100%): Running full kinematic sweep check... Clear!
[15:10:25] 🎉 Complete: Production files securely generated and ready for 3D printing.

```