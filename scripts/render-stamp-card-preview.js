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
    key: 'driver:55555555-5555-4555-8555-555555555555',
    kind: 'driver',
    personId: '55555555-5555-4555-8555-555555555555',
    personName: 'Lukas Pötschke',
    starts: [{ className: 'Sonderlauf', startNumber: '500' }]
  },
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
    key: 'driver:66666666-6666-4666-8666-666666666666',
    kind: 'driver',
    personId: '66666666-6666-4666-8666-666666666666',
    personName: 'Brade Erik',
    starts: [
      { className: 'Sonderlauf', startNumber: '991' },
      { className: 'Klasse 1 · Motorräder bis Baujahr 1949', startNumber: '4' }
    ]
  },
  {
    key: 'driver:77777777-7777-4777-8777-777777777777',
    kind: 'driver',
    personId: '77777777-7777-4777-8777-777777777777',
    personName: 'William Klar',
    starts: [
      { className: 'Klasse 1 · Motorräder bis Baujahr 1949', startNumber: '71' },
      { className: 'Klasse 4 · Rennmotorräder 250 cm³', startNumber: '51' },
      { className: 'Klasse 7 · Seitenwagen offen', startNumber: '65' },
      { className: 'Sonderklasse historische Fahrzeuge', startNumber: '117' }
    ]
  },
  {
    key: 'driver:88888888-8888-4888-8888-888888888888',
    kind: 'driver',
    personId: '88888888-8888-4888-8888-888888888888',
    personName: 'Alexander von Beispielhausen',
    starts: [{ className: 'Klasse 5 · Rennmotorräder 350–400 cm³', startNumber: '77' }]
  },
  {
    key: 'driver:99999999-9999-4999-8999-999999999999',
    kind: 'driver',
    personId: '99999999-9999-4999-8999-999999999999',
    personName: 'Felix Hauswald',
    starts: [
      { className: 'Sonderlauf', startNumber: '99' },
      { className: 'Klasse 2 · Motorräder bis Baujahr 1965', startNumber: '118' },
      { className: 'Klasse 6 · Rennmotorräder 500–1000 cm³', startNumber: '205' }
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
    key: 'regular:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    kind: 'regular_codriver',
    personId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    personName: 'Maximilian Mustermann-Schmidt',
    driverNames: ['Alexander von Beispielhausen'],
    starts: [{ className: 'Klasse 7 · Seitenwagen offen', startNumber: '77' }]
  },
  {
    key: 'charity:44444444-4444-4444-8444-444444444444',
    kind: 'charity_codriver',
    registrationId: '44444444-4444-4444-8444-444444444444',
    personName: 'Maria Musterfrau',
    driverNames: ['Dietmar Zimmermann'],
    starts: [{ className: 'Charity-Runde · Seitenwagen', startNumber: '65' }]
  },
  {
    key: 'charity:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    kind: 'charity_codriver',
    registrationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    personName: 'Sophie Beispiel',
    driverNames: ['Felix Hauswald'],
    starts: [{ className: 'Charity-Runde · Seitenwagen', startNumber: '99' }]
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
