const JPEG_SOI_0 = 0xff;
const JPEG_SOI_1 = 0xd8;

type SupportedImageType = 'image/jpeg' | 'image/png' | 'image/webp';

export type ValidatedImageInfo = {
  contentType: SupportedImageType;
  width: number;
  height: number;
  byteLength: number;
};

const isPng = (buffer: Buffer): boolean =>
  buffer.length >= 24 &&
  buffer[0] === 0x89 &&
  buffer[1] === 0x50 &&
  buffer[2] === 0x4e &&
  buffer[3] === 0x47 &&
  buffer[4] === 0x0d &&
  buffer[5] === 0x0a &&
  buffer[6] === 0x1a &&
  buffer[7] === 0x0a;

const isJpeg = (buffer: Buffer): boolean => buffer.length >= 4 && buffer[0] === JPEG_SOI_0 && buffer[1] === JPEG_SOI_1;

const isWebp = (buffer: Buffer): boolean =>
  buffer.length >= 16 &&
  buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
  buffer.subarray(8, 12).toString('ascii') === 'WEBP';

const readPngDimensions = (buffer: Buffer): { width: number; height: number } | null => {
  if (!isPng(buffer) || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
};

const readJpegDimensions = (buffer: Buffer): { width: number; height: number } | null => {
  if (!isJpeg(buffer)) {
    return null;
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) {
      offset += 1;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= buffer.length) {
      return null;
    }

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) {
      return null;
    }

    if (offset + 1 >= buffer.length) {
      return null;
    }
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      return null;
    }

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isStartOfFrame) {
      if (segmentLength < 7) {
        return null;
      }
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5)
      };
    }

    offset += segmentLength;
  }

  return null;
};

const readWebpDimensions = (buffer: Buffer): { width: number; height: number } | null => {
  if (!isWebp(buffer)) {
    return null;
  }

  const chunkHeader = buffer.subarray(12, 16).toString('ascii');
  if (chunkHeader === 'VP8X') {
    if (buffer.length < 30) {
      return null;
    }
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    };
  }

  if (chunkHeader === 'VP8 ') {
    if (buffer.length < 30) {
      return null;
    }
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }

  if (chunkHeader === 'VP8L') {
    if (buffer.length < 25 || buffer[20] !== 0x2f) {
      return null;
    }
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }

  return null;
};

export const validateImageBuffer = (
  buffer: Buffer,
  maxFileSizeBytes: number,
  maxDimensionPixels: number
): ValidatedImageInfo | null => {
  if (buffer.length === 0 || buffer.length > maxFileSizeBytes) {
    return null;
  }

  if (isPng(buffer)) {
    const dimensions = readPngDimensions(buffer);
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
      return null;
    }
    if (dimensions.width > maxDimensionPixels || dimensions.height > maxDimensionPixels) {
      return null;
    }
    return {
      contentType: 'image/png',
      width: dimensions.width,
      height: dimensions.height,
      byteLength: buffer.length
    };
  }

  if (isJpeg(buffer)) {
    const dimensions = readJpegDimensions(buffer);
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
      return null;
    }
    if (dimensions.width > maxDimensionPixels || dimensions.height > maxDimensionPixels) {
      return null;
    }
    return {
      contentType: 'image/jpeg',
      width: dimensions.width,
      height: dimensions.height,
      byteLength: buffer.length
    };
  }

  if (isWebp(buffer)) {
    const dimensions = readWebpDimensions(buffer);
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
      return null;
    }
    if (dimensions.width > maxDimensionPixels || dimensions.height > maxDimensionPixels) {
      return null;
    }
    return {
      contentType: 'image/webp',
      width: dimensions.width,
      height: dimensions.height,
      byteLength: buffer.length
    };
  }

  return null;
};
