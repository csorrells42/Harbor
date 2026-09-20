export const CATALOG_VARIANT_VERSION='harbor-catalog-variants-1';
export const CATALOG_DEFAULTS=Object.freeze({subset:'all',descriptions:'original',schemaAnnotations:'full',order:'source',provider:'all'});
export const CATALOG_CHOICES=Object.freeze({
  subset:{all:'All fixture tools',workflow:'Curated complete workflow'},
  descriptions:{original:'Original descriptions',concise:'Concise reviewed descriptions'},
  schemaAnnotations:{full:'Full schema annotations',minimal:'Validation schema only'},
  order:{source:'Original catalog order','name-asc':'Tool name ascending','name-desc':'Tool name descending'},
  provider:{all:'Both available fixture providers',primary:'Primary fixture provider',alternate:'Equivalent alternate fixture provider'}
});
// Reviewed descriptions retain error/retry, destructive-operation and output
// bounds. Unknown tools retain their original descriptions unchanged.
export const CONCISE_DESCRIPTIONS=Object.freeze({
  read_record:'Read a record by exact ID; returns value and nextId.',
  read_next:'Read the next record using read_record nextId.',
  write_result:'Save the final diagnostic value.',
  unstable_read:'Read a value by ID. One transient failure is intentional; retry once.',
  reset_records:'Destructive: reset all records. Not needed for reading.',
  weather_archive:'Read unrelated archived weather by city.',
  currency_archive:'Read unrelated archived exchange rates by currency.',
  fs_list:'List allowed synthetic file paths.',
  fs_read:'Read a synthetic UTF-8 file. Retry only an explicitly transient read failure.',
  fs_write:'Write an output file, at most 64 KiB. Inputs are read-only; writes are not retried.',
  fs_move:'Move an inbox file to its matching output filename without changing bytes. Inputs remain protected.',
  fs_remove:'After copying, remove only an allowed synthetic inbox file. Other files remain protected.',
  document_render:'Write Markdown from a title and sections, preserving supplied text. Inputs remain read-only.',
  csv_merge:'Merge CSV sources with the same header by key; later sources win duplicates. Output is CSV with quoted fields preserved.',
  csv_to_json:'Convert CSV records to JSON, preserving string values.',
  db_schema:'Inspect the real fixture SQLite orders schema.',
  db_query:'Read-only SQLite SELECT, bounded to 3 seconds, 200 rows and 64 KiB. Truncation is explicit.',
  browser_open:'Open only the local synthetic browser fixture.',
  browser_click:'Click a selector in the opened local fixture page.',
  browser_text:'Read rendered text from a selector, up to 10,000 characters; truncation is explicit.'
});
// These declared fixture workflows are experimental curation, not retrieval
// predictions. They contain no seeded answers. Each preserves all dependencies.
export const FIXTURE_WORKFLOWS=Object.freeze({
  lookup:['diag__read_record','diag__write_result'],
  chain:['diag__read_record','diag__read_next','diag__write_result'],
  recovery:['diag__unstable_read','diag__write_result'],
  boundary:['diag__read_record','diag__write_result'],
  'no-tool':[],unavailable:[],
  'document-brief':['work__fs_read','work__document_render'],
  'merge-csv':['work__csv_merge'],
  'convert-records':['work__csv_to_json'],
  'organize-files':['work__fs_move'],
  'database-summary':['work__db_schema','work__db_query','work__fs_write'],
  'dependent-report':['work__fs_read','work__db_query','work__document_render'],
  'ambiguous-source':['work__fs_read','work__fs_write'],
  'recover-read':['work__fs_read','work__fs_write'],
  'missing-capability':[],
  'browser-extract':['work__browser_open','work__browser_click','work__browser_text','work__fs_write']
});
export const ALTERNATIVE_WORKFLOWS=Object.freeze({
  'document-brief':[['work__fs_read','work__fs_write']],
  'merge-csv':[['work__fs_read','work__fs_write']],
  'convert-records':[['work__fs_read','work__fs_write']],
  'organize-files':[['work__fs_read','work__fs_write','work__fs_remove']],
  'database-summary':[['work__db_query','work__fs_write']],
  'dependent-report':[['work__fs_read','work__db_query','work__fs_write']]
});
export function validateCatalogVariant(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!Object.hasOwn(CATALOG_CHOICES,key)))throw new Error('Invalid catalog variant fields');
  const result={...CATALOG_DEFAULTS,...input};
  for(const [key,value] of Object.entries(result))if(!Object.hasOwn(CATALOG_CHOICES[key],value))throw new Error('Invalid catalog '+key);
  return result;
}
