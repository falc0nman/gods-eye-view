import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    'fire-perimeters': createWfigsPerimeterSource(),
  };
}
