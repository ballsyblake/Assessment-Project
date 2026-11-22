// Tiny auto-escaping HTML templating.
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(String(v));
}
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += render(vals[i]); });
  return new Safe(out);
}

export const STATUS_LABEL = {
  not_started: 'Not started', submitted: 'Submitted', approved: 'Approved', returned: 'Returned with comment', closed: 'Closed',
};
export const statusBadge = (s, kind) => {
  if (kind === 'onfield' || kind === 'fq') {
    return s === 'approved' ? html`<span class="badge b-approved">Assessed by FQ</span>` : html`<span class="badge b-muted">Awaiting FQ assessment</span>`;
  }
  return html`<span class="badge b-${s}">${STATUS_LABEL[s] ?? s}</span>`;
};
export const VERIF_LABEL = { verified: 'Verified', rejected: 'Rejected', returned: 'Returned', observed: 'Observed' };

export const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Brisbane' }) : '');
export const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-AU', { dateStyle: 'medium', timeZone: 'Australia/Brisbane' }) : '');
export const fmtNum = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('en-AU', { maximumFractionDigits: 1 }));
export const kb = (n) => (n > 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function progressBar(approved, submitted, total, label = '') {
  const a = total ? (approved / total) * 100 : 0;
  const s = total ? (submitted / total) * 100 : 0;
  return html`<div class="progress" role="img" aria-label="${label} ${approved} approved, ${submitted} awaiting review, of ${total}">
    <span class="p-approved" style="width:${a.toFixed(1)}%"></span><span class="p-submitted" style="width:${s.toFixed(1)}%"></span>
  </div>`;
}

const SHIELD_COLOR = { Gold: '#C9A227', Silver: '#9AA3AD', Bronze: '#B0713A', 'Development Committed': '#2F6B8F', 'Not rated': '#8A8F98' };
export function shield(rating, size = 96) {
  const c = SHIELD_COLOR[rating] ?? '#8A8F98';
  return html`<svg class="shield" width="${size}" height="${size * 1.15}" viewBox="0 0 100 115" aria-label="${rating} rating">
    <path d="M50 4 L92 18 V55 C92 82 72 101 50 111 C28 101 8 82 8 55 V18 Z" fill="${c}" stroke="#1b2a41" stroke-width="3"/>
    <path d="M50 14 L82 25 V55 C82 76 67 91 50 99 C33 91 18 76 18 55 V25 Z" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="2"/>
    <text x="50" y="62" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="700" font-size="${rating.length > 8 ? 10 : 15}" fill="#fff">${rating.toUpperCase()}</text>
  </svg>`;
}

export function layout({ title, user, nav = [], active = '', body, flash, error }) {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Club Assessment</title><link rel="stylesheet" href="/static/style.css"></head>
<body>
<header class="top"><div class="wrap top-in">
  <a class="brand" href="/">Club Assessment <span>Prototype</span></a>
  ${nav.length ? html`<nav>${nav.map(([href, label]) => html`<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`)}</nav>` : ''}
  ${user ? html`<div class="who"><span>${user.name} · ${user.role === 'club' ? 'Club' : user.role === 'admin' ? 'Admin' : 'Assessor'}</span>
    <form method="post" action="/logout"><button class="link">Sign out</button></form></div>` : ''}
</div></header>
<main class="wrap">
  ${flash ? html`<div class="flash ok">${flash}</div>` : ''}
  ${error ? html`<div class="flash err">${error}</div>` : ''}
  ${body}
</main>
<footer class="wrap foot">Prototype with fictional clubs, people and dummy evidence.</footer>
</body></html>`;
}

export const NAV = {
  club: [['/club', 'Dashboard'], ['/club/s/planning', 'Planning'], ['/club/staff', 'Staff'], ['/club/s/delivery', 'Delivery'],
    ['/club/s/outcomes', 'Outcomes'], ['/club/s/nn', 'Non-negotiables'], ['/club/results', 'Results'], ['/club/team', 'Contacts']],
  assessor: [['/assessor', 'My clubs']],
  admin: [['/admin', 'Progress'], ['/admin/assignments', 'Assignments'], ['/admin/reconcile', 'Reconciliation'],
    ['/admin/release', 'Release'], ['/admin/users', 'People'], ['/admin/settings', 'Settings'], ['/admin/audit', 'Audit log']],
};
