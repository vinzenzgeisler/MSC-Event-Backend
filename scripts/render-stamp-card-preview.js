const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderStampCardPdf } = require('../api/dist/routes/stampCards');

process.env.MAIL_PUBLIC_BASE_URL = 'https://example.test';

const repositoryRoot = path.resolve(__dirname, '..');
const assetRoot = path.join(repositoryRoot, 'infra/assets/stamp-cards');
const assets = {
  cornerLogo: fs.readFileSync(path.join(assetRoot, 'msc-logo-clean-transparent.png')),
  displayFont: fs.readFileSync(path.join(assetRoot, 'fonts/oswald-700.ttf')),
  textFont: fs.readFileSync(path.join(assetRoot, 'fonts/barlow-500.ttf')),
  boldFont: fs.readFileSync(path.join(assetRoot, 'fonts/barlow-700.ttf'))
};

const cards = [
  {
    key: 'driver:22222222-2222-4222-8222-222222222222',
    kind: 'driver',
    personId: '22222222-2222-4222-8222-222222222222',
    personName: 'Jürgen Weiß-Zimmermann',
    starts: [
      { className: 'Klasse 1 · Motorräder bis Baujahr 1949', startNumber: '4' },
      { className: 'Klasse 6 · Rennmotorräder 500–1000 cm³ bis Baujahr 1995', startNumber: '410' },
      { className: 'Klasse 7 · Seitenwagen offen', startNumber: '65' }
    ]
  },
  {
    key: 'regular:33333333-3333-4333-8333-333333333333',
    kind: 'regular_codriver',
    personId: '33333333-3333-4333-8333-333333333333',
    personName: 'Anna Beispiel',
    driverNames: ['Dietmar Zimmermann'],
    starts: [{ className: 'Klasse 7 · Seitenwagen offen', startNumber: '65' }]
  },
  {
    key: 'charity:44444444-4444-4444-8444-444444444444',
    kind: 'charity_codriver',
    registrationId: '44444444-4444-4444-8444-444444444444',
    personName: 'Maria Musterfrau',
    driverNames: ['Dietmar Zimmermann'],
    starts: [{ className: 'Charity-Runde · Seitenwagen', startNumber: '65' }]
  }
];

const outputPath = path.join(os.tmpdir(), 'fahrerausweis-design-vorschau.pdf');

renderStampCardPdf({
  cards,
  eventId: '11111111-1111-4111-8111-111111111111',
  startSlot: 1,
  year: '2026',
  accentColor: '#153A81',
  assets
}).then((pdf) => {
  fs.writeFileSync(outputPath, pdf);
  console.log(outputPath);
});
