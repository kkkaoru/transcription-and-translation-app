export type CustomDictionaryCsvRow = { reading: string; word: string };

const escapeCsvCell = (value: string): string =>
  /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

/** UTF-8 BOM keeps Japanese headers/text intact when opened in spreadsheet apps. */
export const exportCustomDictionaryCsv = (rows: readonly CustomDictionaryCsvRow[]): string =>
  `\uFEFFよみ,単語\r\n${rows
    .map(({ reading, word }) => `${escapeCsvCell(reading)},${escapeCsvCell(word)}`)
    .join("\r\n")}${rows.length > 0 ? "\r\n" : ""}`;

const parseCsvRecords = (input: string): string[][] => {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? "";
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      if (character === "\r" && input[index + 1] === "\n") {
        index += 1;
      }
    } else {
      field += character;
    }
  }
  if (quoted) {
    throw new Error("unterminated quoted CSV field");
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
};

const isHeader = ([reading = "", word = ""]: readonly string[]): boolean => {
  const normalizedReading = reading.trim().toLowerCase();
  const normalizedWord = word.trim().toLowerCase();
  return (
    (normalizedReading === "よみ" || normalizedReading === "reading") &&
    (normalizedWord === "単語" || normalizedWord === "word")
  );
};

/** Parse two-column よみ/単語 CSV. Blank records are ignored; extra columns are invalid. */
export const importCustomDictionaryCsv = (csv: string): CustomDictionaryCsvRow[] => {
  const records = parseCsvRecords(csv.replace(/^\uFEFF/u, ""));
  if (records[0] && isHeader(records[0])) {
    records.shift();
  }
  return records
    .filter((record) => record.some((cell) => cell.trim()))
    .map((record, index) => {
      if (record.length !== 2) {
        throw new Error(`CSV row ${index + 1} must contain exactly two columns`);
      }
      const reading = (record[0] ?? "").trim();
      const word = (record[1] ?? "").trim();
      if (!reading || !word || /[\t\r\n]/u.test(reading) || /[\t\r\n]/u.test(word)) {
        throw new Error(`CSV row ${index + 1} contains an invalid reading or word`);
      }
      return { reading, word };
    });
};
