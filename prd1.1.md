# Product Requirements Document (PRD)

## Project Horizon — Phase 1: Parametric 3D Generator Platform

---

## 1. Executive Summary & Objective

The goal of Project Horizon (Phase 1) is to build and launch a fully functional, zero-overhead, web-based 3D parametric design platform. The platform allows users to select pre-made gadget templates, customize them in real-time using intuitive physical parameter sliders, and instantly download print-ready 3D files (`.STL`).

To maintain a **$0 recurring operational budget**, all heavy geometric computation is executed client-side in the user's browser using WebAssembly. This phase serves to validate market demand, template engagement, and performance viability before investing in server-side CAD infrastructure.

---

## 2. Core User Workflows

1. **Discover:** The user browses a curated catalogue of parametric gadgets by category or popularity.
2. **Customize:** The user alters dimensions (e.g., width, thickness, slots) via sliders and dropdowns. The 3D model renders a live updated view.
3. **Save/Share:** The user saves their unique parameter configuration to their profile or shares a public link.
4. **Manufacture:** The user downloads a locally compiled `.STL` file to send directly to a 3D printer.

---

## 3. Technical Architecture & $0-Budget Stack

Phase 1 relies strictly on free tiers by eliminating backend 3D processing. Compute costs scale linearly with the user's local hardware rather than our cloud infrastructure.

```
+-------------------------------------------------------------------------+
|                              USER BROWSER                               |
|                                                                         |
|  +--------------------+   Param UI Values   +------------------------+  |
|  |   UI Controls      | ------------------> |   WebWorker Thread     |  |
|  |  (Sliders, Menus)  | <------------------ |  (openscad.wasm Core)  |  |
|  +--------------------+    Mesh Buffers     +------------------------+  |
|           ^                                              |              |
|           | WebGL Render                                 | Compiles     |
|           v                                              v              |
|  +--------------------+                     +------------------------+  |
|  |  Three.js Viewport |                     | Binary .STL Generation |  |
|  +--------------------+                     +------------------------+  |
+-------------------------------------------------------------------------+
            ^                                              |
      Reads | Templates                                    | Uploads (WebP)
            | & Parameters                                 v
+------------------------+                    +------------------------+
|   Supabase Database    |                    |     Cloudflare R2      |
|  (PostgreSQL + RLS)    |                    |    (Object Storage)    |
+------------------------+                    +------------------------+

```

### Infrastructure Specifications

* **Frontend & Static Hosting:** Vercel or Netlify. Serves the core application and the static `openscad.wasm` binaries (~10–20 MB) over a global CDN.
* **Database & Authentication:** Supabase. Stores structural JSON payloads for templates, user configuration matrices, and handles secure user sessions via Supabase Auth.
* **Static Asset Storage:** Cloudflare R2. Hosts user-generated thumbnail images (`.webp`) with $0 egress/download fees.
* **3D Execution Engine:** `openscad.wasm` combined with a Three.js WebGL viewport rendering engine running strictly client-side.

---

## 4. System Components & Functional Requirements

### 4.1 Input-to-Source Parametric Parser

The system must safely translate UI form values into clean structural CAD parameters without performing un-sanitized string replacements.

* **Mechanism:** Identifiers are injected as strict variable assignments pre-pended to the top of the OpenSCAD code execution block.
* **Validation:** The compiler must validate types explicitly (`number`, `integer`, `enum`, `boolean`) against the template schema contract before executing a build pipeline.

### 4.2 Multi-Threaded CAD Compilation Loop

To keep the application highly responsive during real-time modifications, 3D calculation cannot run on the main browser thread.

* **Worker Execution:** The parametric engine must run inside a background `WebWorker`.
* **Debouncing & Cancellation:** Slider changes must be debounced by **150–250 ms**. When a new compile job is triggered while a prior job is running, the older job must be aborted/ignored using unique sequential `jobId` markers.
* **Format Execution:** The worker must compile to `.STL` files for both structural preview transformations and local delivery.

### 4.3 Client-Side Mesh Viewport & Native Export

* **Live Viewport:** The main thread accepts incoming mesh buffers from the worker, parses them via Three.js `STLLoader`, and mounts them into the 3D scene using a neutral, matte material profile.
* **Zero-Server Export:** Clicking "Download" generates an immediate local browser file download via a `Blob` URL pairing. The server is never contacted to compile, package, or process the download file.
* **Automated Thumbnail Capture:** Saving a model commands the Three.js viewport to render an offscreen frame capture, convert it to a lightweight WebP image (~40 KB), and upload it to Cloudflare R2 via a secure, short-lived presigned URL.

---

## 5. Data Schemas

### 5.1 Template Configuration Schema (`base_templates`)

Every parametric asset is mapped using a unified configuration schema defining its metadata, control bounds, and functional source code.

```json
{
  "template_id": "rugged_box_v1",
  "schema_version": 1,
  "metadata": {
    "title": "Rugged Utility SD Card Box",
    "category": "Tech & Gadgets",
    "tags": ["3dprinting", "edc", "storage"],
    "author": "system"
  },
  "ui_parameters": [
    {
      "key": "box_width",
      "label": "Internal Width",
      "type": "number",
      "control": "slider",
      "min": 40.0,
      "max": 150.0,
      "step": 0.5,
      "default": 80.0,
      "unit": "mm"
    },
    {
      "key": "sd_slots",
      "label": "Number of SD Card Slots",
      "type": "integer",
      "control": "stepper",
      "min": 2,
      "max": 12,
      "step": 1,
      "default": 4
    },
    {
      "key": "latch_type",
      "label": "Latch Style",
      "type": "enum",
      "control": "dropdown",
      "options": ["snap_fit", "hinge_bolt"],
      "default": "snap_fit"
    }
  ],
  "openscad_source": "module main() { difference() { cube([box_width, 60, 30], center=true); for (i = [1:sd_slots]) { translate([(i * (box_width/(sd_slots+1))) - box_width/2, 0, 5]) cube([24, 32, 2.1], center=true); } } } main();"
}

```

### 5.2 Relational Database Schema (PostgreSQL DDL)

The platform enforces user boundaries directly at the database tier using Supabase Row Level Security (RLS).

```sql
-- Public catalog of templates
CREATE TABLE base_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    config_payload JSONB NOT NULL,
    is_published BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON base_templates (category) WHERE is_published;

-- User-saved configurations
CREATE TABLE user_creations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES base_templates(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    saved_parameters JSONB NOT NULL,
    thumbnail_url TEXT,
    is_public BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON user_creations (user_id);
CREATE INDEX ON user_creations (template_id);

-- Enable Security Policies
ALTER TABLE base_templates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_creations    ENABLE ROW LEVEL SECURITY;

-- RLS Declarations
CREATE POLICY "templates_public_read" ON base_templates
  FOR SELECT USING (is_published);

CREATE POLICY "creations_owner_all" ON user_creations
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  
CREATE POLICY "creations_public_read" ON user_creations
  FOR SELECT USING (is_public);

```

---

## 6. Security & Guardrails

* **Header Isolation:** `vercel.json` must pass strict `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` HTTP headers to guarantee high-speed memory allocation routines safely in the browser.
* **Input Sanitization:** Parameter values sent through the compiler code string are passed through an alphanumerical regex check (`/^[A-Za-z0-9_\-]+$/`) to stop string-injection attacks or unauthorized system commands.
* **Parameter Boundaries:** Sliders contain hard minimum and maximum constraints within the `template_config.json` schema. The compiler must drop any slider variable payload attempting to exceed these thresholds to avoid crashing the browser tab with infinitely large geometric logic loops.

---

## 7. Operational & Growth Metric Triggers (Phase 1 Exit Criteria)

To validate the platform and transition smoothly into **Phase 2 (Paid Tiers, CadQuery, STEP exports, and the AI Model Context Protocol Server)**, the application must hit the following performance targets:

1. **User Retention:** A steady, week-over-week growth of return users building variations of existing templates.
2. **Performance Health:** Real-time canvas recalculations must average **under 1.5 seconds** on consumer-grade laptop computers.
3. **Feature Demand Signal:** Measurable user inquiries or analytics tracking highlighting an explicit requirement for industrial formats (`.STEP`, `.IGES`), multi-part mechanical assemblies, or programmatic AI access pipelines.