'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { renderStampCardPdf } = require('../api/dist/routes/stampCards');

process.env.MAIL_PUBLIC_BASE_URL = 'https://event.msc-oberlausitz.de';

const repositoryRoot = path.resolve(__dirname, '..');
const assetRoot = path.join(repositoryRoot, 'infra', 'assets', 'stamp-cards');
const outputPath = path.join(repositoryRoot, 'Fahrerkarte-Tim-Alexander-Adler-Klasse-6-Startnummer-8-2026.pdf');

const assets = {
  cornerLogo: fs.readFileSync(path.join(assetRoot, 'msc-logo-clean-transparent.png')),
  displayFont: fs.readFileSync(path.join(assetRoot, 'fonts', 'oswald-700.ttf')),
  textFont: fs.readFileSync(path.join(assetRoot, 'fonts', 'barlow-500.ttf')),
  boldFont: fs.readFileSync(path.join(assetRoot, 'fonts', 'barlow-700.ttf'))
};

const card = {
  key: 'driver:tim-alexander-adler-special-class-6-number-8',
  kind: 'driver',
  // Intentionally use the person ID belonging to the existing Klasse 6 / #8
  // card so the generated QR code is exactly the requested #8 inspection QR.
  personId: 'b47ad3ae-02fb-4b75-bc2f-5615d90992fe',
  personName: 'Tim-Alexander Adler',
  starts: [{
    className: 'Klasse 6 · Rennmotorräder 500–1000 cm³ bis Bj. 1995',
    startNumber: '8'
  }]
};

renderStampCardPdf({
  cards: [card],
  eventId: 'e5dc0ac8-3a6f-4ee3-9a1c-45e2057d2a28',
  startSlot: 1,
  year: '2026',
  accentColor: '#153A81',
  assets
}).then((pdf) => {
  fs.writeFileSync(outputPath, pdf);
  console.log(outputPath);
});
