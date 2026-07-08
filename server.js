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

/* ===================== Gemeente-scan (server-side bulk) ===================== */
const proj4 = require('proj4');
proj4.defs('EPSG:28992','+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs');
const toRD = (lng,lat)=>proj4('EPSG:4326','EPSG:28992',[lng,lat]);
const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_ANON_KEY;
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
const norm = s=>(s||'').toLowerCase().replace(/[\s\-_]/g,'');
const mercM = (lat,lng)=>{const R=6378137;return [R*lng*Math.PI/180, R*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))];};

function pip(x,y,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1];if(((yi>y)!=(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi))inside=!inside;}return inside;}
function polyHit(x,y,rings){if(!rings||!rings.length||!pip(x,y,rings[0]))return false;for(let k=1;k<rings.length;k++)if(pip(x,y,rings[k]))return false;return true;}
function pointInGeom(pt,geom){if(!geom)return false;const [x,y]=pt;if(geom.type==='Polygon')return polyHit(x,y,geom.coordinates);if(geom.type==='MultiPolygon')return geom.coordinates.some(p=>polyHit(x,y,p));return false;}

async function sbInsert(table,rows){return fetch(`${SB_URL}/rest/v1/${table}`,{method:'POST',headers:{apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`,'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify(rows)}).then(r=>r.json());}
async function sbPatch(table,id,patch){await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}`,{method:'PATCH',headers:{apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(patch)});}

async function rpZoekS(path,body,withGeom){
  const r=await fetch(`${RP_BASE}/${path}/_zoek?pageSize=200${withGeom?'&expand=geometrie':''}`,{method:'POST',headers:{'x-api-key':RP_KEY,'Content-Type':'application/json','Content-Crs':'epsg:28992','Accept-Crs':'epsg:28992','Accept':'application/hal+json'},body:JSON.stringify(body)});
  if(!r.ok)return null; return r.json();
}
async function fetchBagCell(w,s,e,n){
  const sw=mercM(s,w), ne=mercM(n,e);
  const url=`https://service.pdok.nl/lv/bag/wfs/v2_0?service=WFS&version=2.0.0&request=GetFeature&typeName=bag:pand&outputFormat=application/json&srsName=EPSG:4326&count=4000&bbox=${sw[0]},${sw[1]},${ne[0]},${ne[1]},EPSG:3857`;
  const j=await (await fetch(url)).json();
  return ((j.features)||[]).map(f=>{
    const g=f.geometry; const ring=g&&(g.type==='Polygon'?g.coordinates[0]:(g.type==='MultiPolygon'?g.coordinates[0][0]:null));
    if(!ring)return null;
    let lx=0,ly=0; ring.forEach(c=>{lx+=c[0];ly+=c[1];}); const lng=lx/ring.length, lat=ly/ring.length;
    const raw=(f.properties.gebruiksdoel||'')+''; let gebruik=raw.split(/[;,]/).map(x=>x.trim().toLowerCase()).filter(Boolean);
    if(!gebruik.length)gebruik=['geen functie'];
    return {id:String(f.properties.identificatie||''),gebruik,lng,lat};
  }).filter(Boolean);
}
async function scanCell(w,s,e,n,functies,keywords){
  const panden=await fetchBagCell(w,s,e,n);
  if(!panden.length)return [];
  const ring=[[w,s],[e,s],[e,n],[w,n],[w,s]].map(([lo,la])=>toRD(lo,la));
  const geo={_geo:{intersects:{type:'Polygon',coordinates:[ring]}}};
  const pj=await rpZoekS('plannen',geo,false);
  let bp=((pj&&pj._embedded&&pj._embedded.plannen)||[]).filter(p=>/bestemmingsplan|beheersverordening|inpassingsplan/i.test(p.type||''));
  const isParaplu=p=>/paraplu|facet|parkeer|archeolog|cultuurhist|geluid|natuurbescherm/i.test((p.naam||'')+' '+(p.type||''));
  bp.sort((a,b)=>(isParaplu(a)?1:0)-(isParaplu(b)?1:0));
  const plannen=bp.map(p=>p.id||p.identificatie).filter(Boolean).slice(0,12);
  const targets=[];
  for(const id of plannen){
    for(const coll of ['bestemmingsvlakken','functieaanduidingen']){
      const j=await rpZoekS(`plannen/${encodeURIComponent(id)}/${coll}`,geo,true);
      const arr=(j&&j._embedded&&(j._embedded[coll]||Object.values(j._embedded)[0]))||[];
      arr.forEach(o=>{const naam=(o.naam||o.bestemmingshoofdgroep||'');const nl=naam.toLowerCase();if(!nl||nl.includes('uitgesloten')||!o.geometrie)return;if(keywords.some(k=>norm(naam).includes(norm(k))))targets.push({naam,geom:o.geometrie});});
    }
  }
  if(!targets.length)return [];
  const hits=[],seen=new Set();
  panden.forEach(p=>{
    if(!p.gebruik.some(g=>functies.includes(g)))return;
    const [rx,ry]=toRD(p.lng,p.lat);
    for(const t of targets){ if(pointInGeom([rx,ry],t.geom)){ if(!seen.has(p.id)){seen.add(p.id);hits.push({pand_id:p.id,gebruik:p.gebruik.join(', '),bestemming:t.naam,lat:p.lat,lng:p.lng});} break; } }
  });
  return hits;
}
async function runScan(jobId,bbox,functies,keywords){
  const latStep=0.007, lngStep=0.011; // ~0,7 km cellen
  const cells=[];
  for(let la=bbox.s; la<bbox.n; la+=latStep) for(let lo=bbox.w; lo<bbox.e; lo+=lngStep) cells.push([lo,la,Math.min(lo+lngStep,bbox.e),Math.min(la+latStep,bbox.n)]);
  await sbPatch('scan_jobs',jobId,{total_cells:cells.length,status:'bezig'});
  let done=0,hits=0;
  for(const [w,s,e,n] of cells){
    try{ const found=await scanCell(w,s,e,n,functies,keywords); if(found.length){ await sbInsert('scan_resultaten',found.map(f=>({job_id:jobId,...f}))); hits+=found.length; } }catch(err){}
    done++;
    if(done%3===0||done===cells.length) await sbPatch('scan_jobs',jobId,{done_cells:done,hits});
    await sleep(150);
  }
  await sbPatch('scan_jobs',jobId,{status:'klaar',done_cells:done,hits});
}

app.post('/api/scan/start', async (req,res)=>{
  if(!RP_KEY) return res.status(503).json({error:'RP_API_KEY niet ingesteld'});
  if(!SB_URL) return res.status(503).json({error:'Supabase niet ingesteld'});
  const {gemeente,functies,keywords}=req.body||{};
  if(!gemeente||!keywords||!keywords.length) return res.status(400).json({error:'gemeente en minimaal één trefwoord vereist'});
  try{
    const lu=await (await fetch(`https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=${encodeURIComponent(gemeente)}&fq=type:gemeente&rows=1&fl=weergavenaam,geometrie_ll`)).json();
    const doc=lu.response&&lu.response.docs&&lu.response.docs[0];
    if(!doc||!doc.geometrie_ll) return res.status(404).json({error:'gemeente niet gevonden'});
    const nums=(doc.geometrie_ll.match(/-?\d+\.\d+/g)||[]).map(Number);
    let w=999,s=999,e=-999,n=-999;
    for(let i=0;i+1<nums.length;i+=2){const lo=nums[i],la=nums[i+1];if(lo<w)w=lo;if(lo>e)e=lo;if(la<s)s=la;if(la>n)n=la;}
    const job=(await sbInsert('scan_jobs',[{gemeente:doc.weergavenaam,status:'gestart',functies:(functies||[]).join(','),keywords:keywords.join(',')}]))[0];
    res.json({job_id:job.id,gemeente:doc.weergavenaam});
    runScan(job.id,{w,s,e,n},functies||[],keywords).catch(()=>{});
  }catch(e){ res.status(502).json({error:e.message}); }
});
app.get('/api/scan/status', async (req,res)=>{
  if(!SB_URL) return res.status(503).json({error:'Supabase niet ingesteld'});
  try{
    const j=await (await fetch(`${SB_URL}/rest/v1/scan_jobs?id=eq.${encodeURIComponent(req.query.job)}`,{headers:{apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`}})).json();
    res.json(j[0]||{});
  }catch(e){ res.status(502).json({error:e.message}); }
});

app.listen(PORT, () => console.log(`Bestemmingsradar draait op poort ${PORT}`));
