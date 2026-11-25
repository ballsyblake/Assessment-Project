import express from 'express';
import multer from 'multer';
import { html, statusBadge, progressBar, fmtDate, fmtDay, kb, shield, fmtNum } from '../html.js';
import { SECTIONS, sectionLabel, applicable, STAFF_POSITIONS, STAFF_TEAMS, QUALIFICATION_GROUPS, QUAL_YEARS, framework } from '../catalog.js';
import { getReqs, getClub, getItems, getFiles, getStaff, getPhases, submissionProgress } from '../model.js';
import { issueLink } from '../auth.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 10 } });
const back = (res, target, msg) => {
  const [p, hash] = target.split('#');
  res.redirect(`${p}?msg=${encodeURIComponent(msg)}${hash ? `#${hash}` : ''}`);
};
const ALLOWED = /\.(pdf|docx?|xlsx?|pptx?|csv|png|jpe?g|txt|mp4|mov)$/i;
const today = () => new Date().toISOString().slice(0, 10);
const LOCKED = ['approved', 'not_accepted'];

// Is the club allowed to upload for this item right now? (The database enforces the same rule.)
function canUpload(phase, extension, item) {
  if (phase.closed) return false;
  if (phase.submissionOpen) return true;
  if (extension && today() <= new Date(extension.until).toISOString().slice(0, 10)) return true;
  return Boolean(item?.upload_until && today() <= new Date(item.upload_until).toISOString().slice(0, 10));
}
function deadlineNote(phase, extension) {
  if (phase.closed) return html`<span class="badge b-muted">Closed</span>`;
  if (extension && today() <= new Date(extension.until).toISOString().slice(0, 10)) return html`<span class="badge b-warn">Extension to ${fmtDay(extension.until)}</span>`;
  if (phase.submissionOpen) return html`<span class="badge b-submitted">Due ${fmtDay(phase.deadline)}</span>`;
  return html`<span class="badge b-muted">Submissions closed ${fmtDay(phase.deadline)}</span>`;
}

export default function clubRoutes() {
  const r = express.Router();

  const load = (req) => req.db(async (tx) => {
    const club = await getClub(tx, req.user.club_id);
    const reqs = await getReqs(tx);
    const items = await getItems(tx, club.id);
    const phases = await getPhases(tx);
    const ext = (await tx.query('select * from extensions where club_id = $1', [club.id])).rows;
    return { club, reqs, items, phases, ext };
  });

  r.get('/', async (req, res) => {
    const d = await load(req);
    const extra = await req.db(async (tx) => ({
      staff: await getStaff(tx, d.club.id),
      result: (await tx.query('select rating from results where club_id = $1', [d.club.id])).rows[0],
    }));
    const prog = submissionProgress(d.reqs, d.club, d.items, extra.staff);
    const returned = Object.values(d.items).filter((i) => i.status === 'returned');
    const link = (s) => (s === 'staff' ? '/club/staff' : `/club/s/${s}`);
    res.page('Dashboard', html`
      <h1>${d.club.name}</h1>
      <p class="sub">${framework.name} · Pool ${d.club.pool}</p>
      ${extra.result ? html`<div class="notice row">${shield(extra.result.rating, 40)}<div><strong>Your results are available.</strong>
        <a href="/club/results">View results</a></div></div>` : ''}
      ${returned.length || extra.staff.some((s) => s.status === 'returned') ? html`<div class="warnbox"><strong>Needs your attention:</strong>
        item(s) returned with a comment from FQ.
        ${returned.map((i) => html` <a href="/club/s/${d.reqs.find((x) => x.id === i.req_id).section}#${i.req_id}">${i.req_id}</a>`)}
        ${extra.staff.some((s) => s.status === 'returned') ? html` <a href="/club/staff">staff table</a>` : ''}</div>` : ''}
      <div class="grid">
        ${SECTIONS.map((s) => {
          const p = prog[s.id];
          const ph = d.phases.find((x) => x.id === s.id);
          return html`<a class="card" href="${link(s.id)}" style="text-decoration:none;color:inherit">
            <div class="row"><strong>${s.label}</strong><span class="spacer"></span>${deadlineNote(ph, d.ext.find((e) => e.phase === s.id))}</div>
            ${progressBar(p.approved, p.submitted, p.total, s.label)}
            <div class="small muted">${p.approved} approved · ${p.submitted} awaiting review${p.returned ? html` · <span style="color:var(--warn)">${p.returned} returned</span>` : ''} · ${p.total} ${s.id === 'staff' ? 'positions' : 'items'}</div>
          </a>`;
        })}
      </div>
      <div class="legend"><span><i style="background:var(--ok)"></i>Approved</span><span><i style="background:var(--ok-soft)"></i>Submitted, awaiting review</span></div>
      <p class="small muted" style="margin-top:20px">Uploads close at each section's deadline. Items observed by FQ, and outcomes FQ assesses from its own data, are shown for information only. Results are released by FQ at the end of the cycle.</p>
    `);
  });

  r.get('/s/:section', async (req, res) => {
    const section = req.params.section;
    if (!['planning', 'delivery', 'outcomes', 'nn'].includes(section)) return res.redirect('/club');
    const d = await load(req);
    const files = await req.db((tx) => getFiles(tx, d.club.id));
    const reqs = d.reqs.filter((x) => x.section === section);
    const phase = d.phases.find((p) => p.id === section);
    const extension = d.ext.find((e) => e.phase === section);
    const partial = section === 'planning' && framework.partialPlanning?.pools.includes(d.club.pool);
    const maxOpt = framework.partialPlanning?.maxOptional ?? 0;
    const chosen = reqs.filter((x) => x.optional && d.items[x.id]?.selected).length;
    let lastGroup = '';
    res.page(sectionLabel(section), html`
      <div class="row"><h1>${sectionLabel(section)}</h1><span class="spacer"></span>${deadlineNote(phase, extension)}</div>
      <p class="sub">Upload evidence for each item. You can attach several files per item. Approved and not-accepted items are locked.</p>
      ${!canUpload(phase, extension, null) ? html`<div class="warnbox">The submission deadline for this section has passed. FQ can reopen individual items or grant an extension.</div>` : ''}
      ${partial ? html`<div class="notice"><strong>Pool ${d.club.pool} partial planning assessment.</strong>
        Mandatory items are assessed every year. Choose up to ${maxOpt} other planning items (${chosen} of ${maxOpt} chosen). Items you do not choose keep last cycle's score.</div>` : ''}
      ${reqs.map((q) => {
        const it = d.items[q.id];
        const a = applicable(q, d.club, it);
        const grp = q.grp !== lastGroup ? html`<h3>${(lastGroup = q.grp)}</h3>` : '';
        const fl = files.filter((f) => f.req_id === q.id);
        const locked = LOCKED.includes(it.status);
        const open = canUpload(phase, extension, it);
        const isDoc = q.kind === 'document';
        if (!a.applies && !(partial && q.optional)) {
          return html`${grp}<div class="card item" id="${q.id}" style="opacity:.6"><div class="code">${q.id}</div>
            <div><strong>${q.name}</strong><div class="guid">${a.why}</div></div><div><span class="badge b-muted">Not applicable</span></div></div>`;
        }
        return html`${grp}<div class="card item" id="${q.id}">
          <div class="code">${q.id}</div>
          <div>
            <strong>${q.name}</strong>
            <div class="guid">${q.guidance}</div>
            ${(it.status === 'returned' || it.status === 'not_accepted') && it.return_comment ? html`<div class="comment"><strong>${it.status === 'not_accepted' ? 'Not accepted' : 'Comment from FQ'}:</strong> ${it.return_comment}
              ${it.status === 'not_accepted' ? html`<div class="small muted">This item cannot be resubmitted. Use the review process after results are released if you believe this is an error.</div>` : ''}</div>` : ''}
            ${it.flagged_at && it.status === 'not_started' ? html`<div class="comment">FQ has asked you to check this item (${fmtDate(it.flagged_at)}).</div>` : ''}
            ${it.upload_until && !phase.submissionOpen ? html`<div class="small muted">Reopened by FQ until ${fmtDay(it.upload_until)}.</div>` : ''}
            ${partial && q.optional ? html`<form class="inline" method="post" action="/club/item/${q.id}/select">
                <input type="hidden" name="selected" value="${it.selected ? '0' : '1'}">
                ${it.selected
                  ? html`<span class="badge b-submitted">Chosen for assessment this cycle</span>${it.status === 'not_started' && open ? html` <button class="small secondary">Remove</button>` : ''}`
                  : html`<span class="badge b-muted">Carried forward</span> <span class="muted small">Last cycle's score is kept.</span> ${open ? html`<button class="small secondary" ${chosen >= maxOpt ? 'disabled' : ''}>Choose this item</button>` : ''}`}
              </form>` : ''}
            ${fl.length ? html`<ul class="files">${fl.map((f) => html`<li>
              <a href="/files/${f.id}">${f.filename}</a><span class="muted small">${kb(f.size)} · ${fmtDate(f.uploaded_at)}</span>
              ${!locked && open ? html`<form method="post" action="/club/item/${q.id}/file/${f.id}/delete"><button class="small secondary">Remove</button></form>` : ''}
            </li>`)}</ul>` : ''}
            ${isDoc && !locked && it.selected && open ? html`<form class="inline" method="post" action="/club/item/${q.id}/upload" enctype="multipart/form-data">
                <input type="file" name="files" multiple required>
                <button class="small">${it.status === 'not_started' ? 'Upload and submit' : it.status === 'returned' ? 'Upload and resubmit' : 'Add files'}</button></form>` : ''}
            ${it.status === 'returned' && fl.length && open ? html`<form class="inline" method="post" action="/club/item/${q.id}/resubmit"><button class="small secondary">Resubmit without new files</button></form>` : ''}
            ${locked && isDoc ? html`<div class="small muted">Locked.</div>` : ''}
          </div>
          <div>${it.selected || !partial ? statusBadge(it.status, q.kind) : html`<span class="badge b-muted">Carried forward</span>`}</div>
        </div>`;
      })}
    `, { active: `/club/s/${section}` });
  });

  const sectionOf = async (req, id) => req.db(async (tx) => (await tx.query('select section from requirements where id = $1', [id])).rows[0]?.section);

  r.post('/item/:req/upload', upload.array('files', 10), async (req, res) => {
    const files = (req.files ?? []).filter((f) => ALLOWED.test(f.originalname));
    if (!files.length) throw new Error('Choose at least one file (PDF, Office, image, CSV, text or video).');
    await req.db(async (tx) => {
      for (const f of files) {
        await tx.query(`insert into files(club_id, req_id, filename, mime, size, data, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7)`,
          [req.user.club_id, req.params.req, f.originalname.slice(0, 200), f.mimetype || 'application/octet-stream', f.size, f.buffer, req.user.id]);
      }
      await tx.query(`update club_items set status = 'submitted' where club_id = $1 and req_id = $2`, [req.user.club_id, req.params.req]);
    }, 'Club upload');
    back(res, `/club/s/${await sectionOf(req, req.params.req)}#${req.params.req}`, `${files.length} file(s) submitted for ${req.params.req}.`);
  });

  r.post('/item/:req/resubmit', async (req, res) => {
    await req.db((tx) => tx.query(`update club_items set status = 'submitted' where club_id = $1 and req_id = $2`, [req.user.club_id, req.params.req]), 'Club resubmission');
    back(res, `/club/s/${await sectionOf(req, req.params.req)}`, `${req.params.req} resubmitted.`);
  });

  r.post('/item/:req/file/:fid/delete', async (req, res) => {
    await req.db(async (tx) => {
      await tx.query('delete from files where id = $1 and req_id = $2', [Number(req.params.fid), req.params.req]);
      const { rows: [{ n }] } = await tx.query('select count(*)::int n from files where club_id = $1 and req_id = $2', [req.user.club_id, req.params.req]);
      if (n === 0) {
        await tx.query(`update club_items set status = 'not_started' where club_id = $1 and req_id = $2 and status = 'submitted'`, [req.user.club_id, req.params.req]);
      }
    }, 'Club removed file');
    back(res, `/club/s/${await sectionOf(req, req.params.req)}`, 'File removed.');
  });

  r.post('/item/:req/select', async (req, res) => {
    await req.db((tx) => tx.query('update club_items set selected = $3 where club_id = $1 and req_id = $2',
      [req.user.club_id, req.params.req, req.body.selected === '1']), 'Planning item selection');
    back(res, '/club/s/planning', 'Planning selection updated.');
  });

  // ---------------------------------------------------------------- staff qualifications table
  r.get('/staff', async (req, res) => {
    const d = await load(req);
    const x = await req.db(async (tx) => ({ staff: await getStaff(tx, req.user.club_id), files: await getFiles(tx, req.user.club_id) }));
    const phase = d.phases.find((p) => p.id === 'staff');
    const open = canUpload(phase, d.ext.find((e) => e.phase === 'staff'), null);
    const editing = Number(req.query.edit) || null;
    const dateVal = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
    const form = (s = {}) => html`
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">
        <label>Person<br><input name="person" required value="${s.person ?? ''}"></label>
        <label>Role<br><select name="position" required>${STAFF_POSITIONS.map((p) => html`<option ${s.position === p ? 'selected' : ''}>${p}</option>`)}</select></label>
        <label>Team<br><select name="team">${STAFF_TEAMS.map((t) => html`<option value="${t}" ${s.team === t ? 'selected' : ''}>${t || '(none)'}</option>`)}</select></label>
        <label>Current highest qualification<br><select name="qualification" required><option value=""></option>
          ${QUALIFICATION_GROUPS.map(([g, qs]) => html`<optgroup label="${g}">${qs.map((q) => html`<option ${s.qualification === q ? 'selected' : ''}>${q}</option>`)}</optgroup>`)}</select></label>
        <label>Years holding this qualification<br><select name="qual_years"><option value=""></option>${QUAL_YEARS.map((y) => html`<option ${s.qual_years === y ? 'selected' : ''}>${y}</option>`)}</select></label>
        <label>Qualification expiry<br><input type="date" name="qual_expiry" value="${dateVal(s.qual_expiry)}"></label>
        <label>Gender<br><select name="gender"><option value=""></option>${['F', 'M', 'X'].map((g) => html`<option ${s.gender === g ? 'selected' : ''}>${g}</option>`)}</select></label>
        <label>FA number<br><input name="fa_number" value="${s.fa_number ?? ''}"></label>
        <label>Blue card number<br><input name="blue_card" value="${s.blue_card ?? ''}"></label>
        <label>Blue card expiry<br><input type="date" name="blue_card_expiry" value="${dateVal(s.blue_card_expiry)}"></label>
        <label>Years at club<br><input type="number" min="0" name="years_at_club" value="${s.years_at_club ?? ''}"></label>
        <label>Employment type<br><select name="employment_type">${['', 'Full Time', 'Part Time', 'Casual', 'Volunteer'].map((e) => html`<option ${s.employment_type === e ? 'selected' : ''}>${e}</option>`)}</select></label>
        <label>Certificate${s.id ? ' (optional)' : ''}<br><input type="file" name="certificate" ${s.id ? '' : 'required'}></label>
      </div>`;
    res.page('Staff qualifications', html`
      <div class="row"><h1>Staff qualifications</h1><span class="spacer"></span>${deadlineNote(phase, d.ext.find((e) => e.phase === 'staff'))}</div>
      <p class="sub">One row per person and role, with their qualification certificate attached.</p>
      <div class="tablewrap"><table>
        <tr><th>Person</th><th>Role</th><th>Team</th><th>Qualification</th><th>Years held</th><th>Blue card</th><th>Certificate</th><th>Status</th><th></th></tr>
        ${x.staff.map((s) => html`<tr>
          <td>${s.person}</td><td>${s.position}</td><td>${s.team}</td><td>${s.qualification}</td><td>${s.qual_years}</td><td class="mono">${s.blue_card}</td>
          <td>${x.files.filter((f) => f.staff_row_id === s.id).map((f) => html`<a href="/files/${f.id}">${f.filename}</a><br>`)}</td>
          <td>${statusBadge(s.status)}${s.return_comment && ['returned', 'not_accepted'].includes(s.status) ? html`<div class="comment small">${s.return_comment}</div>` : ''}</td>
          <td>${LOCKED.includes(s.status) || !open ? html`<span class="small muted">Locked</span>` : html`
            <a class="btn small secondary" href="/club/staff?edit=${s.id}#edit">Edit</a>
            <form class="inline" method="post" action="/club/staff/${s.id}/delete"><button class="small secondary">Delete</button></form>`}</td>
        </tr>`)}
        ${x.staff.length ? '' : html`<tr><td colspan="9" class="muted">No staff added yet.</td></tr>`}
      </table></div>
      ${!open ? html`<div class="warnbox">The submission deadline for staff qualifications has passed.</div>`
        : editing ? html`<div class="card" id="edit"><h2 style="margin-top:0">Edit row</h2>
        <form method="post" action="/club/staff/${editing}" enctype="multipart/form-data">${form(x.staff.find((s) => s.id === editing))}
        <p><button>Save and resubmit</button> <a href="/club/staff">Cancel</a></p></form></div>`
        : html`<div class="card"><h2 style="margin-top:0">Add a person</h2>
        <form method="post" action="/club/staff" enctype="multipart/form-data">${form()}<p><button>Add and submit</button></p></form></div>`}
    `);
  });

  const staffFields = (b) => [b.position, b.person.trim(), b.gender || null, b.team || null, b.qualification.trim(), b.qual_expiry || null,
    b.fa_number || null, b.blue_card || null, b.blue_card_expiry || null, b.years_at_club ? Number(b.years_at_club) : null, b.employment_type || null,
    b.qual_years || null];

  r.post('/staff', upload.single('certificate'), async (req, res) => {
    if (!req.file) throw new Error('Attach the certificate for this person.');
    await req.db(async (tx) => {
      const { rows: [row] } = await tx.query(
        `insert into staff_rows(position, person, gender, team, qualification, qual_expiry, fa_number, blue_card, blue_card_expiry, years_at_club, employment_type, qual_years, club_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`, [...staffFields(req.body), req.user.club_id]);
      await tx.query(`insert into files(club_id, staff_row_id, filename, mime, size, data, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7)`,
        [req.user.club_id, row.id, req.file.originalname.slice(0, 200), req.file.mimetype, req.file.size, req.file.buffer, req.user.id]);
    }, 'Club added staff row');
    back(res, '/club/staff', 'Staff row added and submitted.');
  });

  r.post('/staff/:id', upload.single('certificate'), async (req, res) => {
    await req.db(async (tx) => {
      const { rowCount } = await tx.query(
        `update staff_rows set position=$1, person=$2, gender=$3, team=$4, qualification=$5, qual_expiry=$6, fa_number=$7, blue_card=$8,
           blue_card_expiry=$9, years_at_club=$10, employment_type=$11, qual_years=$12 where id=$13`, [...staffFields(req.body), Number(req.params.id)]);
      if (!rowCount) throw new Error('Row not found');
      if (req.file) {
        await tx.query(`insert into files(club_id, staff_row_id, filename, mime, size, data, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7)`,
          [req.user.club_id, Number(req.params.id), req.file.originalname.slice(0, 200), req.file.mimetype, req.file.size, req.file.buffer, req.user.id]);
      }
    }, 'Club edited staff row');
    back(res, '/club/staff', 'Row saved and resubmitted.');
  });

  r.post('/staff/:id/delete', async (req, res) => {
    await req.db((tx) => tx.query('delete from staff_rows where id = $1', [Number(req.params.id)]), 'Club deleted staff row');
    back(res, '/club/staff', 'Row deleted.');
  });

  // ---------------------------------------------------------------- results (only after release; enforced by RLS)
  r.get('/results', async (req, res) => {
    const d = await req.db(async (tx) => ({
      result: (await tx.query('select * from results where club_id = $1', [req.user.club_id])).rows[0],
      club: await getClub(tx, req.user.club_id),
    }));
    if (!d.result) {
      return res.page('Results', html`<h1>Results</h1><div class="card"><p>Results have not been released yet.
        FQ releases all club results together after the assessment and moderation process is complete.</p></div>`);
    }
    res.page('Results', resultsView(d.result, d.club));
  });

  // ---------------------------------------------------------------- contacts
  r.get('/team', async (req, res) => {
    const users = await req.db(async (tx) => (await tx.query('select id, name, email, is_primary from users where club_id = $1 and active order by id', [req.user.club_id])).rows);
    res.page('Contacts', html`<h1>Club contacts</h1>
      <p class="sub">Each person signs in with their own link. Links are never shared.</p>
      <div class="tablewrap"><table><tr><th>Name</th><th>Email</th><th></th></tr>
      ${users.map((u) => html`<tr><td>${u.name}</td><td class="mono">${u.email}</td><td>${u.is_primary ? 'Primary contact' : 'Second contact'}</td></tr>`)}</table></div>
      ${req.user.is_primary && users.length < 2 ? html`<div class="card"><h2 style="margin-top:0">Invite a second person</h2>
        <form method="post" action="/club/team/invite" class="inline"><input name="name" placeholder="Full name" required>
        <input type="email" name="email" placeholder="Email" required><button>Send invite</button></form></div>`
        : html`<p class="muted small">${req.user.is_primary ? 'Your club already has two contacts.' : 'Only the primary contact can invite people.'}</p>`}`);
  });

  r.post('/team/invite', async (req, res) => {
    const id = await req.db(async (tx) => (await tx.query(
      `insert into users(email, name, role, club_id) values ($1,$2,'club',$3) returning id`,
      [String(req.body.email).trim().toLowerCase(), String(req.body.name).trim(), req.user.club_id])).rows[0].id, 'Club invited contact');
    await issueLink(id);
    back(res, '/club/team', 'Invitation sent.');
  });

  return r;
}

// Results page, modelled on FQ's preliminary rating report: rating summary, audit summary
// by section, each section's areas with points missed and % grade plus the lead's comment,
// top 5 strengths and areas to improve, non-negotiables and shield thresholds, next steps.
const SECTION_COLOUR = { staff: '#8d9bb0', planning: '#7fb0de', delivery: '#f2c94c', outcomes: '#8fc27a' };
const ORDER = ['staff', 'planning', 'delivery', 'outcomes'];
const pctClass = (p) => (p >= 75 ? 'g-high' : p >= 50 ? 'g-mid' : 'g-low');

function bars(rows) {
  return html`<div class="bars" role="img" aria-label="${rows.map((r) => `${r.label} ${r.pct}%`).join(', ')}">
    ${rows.map((r) => html`<div class="bar"><div class="bar-track"><div class="bar-fill" style="height:${Math.max(2, r.pct)}%;background:${r.colour}"></div></div>
      <div class="bar-val">${r.pct}%</div><div class="bar-label">${r.label}</div></div>`)}</div>`;
}

export function resultsView(result, club, { preview = false } = {}) {
  const det = result.details;
  const comments = det.comments ?? {};
  const confirmed = Boolean(result.confirmed_at);
  const status = preview ? 'Admin preview' : confirmed ? 'Confirmed rating' : 'Preliminary rating (to be confirmed)';
  const sections = ORDER.filter((s) => det.bySection?.[s]);
  const review = framework.review ?? {};
  return html`
    ${preview ? html`<div class="warnbox noprint">Admin preview. The club cannot see this until results are released.</div>` : ''}
    <div class="card result-head">
      ${shield(result.rating, 110)}
      <div>
        <span class="badge ${confirmed ? 'b-approved' : 'b-warn'}">${status}</span>
        <h1 style="margin-top:6px">${club.name}</h1>
        <p class="sub" style="margin:0">${framework.name}</p>
        <div class="row" style="margin-top:12px;gap:32px">
          <div><div class="muted small">${confirmed ? 'Score' : 'Preliminary score'}</div><div class="stat">${fmtNum(result.total)} <span class="muted small">/ ${fmtNum(result.max_total)}</span></div></div>
          <div><div class="muted small">Score percentage</div><div class="stat">${Math.round(Number(result.pct))}%</div></div>
          <div><div class="muted small">${confirmed ? 'Rating' : 'Preliminary rating'}</div><div class="stat">${result.rating}</div></div>
        </div>
      </div>
      <span class="spacer"></span>
      <button class="secondary noprint" onclick="window.print()">Print or save as PDF</button>
    </div>
    ${det.override ? html`<div class="warnbox">* Rating determined by FQ: ${det.override.reason}</div>`
      : det.downgradeReasons?.length ? html`<div class="warnbox">* The club has been awarded a ${result.rating} shield instead of ${det.scoreRating}, as it was ${det.downgradeReasons.join(' and ')}.</div>` : ''}

    <h2>Club audit summary</h2>
    <div class="grid" style="grid-template-columns:minmax(0,3fr) minmax(0,2fr);align-items:start">
      <div class="tablewrap"><table class="audit">
        <tr><th>Section</th><th class="num">Maximum score</th><th class="num">Score</th><th class="num">Points missed</th><th class="num">% grade</th></tr>
        ${sections.map((s) => { const b = det.bySection[s]; return html`<tr><td><span class="swatch" style="background:${SECTION_COLOUR[s]}"></span>${sectionLabel(s)}</td>
          <td class="num">${fmtNum(b.max)}</td><td class="num">${fmtNum(b.points)}</td><td class="num">${fmtNum(b.missed)}</td><td class="num"><span class="grade ${pctClass(b.pct)}">${b.pct}%</span></td></tr>`; })}
        <tr class="total"><td>Total</td><td class="num">${fmtNum(det.max)}</td><td class="num">${fmtNum(det.total)}</td><td class="num">${fmtNum(det.missed)}</td><td class="num"><span class="grade ${pctClass(det.pct)}">${Math.round(det.pct)}%</span></td></tr>
      </table></div>
      <div class="card">${bars(sections.map((s) => ({ label: sectionLabel(s), pct: det.bySection[s].pct, colour: SECTION_COLOUR[s] })))}</div>
    </div>

    ${comments.overall ? html`<h2>Assessment summary</h2><div class="lead-comment">${comments.overall}</div>` : ''}

    ${sections.map((s) => {
      const b = det.bySection[s];
      const areas = det.areas?.[s] ?? [];
      return html`<section class="report-section">
        <div class="phase-head"><h2><span class="swatch" style="background:${SECTION_COLOUR[s]}"></span>${sectionLabel(s)}</h2>
          <span class="muted">${fmtNum(b.points)} of ${fmtNum(b.max)} points · <span class="grade ${pctClass(b.pct)}">${b.pct}%</span></span></div>
        <div class="tablewrap"><table class="report">
          ${areas.map((a) => html`
            <tr class="area-head"><th colspan="2">${a.name}</th><th class="num">Club score</th><th class="num">Weighting</th><th class="num">Points</th></tr>
            ${a.lines.map((l) => html`<tr><td class="code-cell">${l.id}</td><td>${l.name}${l.source === 'carried forward' ? html` <span class="badge b-muted">carried forward</span>` : ''}
              ${l.source === 'rolling average' ? html` <span class="badge b-muted">2-year average</span><div class="small muted">This year ${fmtNum(l.current)} · last year ${fmtNum(l.prior)}</div>` : ''}
              ${l.reviewedFrom !== null && l.reviewedFrom !== undefined ? html` <span class="badge b-submitted">Changed after review (${l.current - l.reviewedFrom > 0 ? '+' : ''}${fmtNum(l.current - l.reviewedFrom)})</span>` : ''}</td>
              <td class="num">${fmtNum(l.score)}</td><td class="num">${l.weight}</td><td class="num">${fmtNum(l.points)}</td></tr>`)}
            <tr class="area-total"><td colspan="2">Area: ${fmtNum(a.points)} of ${fmtNum(a.max)} · ${fmtNum(a.missed)} points missed</td>
              <td colspan="3" class="num"><span class="grade ${pctClass(a.pct)}">${a.pct}%</span></td></tr>`)}
        </table></div>
        ${s === 'planning' && det.rolling ? html`<p class="small muted">Pool ${club.pool}: planning uses a two-year rolling average. Items assessed this year score the average of this year and last year; items not chosen keep last year's score.</p>` : ''}
        ${areas.length > 1 ? html`<div class="card">${bars(areas.map((a) => ({ label: a.name, pct: a.pct, colour: SECTION_COLOUR[s] })))}</div>` : ''}
        ${comments[s] ? html`<h3>${sectionLabel(s)} summary</h3><div class="lead-comment">${comments[s]}</div>` : ''}
      </section>`;
    })}

    <section class="report-section">
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))">
        ${[['Top 5 strengths', det.strengths], ['Top 5 areas to improve', det.improve]].map(([title, rows]) => html`<div>
          <h2>${title}</h2><div class="tablewrap"><table>
          <tr><th>Area</th><th>Line item</th><th class="num">Score</th><th class="num">Weighting</th><th class="num">Points</th></tr>
          ${(rows ?? []).map((l) => html`<tr><td class="small">${l.grp}</td><td>${l.id} ${l.name}</td><td class="num">${fmtNum(l.score)} / ${l.max_score}</td><td class="num">${l.weight}</td><td class="num">${fmtNum(l.points)}</td></tr>`)}
          ${(rows ?? []).length ? '' : html`<tr><td colspan="5" class="muted">None.</td></tr>`}
          </table></div></div>`)}
      </div>
    </section>

    <section class="report-section">
      <h2>Non-negotiables</h2>
      <div class="tablewrap"><table>
        <tr><th>Ref</th><th>Compliance standard</th><th>Yes / No</th></tr>
        ${(det.compliance ?? det.nn ?? []).map((n) => html`<tr><td>${n.id}</td><td>${n.name}</td><td>${n.met ? html`<span class="badge b-approved">Yes</span>` : html`<span class="badge b-bad">No</span>`}</td></tr>`)}
      </table></div>
      ${(det.thresholds ?? []).length ? html`<h3>Shield threshold standards</h3><div class="tablewrap"><table>
        <tr><th>Ref</th><th>Standard</th><th>Outcome</th></tr>
        ${det.thresholds.map((t) => html`<tr><td>${t.id}</td><td>${t.name}</td><td><span class="badge ${t.code === null ? 'b-muted' : t.code <= 0.5 ? 'b-bad' : 'b-approved'}">${t.label}</span>
          ${t.code === 0.5 && t.prior === 0.5 ? html` <span class="small muted">(also on notice last year)</span>` : ''}</td></tr>`)}
      </table></div>
      <p class="small muted">${framework.thresholdRule?.description ?? ''}</p>` : ''}
      ${comments.nn ? html`<div class="lead-comment">${comments.nn}</div>` : ''}
    </section>

    ${confirmed ? '' : html`<section class="report-section"><h2>Next steps</h2><div class="card"><ul>
      <li>You can request a review within ${review.days ?? 8} days if you believe evidence uploaded before the deadline was overlooked. Reviews based only on arguments for more points are not considered.</li>
      <li>Maximum items per review: ${review.maxItems ? `${review.maxItems.staff} staff qualifications, ${review.maxItems.planning} planning (${review.maxItems.planningPartial} for partial planning assessments), ${review.maxItems.delivery} delivery and ${review.maxItems.outcomes} outcomes` : 'see the information pack'}.</li>
      <li>If no review is requested, the rating becomes confirmed when the review period ends. No rating is confirmed while non-negotiable documents are missing.</li>
      <li>Once confirmed, FQ provides your Club Shield. It is the only part of the assessment that may be shared publicly; this report is confidential.</li>
    </ul></div></section>`}`;
}
