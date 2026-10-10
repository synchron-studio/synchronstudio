/* Small browser primitives shared by loading, recording and their regression tests. */
const StudioReliability = (() => {
  const abortError = () => new DOMException("Cancelled", "AbortError");

  // Lädt eine Datei mit Fortschritt. Reißt die Verbindung mittendrin ab (WLAN-Wackler, Handy
  // wechselt Funkzelle), geht es dank „Range“ an der Abbruchstelle weiter — vorher begann ein
  // 70-MB-Video nach dem Abbruch wieder bei 0 %. Bis zu 3 Fortsetzungen, solange es vorangeht.
  async function downloadBlob(url, { signal, onProgress, stallMs = 30000, type = "video/mp4", maxResumes = 3 } = {}) {
    if (signal?.aborted) throw abortError();
    const chunks = [];
    let received = 0, size = 0, lastPct = -1, resumes = 0;
    const progress = pct => {
      if (pct !== lastPct) { lastPct = pct; onProgress?.(pct); }
    };
    while (true) {
      const controller = new AbortController();
      let timer, reader, stalled = false;
      const cancel = () => controller.abort();
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { stalled = true; controller.abort(); }, stallMs);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      touch();
      try {
        const headers = received > 0 ? { Range: "bytes=" + received + "-" } : undefined;
        const response = await fetch(url, { mode: "cors", cache: received > 0 ? "no-store" : "force-cache", signal: controller.signal, headers });
        if (!response.ok) throw Object.assign(new Error("HTTP " + response.status), { http: true });
        if (received > 0 && response.status !== 206) {
          // Server kann kein Fortsetzen → sauber von vorne
          chunks.length = 0; received = 0;
        }
        touch();
        if (!size) {
          const range = /\/(\d+)\s*$/.exec(response.headers.get("content-range") || "");
          size = range ? Number(range[1]) : (Number(response.headers.get("content-length")) || 0) + received;
        }
        if (response.body?.getReader) {
          reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (controller.signal.aborted) throw abortError();
            if (done) break;
            chunks.push(value);
            received += value.byteLength;
            touch(); // Slow, active downloads may take as long as needed.
            progress(size ? Math.min(99, Math.floor(received / size * 100)) : 0);
          }
        } else {
          const bytes = await response.arrayBuffer();
          chunks.push(bytes);
          received += bytes.byteLength;
        }
        if (controller.signal.aborted) throw abortError();
        if (!received) throw new Error("Empty download");
        if (size && received < size) throw new Error("Download incomplete");
        progress(100);
        return new Blob(chunks, { type });
      } catch (error) {
        if (signal?.aborted) throw abortError();
        const canResume = received > 0 && resumes < maxResumes && !error.http && error.message !== "Empty download";
        if (canResume) { resumes++; continue; }
        if (stalled) throw new Error("Download stalled");
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        try { await reader?.cancel(); } catch {}
        controller.abort();
      }
    }
  }

  function waitMedia(video, { timeoutMs = 30000, signal, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      if (!video) return reject(new Error("Missing video"));
      if (signal?.aborted) return reject(abortError());
      if (video.error) return reject(new Error("Video error " + video.error.code));
      if (video.readyState >= 3) { onProgress?.(100); return resolve(); }
      let timer, poll;
      const finish = error => {
        clearTimeout(timer); clearInterval(poll);
        video.removeEventListener("canplay", ready);
        video.removeEventListener("canplaythrough", ready);
        video.removeEventListener("error", failed);
        signal?.removeEventListener("abort", cancelled);
        if (error) reject(error);
        else { onProgress?.(100); resolve(); }
      };
      const ready = () => { if (video.readyState >= 3) finish(); };
      const failed = () => finish(new Error("Video could not load"));
      const cancelled = () => finish(abortError());
      timer = setTimeout(() => finish(new Error("Video loading timed out")), timeoutMs);
      poll = setInterval(() => {
        if (video.readyState >= 3) return ready();
        if (onProgress && video.duration > 0 && Number.isFinite(video.duration) && video.buffered.length) {
          onProgress(Math.min(99, Math.round(video.buffered.end(video.buffered.length - 1) / video.duration * 100)));
        }
      }, 250);
      video.addEventListener("canplay", ready);
      video.addEventListener("canplaythrough", ready);
      video.addEventListener("error", failed);
      signal?.addEventListener("abort", cancelled, { once: true });
      // Assigning src already starts loading. Calling load() here restarts requests/seeks.
    });
  }

  function seekMedia(video, time, { timeoutMs = 4000, cancelled = () => false } = {}) {
    return new Promise((resolve, reject) => {
      let poll, timer;
      const finish = error => {
        clearTimeout(timer); clearInterval(poll);
        video.removeEventListener("seeked", check);
        video.removeEventListener("error", failed);
        error ? reject(error) : resolve();
      };
      const failed = () => finish(new Error("Video seek failed"));
      const check = () => {
        if (cancelled()) return finish(Object.assign(new Error("cancel"), { name: "RecCancel" }));
        if (!video.seeking && Math.abs(video.currentTime - time) < 0.05) finish();
      };
      timer = setTimeout(() => finish(new Error("Video seek timed out")), timeoutMs);
      poll = setInterval(check, 40);
      video.addEventListener("seeked", check);
      video.addEventListener("error", failed);
      try { video.currentTime = time; check(); } catch (error) { finish(error); }
    });
  }

  return { downloadBlob, waitMedia, seekMedia };
})();
if (typeof module !== "undefined") module.exports = StudioReliability;
