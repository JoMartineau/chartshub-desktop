/** Native song clock is authoritative. video_start_time is a position in the
 * video: positive skips forward; negative delays its start. No audio is played. */
export function visualTarget(snapshot, elapsedSeconds = 0) {
  const c = snapshot?.clock;
  if (!snapshot?.video || !['playing', 'paused'].includes(snapshot.phase) || !c
    || !Number.isFinite(c.positionSeconds) || !Number.isFinite(c.durationSeconds) || !Number.isFinite(c.speed)
    || c.speed < .01 || c.speed > 10 || !Number.isSafeInteger(snapshot.videoStartTimeMs)
    || Math.abs(snapshot.videoStartTimeMs) > 86400000 || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 || elapsedSeconds > 2.5) return null;
  const position = c.positionSeconds + (snapshot.phase === 'playing' ? elapsedSeconds * c.speed : 0);
  if (position > c.durationSeconds + .5) return null;
  const videoSeconds = position + snapshot.videoStartTimeMs / 1000;
  return { seconds: Math.max(0, videoSeconds), hidden: videoSeconds < 0, playing: snapshot.phase === 'playing' && videoSeconds >= 0, speed: c.speed };
}
