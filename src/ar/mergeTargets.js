import { decode, encode } from '@msgpack/msgpack';

/**
 * Combine several compiled MindAR target files (.mind) into one, so a single
 * tracking session recognises all of their images (gallery link). Target
 * index i in the result is the i-th buffer's image. A .mind file is msgpack
 * `{ v, dataList: [...] }`; each compiled image is one dataList entry.
 * @param {ArrayBuffer[]} buffers
 * @returns {ArrayBuffer}
 */
export function mergeMindBuffers(buffers) {
  if (buffers.length === 1) return buffers[0];
  let version = null;
  const dataList = [];
  for (const buffer of buffers) {
    const data = decode(new Uint8Array(buffer));
    if (!data?.dataList?.length) throw new Error('Invalid image target data.');
    if (version !== null && data.v !== version) throw new Error('Image targets were compiled with different MindAR versions.');
    version = data.v;
    // Each file of this app holds exactly one image; use its first entry so
    // target indexes match experience indexes.
    dataList.push(data.dataList[0]);
  }
  const bytes = encode({ v: version, dataList });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
