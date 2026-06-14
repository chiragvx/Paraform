/**
 * Chat attachment store — images the user dropped/pasted into the composer for
 * the current turn. ChatPanel writes here on send; the AI's image_to_sketch tool
 * reads the latest image to vectorize it (the model can't hand raw pixels to a
 * tool, so the bytes travel out-of-band through this singleton, like the
 * viewport selection does for deixis).
 *
 * Each image: { mediaType, dataBase64, name? }.
 */

let _images = [];

export function setAttachedImages(imgs) {
    _images = Array.isArray(imgs) ? imgs.filter((x) => x && x.dataBase64) : [];
}

export function getAttachedImages() {
    return _images.slice();
}

export function getLastAttachedImage() {
    return _images.length ? _images[_images.length - 1] : null;
}

export function clearAttachedImages() {
    _images = [];
}
