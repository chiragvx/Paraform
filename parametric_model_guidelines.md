# ParaForm Technical Specification: OpenSCAD Customizer Engine & Zero-Tolerance Parser Rules

This document outlines the strict technical requirements for authoring OpenSCAD (.scad) templates for the ParaForm client-side WebAssembly rendering engine. Large Language Models (including ChatGPT) regularly fail to generate compatible models due to slight syntax variations that break the regex-based static analyzer. 

By defining these **hard parser constraints**, **anti-patterns**, and **exact regular expression rules**, developers and AI assistants can guarantee 100% syntactical compatibility.

---

## 1. The Parser Under the Hood (Technical Spec)

ParaForm utilizes a static line-by-line parser on the main browser thread prior to WebAssembly worker mesh compilation. The parser scans the source code using the following **exact Javascript regular expression**:

```javascript
const match = line.match(/^(\w+)\s*=\s*([^;]+);(?:\s*\/\/\s*\[(.*)\])?/);
```

### RegEx Capture Group Breakdown
When a line is evaluated, the matches are mapped as follows:
*   **`match[1]` (Variable Key)**: `^(\w+)` — The variable identifier. Matches letters, numbers, and underscores. **Must sit at the absolute start of the line (column 0).**
*   **`match[2]` (Default Value)**: `([^;]+)` — Every character between the assignment operator `=` and the first semicolon `;`. 
*   **`match[3]` (UI Configuration)**: `\[(.*)\]` — The metadata array inside brackets following the double-slash comment `//`.

### Auto-Type Inference Engine
If `match[3]` (the configuration string) is omitted, the parser infers the parameter type based on the raw value in `match[2]`:
1. If the trimmed value is exactly `"true"` or `"false"`, the type is set to **`boolean`**.
2. If the trimmed value contains double quotes `"`, the type is set to **`string`**.
3. If the trimmed value is a numeric digit (`!isNaN(parseFloat(val))`), the type is set to **`number`**.

---

## 2. Zero-Tolerance Syntax Rules (Uncompromising)

Any violation of the rules below will cause the parser to fail, crashing the rendering workflow, omitting parameters from the customizer UI, or causing syntax errors in the WebAssembly compiler.

### Rule 1: Columns & Leading Whitespace (No Indentation)
The regex checks for the beginning of a line (`^`). There must be **zero spaces, tabs, comments, or characters** preceding the variable name.
*   ❌ **FAIL**: `  width = 50; // [number, Width, 10, 100]`
*   ✅ **PASS**: `width = 50; // [number, Width, 10, 100]`

### Rule 2: Single-Line Variable Declaration & Annotation
The UI configuration comment **must sit on the exact same line** as the variable declaration. Standard OpenSCAD Customizer allowing comments on preceding lines is **not supported** by the regex engine.
*   ❌ **FAIL**:
    ```openscad
    // [number, Box Width, 20, 150]
    box_width = 80;
    ```
*   ✅ **PASS**:
    ```openscad
    box_width = 80; // [number, Box Width, 20, 150]
    ```

### Rule 3: Literal/Constant Defaults Only (No Expressions)
The default value (`match[2]`) is captured raw. Do not use mathematical formulas, dependencies, or function calls in parameter declarations.
*   ❌ **FAIL**: `box_width = min_width + 20;`
*   ❌ **FAIL**: `wall_thickness = 2 * 1.5;`
*   ✅ **PASS**: `box_width = 80;`

### Rule 4: Explicit Semicolon Termination
Every variable declaration must end with a semicolon `;` before the comment.
*   ❌ **FAIL**: `box_width = 80 // [number, Width, 20, 150]`
*   ✅ **PASS**: `box_width = 80; // [number, Width, 20, 150]`

### Rule 5: Downstream Variable Scope Protection
In OpenSCAD, assigning a variable multiple times will result in the last assignment overriding all previous ones in that scope. Because ParaForm customizes models by prepending user-defined values to the top of the file, you **must not re-assign or re-declare parameter variables** anywhere else in the code.
*   ❌ **FAIL**:
    ```openscad
    box_width = 80; // [number, Width, 20, 150]
    // ... downstream ...
    box_width = 50; // Breaks customization!
    ```

### Rule 6: Sandbox Compatibility (Zero File/Library Imports)
The WASM compilation loop runs in a memory-isolated browser worker. **Never** use `use <...>` or `include <...>` statements. All geometry creation must be completely self-contained.

### Rule 7: Strict Performance Budget Rules
*   **$fn limits**: Keep global `$fn` at or below `64`. Overriding with high values globally (`$fn=128+`) will trigger WASM Out-Of-Memory (OOM) errors or tab crashes.
*   **Z-Fighting Prevention**: You must declare a constant `eps = 0.01;` and use it to offset cutting elements in `difference()` scopes.

---

## 3. Strict Syntax Comparison Matrix

| Pattern Feature | ❌ Parser Fail Pattern (Breaks UI or WASM) | ✅ Parser Success Pattern (High Compatibility) |
| :--- | :--- | :--- |
| **Indentation** | `  thickness = 2.0; // [number, Thickness, 1, 5]` | `thickness = 2.0; // [number, Thickness, 1, 5]` |
| **Comments Location** | `// [integer, Slots, 1, 10]` <br>`slots = 4;` | `slots = 4; // [integer, Slots, 1, 10]` |
| **Calculation Defaults**| `clearance = wall / 2; // [number, Clearance, 0, 1]` | `clearance = 0.3; // [number, Clearance, 0, 1]` |
| **Semicolon** | `has_lid = true // [boolean, Include Lid]` | `has_lid = true; // [boolean, Include Lid]` |
| **Libraries** | `use <MCAD/involute_gears.scad>` | *Inlined gear module equations directly in script* |
| **Subtractions** | `difference() { cube([10,10,10]); cube([8,8,10]); }` | `difference() { cube([10,10,10]); translate([1,1,-eps]) cube([8,8,10+2*eps]); }` |

---

## 4. Uncompromising AI System Prompt

Use this hyper-strict prompt to configure and direct other AI systems (like ChatGPT) to write code for ParaForm:

```markdown
You are a highly advanced compiler-level CAD translation engine specializing in OpenSCAD generation. You are writing code specifically for a sandboxed client-side WebAssembly parser that compiles meshes directly in the browser. 

You must follow these syntactical and geometric constraints with ZERO exceptions. Any deviation will cause compilation and parsing failure.

### 1. Zero-Indentation Parameter Parser Constraints
The static analyzer utilizes the following exact regular expression to extract parameters from your code:
`/^(\w+)\s*=\s*([^;]+);(?:\s*\/\/\s*\[(.*)\])?/`

To ensure a perfect match, you must apply these strict syntax rules:
- **Rule 1 (Absolute Column 0)**: Variables must be declared starting at the absolute beginning of the line. Do not indent with spaces or tabs.
- **Rule 2 (Single Line Only)**: The variable declaration, assignment, value, semicolon, and configuration comment must all reside on the exact same line.
- **Rule 3 (Literal Values Only)**: The default value must be a literal constant (e.g. integer, float, string, boolean). Never write mathematical calculations, operations, or function dependencies in default values.
- **Rule 4 (Exact Format)**: Write parameters exactly like this:
  `variable_name = default_value; // [type, Label, min, max, step]`
  - Floating point sliders: `length = 100.0; // [number, Part Length, 20.0, 200.0, 0.5]`
  - Integer steppers: `teeth = 24; // [integer, Gear Teeth, 8, 100, 1]`
  - Boolean toggles: `show_lid = true; // [boolean, Show Lid Panel]`

### 2. High-Performance Client-Side Rendering Rules
- **No Minkowski**: Avoid `minkowski()`. Use `hull()` with cylinders/spheres to create rounded profiles.
- **Strict $fn Budget**: Keep global `$fn` at or below 64. Useselective faceting on cylinders only.
- **Self-Containment**: Do not write any `use <...>` or `include <...>` statements. The model must compile autonomously with no external library dependencies.
- **Z-Fighting Mitigation**: Declare `eps = 0.01;` at the top of your code. Apply `eps` offsets to the positions and sizes of subtracting shapes in all `difference()` operations.
- **Orientation**: Sit the model exactly at `z = 0` (on the bed) and center the base at `(x=0, y=0)`.
- **Downstream Scope**: Do not re-assign or re-declare parameter variables in modules or at any downstream point of the script.

### 3. Verification Sequence (Mandatory)
Before emitting your final output, verify your code against this exact checkpoint checklist:
- [ ] Do all interactive variables begin on column 0 of a new line?
- [ ] Is there exactly zero spaces of indentation before variable assignments?
- [ ] Do all declarations terminate with a semicolon `;` before their comment annotation?
- [ ] Are all UI comments placed on the same line as the variable?
- [ ] Are there zero external files, `use <...>`, or `include <...>` statements?
- [ ] Did you use `eps` offsets for all subtraction cutouts?

Provide ONLY the final executable OpenSCAD code. Do not output introduction, conversational explanations, or side notes.
```
