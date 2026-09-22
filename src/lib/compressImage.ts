/**
 * Resizes an image to at most `maxDimension` on its long edge and
 * re-encodes it as JPEG, client-side, before it's ever uploaded.
 *
 * Two independent reasons this exists, not one:
 * - An iPhone camera photo is HEIC by default and several MB; a Mac's file
 *   picker usually hands over an already-small JPEG. WebKit's canvas/
 *   createImageBitmap cannot reliably decode HEIC in a web content process
 *   even where Safari itself can display one directly, so a HEIC upload
 *   was going through to storage as-is — correctly stored, but a real gap
 *   this closes: converting to JPEG here means every photo this app ever
 *   stores is something every browser and the manager's own review screen
 *   can actually render, not just whichever device happened to produce it.
 * - Several photos per task, across every location, makes the 1GB
 *   Supabase free tier a real constraint (see PROGRESS.md) — a capped,
 *   re-encoded JPEG is reliably smaller than an original multi-MB photo
 *   regardless of source format.
 *
 * Falls back to the original file, untouched, if this browser can't
 * decode it at all (createImageBitmap throws — the HEIC case on an older
 * WebKit, or any other format gap) or canvas is unavailable for any
 * reason: uploading the original is strictly better than blocking task
 * completion on a codec gap this function can't do anything about anyway.
 */
export async function compressImage(
  file: File,
  maxDimension = 1600,
  quality = 0.85
): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);

    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;

    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) return file;

    const jpegName = file.name.replace(/\.\w+$/, '') + '.jpg';
    return new File([blob], jpegName, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
