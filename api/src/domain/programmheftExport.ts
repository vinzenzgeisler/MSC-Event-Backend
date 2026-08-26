export type ProgrammheftRow = {
  startNumber: string | null;
  className: string;
  driverFirstName: string;
  driverLastName: string;
  driverZip: string | null;
  driverCity: string | null;
  driverCountry: string | null;
  codriverFirstName: string | null;
  codriverLastName: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  vehicleDisplacement: number | null;
};

export type ProgrammheftCellValue = string | number;

export const NORMAL_CLASS_HEADERS = [
  'Start-Nr.',
  'Vorname',
  'Nachname',
  'PLZ',
  'Ort',
  'Fahrzeug',
  'Modell',
  'Baujahr',
  'Hubraum',
  'Land'
] as const;

export const CLASS_SEVEN_HEADERS = [
  'Start-Nr.',
  'Fahrer',
  '',
  'Beifahr.',
  '',
  'PLZ',
  'Ort',
  'Fahrzeug',
  'Modell',
  'Baujahr',
  'Hubr.',
  'Land'
] as const;

export const OVERALL_HEADERS = [
  'Startnummer',
  'Fahrer Vorname',
  'Fahrer Nachname',
  'Fahrer PLZ',
  'Fahrer Ort',
  'Fabrikat',
  'Modell',
  'Baujahr',
  'Hubraum',
  'Fahrer Nationalität',
  'Klasse'
] as const;

const collapseWhitespace = (value: string): string => value.trim().replace(/\s+/g, ' ');
const LOCATION_ABBREVIATIONS = new Set(['OT']);

const titleCaseWord = (word: string, preserveAbbreviations: boolean): string =>
  word
    .split(/([-'])/)
    .map((part) => {
      if (part === '-' || part === "'") return part;
      if (preserveAbbreviations && LOCATION_ABBREVIATIONS.has(part)) return part;
      const lower = part.toLocaleLowerCase('de-DE');
      return `${lower.charAt(0).toLocaleUpperCase('de-DE')}${lower.slice(1)}`;
    })
    .join('');

export const normalizeProgrammheftName = (value: string | null | undefined): string =>
  collapseWhitespace(value ?? '')
    .split(' ')
    .map((word) => titleCaseWord(word, false))
    .join(' ');

export const normalizeProgrammheftCity = (value: string | null | undefined): string =>
  collapseWhitespace(value ?? '')
    .split(' ')
    .map((word) => titleCaseWord(word, true))
    .join(' ');

export const isClassSeven = (className: string): boolean => /^\s*Klasse\s*7\b/i.test(className);

export const getClassHeaders = (className: string): readonly string[] =>
  isClassSeven(className) ? CLASS_SEVEN_HEADERS : NORMAL_CLASS_HEADERS;

export const getClassRowValues = (row: ProgrammheftRow): ProgrammheftCellValue[] => {
  const commonTail: ProgrammheftCellValue[] = [
    row.driverZip ?? '',
    normalizeProgrammheftCity(row.driverCity),
    row.vehicleMake ?? '',
    row.vehicleModel ?? '',
    row.vehicleYear ?? '',
    row.vehicleDisplacement ?? '',
    row.driverCountry ?? ''
  ];

  return isClassSeven(row.className)
    ? [
        row.startNumber ?? '',
        normalizeProgrammheftName(row.driverFirstName),
        normalizeProgrammheftName(row.driverLastName),
        normalizeProgrammheftName(row.codriverFirstName),
        normalizeProgrammheftName(row.codriverLastName),
        ...commonTail
      ]
    : [
        row.startNumber ?? '',
        normalizeProgrammheftName(row.driverFirstName),
        normalizeProgrammheftName(row.driverLastName),
        ...commonTail
      ];
};

export const getOverallRowValues = (row: ProgrammheftRow): ProgrammheftCellValue[] => [
  row.startNumber ?? '',
  normalizeProgrammheftName(row.driverFirstName),
  normalizeProgrammheftName(row.driverLastName),
  row.driverZip ?? '',
  normalizeProgrammheftCity(row.driverCity),
  row.vehicleMake ?? '',
  row.vehicleModel ?? '',
  row.vehicleYear ?? '',
  row.vehicleDisplacement ?? '',
  row.driverCountry ?? '',
  row.className
];
