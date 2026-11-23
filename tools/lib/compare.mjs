// 航次对比：群组构成、设备停用、观察尾部完整性讲清之后，才谈等待差异。
import { estimateWaits } from './waits.mjs';
import { formatTime } from './time.mjs';

export function profileVisit(model, waits, visit) {
  const people = model.peopleOf(visit);
  const groups = model.groupsOf(visit);
  const state = model.visits.get(visit);
  const assisted = people.filter(p => p.assisted);
  const escorted = assisted.filter(p => p.escort);
  const unaccompanied = assisted.filter(p => !p.escort);

  const lastEvent = Math.max(0, ...people.flatMap(p => p.events.map(e => e.time)));
  const openWindows = people.filter(p => {
    const iv = waits.intervals.get(p.person);
    return iv && iv.exit && iv.exit.hi === Infinity;
  }).length;
  const afterCutoff = people.flatMap(p => p.events.filter(e => e.time > state.cutoff)).length;

  return {
    visit,
    people: people.length,
    groups: groups.size,
    assisted: assisted.length,
    escorted: escorted.length,
    unaccompaniedAssisted: unaccompanied.length,
    appointmentOnly: people.filter(p => waits.intervals.get(p.person)?.evidence === '仅预约').map(p => p.person),
    disruptions: state.disruptions.map(d => ({
      zone: d.zone, kind: d.kind, first: d.first, last: d.last, minutes: d.last - d.first,
    })),
    tail: {
      cutoff: state.cutoff,
      lastEvent,
      meetHorizon: Math.max(...people.map(p => p.meetBy)),
      openWindows,
      closedWindows: people.length - openWindows - people.filter(p => p.events.length === 0).length,
      eventsAfterCutoff: afterCutoff,
    },
    promises: promiseSummary(model, waits, visit),
    strata: waits.strata,
  };
}

// 已通知承诺的旅客逐一核对，不用普通队列的平均值抵消协助超承诺。
export function promiseSummary(model, waits, visit) {
  const rows = [];
  for (const person of model.peopleOf(visit)) {
    if (person.notifiedUntil === null) continue;
    const iv = waits.intervals.get(person.person);
    let status;
    if (!iv || iv.evidence === '仅预约') {
      status = '无法确认（无观测）';
    } else if (iv.exit.hi !== Infinity && iv.exit.hi <= person.notifiedUntil) {
      status = '守约';
    } else if (iv.exit.lo > person.notifiedUntil) {
      status = '超出承诺';
    } else {
      status = '无法确认（观察未闭合）';
    }
    rows.push({ person: person.person, notifiedUntil: person.notifiedUntil, exit: iv?.exit ?? null, status });
  }
  return rows;
}

export function compareVisits(model, visitA, visitB, { buckets = null } = {}) {
  const waitsA = estimateWaits(model, { visit: visitA, buckets });
  const waitsB = estimateWaits(model, { visit: visitB, buckets });
  const a = profileVisit(model, waitsA, visitA);
  const b = profileVisit(model, waitsB, visitB);
  const commonHorizon = Math.min(a.tail.cutoff, b.tail.cutoff);
  const notes = [];

  if (a.assisted !== b.assisted || a.unaccompaniedAssisted !== b.unaccompaniedAssisted) {
    notes.push(`群组构成不同：${visitA} 受助 ${a.assisted}（无陪同 ${a.unaccompaniedAssisted}），${visitB} 受助 ${b.assisted}（无陪同 ${b.unaccompaniedAssisted}），等待差异可能来自构成而非窗口。`);
  }
  for (const profile of [a, b]) {
    for (const d of profile.disruptions) {
      notes.push(`${profile.visit} 区域 ${d.zone} 有 ${d.kind === 'closed' ? '停用（禁止配置新服务）' : '断报（观察不全）'} ${formatTime(d.first)}–${formatTime(d.last)}，涉及时段的等待不可与无停用时段直接比。`);
    }
  }
  if (a.tail.cutoff !== b.tail.cutoff || a.tail.openWindows > 0 || b.tail.openWindows > 0) {
    notes.push(`观察尾部不完整：${visitA} 截止 ${formatTime(a.tail.cutoff)}（未闭合 ${a.tail.openWindows} 人），${visitB} 截止 ${formatTime(b.tail.cutoff)}（未闭合 ${b.tail.openWindows} 人）；仅在 ${formatTime(commonHorizon)} 之前的完成者范围内可比，之后不可识别。`);
  }
  if (a.tail.eventsAfterCutoff > 0 || b.tail.eventsAfterCutoff > 0) {
    notes.push(`存在采集截止之后的记录（${visitA} ${a.tail.eventsAfterCutoff} 条，${visitB} ${b.tail.eventsAfterCutoff} 条），截止时刻本身存疑，已单列。`);
  }

  return { a, b, waitsA, waitsB, commonHorizon, notes };
}
