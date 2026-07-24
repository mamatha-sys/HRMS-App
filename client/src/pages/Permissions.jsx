import { useEffect, useState } from 'react';
import api from '../api.js';

const FIELD_LABELS = {
  bank_name: 'Bank name',
  bank_account_number: 'Bank account number',
  ifsc_code: 'IFSC code',
  aadhaar_number: 'Aadhaar number',
  pan_number: 'PAN number',
  date_of_birth: 'Date of birth',
  emergency_contact_name: 'Emergency contact name',
  emergency_contact_relation: 'Emergency contact relation',
  emergency_contact_number: 'Emergency contact number',
  education: 'Education',
  experience: 'Experience',
  skills: 'Skills'
};
const ROLES = ['manager', 'employee'];

export default function Permissions() {
  const [fields, setFields] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');

  function load() {
    api.get('/permissions')
      .then((res) => { setFields(res.data.fields); setPermissions(res.data.permissions); })
      .catch(() => setError('Could not load permissions.'));
  }

  useEffect(load, []);

  function accessFor(role, field) {
    const row = permissions.find((p) => p.role === role && p.field_name === field);
    return row ? row.access : 'hidden';
  }

  async function setAccess(role, field, access) {
    setSaving(`${role}:${field}`);
    setError('');
    try {
      await api.put('/permissions', { role, field_name: field, access });
      setPermissions((prev) => {
        const next = prev.filter((p) => !(p.role === role && p.field_name === field));
        next.push({ role, field_name: field, access });
        return next;
      });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update permission.');
    } finally {
      setSaving('');
    }
  }

  return (
    <div>
      <h1>Manage permissions</h1>
      <div className="subtitle">
        Configure field-level access for Manager and Employee roles on records that aren't their own.
        Super Admin always has full access. Changes apply immediately across Employee Management.
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Field</th>
              {ROLES.map((r) => <th key={r}>{r === 'manager' ? 'Manager' : 'Employee'}</th>)}
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr key={field}>
                <td>{FIELD_LABELS[field] || field}</td>
                {ROLES.map((role) => (
                  <td key={role}>
                    <select
                      value={accessFor(role, field)}
                      disabled={saving === `${role}:${field}`}
                      onChange={(e) => setAccess(role, field, e.target.value)}
                    >
                      <option value="hidden">Hidden</option>
                      <option value="view">View</option>
                      <option value="edit">Edit</option>
                    </select>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="note">
        "Hidden" masks the field entirely for that role when viewing other employees' records (own record and Super Admin are always unmasked).
        "View"/"Edit" both currently unmask the field for reading; write access is enforced by role on the main Employee form.
      </div>
    </div>
  );
}
