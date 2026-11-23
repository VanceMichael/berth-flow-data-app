// 汇总报告：数据质量概览 + 等待分布 + 航次对比 + 放行方案 + 停用影响 + 运营复核。
import { estimateWaits } from './waits.mjs';
import { compareVisits } from './compare.mjs';
import { comparePlans } from './plan.mjs';
import { analyzeOutage } from './outage.mjs';
import { buildReview } from './review.mjs';
import { opsView, airlineView } from './views.mjs';
import { pathsFor } from './model.mjs';

export function buildSummary(model) {
  const anomalies = [];
  for (const person of model.people.values()) {
    for (const anomaly of person.anomalies) {
      anomalies.push({ person: person.person, visit: person.visit, ...anomaly });
    }
  }
  const visits = {};
  for (const [name, state] of model.visits) {
    const people = model.peopleOf(name);
    visits[name] = {
      人数: people.length,
      受助: people.filter(p => p.assisted).length,
      无陪同受助: people.filter(p => p.assisted && !p.escort).length,
      需陪同组合: people.filter(p => p.escort).length,
      采集截止: state.cutoff,
      事件数: people.reduce((sum, p) => sum + p.events.length, 0),
      停用: state.disruptions,
    };
  }
  // 跨航次同组号：分析按 航次:组 键区分，此处提示
  const groupVisits = new Map();
  for (const person of model.people.values()) {
    if (!groupVisits.has(person.group)) groupVisits.set(person.group, new Set());
    groupVisits.get(person.group).add(person.visit);
  }
  const crossVisitGroups = [...groupVisits.entries()].filter(([, v]) => v.size > 1).map(([g]) => g);
  return { visits, anomalies, crossVisitGroups };
}

export function buildPaths(model, visit) {
  const rows = [];
  for (const person of model.peopleOf(visit)) {
    const paths = pathsFor(person, model);
    rows.push({
      person: person.person,
      type: person.assisted ? 'assisted' : 'normal',
      observed: person.events.map(e => ({ zone: e.zone, kind: e.kind, time: e.time })),
      compatiblePaths: paths.map(p => ({ zones: p.zones, minutes: p.minutes })),
      multiple: paths.length > 1,
      none: paths.length === 0,
      anomalies: person.anomalies,
      fastTrack: person.fastTrack,
    });
  }
  return rows;
}

export function buildReport(model, { planSpecs = null } = {}) {
  const visits = [...model.visits.keys()];
  const waits = Object.fromEntries(visits.map(v => [v, estimateWaits(model, { visit: v })]));
  const compare = visits.length >= 2 ? compareVisits(model, visits[0], visits[1]) : null;
  const target = visits.at(-1);
  const plans = planSpecs ?? [
    { name: 'S0/按预约', arrangement: ['S0'], release: 'window' },
    { name: 'S0+S1/按预约', arrangement: ['S0', 'S1'], release: 'window' },
    { name: 'S0+S2/按预约', arrangement: ['S0', 'S2'], release: 'window' },
    { name: 'S0+S1/错峰5分', arrangement: ['S0', 'S1'], release: 'stagger:5' },
    { name: 'S0+S2/错峰5分', arrangement: ['S0', 'S2'], release: 'stagger:5' },
  ];
  const outages = [];
  for (const v of visits) {
    for (const d of model.disruptionsOf(v)) {
      if (d.kind === 'closed') outages.push(analyzeOutage(model, { visit: v, zone: d.zone, first: d.first, last: d.last }));
    }
  }
  return {
    summary: buildSummary(model),
    waits,
    compare,
    plans: comparePlans(model, target, plans),
    outages,
    review: buildReview(model),
    views: Object.fromEntries(visits.map(v => [v, { ops: opsView(model, v), airline: airlineView(model, v) }])),
  };
}
