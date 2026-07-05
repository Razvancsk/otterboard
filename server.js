const http       = require('http');
const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const url        = require('url');
const nodemailer = require('nodemailer');
const { createClerkClient, verifyToken } = require('@clerk/backend');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// Copy Clerk browser bundle to root so it's served as a static file
try {
  const src = path.join(ROOT, 'node_modules/@clerk/clerk-js/dist/clerk.browser.js');
  const dst = path.join(ROOT, 'clerk.js');
  if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
} catch(e) { console.warn('Could not copy clerk.js:', e.message); }

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function loadConfig() {
  // Prefer environment variables, fall back to config.json for local dev
  const fileConfig = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); }
    catch { return {}; }
  })();

  return {
    adzuna_app_id:      process.env.ADZUNA_APP_ID      || fileConfig.adzuna_app_id,
    adzuna_app_key:     process.env.ADZUNA_APP_KEY     || fileConfig.adzuna_app_key,
    adzuna_country:     process.env.ADZUNA_COUNTRY     || fileConfig.adzuna_country     || 'nl',
    site_url:           process.env.SITE_URL            || fileConfig.site_url            || 'https://otterboard.nl',
    clerk_publishable_key: process.env.CLERK_PUBLISHABLE_KEY || fileConfig.clerk_publishable_key,
    clerk_secret_key:      process.env.CLERK_SECRET_KEY      || fileConfig.clerk_secret_key,
    smtp_host:          process.env.SMTP_HOST           || fileConfig.smtp_host,
    smtp_port:          process.env.SMTP_PORT           || fileConfig.smtp_port           || '465',
    smtp_user:          process.env.SMTP_USER           || fileConfig.smtp_user,
    smtp_pass:          process.env.SMTP_PASS           || fileConfig.smtp_pass,
    smtp_from:          process.env.SMTP_FROM           || fileConfig.smtp_from           || 'OtterBoard <alert@otterboard.nl>',
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

/* ── Adzuna proxy ── */
function proxyAdzuna(req, res) {
  const cfg = loadConfig();
  const { adzuna_app_id, adzuna_app_key, adzuna_country } = cfg;

  if (!adzuna_app_id) return json(res, 503, { error: 'not_configured' });

  const q    = url.parse(req.url, true).query;
  const page = parseInt(q.page) || 1;

  const params = new URLSearchParams({
    app_id:           adzuna_app_id,
    app_key:          adzuna_app_key,
    results_per_page: q.results_per_page || '20',
    'content-type':   'application/json',
  });

  if (q.what)         params.set('what',         q.what);
  if (q.where)        params.set('where',        q.where);
  if (q.what_exclude) params.set('what_exclude', q.what_exclude);
  if (q.category)     params.set('category',     q.category);
  if (q.sort_by)      params.set('sort_by',      q.sort_by);
  if (q.salary_min)   params.set('salary_min',   q.salary_min);
  if (q.full_time)    params.set('full_time',    q.full_time);
  if (q.permanent)    params.set('permanent',    q.permanent);

  const apiUrl = `https://api.adzuna.com/v1/api/jobs/${adzuna_country}/search/${page}?${params}`;
  console.log('[Adzuna] GET', apiUrl.replace(adzuna_app_key, '***'));

  https.get(apiUrl, apiRes => {
    let body = '';
    apiRes.on('data', chunk => body += chunk);
    apiRes.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    });
  }).on('error', err => json(res, 502, { error: 'fetch_failed', message: err.message }));
}

/* ── GET /api/salary-history ── */
function proxySalaryHistory(req, res) {
  const cfg = loadConfig();
  const { adzuna_app_id, adzuna_app_key, adzuna_country } = cfg;
  if (!adzuna_app_id) return json(res, 503, { error: 'not_configured' });

  const q = url.parse(req.url, true).query;
  const params = new URLSearchParams({
    app_id:         adzuna_app_id,
    app_key:        adzuna_app_key,
    'content-type': 'application/json',
  });
  if (q.location0) params.set('location0', q.location0);
  if (q.location1) params.set('location1', q.location1);
  if (q.category)  params.set('category',  q.category);
  if (q.months)    params.set('months',    q.months);

  const apiUrl = `https://api.adzuna.com/v1/api/jobs/${adzuna_country}/history?${params}`;
  console.log('[Adzuna] History GET', apiUrl.replace(adzuna_app_key, '***'));

  https.get(apiUrl, apiRes => {
    let body = '';
    apiRes.on('data', chunk => body += chunk);
    apiRes.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    });
  }).on('error', err => json(res, 502, { error: 'fetch_failed', message: err.message }));
}

/* ── GET /api/categories ── */
function proxyCategories(req, res) {
  const cfg = loadConfig();
  const { adzuna_app_id, adzuna_app_key, adzuna_country } = cfg;
  if (!adzuna_app_id) return json(res, 503, { error: 'not_configured' });

  const params = new URLSearchParams({
    app_id:         adzuna_app_id,
    app_key:        adzuna_app_key,
    'content-type': 'application/json',
  });

  const apiUrl = `https://api.adzuna.com/v1/api/jobs/${adzuna_country}/categories?${params}`;
  console.log('[Adzuna] Categories GET', apiUrl.replace(adzuna_app_key, '***'));

  https.get(apiUrl, apiRes => {
    let body = '';
    apiRes.on('data', chunk => body += chunk);
    apiRes.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public,max-age=86400' });
      res.end(body);
    });
  }).on('error', err => json(res, 502, { error: 'fetch_failed', message: err.message }));
}

/* ── GET /api/geodata ── */
function proxyGeodata(req, res) {
  const cfg = loadConfig();
  const { adzuna_app_id, adzuna_app_key, adzuna_country } = cfg;
  if (!adzuna_app_id) return json(res, 503, { error: 'not_configured' });

  const q = url.parse(req.url, true).query;
  const params = new URLSearchParams({
    app_id:         adzuna_app_id,
    app_key:        adzuna_app_key,
    'content-type': 'application/json',
  });
  if (q.location0) params.set('location0', q.location0);
  if (q.location1) params.set('location1', q.location1);
  if (q.category)  params.set('category',  q.category);

  const apiUrl = `https://api.adzuna.com/v1/api/jobs/${adzuna_country}/geodata?${params}`;
  console.log('[Adzuna] Geodata GET', apiUrl.replace(adzuna_app_key, '***'));

  https.get(apiUrl, apiRes => {
    let body = '';
    apiRes.on('data', chunk => body += chunk);
    apiRes.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    });
  }).on('error', err => json(res, 502, { error: 'fetch_failed', message: err.message }));
}

/* ── POST /api/set-user-type ── */
async function handleSetUserType(req, res) {
  const cfg   = loadConfig();
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();

  if (!token) return json(res, 401, { error: 'no_token' });
  if (!cfg.clerk_secret_key) return json(res, 503, { error: 'clerk_not_configured' });

  const body = await readBody(req);
  const { userType, company } = body;

  if (!userType || !['jobseeker', 'employer'].includes(userType)) {
    return json(res, 400, { error: 'invalid_userType' });
  }

  try {
    const payload = await verifyToken(token, {
      secretKey:         cfg.clerk_secret_key,
      publishableKey:    cfg.clerk_publishable_key,
      authorizedParties: ['https://otterboard.nl', 'http://localhost:3000'],
    });
    const userId      = payload.sub;
    const clerkClient = createClerkClient({ secretKey: cfg.clerk_secret_key });

    const metadata = { userType };
    if (company) metadata.company = company;

    await clerkClient.users.updateUserMetadata(userId, { publicMetadata: metadata });
    json(res, 200, { ok: true });
  } catch (err) {
    console.error('[Clerk] set-user-type error:', err.message);
    json(res, 500, { error: err.message });
  }
}

/* ── Alert jobs ── */
function fetchAlertJobs(keywords, cfg) {
  return new Promise((resolve, reject) => {
    const { adzuna_app_id, adzuna_app_key, adzuna_country = 'nl' } = cfg;
    const params = new URLSearchParams({
      app_id:           adzuna_app_id,
      app_key:          adzuna_app_key,
      results_per_page: '5',
      what:             keywords,
      sort_by:          'date',
    });
    const apiUrl = `https://api.adzuna.com/v1/api/jobs/${adzuna_country}/search/1?${params}`;
    https.get(apiUrl, apiRes => {
      let body = '';
      apiRes.on('data', c => body += c);
      apiRes.on('end', () => {
        try { resolve(JSON.parse(body).results || []); }
        catch { resolve([]); }
      });
    }).on('error', reject);
  });
}

function buildEmailHtml(jobs, prefs, siteUrl) {
  const rows = jobs.map(j => {
    const title    = j.title || 'Untitled';
    const company  = j.company?.display_name || '';
    const location = j.location?.display_name || '';
    const salary   = (j.salary_min && j.salary_max)
      ? `€${Math.round(j.salary_min).toLocaleString('nl-NL')} – €${Math.round(j.salary_max).toLocaleString('nl-NL')}`
      : '';
    const jobUrl   = j.redirect_url || `${siteUrl}/?q=${encodeURIComponent(j.title || '')}`;
    const created  = j.created ? new Date(j.created).toLocaleDateString('nl-NL', { day:'numeric', month:'short' }) : '';
    return `
      <tr><td style="padding:16px;border-bottom:1px solid #e5e7eb;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td>
            <a href="${jobUrl}" style="font-size:16px;font-weight:700;color:#1a56db;text-decoration:none;">${title}</a>
            <div style="font-size:13px;color:#4b5563;margin-top:3px;">${company}${location ? ` · ${location}` : ''}</div>
            ${salary  ? `<div style="font-size:13px;color:#057a55;margin-top:3px;font-weight:600;">${salary}</div>` : ''}
            ${created ? `<div style="font-size:12px;color:#9ca3af;margin-top:3px;">Posted ${created}</div>` : ''}
          </td>
          <td style="text-align:right;vertical-align:middle;padding-left:16px;">
            <a href="${jobUrl}" style="background:#1a56db;color:#fff;text-decoration:none;padding:8px 18px;border-radius:99px;font-size:13px;font-weight:700;white-space:nowrap;">View Job</a>
          </td>
        </tr></table>
      </td></tr>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;">
    <tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="background:#1a56db;border-radius:12px 12px 0 0;padding:24px 32px;text-align:center;">
        <img src="${siteUrl}/favicon.png" alt="OtterBoard" width="64" height="64" style="display:block;margin:0 auto 8px;border-radius:14px;" />
        <div style="color:#fff;font-size:13px;margin-top:4px;font-weight:500;">Your job alert — new matches found</div>
      </td></tr>
      <tr><td style="background:#fff;padding:20px 32px 12px;">
        <p style="margin:0;font-size:14px;color:#374151;">We found <strong>${jobs.length} new job${jobs.length !== 1 ? 's' : ''}</strong> matching <strong>"${prefs.keywords}"</strong>.</p>
      </td></tr>
      <tr><td style="background:#fff;padding:0 16px;">
        <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      </td></tr>
      <tr><td style="background:#fff;border-radius:0 0 12px 12px;padding:20px 32px;border-top:1px solid #e5e7eb;">
        <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">
          You're receiving this because you set up job alerts on OtterBoard.<br>
          <a href="${siteUrl}" style="color:#1a56db;">Go to OtterBoard</a>
        </p>
      </td></tr>
    </table></td></tr>
  </table>
</body></html>`;
}

/* ── POST /api/contact ── */
async function handleContact(req, res) {
  const cfg = loadConfig();
  if (!cfg.smtp_user || !cfg.smtp_pass) {
    return json(res, 503, { error: 'smtp_not_configured' });
  }
  const { name, email, phone, reason, userType, message, lang } = await readBody(req);
  if (!name || !email || !message) return json(res, 400, { error: 'missing_fields' });

  const port = parseInt(cfg.smtp_port) || 465;
  const transporter = nodemailer.createTransport({
    host: cfg.smtp_host || 'mail.privateemail.com',
    port,
    secure: port !== 587,
    auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
  });

  const reasonLabels = { question: 'A question', feedback: 'Feedback', other: 'Something else' };
  const userTypeLabels = { jobseeker: 'Job seeker', employer: 'Employer', other: 'Other' };

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;">
    <tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="background:#1a56db;border-radius:12px 12px 0 0;padding:24px 32px;text-align:center;">
        <img src="${cfg.site_url}/favicon.png" alt="OtterBoard" width="56" height="56" style="display:block;margin:0 auto 8px;border-radius:12px;" />
        <div style="color:#fff;font-size:13px;font-weight:500;">New contact form message</div>
      </td></tr>
      <tr><td style="background:#fff;padding:24px 32px;border-radius:0 0 12px 12px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;color:#6b7280;width:140px;">Reason</td><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;">${reasonLabels[reason] || reason || '—'}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;color:#6b7280;">I am a</td><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;">${userTypeLabels[userType] || userType || '—'}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;color:#6b7280;">Name</td><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;">${name}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;color:#6b7280;">Email</td><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;"><a href="mailto:${email}" style="color:#1a56db;">${email}</a></td></tr>
          ${phone ? `<tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;color:#6b7280;">Phone</td><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;">${phone}</td></tr>` : ''}
        </table>
        <p style="margin:20px 0 6px;font-size:13px;font-weight:700;color:#111827;">Message</p>
        <p style="margin:0;font-size:14px;color:#374151;white-space:pre-wrap;">${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
        <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;">Sent from the OtterBoard contact form · <a href="${cfg.site_url}" style="color:#1a56db;">otterboard.nl</a></p>
      </td></tr>
    </table></td></tr>
  </table>
</body></html>`;

  await transporter.sendMail({
    from:    cfg.smtp_from,
    to:      process.env.CONTACT_EMAIL || 'info@otterboard.nl',
    replyTo: `${name} <${email}>`,
    subject: `OtterBoard contact: ${reasonLabels[reason] || reason} — ${name}`,
    html,
  });

  json(res, 200, { ok: true });
}

/* ── POST /api/send-alert ── */
async function handleSendAlert(req, res) {
  const cfg = loadConfig();
  if (!cfg.smtp_user || !cfg.smtp_pass) {
    return json(res, 503, { error: 'smtp_not_configured' });
  }
  const { to, prefs } = await readBody(req);
  if (!to || !prefs?.keywords) return json(res, 400, { error: 'missing_fields' });

  const jobs = await fetchAlertJobs(prefs.keywords, cfg);
  if (!jobs.length) return json(res, 200, { sent: false, message: 'No matching jobs found.' });

  const port = parseInt(cfg.smtp_port) || 465;
  const transporter = nodemailer.createTransport({
    host: cfg.smtp_host || 'mail.privateemail.com',
    port,
    secure: port !== 587,
    auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
  });

  await transporter.sendMail({
    from:    cfg.smtp_from,
    to,
    subject: `🦦 ${jobs.length} new job${jobs.length !== 1 ? 's' : ''} matching "${prefs.keywords}" — OtterBoard`,
    html:    buildEmailHtml(jobs, prefs, cfg.site_url),
  });

  json(res, 200, { sent: true, count: jobs.length });
}

/* ── MongoDB ── */
const ADMIN_EMAIL = 'razvancsk@gmail.com';
let _db = null;

async function getDb() {
  if (_db) return _db;
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.warn('[DB] MONGODB_URI not set — using in-memory fallback'); return null; }
  const client = new MongoClient(uri);
  await client.connect();
  _db = client.db('otterboard');
  console.log('[DB] MongoDB connected');
  return _db;
}

async function getInternalJobs() {
  const db = await getDb();
  if (!db) return _memJobs;
  return db.collection('jobs').find().sort({ created: -1 }).toArray();
}
async function saveInternalJob(job) {
  const db = await getDb();
  if (!db) { _memJobs.unshift(job); return; }
  await db.collection('jobs').insertOne(job);
}
async function deleteInternalJob(id) {
  const db = await getDb();
  if (!db) { _memJobs = _memJobs.filter(j => j.id !== id); return; }
  await db.collection('jobs').deleteOne({ id });
}
async function getApplications() {
  const db = await getDb();
  if (!db) return _memApps;
  return db.collection('applications').find().sort({ appliedAt: -1 }).toArray();
}
async function saveApplication(app) {
  const db = await getDb();
  if (!db) { _memApps.push(app); return; }
  await db.collection('applications').insertOne(app);
}
async function findApplication(id) {
  const db = await getDb();
  if (!db) return _memApps.find(a => a.id === id) || null;
  return db.collection('applications').findOne({ id });
}

// In-memory fallback (lost on restart, but works for local dev without MONGODB_URI)
let _memJobs = [];
let _memApps = [];

async function getAuthUser(req, cfg) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token || !cfg.clerk_secret_key) return null;
  try {
    const payload = await verifyToken(token, {
      secretKey: cfg.clerk_secret_key,
      publishableKey: cfg.clerk_publishable_key,
      authorizedParties: ['https://otterboard.nl', 'http://localhost:3000'],
    });
    const cc   = createClerkClient({ secretKey: cfg.clerk_secret_key });
    const u    = await cc.users.getUser(payload.sub);
    const email = u.emailAddresses.find(e => e.id === u.primaryEmailAddressId)?.emailAddress || '';
    return { userId: payload.sub, email, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || email, isAdmin: email === ADMIN_EMAIL };
  } catch { return null; }
}

/* ── GET /api/internal-jobs ── */
async function handleGetInternalJobs(req, res) {
  json(res, 200, await getInternalJobs());
}

/* ── POST /api/internal-jobs ── */
async function handlePostInternalJob(req, res) {
  const cfg  = loadConfig();
  const user = await getAuthUser(req, cfg);
  if (!user || !user.isAdmin) return json(res, 403, { error: 'forbidden' });
  const body = await readBody(req);
  const { title, company, location, salary_min, salary_max, salary_value, salary_type, salary_period, description, work_type, contract_type } = body;
  if (!title || !description) return json(res, 400, { error: 'title and description required' });
  const job = {
    id: `ob_${Date.now()}`,
    isInternal: true,
    title,
    company: company || 'OtterBoard',
    location: location || 'Netherlands',
    salary_type:   salary_type   || 'range',
    salary_period: salary_period || 'month',
    salary_value:  Number(salary_value) || null,
    salary_min:    Number(salary_min)   || null,
    salary_max:    Number(salary_max)   || null,
    description,
    work_type:     work_type     || 'on-site',
    contract_type: contract_type || 'full-time',
    created: new Date().toISOString(),
  };
  await saveInternalJob(job);
  json(res, 200, { ok: true, job });
}

/* ── DELETE /api/internal-jobs/:id ── */
async function handleDeleteInternalJob(req, res, jobId) {
  const cfg  = loadConfig();
  const user = await getAuthUser(req, cfg);
  if (!user || !user.isAdmin) return json(res, 403, { error: 'forbidden' });
  await deleteInternalJob(jobId);
  json(res, 200, { ok: true });
}

/* ── POST /api/apply ── */
async function handleApply(req, res) {
  const cfg  = loadConfig();
  const user = await getAuthUser(req, cfg);
  if (!user) return json(res, 401, { error: 'login_required' });
  const { jobId, name, email, phone, message, cvBase64, cvName } = await readBody(req);
  if (!jobId || !name || !email) return json(res, 400, { error: 'missing_fields' });
  const jobs = await getInternalJobs();
  const job  = jobs.find(j => j.id === jobId);
  if (!job) return json(res, 404, { error: 'job_not_found' });
  const apps = await getApplications();
  if (apps.some(a => a.jobId === jobId && a.userId === user.userId)) {
    return json(res, 400, { error: 'already_applied' });
  }
  await saveApplication({
    id: `app_${Date.now()}`,
    jobId,
    jobTitle: job.title,
    userId: user.userId,
    name,
    email,
    phone:    phone   || '',
    message:  message || '',
    cvBase64: cvBase64 || null,
    cvName:   cvName   || null,
    appliedAt: new Date().toISOString(),
  });
  json(res, 200, { ok: true });
}

/* ── GET /api/applications ── */
async function handleGetApplications(req, res) {
  const cfg  = loadConfig();
  const user = await getAuthUser(req, cfg);
  if (!user || !user.isAdmin) return json(res, 403, { error: 'forbidden' });
  const apps = (await getApplications()).map(({ cvBase64, ...rest }) => rest);
  json(res, 200, apps);
}

/* ── GET /api/applications/:id/cv ── */
async function handleGetCV(req, res, appId) {
  const cfg  = loadConfig();
  const user = await getAuthUser(req, cfg);
  if (!user || !user.isAdmin) return json(res, 403, { error: 'forbidden' });
  const app = await findApplication(appId);
  if (!app || !app.cvBase64) return json(res, 404, { error: 'not_found' });
  json(res, 200, { cvBase64: app.cvBase64, cvName: app.cvName });
}

/* ── HTTP server ── */
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const pathname = url.parse(req.url).pathname;

  // Redirect .html URLs to clean URLs
  if (pathname.endsWith('.html')) {
    const clean = pathname === '/index.html' ? '/' : pathname.slice(0, -5);
    res.writeHead(301, { Location: clean });
    res.end();
    return;
  }

  if (pathname === '/api/jobs')                                         { proxyAdzuna(req, res); return; }
  if (pathname === '/api/salary-history'  && req.method === 'GET')       { proxySalaryHistory(req, res); return; }
  if (pathname === '/api/geodata'         && req.method === 'GET')       { proxyGeodata(req, res); return; }
  if (pathname === '/api/categories'      && req.method === 'GET')       { proxyCategories(req, res); return; }
  if (pathname === '/api/set-user-type'  && req.method === 'POST')      { handleSetUserType(req, res); return; }
  if (pathname === '/api/send-alert'     && req.method === 'POST')      { handleSendAlert(req, res); return; }
  if (pathname === '/api/contact'        && req.method === 'POST')      { handleContact(req, res); return; }
  if (pathname === '/api/internal-jobs'  && req.method === 'GET')       { handleGetInternalJobs(req, res); return; }
  if (pathname === '/api/internal-jobs'  && req.method === 'POST')      { handlePostInternalJob(req, res); return; }
  if (pathname === '/api/apply'          && req.method === 'POST')      { handleApply(req, res); return; }
  if (pathname === '/api/applications'   && req.method === 'GET')       { handleGetApplications(req, res); return; }
  const deleteJobMatch = pathname.match(/^\/api\/internal-jobs\/([^/]+)$/);
  if (deleteJobMatch && req.method === 'DELETE') { handleDeleteInternalJob(req, res, deleteJobMatch[1]); return; }
  const cvMatch = pathname.match(/^\/api\/applications\/([^/]+)\/cv$/);
  if (cvMatch && req.method === 'GET') { handleGetCV(req, res, cvMatch[1]); return; }
  if (pathname === '/clerk.js') {
    const clerkPath = path.join(ROOT, 'node_modules/@clerk/clerk-js/dist/clerk.browser.js');
    fs.readFile(clerkPath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public,max-age=86400' });
      res.end(data);
    });
    return;
  }

  let filePath = path.join(ROOT, pathname === '/' ? '/index.html' : pathname);
  let ext      = path.extname(filePath);

  // Clean URL support: /salary → salary.html, /admin → admin.html
  if (!ext) filePath = filePath + '.html', ext = '.html';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => {
  const cfg = loadConfig();
  console.log(`\n  OtterBoard running on port ${PORT}`);
  console.log(`  Clerk: ${cfg.clerk_publishable_key ? 'configured ✓' : 'NOT configured'}\n`);
});
