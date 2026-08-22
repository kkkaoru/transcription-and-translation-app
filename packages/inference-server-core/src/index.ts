export {
  PARAPPER_MAX_FRAME_BYTES,
  PARAPPER_SAMPLE_RATE,
  pcm16FromWav,
  pcm16ToWav,
  splitParapperFrames,
} from "./audio.js";
export type { GatewayConfig, TextModelRoute } from "./config.js";
export { validateGatewayConfig } from "./config.js";
export type { GatewayDependencies } from "./http.js";
export {
  correlationHeadersFromRequest,
  createGatewayFetchHandler,
  GatewayError,
  isValidZenzDelimitedPrompt,
  MAX_AUDIO_BYTES,
  MAX_JSON_BYTES,
  SerialGate,
} from "./http.js";
export type {
  ActiveUserLexicon,
  UserLexiconCompactSnapshot,
  UserLexiconConverter,
  UserLexiconConvertInput,
  UserLexiconConvertResult,
  UserLexiconDocument,
  UserLexiconEntry,
  UserLexiconExport,
  UserLexiconMeta,
  UserLexiconMutation,
  UserLexiconReplaceResult,
  UserLexiconRpc,
  UserLexiconSearchPage,
  UserLexiconSearchQuery,
  UserLexiconSnapshot,
  UserLexiconUpsertResult,
} from "./user-lexicon.js";
export {
  applyStoredLexiconReadings,
  clampUserLexiconLimit,
  convertWithStoredUserLexicon,
  createMemoryUserLexicon,
  createUserLexiconEntryId,
  encodeUserLexiconCompact,
  pageUserLexiconEntries,
  parseUserLexiconCsv,
  parseUserLexiconDocument,
  parseUserLexiconImportBody,
  parseUserLexiconSearchQuery,
  parseUserLexiconTsv,
  storedLexiconConverter,
  USER_LEXICON_BINDING,
  USER_LEXICON_CONVERT_PATH,
  USER_LEXICON_DO_NAME,
  USER_LEXICON_ENTRIES_PATH,
  USER_LEXICON_HTTP_PATH,
  USER_LEXICON_IMPORT_PATH,
  USER_LEXICON_INITIAL_REVISION,
  USER_LEXICON_LIST_DEFAULT_LIMIT,
  USER_LEXICON_LIST_MAX_LIMIT,
  USER_LEXICON_MAX_ENTRIES,
  USER_LEXICON_MAX_ID_CHARS,
  USER_LEXICON_MAX_IMPORT_BYTES,
  USER_LEXICON_MAX_READING_CHARS,
  USER_LEXICON_MAX_WORD_CHARS,
  USER_LEXICON_MIN_READING_CHARS,
  USER_LEXICON_VERSION,
  UserLexiconError,
  userLexiconEntriesToTsv,
  userLexiconEntryFromUnknown,
  validateUserLexiconEntries,
} from "./user-lexicon.js";
export type {
  UserLexiconCatalog,
  UserLexiconDictionary,
  UserLexiconImportJob,
} from "./user-lexicon-catalog.js";
export {
  entryMatchesPrefixSearch,
  pagePrefixSearch,
  USER_LEXICON_DEFAULT_DICTIONARY_ID,
  USER_LEXICON_DICTIONARIES_PATH,
} from "./user-lexicon-catalog.js";
export type { UserLexiconHttpDependencies } from "./user-lexicon-http.js";
export { handleUserLexiconHttp } from "./user-lexicon-http.js";
