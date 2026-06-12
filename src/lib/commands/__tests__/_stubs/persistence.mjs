// Stub for $lib/document/persistence.svelte.js
// Tests that need real behaviour from the persistence module import it
// directly via a non-aliased path; the stub keeps registry.js side-effect-free
// for the COMMANDS-table assertions.
let _saveCalls = 0;
let _saveAsCalls = 0;
let _openCalls = 0;
let _shareCalls = 0;
let _unsaved = false;

export const clearSavedDocument = () => {};
export const saveDocumentToFile = (name) => { _saveCalls++; return name || 'document.paraform.json'; };
export const saveDocumentAs = () => { _saveAsCalls++; return 'doc.paraform.json'; };
export const openDocumentFromFile = () => { _openCalls++; return Promise.resolve({ name: 'doc' }); };
export const shareDocumentBundle = () => { _shareCalls++; return { zip: true, screenshot: false, filename: 'document.bundle.zip' }; };
export const hasUnsavedChanges = () => _unsaved;

// Test hooks
export function _setUnsavedForTests(v) { _unsaved = !!v; }
export function _resetCallCountersForTests() { _saveCalls = _saveAsCalls = _openCalls = _shareCalls = 0; }
export function _getCallCountersForTests() {
  return { save: _saveCalls, saveAs: _saveAsCalls, open: _openCalls, share: _shareCalls };
}
