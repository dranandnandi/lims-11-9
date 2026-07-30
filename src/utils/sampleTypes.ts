/**
 * Values of the Postgres `sample_type` enum.
 *
 * Columns typed as this enum (e.g. test_groups.sample_type) reject anything not
 * listed here, so dropdowns and AI-derived values must come from this list.
 * Keep in sync with the DB — mirrored in supabase/functions/ai-report-import.
 */
export const SAMPLE_TYPES = [
  'EDTA Blood',
  'Whole Blood',
  'Capillary Blood',
  'Serum',
  'Plasma',
  'Fluoride Plasma',
  'Citrated Plasma',
  'Urine',
  'Stool',
  'CSF',
  'Sputum',
  'Swab',
  'Tissue',
  'X-Ray',
  'CT Scan',
  'MRI',
  'Ultrasound',
  'Mammography',
  'PET Scan',
  'Fluoroscopy',
  'Angiography',
  'DEXA Scan',
  'ECG',
  'EEG',
  'Endoscopy',
  'Colonoscopy',
  'Bronchoscopy',
  'No Sample Required',
  'Other',
] as const;

export type SampleType = (typeof SAMPLE_TYPES)[number];
