import express from 'express';
import multer from 'multer';
import { html, statusBadge, progressBar, fmtDate, kb, shield, fmtNum } from '../html.js';
import { SECTIONS, sectionLabel, applicable, STAFF_POSITIONS, STAFF_TEAMS } from '../catalog.js';
import { getReqs, getClub, getItems, getFiles, getStaff, submissionProgress } from '../model.js';
import { issueLink } from '../auth.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 10 } });
const back = (res, target, msg) => {
  const [p, hash] = target.split('#');
  res.redirect(`${p}?msg=${encodeURIComponent(msg)}${hash ? `#${hash}` : ''}`);
};
const ALLOWED = /\.(pdf|docx?|xlsx?|pptx?|csv|png|jpe?g|txt|mp4|mov)$/i;

export default function clubRoutes() {
  const r = express.Router();

  r.get('/', async (req, res) => {
    const d = await req.db(async (tx) => {
      const club = await getClub(tx, req.user.club_id);
      const reqs = await getReqs(tx);
      const items = await getItems(tx, club.id);
      const staff = await getStaff(tx, club.id);
      const { rows: [result] } = await tx.query('select rating, released_at from results where club_id = $1', [club.id]);
      return { club, prog: submissionProgress(reqs, club, items, staff), returned: Object.values(items).filter((i) => i.status === 'returned'),
        reqs, staffReturned: staff.filter((s) => s.status === 'returned'), result };
    });
    const link = (s) => (s === 'staff' ? '/club/staff' : `/club/s/${s}`);
    res.page('Dashboard', html`
      <h1>${d.club.name}</h1>
      <p class="sub">2027 Tier 1 club development assessment · Pool ${d.club.pool}</p>
      ${d.result ? html`<div class="notice row">${shield(d.result.rating, 40)}<div><strong>Your 2027 results are available.</strong>
        <a href="/club/results">View results</a></div></div>` : ''}
      ${d.returned.length || d.staffReturned.length ? html`<div class="warnbox"><strong>Needs your attention:</strong>
        ${d.returned.length + d.staffReturned.length} item(s) returned with a comment from FQ.
        ${d.returned.map((i) => html` <a href="/club/s/${d.reqs.find((x) => x.id === i.req_id).section}#${i.req_id}">${i.req_id}</a>`)}
        ${d.staffReturned.length ? html` <a href="/club/staff">staff table</a>` : ''}</div>` : ''}
      <div class="grid">
        ${SECTIONS.map((s) => {
          const p = d.prog[s.id];
          return html`<a class="card" href="${link(s.id)}" style="text-decoration:none;color:inherit">
            <strong>${s.label}</strong>
            ${progressBar(p.approved, p.submitted, p.total, s.label)}
            <div class="small muted">${p.approved} approved · ${p.submitted} awaiting review${p.returned ? html` · <span style="color:var(--warn)">${p.returned} returned</span>` : ''} · ${p.total} ${s.id === 'staff' ? 'positions' : 'items'}</div>
          </a>`;
        })}
      </div>
      <div class="legend"><span><i style="background:var(--ok)"></i>Approved</span><span><i style="background:var(--ok-soft)"></i>Submitted, awaiting review</span></div>
      <p class="small muted" style="margin-top:20px">Items observed by FQ at training and match days, and outcomes FQ assesses from its own records, are shown in each section for information. You do not need to do anything for them. Results are released by FQ at the end of the assessment cycle.</p>
    `);
  });

  r.get('/s/:section', async (req, res) => {
    const section = req.params.section;
    if (!['planning', 'delivery', 'outcomes', 'nn'].includes(section)) return res.redirect('/club');
    const d = await req.db(async (tx) => {
      const club = await getClub(tx, req.user.club_id);
      const reqs = (await getReqs(tx)).filter((x) => x.section === section);
      return { club, reqs, items: await getItems(tx, club.id), files: await getFiles(tx, club.id) };
    });
    const partial = section === 'planning' && d.club.pool !== 'B';
    const chosen = d.reqs.filter((x) => d.items[x.id]?.selected && !['P2', 'P5'].includes(x.id)).length;
    let lastGroup = '';
    res.page(sectionLabel(section), html`
      <h1>${sectionLabel(section)}</h1>
      <p class="sub">Upload evidence for each item. You can attach several files per item. Approved items are locked.</p>
      ${partial ? html`<div class="notice"><strong>Pool ${d.club.pool} partial planning assessment.</strong>
        P2 and P5 are assessed every year. Choose up to three other planning items (${chosen} of 3 chosen). Items you do not choose keep last cycle's score.</div>` : ''}
      ${d.reqs.map((q) => {
        const it = d.items[q.id];
        const a = applicable(q, d.club, it);
        const grp = q.grp !== lastGroup ? html`<h3>${(lastGroup = q.grp)}</h3>` : '';
        const files = d.files.filter((f) => f.req_id === q.id);
        const locked = ['approved', 'closed'].includes(it.status);
        const isDoc = q.kind === 'document';
        if (!a.applies && !(partial && !['P2', 'P5'].includes(q.id))) {
          return html`${grp}<div class="card item" id="${q.id}" style="opacity:.6"><div class="code">${q.id}</div>
            <div><strong>${q.name}</strong><div class="guid">${a.why}</div></div><div><span class="badge b-muted">Not applicable</span></div></div>`;
        }
        return html`${grp}<div class="card item" id="${q.id}">
          <div class="code">${q.id}</div>
          <div>
            <strong>${q.name}</strong>
            <div class="guid">${q.guidance}</div>
            ${it.status === 'returned' && it.return_comment ? html`<div class="comment"><strong>Comment from FQ:</strong> ${it.return_comment}</div>` : ''}
            ${it.flagged_at && it.status === 'not_started' ? html`<div class="comment">FQ has asked you to check this item (${fmtDate(it.flagged_at)}).</div>` : ''}
            ${partial && !['P2', 'P5'].includes(q.id) ? html`<form class="inline" method="post" action="/club/item/${q.id}/select">
                <input type="hidden" name="selected" value="${it.selected ? '0' : '1'}">
                ${it.selected
                  ? html`<span class="badge b-submitted">Chosen for assessment this cycle</span>${it.status === 'not_started' ? html` <button class="small secondary">Remove</button>` : ''}`
                  : html`<span class="muted small">Not chosen: last cycle's score carries forward.</span> <button class="small secondary" ${chosen >= 3 ? 'disabled' : ''}>Choose this item</button>`}
              </form>` : ''}
            ${files.length ? html`<ul class="files">${files.map((f) => html`<li>
              <a href="/files/${f.id}">${f.filename}</a><span class="muted small">${kb(f.size)} · ${fmtDate(f.uploaded_at)}</span>
              ${!locked ? html`<form method="post" action="/club/item/${q.id}/file/${f.id}/delete"><button class="small secondary" title="Remove file">Remove</button></form>` : ''}
            </li>`)}</ul>` : ''}
            ${isDoc && !locked && it.selected ? html`<form class="inline" method="post" action="/club/item/${q.id}/upload" enctype="multipart/form-data">
                <input type="file" name="files" multiple required>
                <button class="small">${it.status === 'not_started' ? 'Upload and submit' : it.status === 'returned' ? 'Upload and resubmit' : 'Add files'}</button></form>` : ''}
            ${it.status === 'returned' && files.length ? html`<form class="inline" method="post" action="/club/item/${q.id}/resubmit"><button class="small secondary">Resubmit without new files</button></form>` : ''}
            ${locked && isDoc ? html`<div class="small muted">Locked. Contact FQ if this evidence needs to change.</div>` : ''}
          </div>
          <div>${it.selected || !partial ? statusBadge(it.status, q.kind) : html`<span class="badge b-muted">Carried forward</span>`}</div>
        </div>`;
      })}
    `);
  });

  r.post('/item/:req/upload', upload.array('files', 10), async (req, res) => {
    const files = (req.files ?? []).filter((f) => ALLOWED.test(f.originalname));
    if (!files.length) throw new Error('Choose at least one file (PDF, Office, image, CSV, text or video).');
    const section = await req.db(async (tx) => {
      const { rows: [q] } = await tx.query('select section from requirements where id = $1', [req.params.req]);
      for (const f of files) {
        await tx.query(
          `insert into files(club_id, req_id, filename, mime, size, data, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7)`,
          [req.user.club_id, req.params.req, f.originalname.slice(0, 200), f.mimetype || 'application/octet-stream', f.size, f.buffer, req.user.id]);
      }
      await tx.query(`update club_items set status = 'submitted' where club_id = $1 and req_id = $2`, [req.user.club_id, req.params.req]);
      return q.section;
    }, 'Club upload');
    back(res, `/club/s/${section}#${req.params.req}`, `${files.length} file(s) submitted for ${req.params.req}.`);
  });

  r.post('/item/:req/resubmit', async (req, res) => {
    const section = await req.db(async (tx) => {
      await tx.query(`update club_items set status = 'submitted' where club_id = $1 and req_id = $2`, [req.user.club_id, req.params.req]);
      return (await tx.query('select section from requirements where id = $1', [req.params.req])).rows[0].section;
    }, 'Club resubmission');
    back(res, `/club/s/${section}`, `${req.params.req} resubmitted.`);
  });

  r.post('/item/:req/file/:fid/delete', async (req, res) => {
    const section = await req.db(async (tx) => {
      await tx.query('delete from files where id = $1 and req_id = $2', [Number(req.params.fid), req.params.req]);
      const { rows: [{ n }] } = await tx.query('select count(*)::int n from files where club_id = $1 and req_id = $2', [req.user.club_id, req.params.req]);
      if (n === 0) {
        // Nothing left: the club has withdrawn the submission.
        await tx.query(`update club_items set status = 'not_started' where club_id = $1 and req_id = $2 and status = 'submitted'`,
          [req.user.club_id, req.params.req]);
      }
      return (await tx.query('select section from requirements where id = $1', [req.params.req])).rows[0].section;
    }, 'Club removed file');
    back(res, `/club/s/${section}`, 'File removed.');
  });

  r.post('/item/:req/select', async (req, res) => {
    await req.db((tx) => tx.query('update club_items set selected = $3 where club_id = $1 and req_id = $2',
      [req.user.club_id, req.params.req, req.body.selected === '1']), 'Planning item selection');
    back(res, '/club/s/planning', 'Planning selection updated.');
  });

  // ---------------------------------------------------------------- staff qualifications table
  r.get('/staff', async (req, res) => {
    const d = await req.db(async (tx) => ({ staff: await getStaff(tx, req.user.club_id), files: await getFiles(tx, req.user.club_id) }));
    const editing = Number(req.query.edit) || null;
    const form = (s = {}) => html`
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">
        <label>Person<br><input name="person" required value="${s.person ?? ''}"></label>
        <label>Role<br><select name="position" required>${STAFF_POSITIONS.map((p) => html`<option ${s.position === p ? 'selected' : ''}>${p}</option>`)}</select></label>
        <label>Team<br><select name="team">${STAFF_TEAMS.map((t) => html`<option value="${t}" ${s.team === t ? 'selected' : ''}>${t || '(none)'}</option>`)}</select></label>
        <label>Qualification<br><input name="qualification" required value="${s.qualification ?? ''}" placeholder="e.g. AFC B Diploma"></label>
        <label>Qualification expiry<br><input type="date" name="qual_expiry" value="${s.qual_expiry ? new Date(s.qual_expiry).toISOString().slice(0, 10) : ''}"></label>
        <label>Gender<br><select name="gender"><option value=""></option>${['F', 'M', 'X'].map((g) => html`<option ${s.gender === g ? 'selected' : ''}>${g}</option>`)}</select></label>
        <label>FA number<br><input name="fa_number" value="${s.fa_number ?? ''}"></label>
        <label>Blue card number<br><input name="blue_card" value="${s.blue_card ?? ''}"></label>
        <label>Blue card expiry<br><input type="date" name="blue_card_expiry" value="${s.blue_card_expiry ? new Date(s.blue_card_expiry).toISOString().slice(0, 10) : ''}"></label>
        <label>Years at club<br><input type="number" min="0" name="years_at_club" value="${s.years_at_club ?? ''}"></label>
        <label>Employment type<br><select name="employment_type">${['', 'Full time', 'Part time', 'Casual', 'Volunteer'].map((e) => html`<option ${s.employment_type === e ? 'selected' : ''}>${e}</option>`)}</select></label>
        <label>Certificate${s.id ? ' (optional, replaces nothing)' : ''}<br><input type="file" name="certificate" ${s.id ? '' : 'required'}></label>
      </div>`;
    res.page('Staff qualifications', html`
      <h1>Staff qualifications</h1>
      <p class="sub">One row per person and role, with their qualification certificate attached. Include the seven leadership positions and every academy head coach.</p>
      <div class="tablewrap"><table>
        <tr><th>Person</th><th>Role</th><th>Team</th><th>Qualification</th><th>Blue card</th><th>Certificate</th><th>Status</th><th></th></tr>
        ${d.staff.map((s) => html`<tr id="row${s.id}">
          <td>${s.person}</td><td>${s.position}</td><td>${s.team}</td><td>${s.qualification}</td><td class="mono">${s.blue_card}</td>
          <td>${d.files.filter((f) => f.staff_row_id === s.id).map((f) => html`<a href="/files/${f.id}">${f.filename}</a><br>`)}</td>
          <td>${statusBadge(s.status)}${s.status === 'returned' && s.return_comment ? html`<div class="comment small">${s.return_comment}</div>` : ''}</td>
          <td>${['approved', 'closed'].includes(s.status) ? html`<span class="small muted">Locked</span>` : html`
            <a class="btn small secondary" href="/club/staff?edit=${s.id}#edit">Edit</a>
            <form class="inline" method="post" action="/club/staff/${s.id}/delete"><button class="small secondary">Delete</button></form>`}</td>
        </tr>`)}
        ${d.staff.length ? '' : html`<tr><td colspan="8" class="muted">No staff added yet.</td></tr>`}
      </table></div>
      ${editing ? html`<div class="card" id="edit"><h2 style="margin-top:0">Edit row</h2>
        <form method="post" action="/club/staff/${editing}" enctype="multipart/form-data">${form(d.staff.find((s) => s.id === editing))}
        <p><button>Save and resubmit</button> <a href="/club/staff">Cancel</a></p></form></div>` : html`
      <div class="card"><h2 style="margin-top:0">Add a person</h2>
        <form method="post" action="/club/staff" enctype="multipart/form-data">${form()}<p><button>Add and submit</button></p></form></div>`}
    `);
  });

  const staffFields = (b) => [b.position, b.person.trim(), b.gender || null, b.team || null, b.qualification.trim(), b.qual_expiry || null,
    b.fa_number || null, b.blue_card || null, b.blue_card_expiry || null, b.years_at_club ? Number(b.years_at_club) : null, b.employment_type || null];

  r.post('/staff', upload.single('certificate'), async (req, res) => {
    if (!req.file) throw new Error('Attach the certificate for this person.');
    await req.db(async (tx) => {
      const { rows: [row] } = await tx.query(
        `insert into staff_rows(position, person, gender, team, qualification, qual_expiry, fa_number, blue_card, blue_card_expiry, years_at_club, employment_type, club_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`, [...staffFields(req.body), req.user.club_id]);
      await tx.query(`insert into files(club_id, staff_row_id, filename, mime, size, data, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7)`,
        [req.user.club_id, row.id, req.file.originalname.slice(0, 200), req.file.mimetype, req.file.size, req.file.buffer, req.user.id]);
    }, 'Club added staff row');
    back(res, '/club/staff', 'Staff row added and submitted.');
  });

  r.post('/staff/:id', upload.single('certificate'), async (req, res) => {
    await req.db(async (tx) => {
      const { rowCount } = await tx.query(
        `update staff_rows set position=$1, person=$2, gender=$3, team=$4, qualification=$5, qual_expiry=$6, fa_number=$7, blue_card=$8,
           blue_card_expiry=$9, years_at_club=$10, employment_type=$11 where id=$12`, [...staffFields(req.body), Number(req.params.id)]);
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
    const result = await req.db(async (tx) => (await tx.query('select * from results where club_id = $1', [req.user.club_id])).rows[0]);
    if (!result) {
      return res.page('Results', html`<h1>Results</h1><div class="card"><p>Results have not been released yet.
        FQ releases all club results together after the assessment and moderation process is complete.</p></div>`);
    }
    res.page('Results', resultsView(result, (await req.db((tx) => getClub(tx, req.user.club_id)))));
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

export function resultsView(result, club, { preview = false } = {}) {
  const det = result.details;
  const SECTION_ORDER = ['staff', 'planning', 'delivery', 'outcomes'];
  return html`
    ${preview ? html`<div class="warnbox noprint">Admin preview. The club cannot see this until results are released.</div>` : ''}
    <div class="card result-head">
      ${shield(result.rating, 110)}
      <div>
        <h1>${club.name}</h1>
        <p class="sub" style="margin:0">2027 Tier 1 Club Development Assessment</p>
        <div class="row" style="margin-top:12px;gap:32px">
          <div><div class="muted small">Total score</div><div class="stat">${fmtNum(result.total)} <span class="muted small">/ ${fmtNum(result.max_total)}</span></div></div>
          <div><div class="muted small">Percentage</div><div class="stat">${fmtNum(result.pct)}%</div></div>
          <div><div class="muted small">Rating</div><div class="stat">${result.rating}</div></div>
        </div>
      </div>
      <span class="spacer"></span>
      <button class="secondary noprint" onclick="window.print()">Print or save as PDF</button>
    </div>
    ${det.capped ? html`<div class="warnbox">One or more non-negotiable standards were not met, so the rating cannot rise above the club's current shield.</div>` : ''}
    <h2>By section</h2>
    <div class="grid">${SECTION_ORDER.filter((s) => det.bySection[s]).map((s) => {
      const b = det.bySection[s];
      return html`<div class="card"><strong>${sectionLabel(s)}</strong>${progressBar(b.points, 0, b.max)}
        <div class="small muted">${fmtNum(b.points)} of ${fmtNum(b.max)} points · ${fmtNum((b.points / b.max) * 100)}%</div></div>`;
    })}</div>
    ${SECTION_ORDER.map((s) => {
      const lines = det.lines.filter((l) => l.section === s);
      if (!lines.length) return '';
      return html`<h2>${sectionLabel(s)}</h2><div class="tablewrap"><table>
        <tr><th>Item</th><th>Line item</th><th class="num">Score</th><th class="num">Weighting</th><th class="num">Points</th><th class="num">Max</th></tr>
        ${lines.map((l) => html`<tr><td>${l.id}</td><td>${l.name}${l.source === 'carried forward' ? html` <span class="badge b-muted">carried forward</span>` : ''}</td>
          <td class="num">${fmtNum(l.score)} / ${l.max_score}</td><td class="num">${l.weight}</td><td class="num">${fmtNum(l.points)}</td><td class="num">${l.max}</td></tr>`)}
      </table></div>`;
    })}
    <h2>Non-negotiables</h2>
    <div class="tablewrap"><table><tr><th>Item</th><th>Standard</th><th>Outcome</th></tr>
      ${det.nn.map((n) => html`<tr><td>${n.id}</td><td>${n.name}</td><td>${n.met ? html`<span class="badge b-approved">Met</span>` : html`<span class="badge b-bad">Not met</span>`}</td></tr>`)}
    </table></div>`;
}
