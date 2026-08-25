// Outline-only nav icons (stroke = currentColor, no fill) so they inherit the sidebar's
// active/hover text color automatically instead of carrying their own colors like emoji did.
const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' };

export const ICONS = {
  dashboard: (
    <svg {...common}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </svg>
  ),
  employees: (
    <svg {...common}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c1.4-4 5-5.5 7.5-5.5s6.1 1.5 7.5 5.5" />
    </svg>
  ),
  attendance: (
    <svg {...common}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.2v5l3.3 2" />
    </svg>
  ),
  leave: (
    <svg {...common}>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17" />
      <path d="M8 3v4M16 3v4" />
      <path d="M8.5 14.2l2 2 4-4.2" />
    </svg>
  ),
  payroll: (
    <svg {...common}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M3 10h18" />
      <path d="M7 14h4" />
    </svg>
  ),
  recruitment: (
    <svg {...common}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M15.2 8.8l-1.9 4.5-4.5 1.9 1.9-4.5z" />
    </svg>
  ),
  performance: (
    <svg {...common}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.6" />
    </svg>
  ),
  learning: (
    <svg {...common}>
      <path d="M12 4.2L2.5 9l9.5 4.8L21.5 9z" />
      <path d="M6 11.5V17c0 1.4 2.7 3 6 3s6-1.6 6-3v-5.5" />
      <path d="M21.5 9v6" />
    </svg>
  ),
  assets: (
    <svg {...common}>
      <rect x="4" y="4.5" width="16" height="11" rx="1.5" />
      <path d="M2 19.5h20" />
      <path d="M9.3 19.5l1-2h3.4l1 2" />
    </svg>
  ),
  helpdesk: (
    <svg {...common}>
      <path d="M4 13v-1a8 8 0 0116 0v1" />
      <rect x="2.5" y="13" width="4" height="6" rx="1.5" />
      <rect x="17.5" y="13" width="4" height="6" rx="1.5" />
      <path d="M20 19v.5a3 3 0 01-3 3h-3.5" />
    </svg>
  ),
  announcements: (
    <svg {...common}>
      <path d="M3 10.2v3.6a1 1 0 001 1h2l9 3.7V5.5l-9 3.7H4a1 1 0 00-1 1z" />
      <path d="M18 9.3a4 4 0 010 5.4" />
      <path d="M8 15v2.8A1.7 1.7 0 009.7 19.5H11" />
    </svg>
  ),
  expenses: (
    <svg {...common}>
      <path d="M6 3h12v18l-2.5-1.7L13 21l-2.5-1.7L8 21l-2-1.7z" />
      <path d="M9 8.3h6M9 12h6" />
    </svg>
  ),
  surveys: (
    <svg {...common}>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <rect x="9" y="2.3" width="6" height="3" rx="1" />
      <path d="M8.5 12.7l2 2 4-4.4" />
    </svg>
  ),
  documents: (
    <svg {...common}>
      <path d="M3 6.5A1.5 1.5 0 014.5 5H9l2 2.2h8.5A1.5 1.5 0 0121 8.7v9.8a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18.5z" />
    </svg>
  ),
  shiftRoster: (
    <svg {...common}>
      <rect x="3.3" y="4.5" width="17.4" height="15.5" rx="2" />
      <path d="M3.3 9.5h17.4" />
      <path d="M8 3v3M16 3v3" />
      <circle cx="15.3" cy="15" r="3.1" />
      <path d="M15.3 13.4V15l1 .9" />
    </svg>
  ),
  recognition: (
    <svg {...common}>
      <path d="M7 4h10v3a5 5 0 01-10 0z" />
      <path d="M7 5H4a3 3 0 003 3M17 5h3a3 3 0 01-3 3" />
      <path d="M12 12v4" />
      <path d="M8.5 20h7" />
      <path d="M10 20c0-2 .8-3 2-3s2 1 2 3" />
    </svg>
  ),
  projects: (
    <svg {...common}>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </svg>
  ),
  timesheet: (
    <svg {...common}>
      <circle cx="12" cy="13.5" r="7.5" />
      <path d="M12 9.5v4l3 2" />
      <path d="M9.5 2.5h5" />
      <path d="M12 2.5v2.3" />
    </svg>
  ),
  disciplinary: (
    <svg {...common}>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      <path d="M12 8v4.4" />
      <path d="M12 15.4v.3" />
    </svg>
  ),
  configurations: (
    <svg {...common}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2L5.6 5.6" />
    </svg>
  ),
  policies: (
    <svg {...common}>
      <path d="M6 3h9l4 4v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z" />
      <path d="M14 3v4h4" />
      <path d="M8 12h8M8 16h5" />
    </svg>
  ),
  roles: (
    <svg {...common}>
      <circle cx="7.5" cy="16.5" r="4" />
      <path d="M10.3 13.7L19 5" />
      <path d="M15.5 8.5l2.5 2.5" />
      <path d="M18 6l2 2" />
    </svg>
  ),
  orgStructure: (
    <svg {...common}>
      <rect x="9" y="3" width="6" height="5" rx="1" />
      <path d="M12 8v3" />
      <path d="M5 15h14" />
      <path d="M5 11v4M19 11v4" />
      <rect x="2.5" y="15" width="6" height="5" rx="1" />
      <rect x="9" y="15" width="6" height="5" rx="1" />
      <rect x="15.5" y="15" width="6" height="5" rx="1" />
    </svg>
  ),
  integrations: (
    <svg {...common}>
      <path d="M9 2v5M15 2v5" />
      <path d="M6 7h12v4a6 6 0 01-12 0z" />
      <path d="M12 17v5" />
    </svg>
  ),
  knowledgeTransfer: (
    <svg {...common}>
      <path d="M12 3a6 6 0 00-3.5 10.9c.5.4.8 1 .8 1.6v.5h5.4v-.5c0-.6.3-1.2.8-1.6A6 6 0 0012 3z" />
      <path d="M10 19h4M10.5 21.5h3" />
    </svg>
  )
};
