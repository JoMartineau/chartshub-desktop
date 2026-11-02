// A resolved play() / stream grant is not proof that the source delivered video.
// Keep the start bounded and cancellable, including when play() never resolves.
export function startVideoFrames(video, { signal, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let frame = null, timer = null, finished = false;
    const done = error => {
      if (finished) return; finished = true;
      clearTimeout(timer);
      if (frame !== null) video.cancelVideoFrameCallback?.(frame);
      for (const name of ['loadeddata','timeupdate','resize']) video.removeEventListener(name, fallback);
      video.removeEventListener('error', failed); signal?.removeEventListener('abort', aborted);
      error ? reject(error) : resolve({ width: video.videoWidth, height: video.videoHeight });
    };
    const valid = () => video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
    const fallback = () => { if (!video.requestVideoFrameCallback && valid()) done(); };
    const nextFrame = () => {
      frame = null;
      if (valid()) done();
      else if (!finished) frame = video.requestVideoFrameCallback(nextFrame);
    };
    const failed = () => done(Error('capture-unavailable'));
    const aborted = () => done(Error('capture-cancelled'));
    if (signal?.aborted) return aborted();
    signal?.addEventListener('abort', aborted, { once: true });
    video.addEventListener('error', failed, { once: true });
    timer = setTimeout(() => done(Error('no-video-frame')), timeoutMs);
    if (video.requestVideoFrameCallback) frame = video.requestVideoFrameCallback(nextFrame);
    else for (const name of ['loadeddata','timeupdate','resize']) video.addEventListener(name, fallback);
    try { Promise.resolve(video.play()).then(fallback, done); } catch (error) { done(error); }
  });
}

export function captureFailure(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'permission-denied';
  return error?.message === 'no-video-frame' ? 'no-video-frame' : 'capture-unavailable';
}
