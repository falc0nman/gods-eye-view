/**
 * The transport used when no notification backend is configured (GW-81).
 *
 * The SNS → SQS consumer belongs to the backend. Until one is connected,
 * starting this transport fails, so the dispatcher reports the stream as
 * `down` and feeds go straight to their polling fallback, without waiting
 * for the stream to lapse.
 */
export function unconfiguredTransport() {
  return {
    start() {
      throw new Error('no notification transport configured');
    },
  };
}
