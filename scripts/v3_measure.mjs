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

const funcs = [
    'renderTemplateGrid', 'selectTemplate', 'openStudioLibrary',
    'renderParameters', 'renderLayersTab', 'renderParametersMultiPart',
    'generateMeshThumbnail', 'loadTemplateThumbnails',
];

for (const name of funcs) {
    const prefix = `function ${name}(`;
    const asyncPrefix = `async function ${name}(`;
    const start = lines.findIndex(l => l.startsWith(prefix) || l.startsWith(asyncPrefix));
    if (start < 0) {
        console.log(`${name}: NOT FOUND`);
        continue;
    }
    const end = findEnd(start);
    console.log(`${name}: lines ${start + 1}..${end + 1}  (${end - start + 1} lines)`);
}
