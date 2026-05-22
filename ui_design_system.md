# ParaForm UI Design System
## Premium Dynamic Glassmorphism Aesthetic (v2)

This document defines the core tokens, design guidelines, components, and interactive patterns for the **ParaForm UI Design System v2**. It serves as the single source of truth for maintainability, ensuring that future pages and layouts preserve the modern, glass-like, immersive 3D utility look.

---

## 📐 Layout Architecture

To maximize screen utility in a 3D modeling environment, ParaForm uses a docked modular workspace combined with floating glassmorphism panels to give a futuristic, professional desktop environment.

### Landing Page Alignment Grid
To keep the public brand onboarding space visually cohesive, clean, and stunning:
* The Landing Page container has a maximum column boundary locked at `1200px` and centered with `margin: 0 auto;`.
* Both the primary `.hero` panel and all supplementary `.landing-section` blocks (including features grids, manifestos, and workflow panels) are bound to a strict horizontal padding limit of `16px`. This guarantees that all vertical gutters and borders align perfectly.

### Desktop Grid Layout
On viewport widths above `768px`, the studio docks panels flush with the screen edges or floats them elegantly:

```mermaid
graph TD
    classDef main fill:#16161d,stroke:#4b9eff,stroke-width:2px,color:#ffffff;
    classDef panel fill:#16161d,stroke:rgba(255,255,255,0.07),stroke-width:1px,color:#eeeef5;
    classDef view fill:#0c0c10,stroke:rgba(255,255,255,0.07),stroke-width:1px,color:#ffffff;

    GlobalNav[Global Navbar: height 52px] --> StudioContainer[Studio Workspace]
    
    subgraph Studio Container [Studio Workspace Container]
        LeftPanel[Left Panel: width 340px, glassmorphic]:::panel
        Viewport[3D Viewport: absolute center background]:::view
        RightPanel[Right Panel: width 240px, floating panel]:::panel
    end

    class GlobalNav main;
```

### Mobile Stacked Layout
On viewports below `768px`, columns collapse into a vertical stack to optimize interaction:

```mermaid
graph TD
    classDef mobile fill:#0c0c10,stroke:rgba(255,255,255,0.07),stroke-width:1px,color:#ffffff;
    classDef scroll fill:#16161d,stroke:rgba(255,255,255,0.07),stroke-width:1px,color:#eeeef5;

    GlobalNav[Global Navbar: height 52px] --> MobileLayout[Stacked Mobile Layout]

    subgraph MobileLayout
        Viewport[3D Viewport: height 45vh]:::mobile
        LeftPanel[Left Panel: scrolls inline]:::scroll
        RightPanel[Right Panel: scrolls inline]:::scroll
    end
```

---

## 🎨 Design System Tokens

Design system tokens are mapped to CSS custom variables in `style.css`. When writing styles, **always** refer to these custom tokens:

| Token | CSS Value | Application |
| :--- | :--- | :--- |
| `--bg-color` | `#0c0c10` | Canvas base, main page background |
| `--panel-bg` | `#16161d` | Workspace sidebar body |
| `--panel-header-bg` | `#1e1e28` | Tab row & top bar headers |
| `--surface-elevated`| `#262632` | Glassmorphic floating containers |
| `--surface-hover` | `#2c2c3a` | Hover states on lists or items |
| `--surface-input` | `#111118` | Form field interior backgrounds |
| `--accent-color` | `#4b9eff` | Brand primary color (royal blue) |
| `--accent-bright` | `#74b5ff` | Bright highlighted state (sky blue) |
| `--accent-dim` | `#1d6fd1` | Subdued highlight state |
| `--accent-subtle` | `rgba(75, 158, 255, 0.1)` | Light background highlight |
| `--accent-glow` | `rgba(75, 158, 255, 0.25)` | Shadow focus and indicator glow |
| `--text-primary` | `#eeeef5` | Primary text, titles, numeric manual inputs |
| `--text-secondary` | `#8888a8` | Secondary labels, descriptions |
| `--text-muted` | `#4a4a60` | Developer notes, code comments, hints |
| `--border-color` | `rgba(255, 255, 255, 0.07)` | Standard structural borders |
| `--border-strong` | `rgba(255, 255, 255, 0.12)` | Active or high-contrast borders |
| `--font-main` | `'Outfit', sans-serif` | Main body typography |
| `--font-mono` | `'JetBrains Mono', monospace`| Source code, system outputs, numeric readouts |
| `--border-radius` | `var(--radius)` (5px) | Rounded corners style |

> [!IMPORTANT]
> **MINIMUM FONT SIZE BOUND**: Never declare `font-size` smaller than `11px` (including headers, captions, badges, or numeric inputs). This is critical for legibility in dense layouts.
>
> **GLASSMORPHISM EFFECTS**: Floating panels and major dialog boxes must utilize the `.glass` class to gain standard translucent slate backgrounds, subtle solid border edges, and beautiful backdrop blurs (`backdrop-filter: blur(16px)`).

---

## 📦 Component Specifications & Code Snippets

### 1. Unified Glassmorphic Buttons
Buttons feature rounded corners, smooth transitions (`150ms var(--ease)`), and soft drop shadows/glows.

```html
<!-- Primary action button (Vibrant blue with a subtle glow) -->
<button class="primary-btn">Export STL</button>

<!-- Secondary action button (Monochrome elevated surface) -->
<button class="secondary-btn">Save Project</button>

<!-- Outline indicator button (Transparent bordered blue) -->
<button class="outline-btn">Browse Library</button>
```

```css
.primary-btn {
    background: var(--accent-color);
    color: #ffffff;
    border: 1px solid var(--accent-color);
    font-size: 13px;
    font-weight: 600;
    font-family: var(--font-main);
    cursor: pointer;
    border-radius: var(--radius);
    transition: all var(--transition);
    box-shadow: 0 4px 12px var(--accent-glow);
}
.primary-btn:hover {
    background: var(--accent-bright);
    border-color: var(--accent-bright);
    box-shadow: 0 4px 18px rgba(75, 158, 255, 0.4);
    transform: translateY(-1px);
}
```

### 2. Form & Select Controls
Forms require glassmorphic inputs to remain cohesive in a semi-transparent atmosphere:

```html
<!-- Standard text/code parameter input -->
<input type="text" class="glass-input" placeholder="Enter parameter...">

<!-- Snappy dropdown picker selection -->
<select class="glass-select">
    <option value="both">Show Both</option>
    <option value="box">Show Box</option>
</select>
```

### 3. Compact Number Fields (Manual overrides)
Inputs sit alongside range sliders for instant numeric adjustment.

```html
<div class="param-label">
    <span>Width</span>
    <input type="number" class="manual-input" value="80" step="1">
</div>
<input type="range" min="40" max="150" step="1" value="80">
```

### 4. Sliders (Tactile Modern Range Track)
To optimize touch and drag accuracy, the slider has an expanded vertical interactive height of `32px` and uses a `14px` tactile round thumb with a subtle outline.

```css
input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    height: 14px;
    width: 14px;
    background: var(--accent-color);
    border: 2px solid #ffffff;
    margin-top: -5px;
    cursor: pointer;
    border-radius: var(--radius-full);
}
```

### 5. Status Diagnostics Badges
Colored markers representing background CAD parser and rendering status.

```html
<span id="status-badge" class="loading">Rendering...</span>
<span id="status-badge" class="success">Ready</span>
<span id="status-badge" class="error">Compilation Failure</span>
```

### 6. Conversational Chat Bot GUI
The AI Tab is designed as a modern messaging chatbot:
* **Scrollable Chat Container (`#ai-chat-history`)**: Messages are displayed sequentially with smooth scrolls.
* **User Chat Bubbles**: Right-aligned, colored with the primary accent background and white text.
* **Assistant Chat Bubbles**: Left-aligned, colored with elevated glassmorphic surface and light text.
* **Action Prompt Chips (`.ai-chip`)**: Pill-shaped action triggers positioned just above the input to prompt standard edits (e.g. "Mounting Holes"). Emojis have been removed for a professional interface.

---

## 🧑‍💻 Code Guidelines for Future Editors
Please read these instructions before modifying the codebase:

> [!WARNING]
> **1. BORDER RADII RULE**: Ensure you leverage the predefined border radii variables (`var(--radius-sm)`, `var(--radius)`, `var(--radius-lg)`). Avoid hardcoded `0px` or extreme values unless explicitly requested.
> 
> **2. TRANSITIONS & DAMPING**: Utilize pre-declared `var(--transition)` and `var(--transition-fast)` to provide micro-animations and responsive hover/focus visual feedback.
> 
> **3. SCROLLBAR INTEGRITY**: Avoid standard operating system scrollbars which disrupt the dark slate theme. Utilize the custom scrollbars declared in `style.css`.
> 
> **4. GLASSMORPHISM DEPTH**: Apply `.glass` to modals, popups, and panels to achieve maximum visual depth and a state-of-the-art UI atmosphere.
> 
> **5. COMPREHENSIVE RESPONSIVENESS**: Every layout must support mobile devices down to `320px` width. Enforce robust flex wraps and scrollable horizontal lanes where needed.
