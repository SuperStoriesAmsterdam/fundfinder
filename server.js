import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import slugify from 'slugify';
import { randomBytes, createHmac } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ── Data directories ──
const DIRS = ['data/intakes', 'data/feedback', 'data/master-kb', 'uploads'];
for (const dir of DIRS) {
  mkdirSync(join(__dirname, dir), { recursive: true });
}

// ── Middleware ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(join(__dirname, 'uploads')));

// ── Multer config ──
const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.txt'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function makeSlug(name) {
  const base = slugify(name, { lower: true, strict: true });
  const suffix = randomBytes(3).toString('hex');
  return `${base}-${suffix}`;
}

function moveFile(src, dest) {
  try {
    renameSync(src, dest);
  } catch {
    copyFileSync(src, dest);
    unlinkSync(src);
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = join(__dirname, 'uploads', 'tmp');
    mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    // Prefix with timestamp to avoid collisions
    const prefix = Date.now() + '-';
    cb(null, prefix + file.originalname);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Bestandstype ${ext} niet toegestaan. Toegestaan: ${ALLOWED_EXTENSIONS.join(', ')}`));
    }
  }
});

// ── Content JSON paths ──
const CONTENT_DIR = join(__dirname, 'data');
const CONTENT_FILES = {
  nl: join(CONTENT_DIR, 'content.json'),
  en: join(CONTENT_DIR, 'content-en.json')
};

// ── Admin auth middleware ──
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const COOKIE_SECRET = randomBytes(32).toString('hex');

function makeToken() {
  return createHmac('sha256', COOKIE_SECRET).update(ADMIN_PASSWORD).digest('hex');
}

function requireAdmin(req, res, next) {
  // Accept session cookie from previous Basic Auth login
  const cookie = req.headers.cookie || '';
  const token = cookie.split(';').map(c => c.trim()).find(c => c.startsWith('admin_token='));
  if (token && token.split('=')[1] === makeToken()) {
    return next();
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Toegang geweigerd.');
  }
  const decoded = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const password = decoded.split(':').slice(1).join(':');
  if (password !== ADMIN_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Onjuist wachtwoord.');
  }
  // Set session cookie so fetch calls from admin page are authenticated
  res.cookie('admin_token', makeToken(), { httpOnly: true, sameSite: 'strict' });
  next();
}

// ── Serve static HTML ──
app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.get('/admin', requireAdmin, (_req, res) => {
  res.sendFile(join(__dirname, 'admin.html'));
});

app.get('/feedback/:slug', (_req, res) => {
  res.sendFile(join(__dirname, 'feedback.html'));
});

// ── GET /api/content ──
app.get('/api/content', (req, res) => {
  const lang = (req.query.lang === 'en') ? 'en' : 'nl';
  const filePath = CONTENT_FILES[lang];
  try {
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      res.json(data);
    } else {
      res.status(404).json({ error: 'Content file not found' });
    }
  } catch {
    res.status(500).json({ error: 'Failed to read content' });
  }
});

// ── POST /api/content ──
app.post('/api/content', requireAdmin, (req, res) => {
  const lang = (req.query.lang === 'en') ? 'en' : 'nl';
  const filePath = CONTENT_FILES[lang];
  try {
    writeFileSync(filePath, JSON.stringify(req.body, null, 2));
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to save content' });
  }
});

// ── POST /api/intake ──
const REQUIRED_FIELDS = ['organisatie', 'contact', 'rol', 'watdoeje', 'project'];

app.post('/api/intake', upload.array('bestanden', 20), (req, res) => {
  // Validate required fields
  const missing = REQUIRED_FIELDS.filter(f => !req.body[f] || !req.body[f].trim());
  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      error: `Verplichte velden ontbreken: ${missing.join(', ')}`
    });
  }

  const slug = makeSlug(req.body.organisatie);
  const timestamp = new Date().toISOString();

  // Move uploaded files from tmp to slug directory
  const filesMeta = [];
  if (req.files && req.files.length > 0) {
    const slugDir = join(__dirname, 'uploads', slug);
    mkdirSync(slugDir, { recursive: true });

    for (const file of req.files) {
      const destPath = join(slugDir, file.originalname);
      moveFile(file.path, destPath);
      filesMeta.push({
        originalName: file.originalname,
        size: file.size,
        path: `/uploads/${slug}/${file.originalname}`
      });
    }
  }

  // Build intake data
  const intakeData = {
    id: slug,
    timestamp,
    organisatie: req.body.organisatie,
    kvk: req.body.kvk,
    contact: req.body.contact,
    rol: req.body.rol,
    rechtsvorm: req.body.rechtsvorm,
    watdoeje: req.body.watdoeje,
    project: req.body.project,
    eerdersubsidie: req.body.eerdersubsidie,
    bedrag: req.body.bedrag || null,
    deadline: req.body.deadline || null,
    partners: req.body.partners || null,
    website: req.body.website || null,
    handtekening: req.body.handtekening || null,
    bestanden: filesMeta
  };

  // Save JSON
  const filename = `${timestamp.replace(/[:.]/g, '-')}-${slug}.json`;
  writeFileSync(
    join(__dirname, 'data/intakes', filename),
    JSON.stringify(intakeData, null, 2)
  );

  console.log(`[intake] Saved: ${filename}`);

  res.json({ success: true, id: slug, timestamp });
});

// ── POST /api/feedback/:slug ──
app.post('/api/feedback/:slug', upload.array('bestanden', 20), (req, res) => {
  const { slug } = req.params;
  const timestamp = new Date().toISOString();

  // Move uploaded files from tmp to slug directory
  const filesMeta = [];
  if (req.files && req.files.length > 0) {
    const slugDir = join(__dirname, 'uploads', slug);
    mkdirSync(slugDir, { recursive: true });

    for (const file of req.files) {
      const destPath = join(slugDir, file.originalname);
      moveFile(file.path, destPath);
      filesMeta.push({
        originalName: file.originalname,
        size: file.size,
        path: `/uploads/${slug}/${file.originalname}`
      });
    }
  }

  const feedbackData = {
    slug,
    timestamp,
    fonds: req.body.fonds || '',
    typeContact: req.body.typeContact || '',
    typeFeedback: req.body.typeFeedback || '',
    datum: req.body.datum || '',
    samenvatting: req.body.samenvatting || '',
    kansInschatting: req.body.kansInschatting || '',
    bestanden: filesMeta
  };

  // Save in /data/feedback/{slug}/
  const feedbackDir = join(__dirname, 'data/feedback', slug);
  mkdirSync(feedbackDir, { recursive: true });

  const filename = `${timestamp.replace(/[:.]/g, '-')}.json`;
  writeFileSync(
    join(feedbackDir, filename),
    JSON.stringify(feedbackData, null, 2)
  );

  console.log(`[feedback] Saved: ${slug}/${filename}`);

  res.json({ success: true });
});

// ── GET /api/intakes ──
app.get('/api/intakes', (_req, res) => {
  const dir = join(__dirname, 'data/intakes');
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
    const intakes = files.map(f => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
    res.json(intakes);
  } catch {
    res.json([]);
  }
});

// ── GET /api/feedback/:slug ──
app.get('/api/feedback/:slug', (req, res) => {
  const dir = join(__dirname, 'data/feedback', req.params.slug);
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
    const feedback = files.map(f => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
    res.json(feedback);
  } catch {
    res.json([]);
  }
});

// ── Multer error handler ──
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, error: 'Bestand te groot. Maximum is 10MB per bestand.' });
    }
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// ── Start server ──
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Super Stories server running on port ${PORT}`);
  console.log(`Open: http://localhost:${PORT}`);
});
