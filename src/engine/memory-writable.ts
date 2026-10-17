import type { StreamTargetChunk } from 'mediabunny';

/** Поток с записью по позициям в память — запасной вариант, когда нельзя писать сразу на диск. */
export function memoryWritable(): { writable: WritableStream<StreamTargetChunk>; result: () => Blob } {
  let buf = new Uint8Array(1 << 20);
  let size = 0;
  const writable = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      const end = chunk.position + chunk.data.byteLength;
      if (end > buf.length) {
        const grown = new Uint8Array(Math.max(end, buf.length * 2));
        grown.set(buf.subarray(0, size));
        buf = grown;
      }
      buf.set(chunk.data, chunk.position);
      size = Math.max(size, end);
    },
  });
  return { writable, result: () => new Blob([buf.subarray(0, size)], { type: 'video/mp4' }) };
}
