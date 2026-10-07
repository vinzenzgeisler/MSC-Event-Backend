const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit/js/pdfkit.standalone');

const POINTS_PER_MM = 72 / 25.4;
const mm = (value) => value * POINTS_PER_MM;

const PAGE_WIDTH = mm(210);
const PAGE_HEIGHT = mm(297);
const CARD_WIDTH = mm(86);
const CARD_HEIGHT = mm(55);
const PAGE_LEFT = mm(19);
const PAGE_TOP = mm(11);
const VISIBLE_INSET = mm(3);
const CONTENT_SCALE = 1.04;
const scaledMm = (value) => mm(value) * CONTENT_SCALE;
const ACCENT_COLOR = '#153A81';

const repositoryRoot = path.resolve(__dirname, '..');
const assetRoot = path.join(repositoryRoot, 'infra', 'assets', 'stamp-cards');
const personName = process.argv[2] || 'Max Hinke';
const role = process.argv[3] || 'Drohnenpilot';
const year = process.argv[4] || '2026';
const safeFilePart = (value) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');
const outputPath = process.argv[5]
  ? path.resolve(process.argv[5])
  : path.join(repositoryRoot, `${safeFilePart(role)}-${safeFilePart(personName)}-${year}.pdf`);

const logoBuffer = fs.readFileSync(path.join(assetRoot, 'msc-logo-clean-transparent.png'));
const displayFont = fs.readFileSync(path.join(assetRoot, 'fonts', 'oswald-700.ttf'));
const textFont = fs.readFileSync(path.join(assetRoot, 'fonts', 'barlow-500.ttf'));
const boldFont = fs.readFileSync(path.join(assetRoot, 'fonts', 'barlow-700.ttf'));

const fitText = (doc, text, maxWidth, initial, minimum) => {
  let size = initial;
  while (size > minimum && doc.fontSize(size).widthOfString(text) > maxWidth) size -= 0.5;
  return size;
};

const drawCornerLogo = (doc, image, right, top) => {
  const size = scaledMm(11.5);
  const sourceSize = 1254;
  const visibleTop = 47;
  const visibleRight = 1127;
  const scale = size / sourceSize;
  doc.image(image, right - visibleRight * scale, top - visibleTop * scale, {
    width: size,
    height: size
  });
};

const doc = new PDFDocument({
  size: [PAGE_WIDTH, PAGE_HEIGHT],
  margin: 0,
  autoFirstPage: true,
  info: {
    Title: `${role} ${personName} ${year}`,
    Subject: 'Roscheba E113 · Druck bei 100 % / Tatsächliche Größe'
  }
});

doc._root.data.ViewerPreferences = doc.ref({ PrintScaling: 'None' });
const pageBox = [0, 0, PAGE_WIDTH, PAGE_HEIGHT];
doc.page.dictionary.data.CropBox = pageBox;
doc.page.dictionary.data.TrimBox = pageBox;
doc.fillColor('#FFFFFF').rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill();

doc.registerFont('DroneDisplay', displayFont);
doc.registerFont('DroneText', textFont);
doc.registerFont('DroneBold', boldFont);

const logo = doc.openImage(`data:image/png;base64,${logoBuffer.toString('base64')}`);
const x = PAGE_LEFT;
const y = PAGE_TOP;
const visualTop = y + VISIBLE_INSET;
const visualRight = x + CARD_WIDTH - VISIBLE_INSET;
const visualBottom = y + CARD_HEIGHT - VISIBLE_INSET;
const stripeX = x + VISIBLE_INSET;
const contentLeft = stripeX + scaledMm(3.1);
const logoVisibleWidth = scaledMm(9.2);
const logoLeft = visualRight - logoVisibleWidth;

doc.fillColor('#FFFFFF').rect(x, y, CARD_WIDTH, CARD_HEIGHT).fill();
doc.fillColor(ACCENT_COLOR).rect(
  stripeX,
  visualTop,
  2.2 * CONTENT_SCALE,
  visualBottom - visualTop + 0.4
).fill();

drawCornerLogo(doc, logo, visualRight, visualTop);

const displayName = personName.toLocaleUpperCase('de-DE');
const nameWidth = logoLeft - contentLeft - scaledMm(2);
const nameSize = fitText(doc.font('DroneDisplay'), displayName, nameWidth, 16.5 * CONTENT_SCALE, 9.5 * CONTENT_SCALE);
doc.fillColor('#0F172A').font('DroneDisplay').fontSize(nameSize).text(
  displayName,
  contentLeft,
  visualTop - scaledMm(1),
  { width: nameWidth, lineBreak: false }
);

const dividerY = visualTop + scaledMm(7.1);
doc.lineWidth(0.55).strokeColor('#D9DEE5').moveTo(contentLeft, dividerY).lineTo(logoLeft - scaledMm(1.5), dividerY).stroke();

const metaHeight = scaledMm(8);
const yearWidth = scaledMm(17);
const metaGap = scaledMm(2);
const metaY = visualTop + scaledMm(23);
const yearX = visualRight - yearWidth;
const roleX = contentLeft;
const roleWidth = yearX - metaGap - roleX;

doc.fillColor(ACCENT_COLOR).rect(roleX, metaY, roleWidth, metaHeight).fill();
const displayRole = role.toLocaleUpperCase('de-DE');
const roleSize = fitText(doc.font('DroneBold'), displayRole, roleWidth - scaledMm(2), 10.5 * CONTENT_SCALE, 6.5 * CONTENT_SCALE);
doc.fillColor('#FFFFFF').font('DroneBold').fontSize(roleSize);
const roleHeight = doc.heightOfString(displayRole, { width: roleWidth, lineBreak: false });
doc.text(displayRole, roleX, metaY + (metaHeight - roleHeight) / 2 - 0.25, {
  width: roleWidth,
  align: 'center',
  characterSpacing: 0.45,
  lineBreak: false
});

doc.lineWidth(0.85).strokeColor(ACCENT_COLOR).rect(yearX, metaY, yearWidth, metaHeight).stroke();
doc.fillColor(ACCENT_COLOR).font('DroneDisplay').fontSize(12 * CONTENT_SCALE);
const yearHeight = doc.heightOfString(year, { width: yearWidth, lineBreak: false });
doc.text(year, yearX, metaY + (metaHeight - yearHeight) / 2 - 0.3, {
  width: yearWidth,
  align: 'center',
  lineBreak: false
});

doc.pipe(fs.createWriteStream(outputPath));
doc.end();

doc.on('end', () => console.log(outputPath));
