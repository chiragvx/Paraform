/**
 * Document parameter validation.
 *
 * Parameters live above features and emit as `p_<name> = <value>` at the
 * top of the script. Features reference them via the `=p_<name>` string
 * convention (see `py()` in emit.js).
 */

import { addBox, addDocumentParameter, setDocumentParameter } from '../lib/document/operations.js';
import { makeFeature } from '../lib/document/types.js';
import { addFeatureChange } from '../lib/document/changelog.js';
import { getDocumentStore } from '../lib/document/store.js';

export default [
    {
        name: 'Parameter · single literal',
        build: () => {
            addDocumentParameter('wall', 2.4, 'mm');
            addBox({ length: 10, width: 10, height: 10 });
        },
        expect: {
            python: /p_wall\s*=\s*2\.4/,
        },
    },
    {
        name: 'Parameter · equation references another parameter',
        build: () => {
            addDocumentParameter('w', 30, 'mm');
            addDocumentParameter('h', 0, 'mm', 'p_w / 2');
            addBox();
        },
        expect: {
            python: /p_h\s*=\s*p_w\s*\/\s*2/,
        },
    },
    {
        name: 'Parameter · Box length driven by parameter',
        build: () => {
            addDocumentParameter('L', 25, 'mm');
            // Build a Box feature directly so we can pass `=p_L` as length.
            const f = makeFeature('Box', { length: '=p_L', width: 10, height: 10, centered: true });
            getDocumentStore().commit(addFeatureChange(f));
        },
        expect: {
            featureType: 'Box',
            python:      /Box\(p_L,\s*10,\s*10/,
            topology:    { faces: 6, edges: 12 },
        },
    },
    {
        name: 'Parameter · update propagates',
        build: () => {
            addDocumentParameter('r', 5, 'mm');
            setDocumentParameter('r', { value: 8 });
            addBox({ length: '=p_r', width: '=p_r', height: '=p_r' });
        },
        expect: {
            // After the update the emit should reflect 8.
            python: /p_r\s*=\s*8/,
        },
    },
];
