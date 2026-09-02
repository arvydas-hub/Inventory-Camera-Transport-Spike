function stopStream(stream) {
  stream?.getTracks?.().forEach((track) => {
    try {
      track.stop();
    } catch {
      // Cleanup must remain best-effort and idempotent during page teardown.
    }
  });
}

function stopElementStream(element) {
  if (!element) return;
  stopStream(element.srcObject);
  try {
    element.srcObject = null;
  } catch {
    // A detached media element may no longer accept property changes.
  }
}

export function createCameraLifecycle({
  getUserMedia,
  createScanner,
  preview,
  reader,
  isHidden = () => false,
  onStateChange = () => {},
} = {}) {
  let generation = 0;
  let state = 'idle';
  let directStream = null;
  let scanner = null;
  let pendingScannerStart = null;
  let cleanupPromise = null;

  function setState(nextState) {
    state = nextState;
    onStateChange(nextState);
  }

  function stopReaderTracks() {
    const videos = reader?.querySelectorAll?.('video') || [];
    Array.from(videos).forEach(stopElementStream);
  }

  async function releaseScanner(instance) {
    stopReaderTracks();
    if (instance) {
      try {
        await Promise.resolve().then(() => instance.stop());
      } catch {
        // stop() can reject when startup was only partially completed.
      }
      try {
        instance.clear();
      } catch {
        // clear() can reject when the reader surface was never completed.
      }
    }
    stopReaderTracks();
  }

  function detachDirectStream(stream) {
    stopStream(stream);
    if (directStream === stream) directStream = null;
    if (preview?.srcObject === stream) stopElementStream(preview);
    if (preview) preview.hidden = true;
  }

  async function startDirect(constraints) {
    if (state !== 'idle') return { ok: false, code: 'CAMERA_BUSY', state };
    if (typeof getUserMedia !== 'function') {
      return { ok: false, code: 'CAMERA_UNAVAILABLE', error: new Error('getUserMedia is unavailable') };
    }

    const requestGeneration = ++generation;
    let acquiredStream = null;
    setState('direct-starting');
    try {
      acquiredStream = await getUserMedia(constraints);
      if (requestGeneration !== generation || isHidden()) {
        stopStream(acquiredStream);
        return { ok: false, code: 'CAMERA_CANCELLED' };
      }

      directStream = acquiredStream;
      preview.srcObject = acquiredStream;
      preview.hidden = false;
      await preview.play();

      if (requestGeneration !== generation || isHidden()) {
        detachDirectStream(acquiredStream);
        return { ok: false, code: 'CAMERA_CANCELLED' };
      }

      setState('direct-running');
      return { ok: true, stream: acquiredStream };
    } catch (error) {
      if (acquiredStream) detachDirectStream(acquiredStream);
      if (requestGeneration !== generation) return { ok: false, code: 'CAMERA_CANCELLED' };
      setState('idle');
      return { ok: false, code: 'CAMERA_START_FAILED', error };
    } finally {
      if (requestGeneration === generation && state === 'direct-starting') setState('idle');
    }
  }

  async function startScanner(start) {
    if (state !== 'idle') return { ok: false, code: 'CAMERA_BUSY', state };
    if (typeof createScanner !== 'function' || typeof start !== 'function') {
      return { ok: false, code: 'SCANNER_UNAVAILABLE', error: new Error('Scanner is unavailable') };
    }

    const requestGeneration = ++generation;
    let candidate = null;
    let startPromise = null;
    setState('scanner-starting');
    try {
      candidate = createScanner();
      scanner = candidate;
      if (reader) reader.hidden = false;
      startPromise = Promise.resolve().then(() => start(candidate));
      pendingScannerStart = startPromise;
      await startPromise;
      if (pendingScannerStart === startPromise) pendingScannerStart = null;
      if (requestGeneration !== generation || isHidden()) {
        await releaseScanner(candidate);
        if (scanner === candidate) scanner = null;
        return { ok: false, code: 'CAMERA_CANCELLED' };
      }

      setState('scanner-running');
      return { ok: true, scanner: candidate };
    } catch (error) {
      if (pendingScannerStart === startPromise) pendingScannerStart = null;
      await releaseScanner(candidate);
      if (scanner === candidate) scanner = null;
      if (requestGeneration === generation) setState('idle');
      if (reader) reader.hidden = true;
      return { ok: false, code: 'SCANNER_START_FAILED', error };
    } finally {
      if (requestGeneration === generation && state === 'scanner-starting') setState('idle');
    }
  }

  function stop(reason = 'manual') {
    if (cleanupPromise) return cleanupPromise;
    const cleanupGeneration = ++generation;
    setState('stopping');

    const ownedStream = directStream;
    directStream = null;
    if (preview?.srcObject === ownedStream) stopElementStream(preview);
    else {
      stopStream(ownedStream);
      stopElementStream(preview);
    }
    if (preview) preview.hidden = true;

    const ownedScanner = scanner;
    scanner = null;
    const startToSettle = pendingScannerStart;
    stopReaderTracks();
    if (reader) reader.hidden = true;
    cleanupPromise = (async () => {
      await releaseScanner(ownedScanner);
      if (startToSettle) {
        try {
          await startToSettle;
        } catch {
          // The start path returns its own structured error after cleanup.
        }
        await releaseScanner(ownedScanner);
      }
      if (cleanupGeneration === generation) setState('idle');
      return { ok: true, reason };
    })().finally(() => {
      cleanupPromise = null;
    });
    return cleanupPromise;
  }

  return {
    startDirect,
    startScanner,
    stop,
    getState: () => state,
  };
}
