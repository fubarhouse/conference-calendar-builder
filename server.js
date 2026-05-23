import express from 'express';
import multer from 'multer';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, join, dirname, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DATA_DIR = join(ROOT, 'data');
const IMG_DIR = join(ROOT, 'img');

function guardPath(base, sub) {
  const full = resolve(join(base, sub));
  return full === base || full.startsWith(base + sep) ? full : null;
}

const app = express();

// Serve static files (the editor app itself)
app.use(express.static(ROOT));

// Health check for connection testing
app.get('/api/health', (_, res) => res.json({ ok: true }));

// Read a data file
app.get('/api/data/:file', async (req, res) => {
  const target = guardPath(DATA_DIR, req.params.file);
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try {
    const raw = await readFile(target, 'utf8');
    res.type('json').send(raw);
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// Write a data file — receives raw JSON text to preserve formatting
app.put('/api/data/:file', express.text({ type: 'application/json', limit: '10mb' }), async (req, res) => {
  if (!req.params.file.endsWith('.json')) return res.status(400).json({ error: 'JSON files only' });
  const target = guardPath(DATA_DIR, req.params.file);
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try {
    JSON.parse(req.body); // validate before writing
    await writeFile(target, req.body, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Upload an image into img/
const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const targetRelative = String(req.body.targetPath || '').trim().replace(/^\.\//, '');
  if (!targetRelative || !targetRelative.startsWith('img/')) {
    return res.status(400).json({ error: 'targetPath must start with img/' });
  }
  const target = guardPath(IMG_DIR, targetRelative.slice(4)); // strip "img/"
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, req.file.buffer);
    res.json({ ok: true, path: `./${targetRelative}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = parseInt(process.env.PORT || '8080', 10);
app.listen(PORT, () => {
  console.log(`Editor server → http://localhost:${PORT}`);
  console.log(`  editor.html → http://localhost:${PORT}/editor.html`);
});
