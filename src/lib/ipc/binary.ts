import { ReaderApiError } from "./errors";

export type ImageDataFactory = (
  pixels: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
) => ImageData;

const HEADER_BYTES = 8;

function defaultCreateImageData(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): ImageData {
  if (typeof globalThis.ImageData !== "function") {
    throw new ReaderApiError(
      "internal",
      "ImageData constructor is unavailable in this environment.",
    );
  }
  return new globalThis.ImageData(pixels, width, height);
}

/**
 * Decodes the binary `render_page` IPC frame `[width: u32 LE][height: u32 LE][RGBA8]`
 * into an `ImageData` without copying pixel data.
 */
export function decodeRenderFrame(
  buffer: unknown,
  createImageData: ImageDataFactory = defaultCreateImageData,
): ImageData {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER_BYTES) {
    throw new ReaderApiError(
      "internal",
      "Invalid binary frame returned from render_page.",
    );
  }

  const header = new DataView(buffer);
  const width = header.getUint32(0, true);
  const height = header.getUint32(4, true);
  const expectedBytes = width * height * 4;

  if (
    width === 0 ||
    height === 0 ||
    !Number.isSafeInteger(expectedBytes) ||
    buffer.byteLength < HEADER_BYTES + expectedBytes
  ) {
    throw new ReaderApiError(
      "internal",
      "Truncated RGBA bitmap payload from render_page.",
    );
  }

  const pixels = new Uint8ClampedArray(buffer, HEADER_BYTES, expectedBytes);
  return createImageData(pixels, width, height);
}
