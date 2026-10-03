/**
 * @module worldOverlayTokens
 * @description Visual constants shared by the world-overlay host, painters,
 * and source presentation bridges. Keep source selection and data semantics in
 * their owning modules; this file is the single home for cross-source canvas
 * presentation values.
 */

/** Shared visual tokens used by every world-overlay source. */
export const WORLD_OVERLAY_STYLE = Object.freeze({
  background: 'rgba(4, 12, 16, 0.82)',
  selectedBackground: 'rgba(5, 18, 24, 0.94)',
  border: 'rgba(190, 232, 242, 0.18)',
  selectedBorder: 'rgba(107, 232, 255, 0.72)',
  title: 'rgba(232, 240, 244, 0.96)',
  detail: 'rgba(147, 161, 173, 0.92)',
  leader: 'rgba(147, 213, 228, 0.58)',
  accent: '#6be8ff',
  fontLabel: '500 10px "JetBrains Mono", monospace',
  fontTrack: '600 10px "JetBrains Mono", monospace',
  fontTitle: '600 12px "JetBrains Mono", monospace',
  fontDetail: '500 10.5px "JetBrains Mono", monospace',
  fontSelected: '600 13px "JetBrains Mono", monospace',
  fontTrackedTitle: '600 13px "JetBrains Mono", monospace',
  fontTrackedDetail: '500 11px "JetBrains Mono", monospace',
  radius: 4,
  anchorDotRadius: 3.2,
  anchorDotStrokeWidth: 1,
  anchorDotStroke: 'rgba(4, 12, 16, 0.96)',
  leaderWidth: 1.35,
});

/** CCTV's field-tested thumbnail-card overrides on top of shared card chrome. */
export const CCTV_THUMBNAIL_STYLE = Object.freeze({
  padding: 4,
  titleHeight: 13,
  titleChars: 15,
  background: WORLD_OVERLAY_STYLE.background,
  titleColor: 'rgba(210, 236, 244, 0.95)',
  titleFont: '600 10px "JetBrains Mono", monospace',
  accent: 'rgb(107, 232, 255)',
  leader: 'rgba(107, 232, 255, 0.6)',
  rule: 'rgba(107, 232, 255, 0.95)',
  ruleHeight: 2,
  radius: 4,
});
