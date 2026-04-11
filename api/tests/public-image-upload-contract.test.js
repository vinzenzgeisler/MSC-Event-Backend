const assert = require('node:assert/strict');

const {
  validateCreatePublicEntryInput,
  validateVehicleImageUploadFinalizeInput
} = require('../dist/routes/publicRegistration.js');

const basePayload = {
  eventId: '15ed4cb5-44bb-4e34-926e-81e3cd206f16',
  driver: {
    email: 'max@example.com',
    firstName: 'Max',
    lastName: 'Muster',
    birthdate: '1990-01-01',
    country: 'DE',
    street: 'Musterweg 1',
    zip: '02763',
    city: 'Zittau',
    phone: '+49 123456789',
    emergencyContactName: 'Erika Muster',
    emergencyContactPhone: '+49 987654321',
    motorsportHistory: 'Seit 2010 aktiv'
  },
  consent: {
    termsAccepted: true,
    privacyAccepted: true,
    waiverAccepted: true,
    mediaAccepted: false,
    clubInfoAccepted: false,
    consentVersion: '2026-03',
    locale: 'de',
    consentSource: 'public_form',
    consentCapturedAt: '2026-03-21T10:00:00.000Z'
  },
  classId: '11111111-1111-1111-1111-111111111111',
  vehicle: {
    make: 'NSU',
    model: 'Fox',
    year: 1951,
    displacementCcm: 125,
    cylinders: 1,
    vehicleHistory: 'Historie'
  },
  startNumber: '91'
};

assert.doesNotThrow(() =>
  validateCreatePublicEntryInput({
    ...basePayload,
    vehicle: {
      ...basePayload.vehicle,
      imageUploadId: '22222222-2222-2222-2222-222222222222',
      imageUploadToken: '33333333-3333-3333-3333-333333333333'
    }
  })
);

assert.throws(
  () =>
    validateCreatePublicEntryInput({
      ...basePayload,
      vehicle: {
        ...basePayload.vehicle,
        imageUploadId: '22222222-2222-2222-2222-222222222222'
      }
    }),
  /imageUploadId and imageUploadToken must be provided together/
);

assert.doesNotThrow(() =>
  validateVehicleImageUploadFinalizeInput({
    uploadId: '22222222-2222-2222-2222-222222222222',
    uploadToken: '33333333-3333-3333-3333-333333333333'
  })
);

console.log('public-image-upload-contract.test.js: ok');
