import { useState, useCallback, useMemo } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, Cell, PieChart, Pie,
  RadarChart, Radar, PolarGrid, PolarAngleAxis
} from "recharts";

// ─────────────────────────────────────────────────────────────────────────────
// CSV PARSER — handles HMP2 format + generic microbiome CSVs
// ─────────────────────────────────────────────────────────────────────────────
const NON_TAXA_KEYWORDS = [
  'id','date','age','sex','bmi','diag','weight','visit','week','receipt',
  'participant','symptom','medic','diet','site','project','product','lane',
  'reads','human','viral','ribo','raw','filter','delta','interval','pdo',
  'gssr','lcset','wr ','aggreg','education','occup','scanned','ffq','yaq',
  'appendec','tonsil','biopsy','blood','serum','flora','rna','dna','ecp',
  'consent','race','hispanic','cancer','celiac','bronch','grave','hashimoto',
  'lupus','arthrit','sarcoid','sjogren','asthma','vitiligo','wegener',
  'withdraw','terminat','screen','inflam','crp','esr','location','endoscop',
  'baron','montreal','behavior','extent','lomotil','dipentum','rowasa',
  'canasa','flagyl','cipro','xifaxin','levaquin','antibiotic','prednisone',
  'entocort','imodium','solumedrol','steroids','cortenema','azathioprine',
  'methotrexate','mercaptopurine','vsl','remicade','humira','cimzia',
  'tysabri','asacol','pentasa','lialda','apriso','colozal','sulfasalaz',
  'surgery','endoscopy','histopath','radiology','disease_course','fatigue',
  'nausea','vomit','mouth','back pain','night sweat','appetite','weight loss',
  'health today','smoking','cigarette','marijuana','farm','daycare','prematur',
  'pets','hospital','breastfed','dental','toothbrush','mouthwash','floss',
  'tongue','whitener','sleep','relaxed','tension','angry','depressed','hopeless',
  'failure','unhappy','fearful','anxious','tense','nervous','worried','worthless',
  'helpless','anxious','sccai','sibdq','hbi','fecalcal','data_type','external',
  'number','has the','were you','did you','do you','in the past','if yes',
  'if no','please','subject','patient','study','research','pdo','project',
  'soft drink','fruit juice','water','alcohol','yogurt','dairy','probiotic',
  'fruit','vegetable','beans','grains','starch','eggs','meat','fish','sweets',
  'tea','coffee','colonoscopy','contrast','diarrhea','bowel','stool','tube',
  'sample','smoking','number years','age when','cigarettes','urgency','blood in',
  'well being','general','partial','total','score','reason','duration','type of',
  'was ','were ','have ','has ','is_','baseline','modified','partial',
  'ileum','rectum','colon','transverse','screening','uveitis','erythema',
  'pyoderma','aphthous','fistula','abscess','stricture','narrowing','skin',
  'fever','arthralgias','specify','stool_id','interval_days','projectspecific',
  'sor ', 'sor_','aggregated','# lanes','reads_','delta','intervalname',
  'intervalsequence','pdonumber','aggregatedlanes','wrid','gsrids'
];

function parseCSVLine(line) {
  const cols = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // Handle escaped quotes ""
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

function looksLikeTaxa(colName) {
  const low = colName.toLowerCase().trim();
  if (low.length < 2) return false;
  return !NON_TAXA_KEYWORDS.some(k => low.includes(k));
}

// Known HMP2 / clinical metadata columns to extract
const META_MAP = {
  patient_id:  ['participant id','participant_id','patient_id','patientid','subject id'],
  sample_date: ['date_of_receipt','date of receipt','sample_date','sampledate','collection_date','date'],
  week:        ['week_num','week num','visit_num','visit num'],
  age:         ['consent_age','age at diagnosis','age'],
  sex:         ['sex','gender'],
  bmi:         ['bmi'],
  diagnosis:   ['diagnosis'],
  site:        ['site_name','site name'],
  antibiotics: ['antibiotics','has the subject used any antibiotics since the last visit?'],
  diarrhea:    ['4) in the past 2 weeks, have you had diarrhea?'],
  fecalcal:    ['fecalcal_ng_ml','fecalcal'],
  hbi:         ['hbi'],
  sccai:       ['sccai'],
  data_type:   ['data_type'],
  inflamed:    ['is_inflamed'],
  hospitalized:['has the subject been hospitalized for any reason since the last study visit?'],
};

function findCol(headers, candidates) {
  for (const c of candidates) {
    const i = headers.findIndex(h => h.toLowerCase().trim() === c.toLowerCase());
    if (i >= 0) return i;
  }
  // partial match fallback
  for (const c of candidates) {
    const i = headers.findIndex(h => h.toLowerCase().includes(c.toLowerCase()));
    if (i >= 0) return i;
  }
  return -1;
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = parseCSVLine(lines[0]).map(h => h.replace(/^"|"$/g,''));

  // Map metadata columns
  const metaIdx = {};
  Object.entries(META_MAP).forEach(([key, candidates]) => {
    const i = findCol(headers, candidates);
    if (i >= 0) metaIdx[key] = i;
  });

  // Require at least patient_id
  if (metaIdx.patient_id === undefined) {
    // Try fallback: first column
    metaIdx.patient_id = 0;
  }

  // Identify taxa columns (numeric columns that aren't metadata)
  const metaIdxSet = new Set(Object.values(metaIdx));
  const taxaCols = headers
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => !metaIdxSet.has(i) && looksLikeTaxa(h))
    .map(({ h, i }) => i);
  const taxaNames = taxaCols.map(i => headers[i]);

  const records = [];
  const metaMap = {};

  lines.slice(1).forEach(line => {
    if (!line.trim()) return;
    const cols = parseCSVLine(line);

    const pid = cols[metaIdx.patient_id] || '';
    if (!pid) return;

    // Build meta
    const meta = {};
    Object.entries(metaIdx).forEach(([key, i]) => {
      meta[key] = cols[i] || '';
    });

    // Build sample_date from week_num if no real date
    if (!meta.sample_date || meta.sample_date === 'nan' || meta.sample_date === '') {
      const wk = meta.week || '0';
      meta.sample_date = `Week ${parseFloat(wk)||0}`;
    }

    if (!metaMap[pid]) metaMap[pid] = meta;

    // Taxa abundances (may be empty for metadata-only files)
    const abundances = taxaCols.map(i => parseFloat(cols[i]) || 0);
    const hasAbundance = abundances.some(v => v > 0);

    records.push({
      patient_id: pid,
      sample_date: meta.sample_date,
      week: parseFloat(meta.week) || 0,
      abundances,
      taxaNames,
      hasAbundance,
      meta,
    });
  });

  if (records.length === 0) throw new Error('No valid rows found. Check your CSV format.');

  const hasTaxa = records.some(r => r.hasAbundance) && taxaCols.length > 0;
  return { records, metaMap, hasTaxa, taxaCount: taxaCols.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────
function shannonIndex(a) {
  const t = a.reduce((s,v)=>s+v,0);
  if (!t) return 0;
  return -a.reduce((s,v)=>{ const p=v/t; return p>0?s+p*Math.log(p):s; },0);
}
function simpsonIndex(a) {
  const t = a.reduce((s,v)=>s+v,0);
  if (!t) return 0;
  return 1 - a.reduce((s,v)=>s+(v/t)**2,0);
}
function richness(a) { return a.filter(v=>v>0.01).length; }

function classifyEnterotype(record) {
  const get = name => { const i=record.taxaNames.indexOf(name); return i>=0?record.abundances[i]:0; };
  const b=get("Bacteroides"), p=get("Prevotella"), r=get("Ruminococcus");
  if (b>=p&&b>=r) return {type:"ET-1",dominant:"Bacteroides",color:"#f472b6",desc:"Bacteroides-dominant. Linked to high animal protein & fat diets."};
  if (p>=b&&p>=r) return {type:"ET-2",dominant:"Prevotella",color:"#4ade80",desc:"Prevotella-dominant. Associated with high-fiber, plant-rich diets."};
  return {type:"ET-3",dominant:"Ruminococcus",color:"#a78bfa",desc:"Ruminococcus-dominant. Associated with long-term dietary fiber intake."};
}

function calcGutScore(record, sh, si, ri) {
  const get = n => { const i=record.taxaNames.indexOf(n); return i>=0?record.abundances[i]:0; };
  const score = (v,mn,mx,w) => {
    if (v>=mn&&v<=mx) return w;
    if (v<mn) return w*Math.max(0,v/mn);
    return w*Math.max(0,(2*mx-v)/mx);
  };
  return Math.round(score(sh,3.0,4.5,25)+score(si,0.90,0.99,25)+score(ri,150,300,20)+
    score(get("Akkermansia"),0.5,5.0,10)+score(get("Faecalibacterium"),5.0,20.0,10)+score(get("Bifidobacterium"),2.0,15.0,10));
}

// ─────────────────────────────────────────────────────────────────────────────
// AI SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
async function generateAISummary(profile) {
  const prompt = `You are an expert gastroenterologist and microbiome clinician. Based on the data below, write a comprehensive patient profile in 4 paragraphs. 

Paragraph 1 — Patient Overview: Summarize who this patient is — their age, sex, diagnosis, and overall clinical picture. Estimate their general health status.

Paragraph 2 — Disease Activity & Trajectory: Analyze their clinical scores (HBI, SCCAI, fecal calprotectin) and whether their disease appears active, in remission, or worsening. If trend data is available, comment on whether they are improving or deteriorating over time.

Paragraph 3 — Microbiome & Gut Health: If microbiome data is available, interpret their diversity, enterotype, and keystone taxa. Estimate what this suggests about their gut ecosystem health. If no microbiome data is available, infer likely gut health from clinical indicators.

Paragraph 4 — Key Concerns & Recommendations: Highlight the most important clinical concerns for this patient and suggest what should be monitored or addressed. Be specific and actionable.

Use clinical language but keep it readable. Do not use bullet points. Make inferences where data is missing — this is an estimation, not just a summary.

--- PATIENT DATA ---
Patient ID: ${profile.pid}
Age: ${profile.age||"unknown"} | Sex: ${profile.sex||"unknown"} | BMI: ${profile.bmi||"unknown"}
Diagnosis: ${profile.diagnosis==="nonIBD"?"Healthy Control (nonIBD)":profile.diagnosis||"unknown"}
Study Site: ${profile.site||"unknown"}
Total visits tracked: ${profile.n}

CLINICAL INDICATORS (latest visit):
- Fecal Calprotectin: ${profile.fecalcal&&profile.fecalcal!=="nan" ? profile.fecalcal+" ng/mL (normal <50, elevated >200)" : "not available"}
- HBI Score (Crohn's activity): ${profile.hbi&&profile.hbi!=="nan" ? profile.hbi+" (remission <5, mild 5-7, moderate 8-16)" : "not available"}
- SCCAI Score (UC activity): ${profile.sccai&&profile.sccai!=="nan" ? profile.sccai+" (remission <3, active ≥3)" : "not available"}
- Diarrhea in past 2 weeks: ${profile.diarrhea||"unknown"}
- Antibiotics use: ${profile.antibiotics||"unknown"}

CLINICAL TREND OVER TIME (week: score):
${profile.clinicalTrend||"No trend data available"}

${profile.hasTaxa ? `MICROBIOME DATA (latest sample):
- Enterotype: ${profile.et?.type} (${profile.et?.dominant}-dominant) — ${profile.et?.desc}
- Gut Health Score: ${profile.score}/100
- Shannon Diversity: ${profile.shannon} (healthy range: 3.0–4.5)
- Simpson Diversity: ${profile.simpson} (healthy range: 0.90–0.99)
- Taxa Richness: ${profile.richness} species (healthy range: 150–300)
- Akkermansia: ${profile.akk}% (healthy: 0.5–5%)
- Faecalibacterium prausnitzii: ${profile.faec}% (healthy: 5–20%, anti-inflammatory)
- Bifidobacterium: ${profile.bifido}% (healthy: 2–15%)` : 
`MICROBIOME DATA: Not available in this dataset. Infer gut microbiome status from clinical indicators.`}`;

  const res = await fetch("/api/microbiome/summary", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ prompt })
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.summary || "Unable to generate summary.";
}

// ─────────────────────────────────────────────────────────────────────────────
// PALETTE & UI
// ─────────────────────────────────────────────────────────────────────────────
const PALETTE = ["#4ade80","#22d3ee","#a78bfa","#f472b6","#fb923c","#facc15","#34d399","#60a5fa","#e879f9","#f87171","#86efac","#67e8f9","#c4b5fd","#f9a8d4","#fdba74"];

const Card = ({children,style={}}) => (
  <div style={{borderRadius:16,border:"1px solid rgba(255,255,255,0.07)",background:"rgba(255,255,255,0.025)",padding:20,...style}}>
    {children}
  </div>
);

const Sec = ({title,sub,children}) => (
  <div style={{marginBottom:0}}>
    <p style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:14,color:"#e2e8f0",marginBottom:sub?2:14}}>{title}</p>
    {sub&&<p style={{fontSize:10,color:"rgba(255,255,255,0.28)",marginBottom:14}}>{sub}</p>}
    {children}
  </div>
);

function RangeBar({label,value,min,max,unit="",color="#4ade80"}) {
  const pct = Math.min(100,Math.max(0,((value-min)/(max-min))*100));
  const ok = value>=min&&value<=max;
  const sc = ok?"#4ade80":value<min?"#facc15":"#f87171";
  return (
    <div style={{marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
        <span style={{fontSize:11,color:"rgba(255,255,255,0.45)"}}>{label}</span>
        <div style={{display:"flex",gap:7,alignItems:"center"}}>
          <span style={{fontSize:12,color:"#e2e8f0",fontWeight:500}}>{typeof value==="number"?value.toFixed(value<10?3:1):value}{unit}</span>
          <span style={{fontSize:9,padding:"1px 7px",borderRadius:100,background:sc+"22",color:sc}}>{ok?"Normal":value<min?"Low":"High"}</span>
        </div>
      </div>
      <div style={{height:5,background:"rgba(255,255,255,0.06)",borderRadius:100,position:"relative"}}>
        <div style={{position:"absolute",left:0,top:0,height:"100%",width:`${pct}%`,background:`linear-gradient(90deg,${color}88,${color})`,borderRadius:100,transition:"width 0.8s ease"}}/>
        <div style={{position:"absolute",left:"20%",top:-2,width:1,height:9,background:"rgba(255,255,255,0.1)"}}/>
        <div style={{position:"absolute",left:"80%",top:-2,width:1,height:9,background:"rgba(255,255,255,0.1)"}}/>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",marginTop:3}}>
        <span style={{fontSize:8,color:"rgba(255,255,255,0.18)"}}>{min}{unit}</span>
        <span style={{fontSize:8,color:"rgba(255,255,255,0.18)"}}>{max}{unit}</span>
      </div>
    </div>
  );
}

function ScoreRing({score}) {
  const color = score>=75?"#4ade80":score>=50?"#facc15":"#f87171";
  const r=52, c=2*Math.PI*r, dash=(score/100)*c;
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
      <div style={{position:"relative",width:130,height:130}}>
        <svg width="130" height="130" style={{transform:"rotate(-90deg)"}}>
          <circle cx="65" cy="65" r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="10"/>
          <circle cx="65" cy="65" r={r} fill="none" stroke={color} strokeWidth="10"
            strokeDasharray={`${dash} ${c}`} strokeLinecap="round"
            style={{transition:"stroke-dasharray 1s ease",filter:`drop-shadow(0 0 8px ${color}66)`}}/>
        </svg>
        <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
          <span style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:28,color}}>{score}</span>
          <span style={{fontSize:9,color:"rgba(255,255,255,0.3)"}}>/ 100</span>
        </div>
      </div>
      <span style={{fontSize:12,fontWeight:600,color,letterSpacing:"1.5px"}}>{score>=75?"GOOD":score>=50?"FAIR":"POOR"}</span>
    </div>
  );
}

function Chip({icon,label,value,color}) {
  if (!value||value==='nan'||value==='') return null;
  return (
    <div style={{padding:"8px 12px",borderRadius:10,background:"rgba(255,255,255,0.03)",border:`1px solid ${color||"rgba(255,255,255,0.07)"}`}}>
      <p style={{fontSize:9,color:"rgba(255,255,255,0.28)",textTransform:"uppercase",letterSpacing:"1.5px",marginBottom:3}}>{icon} {label}</p>
      <p style={{fontSize:12,color:"#e2e8f0",fontWeight:500}}>{value}</p>
    </div>
  );
}

function StatusBadge({label,value,positiveIs="yes"}) {
  if (!value||value==='nan'||value==='') return null;
  const isPositive = value.toLowerCase()===(positiveIs.toLowerCase());
  const color = isPositive?"#f87171":"#4ade80";
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
      <span style={{fontSize:11,color:"rgba(255,255,255,0.4)"}}>{label}</span>
      <span style={{fontSize:10,padding:"2px 8px",borderRadius:100,background:color+"22",color}}>{value}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [data, setData] = useState(null);
  const [pid, setPid] = useState(null);
  const [topN, setTopN] = useState(10);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [aiSummaries, setAiSummaries] = useState({});
  const [aiLoading, setAiLoading] = useState(false);
  const [tab, setTab] = useState("profile");
  const [dataTypeFilter, setDataTypeFilter] = useState("all");
  const [selectedTaxa, setSelectedTaxa] = useState(null); // null = all selected

  const loadCSV = useCallback(text => {
    try {
      const parsed = parseCSV(text);
      setData(parsed);
      const patients = [...new Set(parsed.records.map(r=>r.patient_id))];
      setPid(patients[0]);
      setError(""); setAiSummaries({}); setSelectedTaxa(null);
    } catch(e) { setError(e.message); }
  }, []);

  const handleFile = f => { const r=new FileReader(); r.onload=e=>loadCSV(e.target.result); r.readAsText(f); };
  const onDrop = useCallback(e => { e.preventDefault();setDragging(false);const f=e.dataTransfer.files[0];if(f)handleFile(f); },[]);

  const patients = useMemo(()=>data?[...new Set(data.records.map(r=>r.patient_id))]:[]   ,[data]);

  const ptRecs = useMemo(()=>{
    if(!data) return [];
    let recs = data.records.filter(r=>r.patient_id===pid);
    if(dataTypeFilter!=="all") recs=recs.filter(r=>r.meta?.data_type===dataTypeFilter);
    return recs.sort((a,b)=>a.week-b.week);
  },[data,pid,dataTypeFilter]);

  const dataTypes = useMemo(()=>{
    if(!data) return [];
    const recs = data.records.filter(r=>r.patient_id===pid);
    return [...new Set(recs.map(r=>r.meta?.data_type).filter(Boolean))];
  },[data,pid]);

  const latest = ptRecs[ptRecs.length-1];
  const meta = latest?.meta || data?.metaMap[pid] || {};

  const stats = useMemo(()=>{
    if(!latest||!data?.hasTaxa||!latest.hasAbundance) return null;
    const sh=shannonIndex(latest.abundances), si=simpsonIndex(latest.abundances), ri=richness(latest.abundances);
    const get=n=>{const i=latest.taxaNames.indexOf(n);return i>=0?+latest.abundances[i].toFixed(3):0;};
    return {
      shannon:+sh.toFixed(3), simpson:+si.toFixed(3), richness:ri,
      akk:get("Akkermansia"), faec:get("Faecalibacterium"), bifido:get("Bifidobacterium"),
      score:calcGutScore(latest,sh,si,ri), et:classifyEnterotype(latest)
    };
  },[latest,data]);

  // Clinical scores use ALL rows for this patient (not filtered by data_type)
  // because HBI/SCCAI/fecalcal repeat on every row type, not just stool
  const allPatientRecs = useMemo(()=>data
    ? data.records.filter(r=>r.patient_id===pid).sort((a,b)=>a.week-b.week)
    : []
  ,[data,pid]);

  const clinicalTimeline = useMemo(()=>{
    const seen = new Set();
    const rows = [];
    for (const r of allPatientRecs) {
      const key = String(r.week);
      if (seen.has(key)) continue;
      seen.add(key);
      const fecalcal = parseFloat(r.meta?.fecalcal);
      const hbi = parseFloat(r.meta?.hbi);
      const sccai = parseFloat(r.meta?.sccai);
      if (!isNaN(fecalcal) || !isNaN(hbi) || !isNaN(sccai)) {
        rows.push({
          label: `W${r.week}`,
          week: r.week,
          fecalcal: isNaN(fecalcal) ? null : fecalcal,
          hbi: isNaN(hbi) ? null : hbi,
          sccai: isNaN(sccai) ? null : sccai,
          diarrhea: r.meta?.diarrhea==="Yes" ? 1 : 0,
        });
      }
    }
    return rows;
  },[allPatientRecs]);

  const divData = useMemo(()=>{
    if(!data?.hasTaxa) return [];
    return ptRecs.filter(r=>r.hasAbundance).map(r=>({
      label:`W${r.week}`,
      Shannon:+shannonIndex(r.abundances).toFixed(3),
      Simpson:+simpsonIndex(r.abundances).toFixed(3),
      Richness:richness(r.abundances),
    }));
  },[ptRecs,data]);

  const compData = useMemo(()=>{
    if(!latest||!data?.hasTaxa||!latest.hasAbundance) return [];
    const p=latest.taxaNames.map((name,i)=>({name,value:latest.abundances[i]})).sort((a,b)=>b.value-a.value);
    const top=p.slice(0,topN);
    const other=p.slice(topN).reduce((s,x)=>s+x.value,0);
    if(other>0) top.push({name:"Other",value:+other.toFixed(2)});
    return top;
  },[latest,topN,data]);

  const topTaxa = useMemo(()=>latest&&data?.hasTaxa?latest.taxaNames.map((n,i)=>({n,v:latest.abundances[i]})).sort((a,b)=>b.v-a.v).slice(0,6).map(t=>t.n):[]   ,[latest,data]);

  const taxaTimeline = useMemo(()=>{
    if(!data?.hasTaxa) return [];
    return ptRecs.filter(r=>r.hasAbundance).map(r=>{
      const row={label:`W${r.week}`};
      topTaxa.forEach(n=>{const i=r.taxaNames.indexOf(n);row[n]=i>=0?+r.abundances[i].toFixed(2):0;});
      return row;
    });
  },[ptRecs,topTaxa,data]);

  const radarData = useMemo(()=>{
    if(!stats) return [];
    const n=(v,mn,mx)=>Math.min(100,Math.max(0,((v-mn)/(mx-mn))*100));
    return [
      {m:"Shannon",v:n(stats.shannon,0,5)},{m:"Simpson",v:stats.simpson*100},
      {m:"Richness",v:n(stats.richness,0,400)},{m:"Akkermansia",v:n(stats.akk,0,10)},
      {m:"Faecali.",v:n(stats.faec,0,30)},{m:"Bifido.",v:n(stats.bifido,0,20)},
    ];
  },[stats]);

  // ── Disease Risk Estimation from clinical markers ──
  const diseaseRisk = useMemo(() => {
    if (!meta) return null;
    const hbi     = parseFloat(meta.hbi);
    const sccai   = parseFloat(meta.sccai);
    const fcp     = parseFloat(meta.fecalcal);
    const diag    = meta.diagnosis || "";
    const diarr   = meta.diarrhea === "Yes";
    const inflamed= meta.inflamed === "Yes" || meta.inflamed === "1";
    const abx     = meta.antibiotics === "Yes";

    // CD risk: driven by HBI
    let cdScore = 0;
    if (!isNaN(hbi)) {
      if (hbi >= 16) cdScore = 95;
      else if (hbi >= 8)  cdScore = 75;
      else if (hbi >= 5)  cdScore = 45;
      else cdScore = 15;
    } else if (diag === "CD") cdScore = 60;
    if (diarr)    cdScore = Math.min(cdScore + 10, 98);
    if (inflamed) cdScore = Math.min(cdScore + 15, 98);
    if (!isNaN(fcp) && fcp > 200) cdScore = Math.min(cdScore + 10, 98);
    if (diag === "nonIBD") cdScore = Math.max(cdScore - 40, 2);

    // UC risk: driven by SCCAI
    let ucScore = 0;
    if (!isNaN(sccai)) {
      if (sccai >= 10) ucScore = 92;
      else if (sccai >= 6)  ucScore = 72;
      else if (sccai >= 3)  ucScore = 40;
      else ucScore = 10;
    } else if (diag === "UC") ucScore = 60;
    if (diarr)    ucScore = Math.min(ucScore + 10, 98);
    if (inflamed) ucScore = Math.min(ucScore + 15, 98);
    if (diag === "nonIBD") ucScore = Math.max(ucScore - 40, 2);

    // Dysbiosis risk from taxa if available
    let dysbiosisScore = 30;
    if (stats) {
      if (stats.shannon < 2.5) dysbiosisScore += 30;
      else if (stats.shannon < 3.0) dysbiosisScore += 15;
      if (stats.faec < 2) dysbiosisScore += 20;
      if (stats.akk < 0.1) dysbiosisScore += 10;
      dysbiosisScore = Math.min(dysbiosisScore, 98);
    } else if (diag === "nonIBD") dysbiosisScore = 12;
    else if (diag === "CD" || diag === "UC") dysbiosisScore = 65;

    // Gut health: inverse of dysbiosis
    const gutHealthPct = Math.max(2, 100 - dysbiosisScore);

    return {
      cd: Math.round(cdScore),
      uc: Math.round(ucScore),
      dysbiosis: Math.round(dysbiosisScore),
      gutHealth: Math.round(gutHealthPct),
      hbi, sccai, fcp, diarr, inflamed, abx,
    };
  }, [meta, stats]);

  // ── Good / Bad bacteria reference data ──
  const BACTERIA_ROLES = [
    // Good bacteria
    { name:"Faecalibacterium prausnitzii", role:"good", color:"#4ade80",
      function:"Most abundant anti-inflammatory bacterium. Produces butyrate which heals gut lining.",
      ibd:"Severely depleted in IBD — its absence is strongly linked to Crohn's disease flares.",
      healthy:"5–20%", patient: stats ? `${stats.faec.toFixed(2)}%` : null },
    { name:"Akkermansia muciniphila", role:"good", color:"#4ade80",
      function:"Protects the gut mucosal barrier. Reduces intestinal permeability ('leaky gut').",
      ibd:"Reduced in IBD, obesity, and Type 2 Diabetes.",
      healthy:"0.5–5%", patient: stats ? `${stats.akk.toFixed(2)}%` : null },
    { name:"Bifidobacterium", role:"good", color:"#4ade80",
      function:"Produces lactic acid and short-chain fatty acids. Suppresses harmful bacteria growth.",
      ibd:"Reduced in IBD patients, especially those on antibiotics.",
      healthy:"2–15%", patient: stats ? `${stats.bifido.toFixed(2)}%` : null },
    { name:"Lactobacillus", role:"good", color:"#34d399",
      function:"Produces lactic acid, prevents pathogen colonization, supports immune regulation.",
      ibd:"Often depleted in active IBD.",
      healthy:"1–10%", patient: null },
    { name:"Roseburia intestinalis", role:"good", color:"#34d399",
      function:"Major butyrate producer. Supports colonocyte energy and reduces inflammation.",
      ibd:"Consistently reduced in Crohn's disease.",
      healthy:"2–10%", patient: null },
    { name:"Blautia", role:"good", color:"#86efac",
      function:"Produces acetate and butyrate. Anti-inflammatory, associated with healthy BMI.",
      ibd:"Reduced in IBD and metabolic disease.",
      healthy:"2–8%", patient: null },

    // Bad bacteria
    { name:"Escherichia coli (pathogenic)", role:"bad", color:"#f87171",
      function:"Invasive strains (AIEC) colonize the gut lining and trigger chronic inflammation.",
      ibd:"Strongly associated with Crohn's disease — found in 70%+ of CD patients.",
      healthy:"<1%", patient: null },
    { name:"Fusobacterium nucleatum", role:"bad", color:"#f87171",
      function:"Pro-inflammatory. Promotes gut permeability and activates immune responses.",
      ibd:"Elevated in IBD and colorectal cancer.",
      healthy:"<0.1%", patient: null },
    { name:"Clostridium difficile", role:"bad", color:"#f87171",
      function:"Produces toxins that destroy gut lining. Causes severe diarrhea and colitis.",
      ibd:"IBD patients are highly susceptible, especially after antibiotics.",
      healthy:"<0.01%", patient: null },
    { name:"Enterococcus faecalis", role:"bad", color:"#fb923c",
      function:"Produces superoxide radicals that damage DNA and gut tissue.",
      ibd:"Elevated in UC, contributes to persistent inflammation.",
      healthy:"<1%", patient: null },
    { name:"Peptostreptococcus", role:"bad", color:"#fb923c",
      function:"Opportunistic pathogen. Elevated levels associated with mucosal inflammation.",
      ibd:"Found at higher levels in IBD patients.",
      healthy:"<1%", patient: null },
  ];

  const doAI = async () => {
    if(aiSummaries[pid]||aiLoading) return;
    setAiLoading(true);
    try {
      // Build a trend string from the clinical timeline e.g. "W0: HBI=4, W8: HBI=7, W16: HBI=3"
      const trendStr = clinicalTimeline.map(r => {
        const parts = [];
        if (r.hbi != null)      parts.push(`HBI=${r.hbi}`);
        if (r.sccai != null)    parts.push(`SCCAI=${r.sccai}`);
        if (r.fecalcal != null) parts.push(`FCP=${r.fecalcal.toFixed(1)}`);
        return parts.length ? `${r.label}: ${parts.join(', ')}` : null;
      }).filter(Boolean).join(' | ');

      const s = await generateAISummary({
        pid, ...meta, hasTaxa:data?.hasTaxa, ...stats,
        n: ptRecs.length,
        clinicalTrend: trendStr || "No trend data available",
      });
      setAiSummaries(p=>({...p,[pid]:s}));
    } catch(e) { setAiSummaries(p=>({...p,[pid]:`Error: ${e.message}`})); }
    setAiLoading(false);
  };

  const TT = {contentStyle:{background:"#071a14",border:"1px solid rgba(74,222,128,0.15)",borderRadius:10,fontSize:11}};
  const hasClinical = clinicalTimeline.length > 0;

  const diagColor = d => d==="CD"?"#f472b6":d==="UC"?"#fb923c":d==="nonIBD"?"#4ade80":"#22d3ee";

  return (
    <div style={{minHeight:"100vh",background:"radial-gradient(ellipse at 10% 10%, #071a14 0%, #060c14 40%, #030608 100%)",fontFamily:"'DM Mono','Courier New',monospace",color:"#e2e8f0"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#4ade8033;border-radius:2px}
        .tb{background:none;border-left:none;border-right:none;border-top:none;cursor:pointer;padding:8px 18px;font-family:inherit;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;transition:all 0.2s;border-bottom:2px solid transparent;color:rgba(255,255,255,0.3)}
        .tb:hover{color:rgba(255,255,255,0.65)}.tb-on{color:#4ade80!important;border-bottom-color:#4ade80!important}
        .pb{padding:4px 13px;border-radius:100px;font-size:10px;cursor:pointer;transition:all 0.2s;font-family:inherit}
        .dz:hover{border-color:#4ade80!important;background:rgba(74,222,128,0.04)!important}
        @keyframes fu{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}.fu{animation:fu 0.4s ease forwards}
        @keyframes pl{0%,100%{opacity:1}50%{opacity:0.4}}.pl{animation:pl 1.5s infinite}
      `}</style>

      {/* Header */}
      <header style={{padding:"20px 32px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:"1px solid rgba(255,255,255,0.05)"}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:34,height:34,borderRadius:10,background:"linear-gradient(135deg,#4ade80,#22d3ee)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🧬</div>
          <div>
            <h1 style={{fontFamily:"'Syne',sans-serif",fontSize:20,fontWeight:800,letterSpacing:"-0.5px"}}>
              <span style={{color:"#4ade80",textShadow:"0 0 30px #4ade8055"}}>micro</span><span>scope</span>
            </h1>
            <p style={{fontSize:9,color:"rgba(255,255,255,0.22)",letterSpacing:"3px",textTransform:"uppercase"}}>patient microbiome profiler</p>
          </div>
        </div>
        {data && (
          <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap",maxWidth:"70%",justifyContent:"flex-end"}}>
            {patients.slice(0,20).map(p=>(
              <button key={p} onClick={()=>{setPid(p);setTab("profile");}} className="pb"
                style={{border:"1px solid",borderColor:pid===p?"#4ade80":"rgba(255,255,255,0.1)",background:pid===p?"rgba(74,222,128,0.08)":"transparent",color:pid===p?"#4ade80":"rgba(255,255,255,0.35)"}}>
                {p}
              </button>
            ))}
            {patients.length>20&&<span style={{fontSize:10,color:"rgba(255,255,255,0.3)"}}>+{patients.length-20} more</span>}
            <button onClick={()=>{setData(null);setPid(null);setAiSummaries({});}} className="pb"
              style={{border:"1px solid rgba(255,255,255,0.08)",background:"transparent",color:"rgba(255,255,255,0.22)",marginLeft:8}}>↑ new</button>
          </div>
        )}
      </header>

      <main style={{padding:"24px 32px 60px",maxWidth:1360,margin:"0 auto"}}>
        {!data ? (
          <div style={{maxWidth:580,margin:"80px auto"}} className="fu">
            <div className="dz" onDrop={onDrop} onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)}
              style={{border:`2px dashed ${dragging?"#4ade80":"rgba(255,255,255,0.1)"}`,borderRadius:20,padding:"64px 36px",textAlign:"center",cursor:"pointer",transition:"all 0.3s"}}
              onClick={()=>document.getElementById("fup").click()}>
              <div style={{fontSize:40,marginBottom:12}}>🧬</div>
              <p style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:700,marginBottom:8}}>Drop your microbiome CSV</p>
              <p style={{color:"rgba(255,255,255,0.35)",fontSize:12,marginBottom:4}}>Supports HMP2 / IBDMDB format ✓</p>
              <p style={{color:"rgba(255,255,255,0.2)",fontSize:11,marginBottom:22}}>Also works with any CSV containing patient metadata + optional taxa abundance columns</p>
              <input id="fup" type="file" accept=".csv" style={{display:"none"}} onChange={e=>{if(e.target.files[0])handleFile(e.target.files[0]);}}/>
              <button style={{padding:"9px 22px",borderRadius:100,background:"rgba(74,222,128,0.1)",border:"1px solid rgba(74,222,128,0.4)",color:"#4ade80",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Choose File</button>
            </div>
            {error&&<p style={{color:"#f87171",marginTop:14,textAlign:"center",fontSize:12}}>⚠ {error}</p>}
          </div>
        ) : (
          <div className="fu">
            {/* Data type filter */}
            {dataTypes.length > 1 && (
              <div style={{display:"flex",gap:6,marginBottom:16,flexWrap:"wrap"}}>
                <span style={{fontSize:10,color:"rgba(255,255,255,0.3)",alignSelf:"center",marginRight:4}}>DATA TYPE:</span>
                {["all",...dataTypes].map(dt=>(
                  <button key={dt} onClick={()=>setDataTypeFilter(dt)} className="pb"
                    style={{border:"1px solid",borderColor:dataTypeFilter===dt?"#22d3ee":"rgba(255,255,255,0.1)",background:dataTypeFilter===dt?"rgba(34,211,238,0.08)":"transparent",color:dataTypeFilter===dt?"#22d3ee":"rgba(255,255,255,0.35)"}}>
                    {dt}
                  </button>
                ))}
              </div>
            )}

            {/* Tabs */}
            <div style={{display:"flex",borderBottom:"1px solid rgba(255,255,255,0.06)",marginBottom:22,flexWrap:"wrap"}}>
              {[["profile","Profile"],["clinical","Clinical Timeline"],["risk","🦠 Disease Risk"],
                ...(data.hasTaxa?[["composition","Composition"],["taxa","Taxa Timeline"]]:[] ),
                ["summary","AI Summary"]
              ].map(([id,label])=>(
                <button key={id} onClick={()=>setTab(id)} className={`tb${tab===id?" tb-on":""}`}>{label}</button>
              ))}
            </div>

            {/* ── PROFILE ── */}
            {tab==="profile"&&(
              <div style={{display:"grid",gridTemplateColumns:"290px 1fr",gap:18}}>
                {/* Left */}
                <div style={{display:"flex",flexDirection:"column",gap:14}}>
                  <Card>
                    <div style={{display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center",gap:10}}>
                      <div style={{width:58,height:58,borderRadius:"50%",background:`linear-gradient(135deg,${diagColor(meta.diagnosis)},#22d3ee)`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:18,color:"#050c10"}}>
                        {pid?.slice(0,4)}
                      </div>
                      <div>
                        <p style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:15}}>{pid}</p>
                        <p style={{fontSize:10,color:"rgba(255,255,255,0.28)",marginTop:2}}>{ptRecs.length} visits tracked</p>
                      </div>
                      {meta.diagnosis&&<span style={{fontSize:11,padding:"3px 12px",borderRadius:100,background:diagColor(meta.diagnosis)+"22",color:diagColor(meta.diagnosis),fontWeight:600}}>{meta.diagnosis==="nonIBD"?"Healthy Control":meta.diagnosis}</span>}
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,width:"100%",marginTop:4}}>
                        <Chip icon="👤" label="Age" value={meta.age}/>
                        <Chip icon="⚧" label="Sex" value={meta.sex}/>
                        <Chip icon="⚖️" label="BMI" value={meta.bmi}/>
                        <Chip icon="🏥" label="Site" value={meta.site}/>
                      </div>
                      {meta.antibiotics&&<Chip icon="💊" label="Antibiotics" value={meta.antibiotics} color={meta.antibiotics==="Yes"?"rgba(248,113,113,0.3)":"rgba(74,222,128,0.15)"}/>}
                    </div>
                  </Card>

                  {/* Clinical scores */}
                  <Card>
                    <Sec title="Clinical Indicators" sub="Latest available values">
                      {meta.fecalcal&&meta.fecalcal!=="nan"&&(
                        <RangeBar label="Fecal Calprotectin" value={parseFloat(meta.fecalcal)} min={0} max={50} unit=" ng/mL" color="#fb923c"/>
                      )}
                      {meta.hbi&&meta.hbi!=="nan"&&(
                        <RangeBar label="HBI Score (CD)" value={parseFloat(meta.hbi)} min={0} max={4} unit="" color="#f472b6"/>
                      )}
                      {meta.sccai&&meta.sccai!=="nan"&&(
                        <RangeBar label="SCCAI Score (UC)" value={parseFloat(meta.sccai)} min={0} max={2} unit="" color="#a78bfa"/>
                      )}
                      <StatusBadge label="Diarrhea (past 2 wks)" value={meta.diarrhea}/>
                      <StatusBadge label="Hospitalized" value={meta.hospitalized}/>
                      <StatusBadge label="Inflamed" value={meta.inflamed}/>
                    </Sec>
                  </Card>

                  {/* Enterotype (only if taxa data) */}
                  {stats&&(
                    <Card>
                      <Sec title="Enterotype" sub="Based on dominant genus">
                        <div style={{textAlign:"center"}}>
                          <div style={{fontSize:28,fontFamily:"'Syne',sans-serif",fontWeight:800,color:stats.et.color,marginBottom:4}}>{stats.et.type}</div>
                          <div style={{fontSize:12,color:"rgba(255,255,255,0.55)",marginBottom:10}}>{stats.et.dominant}-dominant</div>
                          <p style={{fontSize:10,color:"rgba(255,255,255,0.3)",lineHeight:1.7}}>{stats.et.desc}</p>
                        </div>
                      </Sec>
                    </Card>
                  )}
                  {stats&&(
                    <Card>
                      <Sec title="Gut Health Score" sub="Composite microbiome index">
                        <div style={{display:"flex",justifyContent:"center"}}><ScoreRing score={stats.score}/></div>
                      </Sec>
                    </Card>
                  )}
                </div>

                {/* Right */}
                <div style={{display:"flex",flexDirection:"column",gap:14}}>
                  {/* No-taxa notice */}
                  {!data.hasTaxa&&(
                    <div style={{padding:"14px 18px",borderRadius:12,background:"rgba(251,146,60,0.08)",border:"1px solid rgba(251,146,60,0.2)",fontSize:12,color:"rgba(251,146,60,0.8)",lineHeight:1.7}}>
                      ℹ️ This file contains <strong>clinical metadata only</strong> — no microbiome abundance columns detected ({data.taxaCount} potential taxa columns found but all empty). 
                      The Profile and Clinical Timeline tabs are fully functional. To unlock Composition and Taxa Timeline tabs, upload a file that also includes species/genus abundance values.
                    </div>
                  )}

                  {/* Reference ranges (taxa) */}
                  {stats&&(
                    <Card>
                      <Sec title="Reference Range Comparison" sub="vs. healthy population benchmarks">
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 32px"}}>
                          <div>
                            <p style={{fontSize:9,color:"rgba(255,255,255,0.25)",textTransform:"uppercase",letterSpacing:"1.5px",marginBottom:14}}>Diversity</p>
                            <RangeBar label="Shannon Index" value={stats.shannon} min={3.0} max={4.5} color="#4ade80"/>
                            <RangeBar label="Simpson Index" value={stats.simpson} min={0.90} max={0.99} color="#22d3ee"/>
                            <RangeBar label="Taxa Richness" value={stats.richness} min={150} max={300} unit=" taxa" color="#a78bfa"/>
                          </div>
                          <div>
                            <p style={{fontSize:9,color:"rgba(255,255,255,0.25)",textTransform:"uppercase",letterSpacing:"1.5px",marginBottom:14}}>Keystone Taxa</p>
                            <RangeBar label="Akkermansia" value={stats.akk} min={0.5} max={5.0} unit="%" color="#fb923c"/>
                            <RangeBar label="Faecalibacterium" value={stats.faec} min={5.0} max={20.0} unit="%" color="#f472b6"/>
                            <RangeBar label="Bifidobacterium" value={stats.bifido} min={2.0} max={15.0} unit="%" color="#facc15"/>
                          </div>
                        </div>
                      </Sec>
                    </Card>
                  )}

                  {/* Radar (taxa) */}
                  {stats&&radarData.length>0&&(
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                      <Card>
                        <Sec title="Microbiome Radar" sub="Normalized fingerprint">
                          <ResponsiveContainer width="100%" height={220}>
                            <RadarChart data={radarData}>
                              <PolarGrid stroke="rgba(255,255,255,0.06)"/>
                              <PolarAngleAxis dataKey="m" tick={{fill:"rgba(255,255,255,0.38)",fontSize:10}}/>
                              <Radar dataKey="v" stroke="#4ade80" fill="#4ade80" fillOpacity={0.12} strokeWidth={2}/>
                            </RadarChart>
                          </ResponsiveContainer>
                        </Sec>
                      </Card>
                      <Card>
                        <Sec title="Diversity Timeline" sub="Shannon & Simpson across visits">
                          <ResponsiveContainer width="100%" height={220}>
                            <LineChart data={divData}>
                              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                              <XAxis dataKey="label" tick={{fill:"rgba(255,255,255,0.22)",fontSize:10}}/>
                              <YAxis tick={{fill:"rgba(255,255,255,0.22)",fontSize:10}}/>
                              <Tooltip {...TT}/><Legend wrapperStyle={{fontSize:10}}/>
                              <Line type="monotone" dataKey="Shannon" stroke="#4ade80" strokeWidth={2} dot={{r:3,fill:"#4ade80"}}/>
                              <Line type="monotone" dataKey="Simpson" stroke="#22d3ee" strokeWidth={2} dot={{r:3,fill:"#22d3ee"}}/>
                            </LineChart>
                          </ResponsiveContainer>
                        </Sec>
                      </Card>
                    </div>
                  )}

                  {/* Clinical timeline preview if no taxa */}
                  {!stats&&hasClinical&&(
                    <Card>
                      <Sec title="Clinical Scores Over Time" sub="Fecal calprotectin, HBI, SCCAI across visits">
                        <ResponsiveContainer width="100%" height={240}>
                          <LineChart data={clinicalTimeline}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                            <XAxis dataKey="label" tick={{fill:"rgba(255,255,255,0.22)",fontSize:9}}/>
                            <YAxis tick={{fill:"rgba(255,255,255,0.22)",fontSize:9}}/>
                            <Tooltip {...TT}/><Legend wrapperStyle={{fontSize:10}}/>
                            {clinicalTimeline.some(r=>r.fecalcal)&&<Line type="monotone" dataKey="fecalcal" name="Fecal Calprotectin" stroke="#fb923c" strokeWidth={2} dot={{r:3}}/>}
                            {clinicalTimeline.some(r=>r.hbi)&&<Line type="monotone" dataKey="hbi" name="HBI (CD)" stroke="#f472b6" strokeWidth={2} dot={{r:3}}/>}
                            {clinicalTimeline.some(r=>r.sccai)&&<Line type="monotone" dataKey="sccai" name="SCCAI (UC)" stroke="#a78bfa" strokeWidth={2} dot={{r:3}}/>}
                          </LineChart>
                        </ResponsiveContainer>
                      </Sec>
                    </Card>
                  )}
                </div>
              </div>
            )}

            {/* ── CLINICAL TIMELINE ── */}
            {tab==="clinical"&&(
              <div style={{display:"flex",flexDirection:"column",gap:18}}>
                {hasClinical ? (
                  <>
                    <Card>
                      <Sec title="Clinical Scores Over Time" sub="Tracking disease activity across visits">
                        <ResponsiveContainer width="100%" height={280}>
                          <LineChart data={clinicalTimeline}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                            <XAxis dataKey="label" tick={{fill:"rgba(255,255,255,0.22)",fontSize:10}}/>
                            <YAxis tick={{fill:"rgba(255,255,255,0.22)",fontSize:10}}/>
                            <Tooltip {...TT}/><Legend wrapperStyle={{fontSize:10}}/>
                            {clinicalTimeline.some(r=>r.fecalcal)&&<Line type="monotone" dataKey="fecalcal" name="Fecal Calprotectin (ng/mL)" stroke="#fb923c" strokeWidth={2} dot={{r:4,fill:"#fb923c"}}/>}
                            {clinicalTimeline.some(r=>r.hbi)&&<Line type="monotone" dataKey="hbi" name="HBI Score (CD)" stroke="#f472b6" strokeWidth={2} dot={{r:4,fill:"#f472b6"}}/>}
                            {clinicalTimeline.some(r=>r.sccai)&&<Line type="monotone" dataKey="sccai" name="SCCAI Score (UC)" stroke="#a78bfa" strokeWidth={2} dot={{r:4,fill:"#a78bfa"}}/>}
                          </LineChart>
                        </ResponsiveContainer>
                      </Sec>
                    </Card>
                    <Card>
                      <Sec title="Diarrhea Events" sub="Reported diarrhea episodes per visit">
                        <ResponsiveContainer width="100%" height={160}>
                          <BarChart data={clinicalTimeline}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                            <XAxis dataKey="label" tick={{fill:"rgba(255,255,255,0.22)",fontSize:10}}/>
                            <YAxis tick={{fill:"rgba(255,255,255,0.22)",fontSize:10}} tickFormatter={v=>v?"Yes":""}/>
                            <Tooltip {...TT} formatter={v=>[v?"Yes":"No","Diarrhea"]}/>
                            <Bar dataKey="diarrhea" name="Diarrhea" radius={[4,4,0,0]}>
                              {clinicalTimeline.map((_,i)=><Cell key={i} fill={clinicalTimeline[i].diarrhea?"#f87171":"#4ade8033"}/>)}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </Sec>
                    </Card>
                  </>
                ) : (
                  <div style={{textAlign:"center",padding:"60px 0",color:"rgba(255,255,255,0.3)",fontSize:13}}>
                    No clinical score data (fecal calprotectin / HBI / SCCAI) found for this patient.
                  </div>
                )}
              </div>
            )}

            {/* ── COMPOSITION ── */}
            {tab==="composition"&&data.hasTaxa&&(
              <div style={{display:"flex",flexDirection:"column",gap:18}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 320px",gap:18}}>
                  <Card>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
                      <Sec title="Bacterial Abundance" sub="Latest sample"><></></Sec>
                      <div style={{display:"flex",gap:5}}>
                        {[5,10,15,20].map(n=>(
                          <button key={n} onClick={()=>setTopN(n)} className="pb"
                            style={{border:"1px solid",borderColor:topN===n?"#4ade80":"rgba(255,255,255,0.1)",background:topN===n?"rgba(74,222,128,0.08)":"transparent",color:topN===n?"#4ade80":"rgba(255,255,255,0.3)"}}>
                            {n}
                          </button>
                        ))}
                      </div>
                    </div>
                    <ResponsiveContainer width="100%" height={320}>
                      <BarChart data={compData} layout="vertical" margin={{left:8,right:16}}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" horizontal={false}/>
                        <XAxis type="number" tick={{fill:"rgba(255,255,255,0.22)",fontSize:10}} tickFormatter={v=>v.toFixed(1)+"%"}/>
                        <YAxis type="category" dataKey="name" tick={{fill:"rgba(255,255,255,0.45)",fontSize:10}} width={130}/>
                        <Tooltip {...TT} formatter={v=>[v.toFixed(2)+"%","Abundance"]}/>
                        <Bar dataKey="value" radius={[0,4,4,0]}>
                          {compData.map((_,i)=><Cell key={i} fill={PALETTE[i%PALETTE.length]}/>)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </Card>
                  <Card>
                    <Sec title="Distribution" sub={`Top ${topN} taxa`}>
                      <ResponsiveContainer width="100%" height={300}>
                        <PieChart>
                          <Pie data={compData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={52} outerRadius={94} paddingAngle={2}>
                            {compData.map((_,i)=><Cell key={i} fill={PALETTE[i%PALETTE.length]}/>)}
                          </Pie>
                          <Tooltip {...TT} formatter={v=>[v.toFixed(2)+"%"]}/>
                        </PieChart>
                      </ResponsiveContainer>
                    </Sec>
                  </Card>
                </div>
              </div>
            )}

            {/* ── TAXA TIMELINE ── */}
            {tab==="taxa"&&data.hasTaxa&&(
              <div style={{display:"flex",flexDirection:"column",gap:18}}>
                <Card>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14,flexWrap:"wrap",gap:10}}>
                    <div>
                      <p style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:14,color:"#e2e8f0",marginBottom:2}}>Top Taxa Over Time</p>
                      <p style={{fontSize:10,color:"rgba(255,255,255,0.28)"}}>6 most abundant taxa across all visits</p>
                    </div>
                    <button
                      onClick={()=>setSelectedTaxa(prev=>{
                        const allSelected = prev===null||prev.length===topTaxa.length;
                        return allSelected ? [] : null;
                      })}
                      style={{
                        padding:"5px 14px",borderRadius:100,fontSize:10,cursor:"pointer",fontFamily:"inherit",
                        border:"1px solid",
                        borderColor:(selectedTaxa===null||selectedTaxa?.length===topTaxa.length)?"#4ade80":"rgba(255,255,255,0.15)",
                        background:(selectedTaxa===null||selectedTaxa?.length===topTaxa.length)?"rgba(74,222,128,0.1)":"rgba(255,255,255,0.04)",
                        color:(selectedTaxa===null||selectedTaxa?.length===topTaxa.length)?"#4ade80":"rgba(255,255,255,0.4)",
                        transition:"all 0.2s"
                      }}>
                      {(selectedTaxa===null||selectedTaxa?.length===topTaxa.length)?"✓ All Selected":"Select All"}
                    </button>
                  </div>
                  {/* Taxa toggles */}
                  <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:18}}>
                    {topTaxa.map((n,i)=>{
                      const active = selectedTaxa===null || selectedTaxa.includes(n);
                      return (
                        <button key={n}
                          onClick={()=>setSelectedTaxa(prev=>{
                            const cur = prev===null ? topTaxa : prev;
                            if(cur.includes(n)) return cur.filter(t=>t!==n);
                            const next = [...cur, n];
                            return next.length===topTaxa.length ? null : next;
                          })}
                          style={{
                            display:"flex",alignItems:"center",gap:6,
                            padding:"5px 12px",borderRadius:100,fontSize:10,cursor:"pointer",fontFamily:"inherit",
                            border:`1px solid ${active?PALETTE[i]+"88":"rgba(255,255,255,0.1)"}`,
                            background:active?PALETTE[i]+"18":"rgba(255,255,255,0.03)",
                            color:active?PALETTE[i]:"rgba(255,255,255,0.28)",
                            transition:"all 0.2s",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"
                          }}
                          title={n}>
                          <span style={{width:8,height:8,borderRadius:"50%",background:active?PALETTE[i]:"rgba(255,255,255,0.15)",flexShrink:0,transition:"background 0.2s"}}/>
                          <span style={{overflow:"hidden",textOverflow:"ellipsis"}}>{n}</span>
                        </button>
                      );
                    })}
                  </div>
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={taxaTimeline}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                      <XAxis dataKey="label" tick={{fill:"rgba(255,255,255,0.22)",fontSize:10}}/>
                      <YAxis tick={{fill:"rgba(255,255,255,0.22)",fontSize:10}} tickFormatter={v=>v+"%"}/>
                      <Tooltip {...TT} formatter={v=>[v.toFixed(2)+"%"]}/>
                      <Legend wrapperStyle={{fontSize:10}}/>
                      {topTaxa.map((n,i)=>{
                        const active = selectedTaxa===null || selectedTaxa.includes(n);
                        return active ? (
                          <Line key={n} type="monotone" dataKey={n} stroke={PALETTE[i]} strokeWidth={2} dot={{r:4,fill:PALETTE[i]}}/>
                        ) : null;
                      })}
                    </LineChart>
                  </ResponsiveContainer>
                </Card>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:18}}>
                  <Card>
                    <Sec title="Diversity Indices" sub="Shannon & Simpson">
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={divData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                          <XAxis dataKey="label" tick={{fill:"rgba(255,255,255,0.22)",fontSize:10}}/>
                          <YAxis tick={{fill:"rgba(255,255,255,0.22)",fontSize:10}}/>
                          <Tooltip {...TT}/><Legend wrapperStyle={{fontSize:10}}/>
                          <Line type="monotone" dataKey="Shannon" stroke="#4ade80" strokeWidth={2} dot={{r:3,fill:"#4ade80"}}/>
                          <Line type="monotone" dataKey="Simpson" stroke="#22d3ee" strokeWidth={2} dot={{r:3,fill:"#22d3ee"}}/>
                        </LineChart>
                      </ResponsiveContainer>
                    </Sec>
                  </Card>
                  <Card>
                    <Sec title="Taxa Richness" sub="Detected taxa per visit">
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart data={divData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                          <XAxis dataKey="label" tick={{fill:"rgba(255,255,255,0.22)",fontSize:10}}/>
                          <YAxis tick={{fill:"rgba(255,255,255,0.22)",fontSize:10}}/>
                          <Tooltip {...TT}/>
                          <Bar dataKey="Richness" radius={[4,4,0,0]}>
                            {divData.map((_,i)=><Cell key={i} fill="#a78bfa" fillOpacity={0.5+i*0.06}/>)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </Sec>
                  </Card>
                </div>
              </div>
            )}

            {/* ── DISEASE RISK ── */}
            {tab==="risk"&&diseaseRisk&&(
              <div style={{display:"flex",flexDirection:"column",gap:18}}>

                {/* Risk meters */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:14}}>
                  {[
                    {label:"Crohn's Disease Risk", pct:diseaseRisk.cd, color:"#f472b6",
                     desc: diseaseRisk.cd>=75?"High activity detected":diseaseRisk.cd>=45?"Moderate activity":diseaseRisk.cd>=20?"Mild / subclinical":"Low risk"},
                    {label:"Ulcerative Colitis Risk", pct:diseaseRisk.uc, color:"#fb923c",
                     desc: diseaseRisk.uc>=75?"High activity detected":diseaseRisk.uc>=40?"Moderate activity":diseaseRisk.uc>=20?"Mild / subclinical":"Low risk"},
                    {label:"Gut Dysbiosis Risk", pct:diseaseRisk.dysbiosis, color:"#a78bfa",
                     desc: diseaseRisk.dysbiosis>=70?"Likely dysbiotic":diseaseRisk.dysbiosis>=40?"Moderate imbalance":"Balanced microbiome likely"},
                    {label:"Overall Gut Health", pct:diseaseRisk.gutHealth, color:"#4ade80",
                     desc: diseaseRisk.gutHealth>=70?"Relatively healthy":diseaseRisk.gutHealth>=40?"Moderate concern":"Poor gut health indicated"},
                  ].map(({label,pct,color,desc})=>{
                    const r=44, c=2*Math.PI*r, dash=(pct/100)*c;
                    return (
                      <Card key={label} style={{textAlign:"center"}}>
                        <div style={{position:"relative",width:110,height:110,margin:"0 auto 10px"}}>
                          <svg width="110" height="110" style={{transform:"rotate(-90deg)"}}>
                            <circle cx="55" cy="55" r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="8"/>
                            <circle cx="55" cy="55" r={r} fill="none" stroke={color} strokeWidth="8"
                              strokeDasharray={`${dash} ${c}`} strokeLinecap="round"
                              style={{filter:`drop-shadow(0 0 6px ${color}66)`,transition:"stroke-dasharray 1s ease"}}/>
                          </svg>
                          <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
                            <span style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:22,color}}>{pct}%</span>
                          </div>
                        </div>
                        <p style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:12,marginBottom:4}}>{label}</p>
                        <p style={{fontSize:10,color:"rgba(255,255,255,0.4)",lineHeight:1.5}}>{desc}</p>
                      </Card>
                    );
                  })}
                </div>

                {/* Risk factors breakdown */}
                <Card>
                  <Sec title="Risk Factor Breakdown" sub="Clinical indicators driving the estimates">
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10}}>
                      {[
                        {label:"HBI Score", value: isNaN(diseaseRisk.hbi)?null:diseaseRisk.hbi, threshold:5, unit:"", higher:"worse", desc:"Harvey-Bradshaw Index (Crohn's activity)"},
                        {label:"SCCAI Score", value: isNaN(diseaseRisk.sccai)?null:diseaseRisk.sccai, threshold:3, unit:"", higher:"worse", desc:"Colitis activity index"},
                        {label:"Fecal Calprotectin", value: isNaN(diseaseRisk.fcp)?null:diseaseRisk.fcp, threshold:50, unit:" ng/mL", higher:"worse", desc:"Gut inflammation marker"},
                        {label:"Diarrhea", value:diseaseRisk.diarr?"Yes":"No", bool:true, bad:"Yes", desc:"Reported in past 2 weeks"},
                        {label:"Intestinal Inflammation", value:diseaseRisk.inflamed?"Yes":"No", bool:true, bad:"Yes", desc:"Active mucosal inflammation"},
                        {label:"Antibiotics Use", value:diseaseRisk.abx?"Yes":"No", bool:true, bad:"Yes", desc:"Disrupts microbiome balance"},
                      ].map(({label,value,threshold,unit,higher,bool,bad,desc})=>{
                        if (value===null||value===undefined) return null;
                        let statusColor = "#ffffff44";
                        if (bool) statusColor = value===bad?"#f87171":"#4ade80";
                        else if (typeof value==="number") statusColor = (higher==="worse"&&value>threshold)||(higher==="better"&&value<threshold)?"#f87171":"#4ade80";
                        return (
                          <div key={label} style={{padding:"12px 14px",borderRadius:12,background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)"}}>
                            <p style={{fontSize:9,color:"rgba(255,255,255,0.3)",textTransform:"uppercase",letterSpacing:"1.5px",marginBottom:4}}>{label}</p>
                            <p style={{fontSize:18,fontWeight:700,color:statusColor,fontFamily:"'Syne',sans-serif",marginBottom:2}}>
                              {typeof value==="number"?value.toFixed(1)+unit:value}
                            </p>
                            <p style={{fontSize:9,color:"rgba(255,255,255,0.25)",lineHeight:1.5}}>{desc}</p>
                          </div>
                        );
                      }).filter(Boolean)}
                    </div>
                  </Sec>
                </Card>

                {/* Good / Bad bacteria */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:18}}>
                  <Card>
                    <Sec title="✅ Protective Bacteria" sub="Higher levels = better gut health">
                      {BACTERIA_ROLES.filter(b=>b.role==="good").map(b=>(
                        <div key={b.name} style={{marginBottom:16,paddingBottom:16,borderBottom:"1px solid rgba(255,255,255,0.05)"}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                            <p style={{fontSize:12,fontWeight:600,color:b.color,flex:1}}>{b.name}</p>
                            <div style={{textAlign:"right",marginLeft:12}}>
                              <p style={{fontSize:10,color:"rgba(255,255,255,0.3)"}}>Healthy: {b.healthy}</p>
                              {b.patient&&<p style={{fontSize:11,fontWeight:600,color:b.color}}>Patient: {b.patient}</p>}
                            </div>
                          </div>
                          <p style={{fontSize:10,color:"rgba(255,255,255,0.45)",lineHeight:1.6,marginBottom:4}}>{b.function}</p>
                          <p style={{fontSize:10,color:"rgba(248,113,113,0.7)",lineHeight:1.5,fontStyle:"italic"}}>{b.ibd}</p>
                        </div>
                      ))}
                    </Sec>
                  </Card>

                  <Card>
                    <Sec title="⚠️ Harmful Bacteria" sub="Higher levels = increased disease risk">
                      {BACTERIA_ROLES.filter(b=>b.role==="bad").map(b=>(
                        <div key={b.name} style={{marginBottom:16,paddingBottom:16,borderBottom:"1px solid rgba(255,255,255,0.05)"}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                            <p style={{fontSize:12,fontWeight:600,color:b.color,flex:1}}>{b.name}</p>
                            <div style={{textAlign:"right",marginLeft:12}}>
                              <p style={{fontSize:10,color:"rgba(255,255,255,0.3)"}}>Healthy: {b.healthy}</p>
                            </div>
                          </div>
                          <p style={{fontSize:10,color:"rgba(255,255,255,0.45)",lineHeight:1.6,marginBottom:4}}>{b.function}</p>
                          <p style={{fontSize:10,color:"rgba(248,113,113,0.7)",lineHeight:1.5,fontStyle:"italic"}}>{b.ibd}</p>
                        </div>
                      ))}
                    </Sec>
                  </Card>
                </div>

                <div style={{padding:"12px 16px",borderRadius:12,background:"rgba(251,146,60,0.06)",border:"1px solid rgba(251,146,60,0.15)",fontSize:11,color:"rgba(251,146,60,0.7)",lineHeight:1.7}}>
                  ⚠️ <strong>Disclaimer:</strong> These risk estimates are calculated from clinical disease activity scores (HBI, SCCAI, fecal calprotectin) and published microbiome research. They are for research and educational purposes only and do not constitute a medical diagnosis. Always consult a qualified physician.
                </div>
              </div>
            )}

            {/* ── AI SUMMARY ── */}
            {tab==="summary"&&(
              <div style={{maxWidth:780}}>
                <Card>
                  <Sec title="AI Clinical Summary" sub="Claude analyzes the full patient profile and generates a clinical narrative">
                    {!aiSummaries[pid] ? (
                      <div style={{textAlign:"center",padding:"36px 0"}}>
                        <p style={{color:"rgba(255,255,255,0.28)",fontSize:12,marginBottom:22,lineHeight:1.8}}>
                          Generate a clinical narrative for <strong style={{color:"rgba(255,255,255,0.55)"}}>{pid}</strong> based on their diagnosis, clinical scores, disease history{data.hasTaxa?", microbiome composition, and diversity indices":""}.
                        </p>
                        <button onClick={doAI} disabled={aiLoading}
                          style={{padding:"10px 28px",borderRadius:100,background:aiLoading?"rgba(74,222,128,0.04)":"rgba(74,222,128,0.1)",border:"1px solid",borderColor:aiLoading?"rgba(74,222,128,0.15)":"rgba(74,222,128,0.45)",color:aiLoading?"rgba(74,222,128,0.35)":"#4ade80",fontSize:12,cursor:aiLoading?"not-allowed":"pointer",fontFamily:"inherit"}}>
                          {aiLoading?<span className="pl">Generating summary…</span>:"✦ Generate AI Summary"}
                        </button>
                      </div>
                    ) : (
                      <div>
                        <div style={{display:"flex",gap:7,marginBottom:18,flexWrap:"wrap"}}>
                          {meta.diagnosis&&<span style={{fontSize:9,padding:"2px 9px",borderRadius:100,background:diagColor(meta.diagnosis)+"22",color:diagColor(meta.diagnosis)}}>{meta.diagnosis}</span>}
                          {stats&&<span style={{fontSize:9,padding:"2px 9px",borderRadius:100,background:"rgba(74,222,128,0.1)",color:"#4ade80"}}>Score {stats.score}/100</span>}
                          {stats&&<span style={{fontSize:9,padding:"2px 9px",borderRadius:100,background:stats.et.color+"22",color:stats.et.color}}>{stats.et.type}</span>}
                          {meta.site&&<span style={{fontSize:9,padding:"2px 9px",borderRadius:100,background:"rgba(34,211,238,0.1)",color:"#22d3ee"}}>{meta.site}</span>}
                        </div>
                        <div style={{fontSize:13,lineHeight:1.9,color:"rgba(255,255,255,0.65)"}}>
                          {aiSummaries[pid].split("\n\n").map((p,i)=>p.trim()&&<p key={i} style={{marginBottom:14}}>{p}</p>)}
                        </div>
                        <button onClick={()=>setAiSummaries(p=>({...p,[pid]:null}))}
                          style={{marginTop:14,padding:"6px 16px",borderRadius:100,border:"1px solid rgba(255,255,255,0.08)",background:"transparent",color:"rgba(255,255,255,0.25)",fontSize:10,cursor:"pointer",fontFamily:"inherit"}}>↺ Regenerate</button>
                      </div>
                    )}
                  </Sec>
                </Card>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
