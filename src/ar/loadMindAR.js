/**
 * Lazily loads the MindAR image-tracking engine (Controller + Compiler).
 *
 * We use MindAR's low-level `Controller` rather than the `MindARThree` helper:
 * the helper imports `sRGBEncoding` (removed from three.js in r162), injects
 * its own UI into <body>, swallows camera errors and never removes its window
 * resize listener. The Controller is the actual tracking engine and is
 * framework-agnostic. The module (TensorFlow.js included) is ~2 MB, so it is
 * only fetched on the AR page and by the admin target compiler.
 */
let modulePromise = null;

export function loadMindAR() {
  if (!modulePromise) {
    modulePromise = import('mind-ar/dist/mindar-image.prod.js').catch((err) => {
      modulePromise = null; // allow retry after a network failure
      throw err;
    });
  }
  return modulePromise;
}
