const http       = require('http');
const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const url        = require('url');
const nodemailer = require('nodemailer');
const { createClerkClient, verifyToken } = require('@clerk/backend');

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
  });
  if (q.what)           params.set('what',          q.what);
  if (q.where)          params.set('where',          q.where);
  if (q.sort_by)        params.set('sort_by',        q.sort_by);
  if (q.sort_direction) params.set('sort_direction', q.sort_direction);
  if (q.distance)       params.set('distance',       q.distance);

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
    const jobUrl   = `${siteUrl}/?job=${encodeURIComponent(j.id)}&q=${encodeURIComponent(j.title || '')}`;
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

  if (pathname === '/api/jobs')                                    { proxyAdzuna(req, res); return; }
  if (pathname === '/api/set-user-type' && req.method === 'POST') { handleSetUserType(req, res); return; }
  if (pathname === '/api/send-alert'    && req.method === 'POST') { handleSendAlert(req, res); return; }
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

  // Clean URL support: /salary → salary.html
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
