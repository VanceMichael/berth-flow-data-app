// 人员与航次模型：把事件挂到旅客，识别重扫、换口、超采集时段等异常，
// 标注陪同约束与快道证据。预约（window）只是预约值，不等于实际到达。
import { buildGraph, shortestWalk, compatiblePaths } from './graph.mjs';

export function buildModel(tables) {
  const graph = buildGraph(tables.walkways);
  const people = new Map();
  for (const row of tables.manifest) {
    people.set(row.person, {
      person: row.person,
      visit: row.visit,
      group: row.group,
      groupKey: `${row.visit}:${row.group}`,
      window: row.window,
      assistance: row.assistance,
      assisted: row.assistance !== 'none',
      escort: row.escort, // 需陪同的同行者；缺省表示服务可由场内人员独立完成
      meetBy: row.meetBy,
      notifiedUntil: row.notifiedUntil, // 此前已报旅客的最迟协助完成承诺
      events: [],
      anomalies: [],
      fastTrack: [],
    });
  }
  for (const event of tables.observations) {
    people.get(event.person).events.push(event);
  }
  for (const person of people.values()) {
    person.events.sort((a, b) => a.time - b.time || a.event.localeCompare(b.event));
  }

  const visits = new Map();
  for (const row of tables.cutoff) {
    visits.set(row.visit, {
      visit: row.visit,
      cutoff: row.lastKnown,
      disruptions: tables.disruptions.filter(d => d.visit === row.visit),
      people: [],
    });
  }
  for (const person of people.values()) {
    visits.get(person.visit).people.push(person.person);
  }

  const model = {
    people,
    visits,
    graph,
    capacity: tables.capacity,
    replies: tables.replies,
    cutoffOf: visit => visits.get(visit)?.cutoff ?? null,
    disruptionsOf: visit => visits.get(visit)?.disruptions ?? [],
    walk: (from, to, opts) => shortestWalk(graph, from, to, opts),
    peopleOf: visit => [...people.values()].filter(p => p.visit === visit),
    groupsOf: visit => {
      const groups = new Map();
      for (const p of people.values()) {
        if (p.visit !== visit) continue;
        if (!groups.has(p.groupKey)) groups.set(p.groupKey, []);
        groups.get(p.groupKey).push(p);
      }
      return groups;
    },
  };

  for (const person of people.values()) detectAnomalies(person, model);
  detectEscortSeparation(model);
  for (const person of people.values()) classifyFastTrack(person, model);
  return model;
}

function detectAnomalies(person, model) {
  const events = person.events;
  const seen = new Set();
  for (const event of events) {
    const key = `${event.zone}|${event.kind}|${event.time}`;
    if (seen.has(key)) {
      person.anomalies.push({ type: '重扫', detail: `${event.zone}/${event.kind}`, time: event.time, event: event.event });
    }
    seen.add(key);
  }
  const cutoff = model.cutoffOf(person.visit);
  for (const event of events) {
    if (cutoff !== null && event.time > cutoff) {
      person.anomalies.push({ type: '超出采集时段', detail: `${event.zone}/${event.kind}`, time: event.time, event: event.event });
    }
  }
  const entry = events.find(e => e.kind === 'scan' || e.kind === 'start');
  const pass = events.find(e => e.kind === 'pass');
  if (entry && pass && entry.zone !== pass.zone) {
    person.anomalies.push({ type: '换口', detail: `${entry.zone}→${pass.zone}`, time: pass.time, event: pass.event });
  }
}

// 需要同行照料的组合：受助者协助未闭合时，陪同者不应先行离开受助队列。
function detectEscortSeparation(model) {
  for (const person of model.people.values()) {
    if (!person.escort) continue;
    const escort = model.people.get(person.escort);
    if (!escort) continue;
    const assistedPass = person.events.find(e => e.kind === 'pass');
    const escortPass = escort.events.find(e => e.kind === 'pass');
    if (escortPass && (!assistedPass || assistedPass.time > escortPass.time)) {
      const note = { type: '陪同者先行离开', detail: `${escort.person} 于 ${escortPass.zone} 通过，受助者协助未闭合`, time: escortPass.time, event: escortPass.event };
      person.anomalies.push(note);
      escort.anomalies.push({ ...note, detail: `本人先于受助者 ${person.person} 离开` });
    }
  }
}

// 快道证据：换口、停用期间通过、非受助者有人工放行记录。
// 走过快道的人不能补成普通窗口的对照，估计普通窗口等待时须剔除。
function classifyFastTrack(person, model) {
  if (person.anomalies.some(a => a.type === '换口')) person.fastTrack.push('换口');
  const pass = person.events.find(e => e.kind === 'pass');
  if (pass) {
    const duringClosed = model.disruptionsOf(person.visit).some(d =>
      d.kind === 'closed' && d.zone === pass.zone && pass.time >= d.first && pass.time <= d.last);
    if (duringClosed) person.fastTrack.push('停用期间通过');
  }
  if (!person.assisted && person.events.some(e => e.source === 'staff')) {
    person.fastTrack.push('人工放行');
  }
}

// 旅客的服务类型：受助（轮椅）与普通分列；同一同行组可分开领行李，组内不强求同队列。
export function serviceTypeOf(person) {
  return person.assisted ? 'assisted' : 'normal';
}

// 计划队列：受助者去当时可用无障碍区域，普通旅客去普通区域（默认 B）。
export function plannedZone(person, model, atTime) {
  if (!person.assisted) return 'B';
  const option = optionAt(model.capacity, atTime ?? person.window);
  return option?.accessibleZones[0] ?? null;
}

export function optionAt(capacity, time) {
  let active = null;
  for (const option of capacity) {
    if (option.from <= time && time <= option.to && (!active || option.from > active.from)) active = option;
  }
  return active;
}

// 旅客的观测区域序列（供相容路径枚举）。
export function observedZones(person) {
  return person.events.map(e => ({ zone: e.zone, time: e.time, kind: e.kind }));
}

export function pathsFor(person, model) {
  const observed = observedZones(person).map(({ zone, time }) => ({ zone, time }));
  return compatiblePaths(model.graph, observed, { wheelchair: person.assisted });
}
