// 分析工具入口：子命令 + 可选 HTTP 服务。仅依赖 Node.js 标准库。
// 用法：node tools/analyze.mjs <summary|paths|waits|compare|plan|outage|review|view|report|serve> [选项]
import { parseArgs } from 'node:util';
import { createServer } from 'node:http';
import path from 'node:path';
import { loadMaterials } from './lib/load.mjs';
import { buildModel } from './lib/model.mjs';
import { estimateWaits } from './lib/waits.mjs';
import { compareVisits } from './lib/compare.mjs';
import { evaluatePlan, comparePlans, defaultServiceRanges } from './lib/plan.mjs';
import { analyzeOutage } from './lib/outage.mjs';
import { buildReview } from './lib/review.mjs';
import { opsView, airlineView } from './lib/views.mjs';
import { buildSummary, buildPaths, buildReport } from './lib/report.mjs';
import { formatTime, formatMinutes, parseTime } from './lib/time.mjs';

const TIME_KEYS = new Set([
  'window', 'cutoff', 'time', 'first', 'last', 'from', 'to', 'meetBy', 'notifiedUntil',
  'arrive', 'pass', 'meet', 'lastEvent', 'meetHorizon', 'newWindow', 'toldWindow', 'release',
  'rebookedWindow', '采集截止',
]);
const DURATION_RANGE_KEYS = new Set(['wait', 'p50', 'p75', 'p90', 'optimistic', 'pessimistic', 'queue', 'service', 'masses']);
const TIME_RANGE_KEYS = new Set(['entry', 'exit', 'completion', 'meet', 'actualExit', 'bucket']);
const DURATION_KEYS = new Set(['minutes', 'reopenWalk']);

// 把分钟数按字段语义转成 HH:MM 或时长；Infinity 不编造，显示为未定/不可识别。
function present(value, key = '') {
  if (value instanceof Map) {
    return present(Object.fromEntries(value), key);
  }
  if (Array.isArray(value)) {
    if (value.length === 2 && value.every(v => typeof v === 'number')) {
      if (key === 'bucket' || key === '时段' || key === 'pair') {
        return `[${formatTime(value[0])}, ${formatTime(value[1])}]`;
      }
      if (key === 'normal' || key === 'assisted') {
        return `[${formatMinutes(value[0])} ~ ${formatMinutes(value[1])}]`;
      }
    }
    if (value.length > 0 && value.every(v => Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number'))) {
      return value.map(pair => `[${formatTime(pair[0])}, ${formatTime(pair[1])}]`);
    }
    return value.map(v => present(v, key));
  }
  if (value && typeof value === 'object') {
    if ('lo' in value && 'hi' in value) {
      const range = TIME_RANGE_KEYS.has(key)
        ? `[${formatTime(value.lo)}, ${formatTime(value.hi)}]`
        : DURATION_RANGE_KEYS.has(key)
          ? `[${formatMinutes(value.lo)} ~ ${formatMinutes(value.hi)}]`
          : `[${formatTime(value.lo)}, ${formatTime(value.hi)}]`;
      if ('kind' in value) return { 区间: range, 依据: value.kind };
      return range;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, present(v, k)]));
  }
  if (typeof value === 'number') {
    if (TIME_KEYS.has(key)) return formatTime(value);
    if (DURATION_KEYS.has(key)) return formatMinutes(value);
  }
  return value;
}

function parseBuckets(text) {
  if (!text) return null;
  const cuts = text.split(',').map(parseTime);
  const bounds = [];
  for (let i = 0; i < cuts.length - 1; i += 1) bounds.push([cuts[i], cuts[i + 1]]);
  if (bounds.length === 0) throw new Error('--buckets 需要至少两个时刻，如 09:00,09:24,10:00');
  return bounds;
}

function parseService(list) {
  if (!list || list.length === 0) return null;
  const service = {};
  for (const item of list) {
    const match = /^(normal|assisted)=(\d+):(\d+)$/.exec(item);
    if (!match) throw new Error(`--service 形如 normal=3:11，收到：${item}`);
    service[match[1]] = [Number(match[2]), Number(match[3])];
  }
  return service;
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: 'string', default: 'fixtures' },
      visit: { type: 'string' },
      buckets: { type: 'string' },
      arrange: { type: 'string' },
      release: { type: 'string' },
      service: { type: 'string', multiple: true },
      zone: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      audience: { type: 'string', default: 'ops' },
      port: { type: 'string', default: '8080' },
    },
  });
  const command = positionals[0];
  if (!command) {
    console.error('用法：node tools/analyze.mjs <summary|paths|waits|compare|plan|outage|review|view|report|serve> [选项]');
    process.exit(2);
  }

  const dir = path.resolve(values.dir);
  const model = buildModel(await loadMaterials(dir));
  const visits = [...model.visits.keys()];
  const visit = values.visit ?? visits.at(-1);
  const buckets = parseBuckets(values.buckets);
  const out = data => console.log(JSON.stringify(present(data), null, 2));

  switch (command) {
    case 'summary':
      out(buildSummary(model));
      break;
    case 'paths':
      out(buildPaths(model, visit));
      break;
    case 'waits':
      out(estimateWaits(model, { visit, buckets }));
      break;
    case 'compare': {
      if (visits.length < 2) throw new Error('只有一个航次，无法对比');
      out(compareVisits(model, visits[0], visits[1], { buckets }));
      break;
    }
    case 'plan': {
      const service = parseService(values.service);
      if (values.arrange) {
        out(evaluatePlan(model, visit, {
          arrangement: values.arrange.split(','),
          release: values.release ?? 'window',
          service: service ? { ...defaultServiceRanges(model), ...service } : null,
        }));
      } else {
        const plans = [
          { name: 'S0/按预约', arrangement: ['S0'], release: 'window' },
          { name: 'S0+S1/按预约', arrangement: ['S0', 'S1'], release: 'window' },
          { name: 'S0+S2/按预约', arrangement: ['S0', 'S2'], release: 'window' },
          { name: 'S0+S1/错峰5分', arrangement: ['S0', 'S1'], release: 'stagger:5' },
          { name: 'S0+S2/错峰5分', arrangement: ['S0', 'S2'], release: 'stagger:5' },
        ];
        if (service) for (const plan of plans) plan.service = { ...defaultServiceRanges(model), ...service };
        out(comparePlans(model, visit, plans));
      }
      break;
    }
    case 'outage': {
      if (values.zone) {
        out(analyzeOutage(model, {
          visit,
          zone: values.zone,
          first: parseTime(values.from),
          last: parseTime(values.to),
        }));
      } else {
        const closed = model.disruptionsOf(visit).filter(d => d.kind === 'closed');
        out(closed.map(d => analyzeOutage(model, { visit, zone: d.zone, first: d.first, last: d.last })));
      }
      break;
    }
    case 'review':
      out(buildReview(model));
      break;
    case 'view':
      out(values.audience === 'airline' ? airlineView(model, visit) : opsView(model, visit));
      break;
    case 'report':
      out(buildReport(model));
      break;
    case 'serve': {
      const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const parts = url.pathname.split('/').filter(Boolean);
        const send = (code, data) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(present(data), null, 2));
        };
        try {
          if (parts[0] === 'ops' && parts[1]) return send(200, opsView(model, parts[1]));
          if (parts[0] === 'airline' && parts[1]) return send(200, airlineView(model, parts[1]));
          if (parts[0] === 'report') return send(200, buildReport(model));
          return send(200, { 路由: ['/ops/:visit 现场视图', '/airline/:visit 航司聚合', '/report 汇总报告'] });
        } catch (error) {
          return send(500, { 错误: error.message });
        }
      });
      server.listen(Number(values.port), () => {
        console.log(`视图服务已启动：http://localhost:${values.port}/ （/ops/:visit、/airline/:visit、/report）`);
      });
      break;
    }
    default:
      throw new Error(`未知命令：${command}`);
  }
}

await main();
