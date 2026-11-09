const MAX_EDGE = 2048;
const KEEP_BYTES = 1.5 * 1024 * 1024;

const SHRINKABLE = /^image\/(jpeg|png|webp|heic|heif)$/;

/** Scale a photo down before upload (PNG stays PNG, else JPEG); GIFs are left alone since they may move. */
export async function shrinkImage(file: File): Promise<File> {
  if (!SHRINKABLE.test(file.type) || typeof createImageBitmap !== 'function') return file;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const heic = /hei[cf]$/.test(file.type);
    if (scale === 1 && !heic && file.size <= KEEP_BYTES) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, type, 0.85));
    if (!blob || (blob.size >= file.size && !heic)) return file;
    const stem = file.name.replace(/\.[^.]*$/, '') || 'image';
    return new File([blob], type === 'image/png' ? `${stem}.png` : `${stem}.jpg`, { type, lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}
