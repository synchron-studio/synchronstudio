/**
 * Kleine Helfer rund um Bilder und Blobs, die von mehreren Exporten gebraucht werden.
 */

/**
 * Nur echte Blobs durchlassen. Aus dem localStorage geladene Projekte enthalten statt
 * einer Datei ein leeres Objekt ({}), weil JSON keine Dateien speichern kann. Das an
 * JSZip weiterzugeben ließ den ganzen Export abbrechen.
 */
export function asBlob(value: unknown): Blob | null {
  return typeof Blob !== 'undefined' && value instanceof Blob && value.size > 0 ? value : null;
}

/** Bild-URL (data:, blob:, http) holen — liefert null statt zu werfen. */
export async function fetchBlob(url?: string): Promise<Blob | null> {
  if (!url) return null;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return asBlob(await resp.blob());
  } catch {
    return null;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image could not be decoded'));
    img.src = src;
  });
}

/**
 * Beliebiges Bild (auch SVG) als PNG mit höchstens `max` Pixeln Kantenlänge.
 * createImageBitmap kann in Chrome/Firefox kein SVG — deshalb über ein <img>.
 * Früher landete das SVG dadurch mit .png-Endung im Export und das Spiel zeigte
 * ein kaputtes Bild.
 */
export async function toPngBlob(blob: Blob, max = 256): Promise<Blob | null> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth || img.width || max;
    const h = img.naturalHeight || img.height || max;
    const scale = Math.min(1, max / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob.type === 'image/png' ? blob : null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  } catch {
    // Nicht dekodierbar: nur ein echtes PNG unverändert durchreichen, nie SVG als .png
    return blob.type === 'image/png' ? blob : null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Bild-Datei verkleinern und als data:-URL liefern (für das Speichern im Projekt). */
export async function fileToSmallDataUrl(file: Blob, max = 512): Promise<string> {
  const png = await toPngBlob(file, max);
  const source = png || file;
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(source);
  });
}

/** Download starten. Die Adresse erst später freigeben — sofortiges Freigeben ließ den
 *  Download in Firefox/Safari still ausfallen. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
