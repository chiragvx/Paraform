## 🗺️ Site Information Architecture (IA)

```
                       [ Global Navigation Bar ]
                                   │
      ┌───────────────┬────────────┴────────────┬───────────────┐
      ▼               ▼                         ▼               ▼
[ Landing Page ]  [ Explore Page ]       [ Create Page ]  [ About Page ]
                      │                         │
                      ├─► Category Grid         ├─► Parameter Panel (Left)
                      ├─► Trending Shelf        └─► 3D Viewport Canvas (Right)
                      └─► Tags / Search Filter

```

---

## 📄 Page Layouts & Component Placement

### 1. Landing Page

* **Hero Section (Top 50% of viewport):**
* **Left Column:** High-impact text headline + sub-headline + prominent call-to-action (CTA) button ("Explore Templates").
* **Right Column:** A simplified, interactive 3D WebGL preview canvas hosting a high-engagement starter gadget. Directly underneath or overlaying the canvas is a single interactive slider labeled "Adjust Part Size" to demonstrate real-time geometric morphing before entering the editor.


* **Onboarding / How It Works Section (Middle):**
* Three-column horizontal grid detailing step-by-step functionality:
1. *Select:* Browse the curated catalog.
2. *Slide:* Tweak real-time dimensional values.
3. *Print:* Download the locally compiled `.STL` file.




* **Value Proposition Grid (Bottom):**
* A clean, multi-column grid matrix illustrating the functional benefit of parametric assets over static meshes (e.g., enclosure scaling, dimensional adapters, custom text engraving).



### 2. Explore Page

* **Search & Filter Bar (Top):**
* Centered full-width text input field mapped directly to template metadata strings (`slug`, `title`, `tags`). Below the input box, include quick-filter chip buttons for structural categorization.


* **Trending Shelf (Upper Body):**
* A prominent, horizontally scrolling row displaying cards of the most frequently modified or downloaded templates.


* **Categorized Grid (Lower Body):**
* A vertical stacked list of distinct categorical sections (e.g., *Tech & Gadgets*, *Home & Living*, *Everyday Carry*).
* Each section populates a responsive grid of card components. Each card embeds:
* A static WebP thumbnail image pulled directly from Cloudflare R2.
* The template title text, creator attribution, and a "Customize" action link.





### 3. Create Page (The Dual-Panel View)

* **Left Panel — Control Column (35% Width):**
* **Header Zone:** Contains the back-to-catalog link, template title, description, and primary action bar hosting three distinct button components: **"Save Creation"**, **"Start New"**, and **"Download STL"**.
* **Body Zone (Scrollable Form Environment):** A dynamically rendering array parsing the template’s `ui_parameters` schema into corresponding input wrappers:
* `type: number/integer` $\rightarrow$ Render custom dual-state sliders with manual numerical value input boxes.
* `type: enum` $\rightarrow$ Render native select dropdown components.
* `type: boolean` $\rightarrow$ Render toggle switch buttons.




* **Right Panel — Viewport Canvas (65% Width, Fixed):**
* A persistent WebGL canvas element hosting the Three.js viewport context.
* **Overlay UI Element:** A small, semi-transparent status box in the upper-left or bottom-right quadrant displaying dynamic compiler diagnostics (e.g., *"Compiling..."*, *"Render Ready"*, or raw worker execution timeline tallies in milliseconds).



### 4. About Page

* **Manifesto Section (Top):**
* Centered, readable paragraph blocks explaining the motivation behind the platform—shifting the 3D asset world from rigid, static meshes into flexible, programmatic formulas.


* **Technical Architecture Breakdown (Bottom):**
* A neat visual or structural list mapping the browser-side tech stack (OpenSCAD via WebAssembly, WebWorkers, Three.js WebGL) to emphasize the client-first, decentralized structure of the system.