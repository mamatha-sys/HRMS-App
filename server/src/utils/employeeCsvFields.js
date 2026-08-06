// The full set of employee fields usable for CSV import/export — every practical, text/number/
// date column on `employees` (excludes photo/documents: binary/structured data that doesn't fit
// a CSV cell). `team` is exposed by NAME (not the internal team_id) since a CSV author works
// with names, not database ids — resolved against the row's own `department` on import.
export const CSV_FIELDS = [
  { key: 'employee_code', label: 'Employee ID', sample: '(auto if blank)' },
  { key: 'name', label: 'Full name', sample: 'Asha Rao' },
  { key: 'email', label: 'Email', sample: 'asha.rao@example.com' },
  { key: 'phone', label: 'Phone', sample: '9876543210' },
  { key: 'date_of_birth', label: 'Date of birth', sample: '1995-06-14' },
  { key: 'department', label: 'Department', sample: 'Engineering' },
  { key: 'branch', label: 'Branch', sample: 'Bengaluru' },
  { key: 'team', label: 'Team', sample: '' },
  { key: 'designation', label: 'Role / Designation', sample: 'Software Engineer' },
  { key: 'date_of_joining', label: 'Date of joining', sample: '2026-08-01' },
  { key: 'reporting_manager', label: 'Reporting manager', sample: '' },
  { key: 'status', label: 'Status (Active/On Probation/Exited)', sample: 'Active' },
  { key: 'shift', label: 'Shift', sample: 'General (9:00 AM – 6:00 PM)' },
  { key: 'employment_type', label: 'Employment Type (Fresher/Experienced)', sample: 'Fresher' },
  { key: 'pay_type', label: 'Pay Type', sample: '' },
  { key: 'ctc', label: 'CTC (annual, ₹)', sample: '' },
  { key: 'address_type', label: 'Address Type (Current/Permanent)', sample: '' },
  { key: 'address_line1', label: 'Address Line 1', sample: '' },
  { key: 'address_line2', label: 'Address Line 2', sample: '' },
  { key: 'address_building_no', label: 'Building No.', sample: '' },
  { key: 'address_door_no', label: 'Door No.', sample: '' },
  { key: 'address_floor_no', label: 'Floor No.', sample: '' },
  { key: 'address_landmark', label: 'Landmark', sample: '' },
  { key: 'address_city', label: 'City / Town', sample: '' },
  { key: 'address_district', label: 'District', sample: '' },
  { key: 'address_state', label: 'State / Province', sample: '' },
  { key: 'address_country', label: 'Country', sample: '' },
  { key: 'address_pincode', label: 'Postal Code / ZIP Code', sample: '' },
  { key: 'emergency_contact_name', label: 'Emergency contact name', sample: '' },
  { key: 'emergency_contact_relation', label: 'Emergency contact relation', sample: '' },
  { key: 'emergency_contact_number', label: 'Emergency contact number', sample: '' },
  { key: 'bank_name', label: 'Bank name', sample: '' },
  { key: 'bank_account_number', label: 'Account number', sample: '' },
  { key: 'ifsc_code', label: 'IFSC code', sample: '' },
  { key: 'pan_number', label: 'PAN number', sample: '' },
  { key: 'aadhaar_number', label: 'Aadhaar number', sample: '' },
  { key: 'uan_number', label: 'UAN number', sample: '' },
  { key: 'pf_number', label: 'PF number', sample: '' },
  { key: 'esi_number', label: 'ESI number', sample: '' },
  { key: 'education', label: 'Education details', sample: '' },
  { key: 'experience', label: 'Work experience details', sample: '' },
  { key: 'skills', label: 'Skills & certifications', sample: '' }
];

// Fields that map directly 1:1 to a real `employees` column of the same name — every CSV_FIELDS
// entry except 'team' (resolved separately to team_id) and 'employee_code' (system-generated,
// read-only on import).
export const DIRECT_COLUMN_KEYS = CSV_FIELDS.map((f) => f.key).filter((k) => k !== 'team' && k !== 'employee_code');
