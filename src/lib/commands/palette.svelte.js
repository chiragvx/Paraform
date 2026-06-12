// Module-level palette state. Uses a Svelte 5 class with $state so any
// component can read/write `palette.open` and stay reactive.

class PaletteState {
  open = $state(false);
  query = $state('');

  show() {
    this.query = '';
    this.open = true;
  }
  hide() {
    this.open = false;
  }
  toggle() {
    if (this.open) this.hide();
    else this.show();
  }
}

export const palette = new PaletteState();
