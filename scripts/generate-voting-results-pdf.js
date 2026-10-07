const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

const outputPath = path.resolve('Fahrervoting-Ergebnis-2026.pdf');
const logoPath = path.resolve('infra/assets/stamp-cards/msc-logo-clean-transparent.png');
const regularFont = path.resolve('infra/assets/stamp-cards/fonts/barlow-500.ttf');
const boldFont = path.resolve('infra/assets/stamp-cards/fonts/barlow-700.ttf');

const winners = [
  ['Klasse 1', 'Motorräder bis Bj. 1949', 'Michael Berndt'],
  ['Klasse 2', 'Rennmotorräder 50–80 cm³ bis Bj. 1995', 'Uwe Wetzko'],
  ['Klasse 3', 'Rennmotorräder 125–175 cm³ bis Bj. 1995', 'Knut Oelmann'],
  ['Klasse 4', 'Rennmotorräder 250 cm³ bis Bj. 1995', 'Marko Zimmermann'],
  ['Klasse 5', 'Rennmotorräder 350–400 cm³ bis Bj. 1995', 'Mario Gebauer'],
  ['Klasse 6', 'Rennmotorräder 500–1000 cm³ bis Bj. 1995', 'Tim Hartmann'],
  ['Klasse 7', 'Seitenwagen offen', 'Tom van Beek'],
  ['Klasse 8', 'Rennmotorräder offen für Aktive und Ehemalige', 'Nico Müller'],
  ['Klasse 9', 'Formelwagen bis Baujahr 1995', 'Olaf Havlat'],
  ['Klasse 10', 'Tourenwagen geschlossen bis Bj. 1995', 'Michael Stadelmann'],
  ['Klasse 12', 'Trabant geschlossen', 'Lutz Ernstberger'],
  ['Sonderlauf', '', 'Calvin Eisele']
];

const doc = new PDFDocument({ size: 'A4', margin: 36, info: {
  Title: 'Ergebnis Fahrervoting 2026',
  Author: 'MSC Oberlausitzer Dreiländereck e. V.'
} });
doc.pipe(fs.createWriteStream(outputPath));
doc.registerFont('Regular', regularFont);
doc.registerFont('Bold', boldFont);

const pageWidth = doc.page.width;
const contentWidth = pageWidth - 72;
doc.rect(0, 0, pageWidth, 118).fill('#101820');
doc.image(logoPath, 38, 19, { fit: [72, 72] });
doc.font('Bold').fontSize(24).fillColor('#ffffff').text('ERGEBNIS FAHRERVOTING', 126, 29, { width: 420 });
doc.font('Regular').fontSize(12).fillColor('#d7dde2').text('12. Oberlausitzer Dreieck · 13. September 2026', 127, 65, { width: 420 });
doc.rect(0, 112, pageWidth, 6).fill('#e3b341');

let y = 132;
for (let index = 0; index < winners.length; index += 1) {
  const [className, description, winner] = winners[index];
  const fill = index % 2 === 0 ? '#f4f6f7' : '#ffffff';
  doc.roundedRect(36, y, contentWidth, 49, 5).fill(fill);
  doc.circle(55, y + 24.5, 11).fill('#e3b341');
  doc.font('Bold').fontSize(10).fillColor('#101820').text('1', 51.5, y + 17.5, { width: 7, align: 'center' });
  doc.font('Bold').fontSize(11).fillColor('#44505a').text(className.toUpperCase(), 76, y + 8, { width: 270, lineBreak: false });
  if (description) {
    doc.font('Regular').fontSize(8.5).fillColor('#68737d').text(description, 76, y + 25, { width: 285, lineBreak: false });
  }
  doc.font('Bold').fontSize(15).fillColor('#101820').text(winner, 350, y + 15, { width: 195, align: 'right', lineBreak: false });
  y += 52;
}

doc.font('Regular').fontSize(8).fillColor('#68737d').text(
  'MSC Oberlausitzer Dreiländereck e. V.',
  36,
  812,
  { width: contentWidth, align: 'center', lineBreak: false }
);

doc.end();
doc.on('end', () => console.log(outputPath));
