// 等待时间估计。
// 进场、换队、离开都只信有证据的记录；窗口未闭合的旅客留在等待时间范围中（区间/右删失）。
// closed=禁止配置新服务（在服务的可完成），missing-gate=观察不全（期间可能有人未留记录地通过）。
import { serviceTypeOf, plannedZone } from './model.mjs';

// 一名旅客在其服务区域的等待区间。
// 返回 { zone, entry:{lo,hi,kind}, exit:{lo,hi,kind}, wait:{lo,hi}, censor, segments, evidence }
// hi=Infinity 表示观察未闭合；wait 单位分钟。
export function waitInterval(person, model) {
  const events = person.events;
  const pass = [...events].reverse().find(e => e.kind === 'pass');
  const start = events.find(e => e.kind === 'start');
  const scan = events.find(e => e.kind === 'scan');
  const arrive = events.find(e => e.kind === 'arrive');
  const cutoff = model.cutoffOf(person.visit);
  const disruptions = model.disruptionsOf(person.visit);

  const zone = pass?.zone ?? start?.zone ?? scan?.zone ?? null;
  if (events.length === 0) {
    return { person: person.person, zone: null, evidence: '仅预约', censor: '无观测', wait: { lo: 0, hi: Infinity }, entry: null, exit: null, segments: {} };
  }
  const effectiveZone = zone ?? plannedZone(person, model, person.window);

  // 进场：优先用该区域自己的 scan/start；否则按约定“无反证时径直步行进场”（大厅到达+步行分钟），
  // 逗留松弛度单列；只有 pass 的以预约为下界。
  let entry = null;
  const anchor = (start && (!pass || start.time <= pass.time) && start.zone === effectiveZone) ? start
    : (scan && (!pass || scan.time <= pass.time) && scan.zone === effectiveZone) ? scan : null;
  if (anchor) {
    entry = { lo: anchor.time, hi: anchor.time, kind: anchor.kind === 'start' ? '服务开始记录' : '闸机扫码', slack: 0 };
  } else {
    const before = events.filter(e => e.kind !== 'pass' && (!pass || e.time <= pass.time)).at(-1);
    if (before) {
      const walk = model.walk(before.zone, effectiveZone, { wheelchair: person.assisted });
      const at = before.time + (walk ?? 0);
      const slackTo = pass ? pass.time : cutoff;
      entry = {
        lo: at,
        hi: at,
        kind: walk === null ? '换乘不可达，按同时刻计' : `由${before.zone}径直步行推算（约定）`,
        slack: Math.max(0, slackTo - at), // 若在大厅逗留，真实进场更晚、队列等待更短
      };
    } else if (!pass) {
      entry = { lo: person.window, hi: cutoff, kind: '以预约为界', slack: 0 };
    } else {
      entry = { lo: person.window, hi: pass.time, kind: '以预约为界', slack: 0 };
    }
  }

  // 离开：有 pass 用 pass；否则按 missing-gate / 采集截止删失。
  let exit;
  let censor = '无';
  if (pass) {
    const missing = disruptions.some(d => d.kind === 'missing-gate' && d.zone === pass.zone && pass.time >= d.first && pass.time <= d.last);
    exit = { lo: pass.time, hi: pass.time, kind: missing ? '闸机通过（断报期记录）' : '闸机通过' };
  } else {
    const lastSeen = events.at(-1).time;
    const gap = disruptions.find(d => d.kind === 'missing-gate' && d.zone === effectiveZone && d.last >= lastSeen);
    if (gap) {
      // 断报期间也可能通过：离开时刻不早于断报开始，且观察未闭合。
      exit = { lo: Math.max(gap.first, lastSeen), hi: Infinity, kind: '断报期间可能已离开' };
      censor = '断报删失';
    } else {
      exit = { lo: Math.max(cutoff, lastSeen), hi: Infinity, kind: '采集截止时仍在队列' };
      censor = '右删失';
    }
  }

  const wait = {
    lo: Math.max(0, exit.lo - entry.hi),
    hi: exit.hi === Infinity ? Infinity : Math.max(0, exit.hi - entry.lo),
  };

  const segments = {};
  if (start && start.zone === effectiveZone) {
    segments.queue = { lo: Math.max(0, start.time - entry.hi), hi: Math.max(0, start.time - entry.lo) };
    segments.service = exit.hi === Infinity
      ? { lo: Math.max(0, exit.lo - start.time), hi: Infinity }
      : { lo: Math.max(0, exit.lo - start.time), hi: Math.max(0, exit.hi - start.time) };
  }

  return {
    person: person.person,
    zone: effectiveZone,
    evidence: pass || anchor ? '有证据' : '部分证据',
    censor,
    entry,
    exit,
    wait,
    segments,
  };
}

// Turnbull 区间删失估计：点观测、区间观测、右删失统一处理。
// intervals: [{lo, hi}]，hi 可为 Infinity。返回基本区间上的概率质量与分位数区间。
export function turnbull(intervals, { tol = 1e-10, maxIter = 5000 } = {}) {
  const usable = intervals.filter(iv => Number.isFinite(iv.lo) && iv.lo <= iv.hi);
  if (usable.length === 0) return { masses: [], n: 0, converged: true };

  const endpoints = new Set([0]);
  for (const { lo, hi } of usable) {
    endpoints.add(Math.max(0, lo));
    if (Number.isFinite(hi)) endpoints.add(hi);
  }
  const sorted = [...endpoints].sort((a, b) => a - b);
  const elements = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const lo = i === 0 ? 0 : sorted[i - 1];
    const hi = sorted[i];
    if (hi >= lo) elements.push({ lo, hi });
  }
  if (usable.some(iv => iv.hi === Infinity)) {
    elements.push({ lo: sorted.at(-1), hi: Infinity });
  }

  // 每个观测覆盖哪些基本区间：约定 (lo, hi] 左开右闭；点观测落在 hi 等于其值的基本区间。
  const covers = usable.map(({ lo, hi }) => {
    const idx = [];
    elements.forEach((el, j) => {
      if (lo === hi) {
        if (el.hi === lo || (j === 0 && lo <= el.hi)) idx.push(j);
      } else if (el.hi > lo && el.lo < hi) {
        idx.push(j);
      }
    });
    if (idx.length === 0) idx.push(elements.length - 1);
    return idx;
  });

  let p = new Array(elements.length).fill(0);
  for (const idx of covers) for (const j of idx) p[j] += 1;
  p = p.map(v => v / p.reduce((a, b) => a + b, 0));

  let converged = false;
  for (let iter = 0; iter < maxIter; iter += 1) {
    const counts = new Array(elements.length).fill(0);
    for (const idx of covers) {
      const total = idx.reduce((sum, j) => sum + p[j], 0);
      if (total === 0) continue;
      for (const j of idx) counts[j] += p[j] / total;
    }
    const next = counts.map(c => c / usable.length);
    const delta = Math.max(...next.map((v, j) => Math.abs(v - p[j])));
    p = next;
    if (delta < tol) { converged = true; break; }
  }

  const masses = elements.map((el, j) => ({ lo: el.lo, hi: el.hi, p: p[j] })).filter(m => m.p > 1e-6);
  return { masses, n: usable.length, converged };
}

export function quantileOf(masses, q) {
  let cumulative = 0;
  for (const mass of masses) {
    cumulative += mass.p;
    if (cumulative >= q - 1e-12) return { lo: mass.lo, hi: mass.hi };
  }
  return { lo: Infinity, hi: Infinity };
}

// 乐观/悲观界限：分别把每个观测压到下界/上界后的经验分位数。
export function boundQuantiles(intervals, q) {
  const pick = values => {
    const finite = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    const rank = Math.ceil(q * values.length);
    if (rank <= finite.length) return finite[rank - 1];
    return Infinity; // 删失质量太大，该分位数不可识别
  };
  return {
    optimistic: pick(intervals.map(iv => iv.lo)),
    pessimistic: pick(intervals.map(iv => iv.hi)),
  };
}

// 按时段×服务类型分层估计等待分布与不确定性。
// 只有预约的人不进分层样本，单独计数；快道者从普通窗口对照中剔除。
// visit 限定后只取该航次人员；缺省合并全部（用于相容既往观测的汇总）。
export function estimateWaits(model, { buckets = null, visit = null } = {}) {
  const intervals = new Map(); // person -> interval
  for (const person of model.people.values()) {
    if (visit !== null && person.visit !== visit) continue;
    intervals.set(person.person, waitInterval(person, model));
  }

  const boundaries = buckets ?? defaultBuckets(model);
  const bucketOf = time => {
    for (const bucket of boundaries) {
      if (time >= bucket[0] && time < bucket[1]) return bucket;
    }
    return null;
  };

  const strata = new Map();
  const ensure = (type, bucket) => {
    const key = `${type}|${bucket[0]}|${bucket[1]}`;
    if (!strata.has(key)) strata.set(key, { serviceType: type, bucket, samples: [], excludedFastTrack: [], censored: 0 });
    return strata.get(key);
  };

  const appointmentOnly = { assisted: 0, normal: 0, people: [] };
  for (const person of model.people.values()) {
    if (visit !== null && person.visit !== visit) continue;
    const type = serviceTypeOf(person);
    const iv = intervals.get(person.person);
    if (iv.evidence === '仅预约') {
      appointmentOnly[type] += 1;
      appointmentOnly.people.push(person.person);
      continue;
    }
    const entryTime = iv.entry ? iv.entry.lo : person.window;
    const bucket = bucketOf(entryTime);
    if (!bucket) continue;
    const stratum = ensure(type, bucket);
    if (type === 'normal' && person.fastTrack.length > 0) {
      stratum.excludedFastTrack.push({ person: person.person, reasons: person.fastTrack });
      continue;
    }
    stratum.samples.push({ person: person.person, ...iv.wait, censor: iv.censor });
    if (iv.censor !== '无') stratum.censored += 1;
  }

  const result = [];
  for (const stratum of strata.values()) {
    const ivs = stratum.samples.map(s => ({ lo: s.lo, hi: s.hi }));
    const fit = turnbull(ivs);
    const quantiles = {};
    for (const [name, q] of [['p50', 0.5], ['p75', 0.75], ['p90', 0.9]]) {
      quantiles[name] = ivs.length > 0 ? quantileOf(fit.masses, q) : null;
    }
    const bounds = ivs.length > 0
      ? { p50: boundQuantiles(ivs, 0.5), p75: boundQuantiles(ivs, 0.75), p90: boundQuantiles(ivs, 0.9) }
      : null;
    result.push({
      serviceType: stratum.serviceType,
      bucket: stratum.bucket,
      n: stratum.samples.length,
      censored: stratum.censored,
      excludedFastTrack: stratum.excludedFastTrack,
      masses: fit.masses,
      quantiles,
      bounds,
      converged: fit.converged,
    });
  }
  return { strata: result, appointmentOnly, intervals, buckets: boundaries };
}

function defaultBuckets(model) {
  const times = [];
  for (const person of model.people.values()) times.push(person.window);
  for (const visit of model.visits.values()) times.push(visit.cutoff);
  const lo = Math.min(...times);
  const hi = Math.max(...times) + 1;
  const cuts = [...new Set(model.capacity.map(o => o.from))].filter(t => t > lo && t < hi).sort((a, b) => a - b);
  const boundaries = [];
  let start = lo;
  for (const cut of [...cuts, hi]) {
    boundaries.push([start, cut]);
    start = cut;
  }
  return boundaries;
}
