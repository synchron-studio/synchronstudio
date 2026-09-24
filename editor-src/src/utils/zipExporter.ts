/**
 * Gemeinsame Export-Typen und die Einzelbild-Aufnahme für "Auto-capture video frame".
 *
 * Der frühere Choicer-Voicer-Modpack-Export (exportModpackZip) wurde nirgends mehr
 * aufgerufen — der Editor exportiert nur noch Synchronstudio-Szenen (ssExport.ts).
 * Der tote Code ist entfernt; er steht bei Bedarf in der Git-Historie.
 */

export interface ZipExportProgress {
  status: string;
  percent: number;
}

/** Höchstens so breit werden aufgenommene Einzelbilder. Volle 1280×720-PNGs als
 *  data:-URL waren je 1–2 MB groß und sprengten den Projektspeicher des Browsers. */
const FRAME_MAX_WIDTH = 640;

export const captureFrameAtTime = (
  time: number,
  videoMediaUrl?: string
): Promise<string> => {
  return new Promise((resolve) => {
    const videoEl = document.getElementById('main-video-player') as HTMLVideoElement | null;
    const mediaUrl = videoMediaUrl || videoEl?.currentSrc || videoEl?.src;

    if (!mediaUrl) {
      resolve('');
      return;
    }

    const offscreenVid = document.createElement('video');
    offscreenVid.crossOrigin = 'anonymous';
    offscreenVid.muted = true;
    offscreenVid.playsInline = true;
    offscreenVid.preload = 'auto';

    let done = false;
    const finish = (result: string) => {
      if (done) return;
      done = true;
      offscreenVid.removeEventListener('seeked', handleSeeked);
      offscreenVid.removeEventListener('loadedmetadata', handleLoadedMetadata);
      offscreenVid.removeEventListener('error', handleError);
      clearTimeout(timeoutId);
      try {
        offscreenVid.pause();
        offscreenVid.removeAttribute('src');
        offscreenVid.load();
      } catch { /* egal */ }
      resolve(result);
    };

    const doCapture = () => {
      try {
        const vw = offscreenVid.videoWidth, vh = offscreenVid.videoHeight;
        if (!vw || !vh) return finish('');
        const scale = Math.min(1, FRAME_MAX_WIDTH / vw);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(vw * scale));
        canvas.height = Math.max(1, Math.round(vh * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return finish('');
        ctx.drawImage(offscreenVid, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/png'));
      } catch (err) {
        console.error('Frame capture error:', err);
        finish('');
      }
    };

    const handleSeeked = () => doCapture();
    const handleLoadedMetadata = () => {
      const targetTime = Math.min(Math.max(0, time), Math.max(0, (offscreenVid.duration || 100) - 0.05));
      offscreenVid.currentTime = targetTime;
    };
    const handleError = () => finish('');

    // Nie ewig hängen bleiben; danach mit dem nehmen, was da ist
    const timeoutId = setTimeout(doCapture, 4000);

    offscreenVid.addEventListener('seeked', handleSeeked);
    offscreenVid.addEventListener('loadedmetadata', handleLoadedMetadata);
    offscreenVid.addEventListener('error', handleError);
    offscreenVid.src = mediaUrl;
  });
};
