const assert = require('node:assert/strict');
const sharp = require('sharp');
const { RekognitionClient } = require('@aws-sdk/client-rekognition');
const { detectVehicles, nearestContainingVehicleIndex } = require('../dist/racepic/rekognition');
const { renderWatermarkedPreview } = require('../dist/racepic/imageProcessing');

async function main() {
  const originalSend = RekognitionClient.prototype.send;
  RekognitionClient.prototype.send = async () => ({ Labels: [{ Name: 'Car', Confidence: 92, Instances: [] }] });
  try {
    const fallback = await detectVehicles(Buffer.from([0xff, 0xd8, 0xff]));
    assert.equal(fallback.length, 1, 'a vehicle label without instances must still enter matching');
    assert.deepEqual(fallback[0].bbox, { left: 0, top: 0, width: 1, height: 1 });
  } finally { RekognitionClient.prototype.send = originalSend; }

  const fullFrame = { left: 0, top: 0, width: 1, height: 1 };
  const car = { left: 0.3, top: 0.25, width: 0.35, height: 0.3 };
  const number = { left: 0.42, top: 0.34, width: 0.05, height: 0.04 };
  assert.equal(nearestContainingVehicleIndex(number, [fullFrame, car]), 1, 'OCR must prefer the specific car over a fallback box');
  assert.equal(nearestContainingVehicleIndex({ ...number, left: 0.85 }, [car]), -1, 'unrelated OCR must remain unassigned');

  const source = await sharp({ create: { width: 800, height: 500, channels: 3, background: '#36719a' } }).webp().toBuffer();
  const marked = await renderWatermarkedPreview(source);
  const metadata = await sharp(marked).metadata();
  assert.equal(metadata.width, 800);
  assert.equal(metadata.height, 500);
  assert.equal(metadata.format, 'webp');
  const difference = await sharp(marked).composite([{ input: source, blend: 'difference' }]).stats();
  assert(difference.channels.some((channel) => channel.mean > 3), 'paid preview must visibly differ from the clean original');
  process.stdout.write('RacePic OCR assignment and paid preview regression checks passed.\n');
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
