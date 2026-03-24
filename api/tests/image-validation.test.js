const assert = require('node:assert/strict');

const { validateImageBuffer } = require('../dist/domain/imageValidation.js');

const png1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63606060000000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex'
);

const jpeg1x1 = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffc00011080001000103012200021101031101ffda000c03010002110311003f00' +
    '00ffd9',
  'hex'
);

const webp1x1 = Buffer.from(
  '5249464615000000574542505650384c0a0000002f00000010001000000710',
  'hex'
);

assert.equal(validateImageBuffer(Buffer.from('not-an-image'), 8 * 1024 * 1024, 6000), null);

assert.deepEqual(validateImageBuffer(png1x1, 8 * 1024 * 1024, 6000), {
  contentType: 'image/png',
  width: 1,
  height: 1,
  byteLength: png1x1.length
});

assert.deepEqual(validateImageBuffer(jpeg1x1, 8 * 1024 * 1024, 6000), {
  contentType: 'image/jpeg',
  width: 1,
  height: 1,
  byteLength: jpeg1x1.length
});

assert.deepEqual(validateImageBuffer(webp1x1, 8 * 1024 * 1024, 6000), {
  contentType: 'image/webp',
  width: 1,
  height: 1,
  byteLength: webp1x1.length
});

assert.equal(validateImageBuffer(png1x1, png1x1.length - 1, 6000), null);
assert.equal(validateImageBuffer(png1x1, 8 * 1024 * 1024, 0), null);

console.log('image-validation.test.js: ok');
