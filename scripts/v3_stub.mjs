import fs from 'node:fs';

const lines = fs.readFileSync('main.js', 'utf8').split('\n');

const findEnd = (start) => {
    let depth = 0;
    let saw = false;
    for (let i = start; i < lines.length; i++) {
        for (const ch of lines[i]) {
            if (ch === '{') { depth++; saw = true; }
            if (ch === '}') { depth--; if (saw && depth === 0) return i; }
        }
    }
    return -1;
};

const targets = [
    { name: 'renderTemplateGrid',        async: false },
    { name: 'selectTemplate',            async: true  },
    { name: 'openStudioLibrary',         async: false },
    { name: 'renderParameters',          async: false },
    { name: 'renderLayersTab',           async: false },
    { name: 'renderParametersMultiPart', async: false },
    { name: 'generateMeshThumbnail',     async: false },
    { name: 'loadTemplateThumbnails',    async: false },
];

// Walk targets in reverse line order so earlier edits don't shift the next.
const found = [];
for (const t of targets) {
    const prefix = t.async ? `async function ${t.name}(` : `function ${t.name}(`;
    const start = lines.findIndex(l => l.startsWith(prefix));
    if (start < 0) {
        console.error(`SKIP: ${t.name} not found`);
        continue;
    }
    const end = findEnd(start);
    found.push({ ...t, start, end });
}
found.sort((a, b) => b.start - a.start);

for (const { name, async: isAsync, start, end } of found) {
    const sig = isAsync ? `async function ${name}` : `function ${name}`;
    const stub = [
        `// ${name} retired with the v3 template / right-panel surface.`,
        `${sig}() { /* no-op (v3) */${isAsync ? ' return null;' : ''} }`,
    ];
    lines.splice(start, end - start + 1, ...stub);
    console.log(`stubbed ${name}: was ${end - start + 1} lines → 2`);
}

fs.writeFileSync('main.js', lines.join('\n'));
console.log('Done. New line count:', lines.length);
