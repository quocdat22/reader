export const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.85, 1.0, 1.15, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
  4.0,
] as const;

export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[14];

/**
 * Clamps a zoom multiplier within `[MIN_ZOOM, MAX_ZOOM]`.
 */
export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) {
    return 1.0;
  }
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
}

/**
 * Returns the next discrete zoom step above or below `currentScale`.
 */
export function getNextZoomStep(
  currentScale: number,
  direction: 1 | -1,
): number {
  const epsilon = 0.01;
  if (direction > 0) {
    for (const step of ZOOM_STEPS) {
      if (step > currentScale + epsilon) {
        return step;
      }
    }
    return MAX_ZOOM;
  }

  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    const step = ZOOM_STEPS[i];
    if (step !== undefined && step < currentScale - epsilon) {
      return step;
    }
  }
  return MIN_ZOOM;
}
