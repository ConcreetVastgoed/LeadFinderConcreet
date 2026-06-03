/**
 * Bestemmingsradar — Express server
 * - Serveert de statische frontend (public/)
 * - Proxiet de BAG individuele-bevragingen API en de Ruimtelijke Plannen API
 *   zodat je API-keys server-side blijven en CORS geen probleem is.
 * - Geeft de (publieke) Supabase-config door aan de frontend.
 *
 * Alle keys komen uit environment variables — niets staat in deze code.
 */
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const BAG_KEY = process.env.BAG_API_KEY;
const RP_KEY  = process.env.RP_API_KEY;

const BAG_BASE = 'https://api.bag.kadaster.nl/lvbag/individuelebevragingen/v2';
const RP_BASE  = 'https://ruimte.omgevingswet.overheid.nl/ruimtelijke-plannen/api/opvragen/v4';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* Publieke config voor de frontend (anon key mag client-side, met RLS in Supabase). */
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    rpEnabled: !!RP_KEY,
    bagEnabled: !!BAG_KEY
  });
});

/* ---- BAG proxy (detailverrijking van een pand) ----
   Frontend roept bv. /api/bag/adressenuitgebreid?pandIdentificatie=... aan. */
app.all('/api/bag/*', async (req, res) => {
  if (!BAG_KEY) return res.status(503).json({ error: 'BAG_API_KEY niet ingesteld' });
  const tail = req.originalUrl.replace(/^\/api\/bag/, '');
  try {
    const r = await fetch(BAG_BASE + tail, {
      method: req.method,
      headers: {
        'X-Api-Key': BAG_KEY,
        'Accept-Crs': 'epsg:28992',
        'Accept': 'application/hal+json'
      }
    });
    const body = await r.text();
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(body);
  } catch (e) {
    res.status(502).json({ error: 'BAG proxy fout', detail: e.message });
  }
});

/* ---- Ruimtelijke Plannen proxy ----
   Frontend doet bv. POST /api/rp/bestemmingsvlakken/_zoek met een _geo-body. */
app.all('/api/rp/*', async (req, res) => {
  if (!RP_KEY) return res.status(503).json({ error: 'RP_API_KEY niet ingesteld' });
  const tail = req.originalUrl.replace(/^\/api\/rp/, '');
  try {
    const opts = {
      method: req.method,
      headers: {
        'x-api-key': RP_KEY,
        'Content-Type': 'application/json',
        'Content-Crs': req.get('Content-Crs') || 'epsg:28992',
        'Accept-Crs': req.get('Accept-Crs') || 'epsg:4326',
        'Accept': 'application/hal+json'
      }
    };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Object.keys(req.body).length) {
      opts.body = JSON.stringify(req.body);
    }
    const r = await fetch(RP_BASE + tail, opts);
    const body = await r.text();
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(body);
  } catch (e) {
    res.status(502).json({ error: 'RP proxy fout', detail: e.message });
  }
});

app.listen(PORT, () => console.log(`Bestemmingsradar draait op poort ${PORT}`));
