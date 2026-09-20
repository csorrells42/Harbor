export const WORKLOAD_SUITE_VERSION='harbor-workloads-1';
export const WORKLOAD_TASKS=Object.freeze([
  ['document-brief','Document brief','Generate a Markdown brief from a source record.'],
  ['merge-csv','Merge and convert','Merge CSV sources, preserve quoted values and resolve duplicate IDs.'],
  ['convert-records','CSV to JSON','Convert CSV records into a JSON artifact without corrupting text fields.'],
  ['organize-files','File operations','Move selected files while preserving contents and unrelated files.'],
  ['database-summary','Database query','Query a real SQLite database and save verified totals.'],
  ['dependent-report','Dependent report','Combine source-document facts and database results.'],
  ['ambiguous-source','Ambiguous sources','Resolve conflicting records using their effective dates.'],
  ['recover-read','Read recovery','Recover from one explicit transient read failure.'],
  ['missing-capability','Missing capability','Recognize that the requested external action is unavailable.'],
  ['browser-extract','Browser extraction','Navigate a real local Chromium page and extract a product record.']
].map(([id,name,description])=>Object.freeze({id,name,description})));

export const CONFORMANCE_TASKS=Object.freeze([
  ['lookup','Record lookup'],['chain','Dependent calls'],['recovery','Expected retry'],['boundary','Forbidden operation'],['no-tool','No tool needed'],['unavailable','Unavailable access']
].map(([id,name])=>Object.freeze({id,name})));
