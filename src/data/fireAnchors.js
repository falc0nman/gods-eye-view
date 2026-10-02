import { createFireAnchors } from '../services/fireAnchors.js';
import * as groundFloor from './groundFloor.js';
export { FIRE_ANCHOR_LIFT_M } from '../services/fireAnchors.js';
const anchors = createFireAnchors(groundFloor);
export const {
  fireAnchorHeight,
  warmFireAnchorFloors,
  _resetFireAnchorsForTest,
} = anchors;
