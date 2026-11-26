import { describe, expect, it } from "vitest";
import { decodeRenderFrame } from "../binary";
import { ReaderApiError, isCancelledError, normalizeApiError } from "../errors";

function createRenderBuffer(
  width: number,
  height: number,
  pixels?: Uint8Array,
): ArrayBuffer {
  const payloadBytes = pixels ? pixels.byteLength : width * height * 4;
  const buffer = new ArrayBuffer(8 + payloadBytes);
  const view = new DataView(buffer);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  if (pixels) {
    new Uint8Array(buffer, 8).set(pixels);
  }
  return buffer;
}

function fakeImageDataFactory(
  data: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): ImageData {
  return {
    data,
    width,
    height,
    colorSpace: "srgb",
  } as ImageData;
}

describe("decodeRenderFrame", () => {
  it("decodes little-endian dimensions and RGBA8 pixels without copying", () => {
    const rgba = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255,
    ]);
    const buffer = createRenderBuffer(2, 2, rgba);

    const frame = decodeRenderFrame(buffer, fakeImageDataFactory);

    expect(frame.width).toBe(2);
    expect(frame.height).toBe(2);
    expect(Array.from(frame.data)).toEqual(Array.from(rgba));
    expect(frame.data.buffer).toBe(buffer);
    expect(frame.data.byteOffset).toBe(8);
  });

  it("rejects non-ArrayBuffer inputs and headers shorter than 8 bytes", () => {
    expect(() => decodeRenderFrame(null, fakeImageDataFactory)).toThrowError(
      ReaderApiError,
    );
    expect(() =>
      decodeRenderFrame(new Uint8Array(16), fakeImageDataFactory),
    ).toThrowError(ReaderApiError);
    expect(() =>
      decodeRenderFrame(new ArrayBuffer(7), fakeImageDataFactory),
    ).toThrowError(ReaderApiError);
  });

  it("rejects zero dimensions and truncated RGBA payloads", () => {
    expect(() =>
      decodeRenderFrame(createRenderBuffer(0, 4), fakeImageDataFactory),
    ).toThrowError(/Truncated RGBA bitmap/);
    expect(() =>
      decodeRenderFrame(createRenderBuffer(4, 0), fakeImageDataFactory),
    ).toThrowError(/Truncated RGBA bitmap/);

    const truncated = createRenderBuffer(2, 2, new Uint8Array(15));
    expect(() =>
      decodeRenderFrame(truncated, fakeImageDataFactory),
    ).toThrowError(/Truncated RGBA bitmap/);
  });

  it("reports internal error if ImageData constructor is missing without a custom factory", () => {
    const original = globalThis.ImageData;
    // @ts-expect-error testing pure Node environment without global ImageData
    globalThis.ImageData = undefined;
    try {
      expect(() => decodeRenderFrame(createRenderBuffer(1, 1))).toThrowError(
        /ImageData constructor is unavailable/,
      );
    } finally {
      globalThis.ImageData = original;
    }
  });
});

describe("normalizeApiError & isCancelledError", () => {
  it("preserves existing ReaderApiError instances", () => {
    const err = new ReaderApiError("io", "Missing file");
    expect(normalizeApiError(err)).toBe(err);
  });

  it("maps structured IPC error objects and falls back unknown codes to internal", () => {
    const known = normalizeApiError({
      code: "password_protected",
      message: "Locked",
    });
    expect(known).toBeInstanceOf(ReaderApiError);
    expect(known.code).toBe("password_protected");
    expect(known.message).toBe("Locked");

    const unknownCode = normalizeApiError({ code: "weird_code", message: "" });
    expect(unknownCode.code).toBe("internal");
    expect(unknownCode.message).toBe("weird_code");
  });

  it("normalizes strings, Error instances, and unknown rejections", () => {
    expect(normalizeApiError("Boom").message).toBe("Boom");
    expect(normalizeApiError(new Error("Native failure")).message).toBe(
      "Native failure",
    );
    expect(normalizeApiError(42).code).toBe("internal");
  });

  it("detects cancelled errors from both ReaderApiError and raw IPC objects", () => {
    expect(
      isCancelledError(new ReaderApiError("cancelled", "Superseded")),
    ).toBe(true);
    expect(isCancelledError({ code: "cancelled", message: "Superseded" })).toBe(
      true,
    );
    expect(isCancelledError(new ReaderApiError("io", "Not found"))).toBe(false);
    expect(isCancelledError(null)).toBe(false);
  });
});
