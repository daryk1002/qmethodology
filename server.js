const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const BASE = '/qsailors';

app.use(express.json({ limit: '10mb' }));
app.use(BASE, express.static(__dirname, { index: false }));

// ============== Data helpers ==============
function readData() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    // Migrate old format (single config/responses) to multi-study
    if (raw.config && !raw.studies) {
      const id = generateId();
      raw.studies = [{ id, config: raw.config, responses: raw.responses || [] }];
      raw.admins = raw.admins || [];
      delete raw.config;
      delete raw.responses;
      writeData(raw);
    }
    return { admins: raw.admins || [], studies: raw.studies || [] };
  } catch {
    return { admins: [], studies: [] };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateId() {
  return crypto.randomBytes(6).toString('hex');
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

function findAdmin(data, username) {
  return data.admins.find(a => a.username === username);
}

function findStudy(data, studyId) {
  return data.studies.find(s => s.id === studyId);
}

// ============== Auth ==============
app.post(`${BASE}/api/register`, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

  const data = readData();
  if (findAdmin(data, username)) return res.status(409).json({ error: 'Username already exists' });

  data.admins.push({ username, passwordHash: hashPassword(password), createdAt: new Date().toISOString() });
  writeData(data);
  res.json({ ok: true, username });
});

app.post(`${BASE}/api/login`, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const data = readData();
  const admin = findAdmin(data, username);
  if (!admin || admin.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  res.json({ ok: true, username });
});

// ============== API: Studies (multi-study) ==============
app.get(`${BASE}/api/studies`, (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  const data = readData();
  const studies = data.studies.filter(s => s.owner === username);
  res.json(studies.map(s => ({
    id: s.id,
    projectName: s.config?.projectName || '(untitled)',
    statementsCount: s.config?.statements?.length || 0,
    responsesCount: s.responses?.length || 0,
    createdAt: s.createdAt
  })));
});

app.post(`${BASE}/api/studies`, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  const data = readData();
  const study = {
    id: generateId(),
    owner: username,
    config: null,
    responses: [],
    createdAt: new Date().toISOString()
  };
  data.studies.push(study);
  writeData(data);
  res.json({ ok: true, id: study.id });
});

app.delete(`${BASE}/api/studies/:id`, (req, res) => {
  const { username } = req.query;
  const data = readData();
  const idx = data.studies.findIndex(s => s.id === req.params.id && s.owner === username);
  if (idx === -1) return res.status(404).json({ error: 'Study not found' });
  data.studies.splice(idx, 1);
  writeData(data);
  res.json({ ok: true });
});

// ============== API: Config (per study) ==============
app.get(`${BASE}/api/studies/:id/config`, (req, res) => {
  const data = readData();
  const study = findStudy(data, req.params.id);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  res.json(study.config || null);
});

app.post(`${BASE}/api/studies/:id/config`, (req, res) => {
  const data = readData();
  const study = findStudy(data, req.params.id);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  study.config = req.body;
  writeData(data);
  res.json({ ok: true });
});

// ============== API: Responses (per study) ==============
app.get(`${BASE}/api/studies/:id/responses`, (req, res) => {
  const data = readData();
  const study = findStudy(data, req.params.id);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  res.json(study.responses || []);
});

app.post(`${BASE}/api/studies/:id/responses`, (req, res) => {
  const data = readData();
  const study = findStudy(data, req.params.id);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  const response = req.body;
  if (study.responses.some(r => r.participantId === response.participantId)) {
    return res.status(409).json({ error: 'Participant ID already exists' });
  }
  study.responses.push(response);
  writeData(data);
  res.json({ ok: true });
});

app.delete(`${BASE}/api/studies/:id/responses/:index`, (req, res) => {
  const data = readData();
  const study = findStudy(data, req.params.id);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  const idx = parseInt(req.params.index);
  if (idx >= 0 && idx < study.responses.length) {
    study.responses.splice(idx, 1);
    writeData(data);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

app.delete(`${BASE}/api/studies/:id/responses`, (req, res) => {
  const data = readData();
  const study = findStudy(data, req.params.id);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  study.responses = [];
  writeData(data);
  res.json({ ok: true });
});

// ============== API: Export XLSX (per study) ==============
app.get(`${BASE}/api/studies/:id/export`, (req, res) => {
  const data = readData();
  const study = findStudy(data, req.params.id);
  if (!study || !study.config) return res.status(400).json({ error: 'No config' });
  const cfg = study.config;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[cfg.projectName || 'Q Study']]), 'name');

  const stmtData = [['Number', 'Statements']];
  cfg.statements.forEach((s, i) => stmtData.push([i + 1, s]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(stmtData), 'statements');

  const scores = Object.keys(cfg.pattern).map(Number).sort((a, b) => a - b);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([scores, scores.map(s => cfg.pattern[s])]), 'pattern');

  const sortsData = study.responses.map(r => [r.participantId, ...r.scores]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sortsData.length ? sortsData : [[]]), 'sorts');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Version'], [2]]), 'version');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Type'], [2]]), 'type');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = (cfg.projectName || 'qstudy').replace(/[^a-zA-Z0-9_-]/g, '_') + '_kenq.xlsx';
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.get(`${BASE}/api/studies/:id/export-demographics`, (req, res) => {
  const data = readData();
  const study = findStudy(data, req.params.id);
  if (!study || !study.config) return res.status(400).json({ error: 'No config' });
  const cfg = study.config;

  const questions = cfg.demoQuestions || [];
  const headers = ['Participant ID', 'Timestamp', ...questions.map(q => q.text)];
  const rows = study.responses.map(r => {
    const demo = r.demographics || {};
    return [r.participantId, r.timestamp || '', ...questions.map(q => demo[q.text] || '')];
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...rows]), 'Respondent Info');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = (cfg.projectName || 'qstudy').replace(/[^a-zA-Z0-9_-]/g, '_') + '_respondent_info.xlsx';
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ============== Serve the app ==============
const htmlFile = path.join(__dirname, 'q-method-collector_simple.html');

app.get(`${BASE}`, (req, res) => res.sendFile(htmlFile));
app.get(`${BASE}/`, (req, res) => res.sendFile(htmlFile));
app.get(`${BASE}/admin`, (req, res) => res.sendFile(htmlFile));
app.get(`${BASE}/sort/:studyId`, (req, res) => res.sendFile(htmlFile));
app.get(`${BASE}/sort/:studyId/:pid`, (req, res) => res.sendFile(htmlFile));

// Redirect root to base
app.get('/', (req, res) => res.redirect(BASE));

app.listen(PORT, () => {
  console.log(`Q Method Collector running at http://localhost:${PORT}${BASE}`);
  console.log(`Admin:      http://localhost:${PORT}${BASE}/admin`);
  console.log(`Respondent: http://localhost:${PORT}${BASE}/sort/STUDY_ID`);
});
