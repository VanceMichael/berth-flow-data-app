// 分时放行方案评估。
// 调度在同一时间最多能开的窗口和协助人员是固定的；一名协助人员同时最多给一个同行组服务。
// 服务时长用相容的既往观测估计；资料不足时不编造固定等待数字，只给有依据的范围或标明无法比较。
import { serviceTypeOf, plannedZone, optionAt } from './model.mjs';
import { waitInterval } from './waits.mjs';

// 既往观测中的区内停留（进场→通过，含排队）证据，用于服务时长情景的缺省范围。
// 快道者与换口者不计入；删失观测只作下界提示，不进样本。
export function serviceEvidence(model, { visits = null } = {}) {
  const evidence = { normal: [], assisted: [], censoredHints: { normal: [], assisted: [] } };
  for (const person of model.people.values()) {
    if (visits && !visits.includes(person.visit)) continue;
    if (person.fastTrack.length > 0) continue;
    const iv = waitInterval(person, model);
    if (!iv.entry || !iv.exit) continue;
    const type = serviceTypeOf(person);
    if (iv.exit.hi === Infinity) {
      evidence.censoredHints[type].push(iv.wait.lo);
    } else {
      evidence[type].push(iv.wait.hi); // 含排队的区内停留上界，作为服务时长的保守上界
    }
  }
  return evidence;
}

// 缺省服务时长情景：normal 用证据的 min–中位；assisted 证据不足时返回 null（不编造）。
export function defaultServiceRanges(model, opts = {}) {
  const evidence = serviceEvidence(model, opts);
  const range = values => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return [sorted[0], sorted[Math.floor((sorted.length - 1) / 2)]];
  };
  return {
    normal: range(evidence.normal),
    assisted: range(evidence.assisted),
    evidenceCounts: { normal: evidence.normal.length, assisted: evidence.assisted.length },
    censoredHints: evidence.censoredHints,
  };
}

// 放行计划：release=按预约；stagger:k=同窗口组按 k 分钟错开。
export function releaseSchedule(model, visit, spec = 'window') {
  const groups = [...model.groupsOf(visit).entries()]
    .map(([key, members]) => ({ key, window: Math.min(...members.map(m => m.window)) }))
    .sort((a, b) => a.window - b.window || a.key.localeCompare(b.key));
  const schedule = new Map();
  if (spec === 'window') {
    for (const g of groups) schedule.set(g.key, g.window);
    return schedule;
  }
  const match = /^stagger:(\d+)$/.exec(spec);
  if (!match) throw new Error(`未知放行计划：${spec}（支持 window、stagger:分钟）`);
  const step = Number(match[1]);
  let cursor = -Infinity;
  for (const g of groups) {
    const release = Math.max(g.window, cursor);
    schedule.set(g.key, release);
    cursor = release + step;
  }
  return schedule;
}

function closedAt(model, visit, zone, time) {
  return model.disruptionsOf(visit).some(d => d.kind === 'closed' && d.zone === zone && time >= d.first && time <= d.last);
}

// 单情景仿真：1 分钟步进，容量随方案时段变化，closed 区域禁止配置新服务（在服务可完成）。
function simulate(model, visit, { arrangement, release, serviceNormal, serviceAssisted, horizon }) {
  const options = arrangement.map(name => {
    const option = model.capacity.find(o => o.option === name);
    if (!option) throw new Error(`候选资源安排中无此方案：${name}`);
    return option;
  }).sort((a, b) => a.from - b.from);
  const capacityAt = time => {
    let active = null;
    for (const option of options) {
      if (option.from <= time && time <= option.to && (!active || option.from > active.from)) active = option;
    }
    // 方案窗口结束后沿用最后配置的容量（窗口与人员不撤，只是未再排新方案）
    if (!active && options.length > 0 && time > Math.max(...options.map(o => o.to))) {
      active = [...options].sort((a, b) => b.to - a.to)[0];
    }
    return active;
  };

  const people = model.peopleOf(visit);
  const arrivals = people.map(person => ({
    person,
    type: serviceTypeOf(person),
    groupKey: person.groupKey,
    arrive: Math.max(release.get(person.groupKey) ?? person.window, person.window),
    needsHelper: person.assisted && !person.escort, // 无陪同受助者须占用协助人员
    done: null,
    zone: null,
  })).sort((a, b) => a.arrive - b.arrive);

  const state = {
    normalQueue: [],
    assistedQueue: [],
    normalBusyUntil: [],
    assistedBusyUntil: [],
    helperBusyUntil: [],
    blockage: { normal: [], assisted: [], helper: [] },
    maxQueue: { normal: 0, assisted: 0 },
  };

  const start = Math.min(...arrivals.map(a => a.arrive));
  for (let t = start; t <= horizon; t += 1) {
    for (const a of arrivals) {
      if (a.arrive === t) {
        if (a.type === 'assisted') state.assistedQueue.push(a);
        else state.normalQueue.push(a);
      }
    }
    const capacity = capacityAt(t);
    const normalZone = 'B';
    const assistedZone = capacity?.accessibleZones[0] ?? null;

    const freeNormal = capacity ? capacity.normalCounters - state.normalBusyUntil.filter(u => u > t).length : 0;
    const freeAssisted = capacity ? capacity.assistedCounters - state.assistedBusyUntil.filter(u => u > t).length : 0;
    const freeHelpers = capacity ? capacity.helpers - state.helperBusyUntil.filter(u => u > t).length : 0;

    // 普通窗口
    if (capacity && !closedAt(model, visit, normalZone, t)) {
      let slots = freeNormal;
      while (slots > 0 && state.normalQueue.length > 0) {
        const a = state.normalQueue.shift();
        a.done = t + serviceNormal;
        a.zone = normalZone;
        state.normalBusyUntil.push(a.done);
        slots -= 1;
      }
    }
    // 协助窗口：无陪同者还须同时占用协助人员（一名协助人员同时最多服务一个同行组）
    if (capacity && assistedZone && !closedAt(model, visit, assistedZone, t)) {
      let counterSlots = freeAssisted;
      let helperSlots = freeHelpers;
      const waiting = [...state.assistedQueue];
      for (const a of waiting) {
        if (counterSlots <= 0) break;
        if (a.needsHelper && helperSlots <= 0) continue;
        state.assistedQueue.splice(state.assistedQueue.indexOf(a), 1);
        a.done = t + serviceAssisted;
        a.zone = assistedZone;
        state.assistedBusyUntil.push(a.done);
        counterSlots -= 1;
        if (a.needsHelper) {
          state.helperBusyUntil.push(a.done);
          helperSlots -= 1;
        }
      }
    }

    state.maxQueue.normal = Math.max(state.maxQueue.normal, state.normalQueue.length);
    state.maxQueue.assisted = Math.max(state.maxQueue.assisted, state.assistedQueue.length);
    if (state.normalQueue.length > 0 && freeNormal <= 0) pushBlockage(state.blockage.normal, t);
    if (state.assistedQueue.length > 0 && freeAssisted <= 0) pushBlockage(state.blockage.assisted, t);
    if (state.assistedQueue.some(a => a.needsHelper) && freeHelpers <= 0) pushBlockage(state.blockage.helper, t);

    if (arrivals.every(a => a.done !== null && a.done <= t) && state.normalQueue.length === 0 && state.assistedQueue.length === 0) break;
  }

  const completions = new Map();
  for (const a of arrivals) {
    const walkMeet = a.zone ? (model.walk(a.zone, 'meet', { wheelchair: a.person.assisted }) ?? 0) : null;
    completions.set(a.person.person, {
      pass: a.done,
      meet: a.done === null ? null : a.done + walkMeet,
      zone: a.zone,
    });
  }
  return { completions, state, unfinished: arrivals.filter(a => a.done === null).map(a => a.person.person) };
}

function pushBlockage(list, t) {
  const last = list[list.length - 1];
  if (last && last[1] === t - 1) last[1] = t;
  else list.push([t, t]);
}

// 评估一个放行计划：多服务时长情景取完成范围；承诺逐一核对，互不抵消。
export function evaluatePlan(model, visit, {
  arrangement,
  release = 'window',
  service = null, // { normal:[lo,hi], assisted:[lo,hi]|null }
  horizon = null,
} = {}) {
  const schedule = release instanceof Map ? release : releaseSchedule(model, visit, release);
  const ranges = service ?? defaultServiceRanges(model);
  const people = model.peopleOf(visit);
  const meetHorizon = Math.max(...people.map(p => p.meetBy));
  const lastRelease = Math.max(...schedule.values());
  const end = horizon ?? Math.max(meetHorizon, lastRelease) + 60;

  const scenarios = [];
  const normalRange = ranges.normal ?? [0, 0];
  const assistedRange = ranges.assisted; // null 表示资料不足：只算 0 服务的最佳情形
  scenarios.push({ normal: normalRange[0], assisted: assistedRange ? assistedRange[0] : 0, tag: '短服务' });
  scenarios.push({ normal: normalRange[1], assisted: assistedRange ? assistedRange[1] : 0, tag: '长服务' });

  const runs = scenarios.map(sc => ({
    sc,
    ...simulate(model, visit, {
      arrangement,
      release: schedule,
      serviceNormal: sc.normal,
      serviceAssisted: sc.assisted,
      horizon: end,
    }),
  }));

  const perPerson = people.map(person => {
    const passes = runs.map(r => r.completions.get(person.person).pass).filter(v => v !== null);
    const meets = runs.map(r => r.completions.get(person.person).meet).filter(v => v !== null);
    const done = passes.length > 0;
    const completion = done ? { lo: Math.min(...passes), hi: Math.max(...passes) } : null;
    const meet = meets.length > 0 ? { lo: Math.min(...meets), hi: Math.max(...meets) } : null;
    let promise = null;
    if (person.notifiedUntil !== null) {
      if (!done) promise = '无法确认（方案内未完成）';
      else if (completion.hi <= person.notifiedUntil) promise = '守约';
      else if (completion.lo > person.notifiedUntil) promise = ranges.assisted ? '超出承诺' : '无法守住（即使服务时长按 0）';
      else promise = ranges.assisted ? '存疑（情景间不一致）' : '资料不足，无法确认';
    }
    return {
      person: person.person,
      type: serviceTypeOf(person),
      completion,
      meet,
      meetBy: person.meetBy,
      meetOk: meet ? meet.hi <= person.meetBy : null,
      notifiedUntil: person.notifiedUntil,
      promise,
    };
  });

  return {
    visit,
    arrangement,
    release: Object.fromEntries(schedule),
    serviceRanges: {
      normal: ranges.normal,
      assisted: ranges.assisted,
      evidenceCounts: ranges.evidenceCounts ?? null,
      note: ranges.assisted
        ? `服务时长由相容既往观测估计（普通 ${ranges.evidenceCounts?.normal ?? '?'} 条、协助 ${ranges.evidenceCounts?.assisted ?? '?'} 条，含排队，偏保守）`
        : '协助服务时长缺乏足够观测：仅给出资源与步行约束下的最佳情形，不填写固定等待数字',
    },
    maxQueue: {
      normal: Math.max(...runs.map(r => r.state.maxQueue.normal)),
      assisted: Math.max(...runs.map(r => r.state.maxQueue.assisted)),
    },
    blockage: mergeBlockage(runs),
    people: perPerson,
    promises: perPerson.filter(p => p.promise !== null),
    unfinished: [...new Set(runs.flatMap(r => r.unfinished))],
  };
}

function mergeBlockage(runs) {
  const merged = { normal: [], assisted: [], helper: [] };
  for (const run of runs) {
    for (const key of Object.keys(merged)) {
      for (const interval of run.state.blockage[key]) {
        merged[key].push(interval);
      }
    }
  }
  for (const key of Object.keys(merged)) {
    merged[key].sort((a, b) => a[0] - b[0]);
    const compact = [];
    for (const [lo, hi] of merged[key]) {
      const last = compact[compact.length - 1];
      if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
      else compact.push([lo, hi]);
    }
    merged[key] = compact;
  }
  return merged;
}

// 对比多个放行计划：排队、协助完成、后续集合三方面的范围。
export function comparePlans(model, visit, plans) {
  return plans.map(plan => {
    const result = evaluatePlan(model, visit, plan);
    const broken = result.promises.filter(p => p.promise.startsWith('超出') || p.promise.startsWith('无法守住'));
    const unconfirmed = result.promises.filter(p => p.promise.startsWith('资料不足') || p.promise.startsWith('无法确认'));
    const meetRisk = result.people.filter(p => p.meetOk === false);
    return {
      name: plan.name ?? `${plan.arrangement.join('+')}/${plan.release}`,
      arrangement: plan.arrangement,
      release: plan.release,
      maxQueue: result.maxQueue,
      blockage: result.blockage,
      promises: { total: result.promises.length, broken: broken.length, unconfirmed: unconfirmed.length, kept: result.promises.length - broken.length - unconfirmed.length },
      meetRisk: meetRisk.map(p => p.person),
      unfinished: result.unfinished,
      note: result.serviceRanges.note,
      detail: result,
    };
  });
}
