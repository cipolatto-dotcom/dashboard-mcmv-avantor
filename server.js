const express = require("express");
const fetch   = require("node-fetch");

const app  = express();
const PORT = process.env.PORT || 3000;

const GHL_TOKEN = process.env.GHL_TOKEN;
const GHL_LOC   = process.env.GHL_LOC;
const GHL_PIPE  = process.env.GHL_PIPE;
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "60000");

if (!GHL_TOKEN || !GHL_LOC || !GHL_PIPE) {
  console.error("ERRO: variáveis GHL_TOKEN, GHL_LOC e GHL_PIPE são obrigatórias.");
  process.exit(1);
}

const STAGES = [
  { id: "cf6c826a-7a17-464f-9dbb-3a2d40c3d76a", name: "Novo Lead"   },
  { id: "1f732a3b-ec6d-452b-9530-7eff8fd6c3b9", name: "Atendimento" },
  { id: "1defe615-8cbc-449c-8202-a67c5b65b1ba", name: "Simulação"   },
  { id: "c321098d-4581-477f-8cbf-46f29d05fec0", name: "Visita"      },
  { id: "a97c5461-39a1-40c7-8f0d-a24ec2109e9f", name: "Aprovação"   },
  { id: "4a5ff2d0-dd4b-4ac9-bc83-56669cf485cd", name: "Negociação"  },
];

// ── Cache de dados brutos (todas as oportunidades) ────────────────────────────
let rawCache = { opps: null, ts: 0 };

async function fetchRawOpps() {
  if (rawCache.opps && Date.now() - rawCache.ts < CACHE_TTL) return rawCache.opps;

  const all = [];
  let url = `https://services.leadconnectorhq.com/opportunities/search`
          + `?location_id=${GHL_LOC}&pipeline_id=${GHL_PIPE}&limit=100`;
  let pages = 0;

  while (url && pages < 30) {
    const res  = await fetch(url, {
      headers: { "Authorization": `Bearer ${GHL_TOKEN}`, "Version": "2021-07-28" }
    });
    const json = await res.json();
    const opps = json.opportunities || [];
    all.push(...opps);
    const next = json.meta?.nextPageUrl;
    url = (next && opps.length === 100) ? next : null;
    pages++;
  }

  rawCache = { opps: all, ts: Date.now() };
  return all;
}

// ── Processa opps com filtro de data em memória ───────────────────────────────
function processOpps(all, fromDate, toDate) {
  const stageMap = {};
  STAGES.forEach(s => {
    stageMap[s.id] = { open: 0, lost: 0, won: 0, open_val: 0, won_val: 0 };
  });

  const fromTs = fromDate ? new Date(fromDate + "T00:00:00").getTime() : null;
  const toTs   = toDate   ? new Date(toDate   + "T23:59:59.999").getTime() : null;

  for (const opp of all) {
    if (fromTs !== null || toTs !== null) {
      const ts = new Date(opp.createdAt).getTime();
      if (fromTs !== null && ts < fromTs) continue;
      if (toTs   !== null && ts > toTs)   continue;
    }
    const sid    = opp.pipelineStageId;
    const status = opp.status || "open";
    const val    = opp.monetaryValue || 0;
    if (!stageMap[sid]) continue;
    stageMap[sid][status] = (stageMap[sid][status] || 0) + 1;
    if (status === "open") stageMap[sid].open_val += val;
    if (status === "won")  stageMap[sid].won_val  += val;
  }

  const stages = STAGES.map(s => ({ ...s, ...stageMap[s.id] }));
  let total = 0, open = 0, lost = 0, won = 0, won_val = 0;
  for (const s of stages) {
    total += s.open + s.lost + s.won;
    open  += s.open;
    lost  += s.lost;
    won   += s.won;
    won_val += s.won_val;
  }

  return { stages, totals: { total, open, lost, won, won_val }, updatedAt: new Date().toISOString() };
}

// ── API JSON ──────────────────────────────────────────────────────────────────
app.get("/api/data", async (req, res) => {
  try {
    res.json(processOpps(await fetchRawOpps(), req.query.from, req.query.to));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Dashboard HTML ────────────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  let data;
  try {
    data = processOpps(await fetchRawOpps(), req.query.from, req.query.to);
  } catch (e) {
    return res.status(500).send(`<pre>Erro: ${e.message}</pre>`);
  }

  const { stages, totals, updatedAt } = data;
  const from = req.query.from || "";
  const to   = req.query.to   || "";

  const N = n => (n || 0).toLocaleString("pt-BR");
  const P = (a, b) => (!b ? "—" : ((a / b) * 100).toFixed(1) + "%");
  const C = n => {
    if (!n) return "R$ 0";
    if (n >= 1e6) return "R$ " + (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return "R$ " + (n / 1e3).toFixed(0) + "k";
    return "R$ " + n.toLocaleString("pt-BR");
  };
  const fmt = iso => new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });

  const stTotals   = stages.map(s => s.open + s.lost + s.won);
  const firstTotal = Math.max(stTotals[0], 1);

  const periodLabel = (() => {
    if (from && to) return `${from.split("-").reverse().join("/")} → ${to.split("-").reverse().join("/")}`;
    if (from) return `A partir de ${from.split("-").reverse().join("/")}`;
    if (to)   return `Até ${to.split("-").reverse().join("/")}`;
    return "Todos os dados";
  })();

  // ── Funil ─────────────────────────────────────────────────────────────────
  const funnelRows = stages.map((s, i) => {
    const total  = stTotals[i];
    const barPct = Math.max((total / firstTotal) * 100, total > 0 ? 6 : 1);

    const convCum  = i === 0 ? "100%" : P(total, firstTotal);
    const convPrev = i === 0 ? "—"    : P(total, stTotals[i - 1]);

    const badges = [
      s.open > 0 ? `<span class="fbadge open">${N(s.open)} aberto</span>` : "",
      s.won  > 0 ? `<span class="fbadge won">${N(s.won)} ganho</span>`   : "",
      s.lost > 0 ? `<span class="fbadge lost">${N(s.lost)} perdido</span>` : "",
    ].filter(Boolean).join("");

    const connector = i === 0 ? "" : `
      <div class="conv-row">
        <div class="conv-line"></div>
        <div class="conv-pills">
          <span class="conv-pill total" title="% acumulada em relação ao 1º estágio">
            &#9654; ${convCum} do total
          </span>
          <span class="conv-pill prev" title="% em relação ao estágio anterior">
            &#8595; ${convPrev} do anterior
          </span>
        </div>
        <div class="conv-line"></div>
      </div>`;

    return `${connector}
    <div class="f-stage">
      <div class="f-bar" style="width:${barPct}%">
        <span class="f-name">${s.name}</span>
        <span class="f-count">${N(total)}</span>
        <span class="f-badges">${badges}</span>
      </div>
    </div>`;
  }).join("");

  // ── Breakdown ─────────────────────────────────────────────────────────────
  const mkBreak = (field, cls) =>
    stages.filter(s => s[field] > 0)
      .map(s => `<div class="brow"><span>${s.name}</span><span class="bn ${cls}">${N(s[field])}</span></div>`)
      .join("") || `<div class="bempty">Nenhum</div>`;

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard MCMV · Avantor Imóveis</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@300;400;500;600;700&family=Barlow+Condensed:wght@500;600;700&display=swap" rel="stylesheet">
<style>
/* ── Reset ───────────────────────────────────────── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Barlow',sans-serif;background:#EEF1F7;color:#0D234A;font-size:14px;min-height:100vh}

/* ── Header ──────────────────────────────────────── */
.hdr{background:#0D234A;height:62px;display:flex;align-items:center;
     justify-content:space-between;padding:0 28px;
     box-shadow:0 2px 10px rgba(0,0,0,.2)}
.hdr-l{display:flex;align-items:center;gap:14px}
/* ícone V + triângulo */
.brand-icon{width:38px;height:38px;flex-shrink:0}
.brand-text{display:flex;flex-direction:column}
.brand-name{font-family:'Barlow Condensed',sans-serif;font-size:21px;font-weight:700;
            color:#fff;letter-spacing:.14em;line-height:1}
.brand-sub{font-size:8.5px;font-weight:500;color:rgba(255,255,255,.45);
           letter-spacing:.26em;text-transform:uppercase;margin-top:2px}
.hdr-r{display:flex;align-items:center;gap:16px}
.hdr-pipe{font-size:11px;color:rgba(255,255,255,.35);letter-spacing:.04em}
.live{display:flex;align-items:center;gap:5px;background:rgba(22,163,74,.15);
      border:1px solid rgba(22,163,74,.3);border-radius:20px;padding:4px 11px;
      font-size:11px;color:#4ADE80}
.dot{width:6px;height:6px;background:#4ADE80;border-radius:50%;
     animation:p 1.8s ease-in-out infinite}
@keyframes p{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.65)}}
.hdr-ts{font-size:10.5px;color:rgba(255,255,255,.3)}

/* ── Gold bar ────────────────────────────────────── */
.gold-bar{height:3px;background:#E6B012}

/* ── Wrap ────────────────────────────────────────── */
.wrap{max-width:1180px;margin:0 auto;padding:22px 28px}

/* ── Filter bar ──────────────────────────────────── */
.filter{background:#fff;border:1px solid #E2E8F0;border-radius:10px;
        padding:12px 18px;display:flex;align-items:center;gap:10px;
        flex-wrap:wrap;margin-bottom:18px}
.flbl{font-size:10px;font-weight:700;color:#6B7A99;text-transform:uppercase;
      letter-spacing:.07em;flex-shrink:0}
.qbtns{display:flex;gap:5px;flex-wrap:wrap}
.qb{background:none;border:1px solid #E2E8F0;border-radius:6px;padding:4px 11px;
    font-size:12px;font-family:'Barlow',sans-serif;color:#0D234A;cursor:pointer;
    transition:all .15s}
.qb:hover,.qb.on{background:#0D234A;color:#fff;border-color:#0D234A}
.fsep{width:1px;height:26px;background:#E2E8F0;flex-shrink:0}
.dinp{display:flex;align-items:center;gap:7px}
.dinp input[type=date]{border:1px solid #E2E8F0;border-radius:6px;padding:4px 9px;
    font-size:12px;font-family:'Barlow',sans-serif;color:#0D234A;outline:none}
.dinp input[type=date]:focus{border-color:#0D234A}
.dsep{font-size:12px;color:#6B7A99}
.fapply{background:#E6B012;border:none;border-radius:6px;padding:5px 14px;
        font-size:12px;font-weight:700;font-family:'Barlow',sans-serif;
        color:#0D234A;cursor:pointer;transition:opacity .15s}
.fapply:hover{opacity:.85}
.period-tag{margin-left:auto;background:rgba(230,176,18,.1);
            border:1px solid rgba(230,176,18,.3);border-radius:6px;
            padding:3px 11px;font-size:10.5px;color:#8B6508;font-weight:500}

/* ── KPI grid ────────────────────────────────────── */
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}
.kpi{background:#fff;border:1px solid #E2E8F0;border-radius:10px;
     padding:18px 20px;position:relative;overflow:hidden}
.kpi::after{content:'';position:absolute;bottom:0;left:0;right:0;height:3px}
.kpi.k-navy::after{background:#0D234A}
.kpi.k-gold::after{background:#E6B012}
.kpi.k-green::after{background:#16A34A}
.kpi.k-red::after{background:#DC2626}
.klbl{font-size:10px;font-weight:700;color:#6B7A99;text-transform:uppercase;
      letter-spacing:.07em;margin-bottom:9px}
.kval{font-size:34px;font-weight:700;line-height:1;color:#0D234A;
      font-family:'Barlow Condensed',sans-serif;letter-spacing:-.01em}
.kpi.k-green .kval{color:#16A34A}
.kpi.k-red .kval{color:#DC2626}
.ksub{font-size:11px;color:#6B7A99;margin-top:5px}

/* ── Section card ────────────────────────────────── */
.section{background:#fff;border:1px solid #E2E8F0;border-radius:10px;
         padding:22px 24px;margin-bottom:18px}
.sec-title{font-size:10px;font-weight:700;color:#6B7A99;text-transform:uppercase;
           letter-spacing:.1em;margin-bottom:22px;display:flex;align-items:center;gap:10px}
.sec-title::after{content:'';flex:1;height:1px;background:#E2E8F0}

/* ── Funil ───────────────────────────────────────── */
.funnel{display:flex;flex-direction:column;align-items:center;padding:0 12px}
.f-stage{width:100%;display:flex;justify-content:center;margin:0}
.f-bar{background:linear-gradient(135deg,#0D234A 0%,#152f60 100%);
       border-radius:8px;height:54px;display:flex;align-items:center;
       padding:0 14px;gap:10px;min-width:140px;transition:width .4s ease}
.f-name{font-size:12.5px;font-weight:600;color:rgba(255,255,255,.8);
        white-space:nowrap;min-width:88px;flex-shrink:0}
.f-count{font-size:22px;font-weight:700;color:#fff;
         font-family:'Barlow Condensed',sans-serif;min-width:36px;flex-shrink:0}
.f-badges{display:flex;gap:4px;flex-wrap:wrap}
.fbadge{font-size:9.5px;padding:2px 7px;border-radius:10px;font-weight:500}
.fbadge.open{background:rgba(255,255,255,.14);color:rgba(255,255,255,.9)}
.fbadge.won{background:rgba(22,163,74,.28);color:#86EFAC}
.fbadge.lost{background:rgba(255,255,255,.07);color:rgba(255,255,255,.4)}

/* ── Conv connector ──────────────────────────────── */
.conv-row{display:flex;align-items:center;width:100%;height:34px;gap:0}
.conv-line{flex:1;height:1px;background:#E2E8F0}
.conv-pills{display:flex;gap:6px;padding:0 10px;flex-shrink:0}
.conv-pill{font-size:10px;padding:3px 10px;border-radius:12px;
           font-weight:600;white-space:nowrap;cursor:default}
.conv-pill.total{background:rgba(13,35,74,.07);color:#0D234A;
                 border:1px solid rgba(13,35,74,.13)}
.conv-pill.prev{background:rgba(230,176,18,.12);color:#7A5500;
                border:1px solid rgba(230,176,18,.35)}

/* ── Breakdown ───────────────────────────────────── */
.bg3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:18px}
.bc{background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:16px 18px}
.bt{font-size:10px;font-weight:700;color:#6B7A99;text-transform:uppercase;
    letter-spacing:.08em;margin-bottom:10px}
.brow{display:flex;justify-content:space-between;align-items:center;
      padding:5px 0;border-bottom:1px solid #F1F5F9;font-size:12px}
.brow:last-child{border-bottom:none}
.bn{font-weight:700;font-family:'Barlow Condensed',sans-serif;font-size:15px}
.bn.open{color:#2563EB}.bn.won{color:#16A34A}.bn.lost{color:#6B7A99}
.bempty{font-size:12px;color:#CBD5E1}

/* ── Footer ──────────────────────────────────────── */
.foot{display:flex;justify-content:space-between;align-items:center;
      padding:10px 0;border-top:1px solid #E2E8F0;
      font-size:10px;color:#94A3B8;letter-spacing:.03em}

/* ── Responsive ──────────────────────────────────── */
@media(max-width:768px){
  .wrap{padding:14px}
  .kpi-grid{grid-template-columns:repeat(2,1fr)}
  .bg3{grid-template-columns:1fr}
  .hdr{padding:0 14px}
  .hdr-pipe,.hdr-ts{display:none}
}
</style>
</head>
<body>

<!-- Header -->
<header class="hdr">
  <div class="hdr-l">
    <!-- Ícone: V branco + triângulo dourado -->
    <svg class="brand-icon" viewBox="0 0 38 38" fill="none" xmlns="http://www.w3.org/2000/svg">
      <polygon points="19,4 24,14 14,14" fill="#E6B012"/>
      <polygon points="8,16 14,16 19,30 24,16 30,16 19,36" fill="white"/>
    </svg>
    <div class="brand-text">
      <span class="brand-name">AVANTOR</span>
      <span class="brand-sub">IMÓVEIS</span>
    </div>
  </div>
  <div class="hdr-r">
    <span class="hdr-pipe">Pipeline MCMV</span>
    <div class="live"><div class="dot"></div>Tempo real</div>
    <span class="hdr-ts">${fmt(updatedAt)}</span>
  </div>
</header>
<div class="gold-bar"></div>

<div class="wrap">

  <!-- Filtro de período -->
  <div class="filter">
    <span class="flbl">Período</span>
    <div class="qbtns">
      <button class="qb${!from && !to ? " on" : ""}" onclick="clearF()">Todos</button>
      <button class="qb" onclick="setD(0)">Hoje</button>
      <button class="qb" onclick="setD(7)">7 dias</button>
      <button class="qb" onclick="setD(30)">30 dias</button>
      <button class="qb" onclick="setD(90)">90 dias</button>
      <button class="qb" onclick="setMes()">Este mês</button>
    </div>
    <div class="fsep"></div>
    <form class="dinp" method="get" action="/">
      <input type="date" name="from" value="${from}">
      <span class="dsep">→</span>
      <input type="date" name="to" value="${to}">
      <button type="submit" class="fapply">Filtrar</button>
    </form>
    <span class="period-tag">${periodLabel}</span>
  </div>

  <!-- KPIs -->
  <div class="kpi-grid">
    <div class="kpi k-navy">
      <div class="klbl">Total no pipeline</div>
      <div class="kval">${N(totals.total)}</div>
      <div class="ksub">oportunidades</div>
    </div>
    <div class="kpi k-navy">
      <div class="klbl">Em aberto</div>
      <div class="kval">${N(totals.open)}</div>
      <div class="ksub">ativos no funil</div>
    </div>
    <div class="kpi k-green">
      <div class="klbl">Ganhos</div>
      <div class="kval">${N(totals.won)}</div>
      <div class="ksub">${C(totals.won_val)} em valor</div>
    </div>
    <div class="kpi k-red">
      <div class="klbl">Perdidos</div>
      <div class="kval">${N(totals.lost)}</div>
      <div class="ksub">conv. geral ${P(totals.won, totals.total)}</div>
    </div>
  </div>

  <!-- Funil -->
  <div class="section">
    <div class="sec-title">Funil de vendas — por etapa</div>
    <div class="funnel">
      ${funnelRows}
    </div>
  </div>

  <!-- Breakdown -->
  <div class="bg3">
    <div class="bc">
      <div class="bt">Em aberto por etapa</div>
      ${mkBreak("open", "open")}
    </div>
    <div class="bc">
      <div class="bt">Ganhos por etapa</div>
      ${mkBreak("won", "won")}
    </div>
    <div class="bc">
      <div class="bt">Perdidos por etapa</div>
      ${mkBreak("lost", "lost")}
    </div>
  </div>

  <!-- Footer -->
  <div class="foot">
    <span>Avantor Imóveis · Dashboard MCMV · Cache ${CACHE_TTL / 1000}s</span>
    <span>Atualizado em ${fmt(updatedAt)}</span>
  </div>

</div>

<script>
const fmt2 = d => d.toISOString().split('T')[0];
const nav  = (f, t) => location.href = '/?from=' + f + '&to=' + t;

function clearF() { location.href = '/'; }

function setD(days) {
  const to   = new Date();
  const from = days === 0 ? new Date() : new Date(Date.now() - days * 86400000);
  nav(fmt2(from), fmt2(to));
}

function setMes() {
  const now  = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  nav(fmt2(from), fmt2(now));
}

// Auto-reload mantendo os filtros da URL
setTimeout(() => location.reload(), ${CACHE_TTL});
</script>

</body>
</html>`;

  res.send(html);
});

app.listen(PORT, () => console.log(`Dashboard MCMV na porta ${PORT}`));
