// 区域临时停用：能重走哪几条路径、哪些旅客须确认联络、哪些资料不足以承诺等待上限。
// closed=禁止配置新服务：已开始的服务可完成，未开始的须改道或等待重开。
import { allPaths } from './graph.mjs';
import { plannedZone, serviceTypeOf } from './model.mjs';
import { waitInterval } from './waits.mjs';

export function analyzeOutage(model, { visit, zone, first, last }) {
  const affected = [];
  const completedDuring = [];
  for (const person of model.peopleOf(visit)) {
    const iv = waitInterval(person, model);
    const planned = plannedZone(person, model, person.window);
    const usesZone = iv.zone === zone || (iv.evidence === '仅预约' && planned === zone);
    if (!usesZone) continue;

    // 停用结束前已通过：不受影响；在停用期间通过的作为“在服务可完成”的佐证单列
    if (iv.exit && iv.exit.hi !== Infinity && iv.exit.hi <= last) {
      if (iv.exit.hi >= first) completedDuring.push(person.person);
      continue;
    }
    const presentDuring = iv.entry && iv.entry.lo < last && (iv.exit === null || iv.exit.hi === Infinity || iv.exit.lo >= first);
    const appointmentOnlyRisk = iv.evidence === '仅预约' && person.window < last && person.meetBy > first;
    if (!presentDuring && !appointmentOnlyRisk) continue;

    const started = person.events.some(e => e.kind === 'start' && e.zone === zone);
    const currentZone = iv.evidence === '仅预约' ? 'hall' : (iv.zone ?? 'hall');
    const status = iv.evidence === '仅预约' ? '仅预约，尚未进场'
      : started ? '在服务可完成（停用不阻断已开始服务）'
        : '在队列，新服务须改道或等待重开';

    // 重走路径：以当前位置为起点、不再经过停用区域；另给等待重开后经原区域的路径
    const reroutes = allPaths(model.graph, currentZone, 'meet', { wheelchair: person.assisted })
      .filter(path => !path.zones.slice(1).includes(zone));
    const reopenPaths = allPaths(model.graph, currentZone, 'meet', { wheelchair: person.assisted })
      .filter(path => path.zones.slice(1).includes(zone));

    const reasons = [];
    if (person.notifiedUntil !== null) {
      // 已通知承诺的客人仍遵守原承诺：受影响且无法确认守约的，列入须确认联络
      reasons.push('已通知承诺，受影响期间无法确认守约');
    }
    if (person.assisted && !person.escort) reasons.push('无陪同受助，须重排协助人员');
    if (person.escort) reasons.push('需同行照料的组合，须与陪同者协调');

    const insufficient = iv.evidence === '仅预约' || (iv.exit && iv.exit.hi === Infinity);

    affected.push({
      person: person.person,
      type: serviceTypeOf(person),
      status,
      evidence: iv.evidence,
      entry: iv.entry,
      exit: iv.exit,
      currentZone,
      reroutes: reroutes.map(p => ({ zones: p.zones, minutes: p.minutes })),
      reopenPaths: reopenPaths.map(p => ({ zones: p.zones, minutes: p.minutes })),
      needsContact: reasons.length > 0,
      contactReasons: reasons,
      insufficientForUpperBound: insufficient,
      insufficientReason: iv.evidence === '仅预约'
        ? '只有预约、无任何观测，不能承诺等待上限'
        : (iv.exit && iv.exit.hi === Infinity ? '窗口未闭合，等待只有下界' : null),
    });
  }
  return { visit, zone, first, last, affected, completedDuring };
}
