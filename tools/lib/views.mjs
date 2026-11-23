// 现场视图：按航次和小组追查共用资源何时阻塞。
// 航司对外视图：只给聚合指标，不出现个人标识。
import { serviceTypeOf, plannedZone } from './model.mjs';
import { waitInterval, estimateWaits } from './waits.mjs';
import { promiseSummary } from './compare.mjs';
import { formatTime } from './time.mjs';

// 队列长度时间线：进场用有证据的 scan/start，或大厅到达+步行推算（标注推断）；离场用 pass。
export function opsView(model, visit) {
  const state = model.visits.get(visit);
  const people = model.peopleOf(visit);
  const zones = {};

  const ensure = zone => {
    if (!zones[zone]) zones[zone] = { entries: [], exits: [] };
    return zones[zone];
  };

  for (const person of people) {
    const iv = waitInterval(person, model);
    if (!iv.entry || !iv.zone) continue;
    const inferred = iv.entry.kind !== '闸机扫码' && iv.entry.kind !== '服务开始记录';
    ensure(iv.zone).entries.push({ person: person.person, time: iv.entry.lo, inferred });
    if (iv.exit && iv.exit.hi !== Infinity) ensure(iv.zone).exits.push({ person: person.person, time: iv.exit.lo });
  }

  const zoneView = {};
  for (const [zone, data] of Object.entries(zones)) {
    const changes = [];
    for (const e of data.entries) changes.push({ time: e.time, delta: 1 });
    for (const x of data.exits) changes.push({ time: x.time, delta: -1 });
    changes.sort((a, b) => a.time - b.time || b.delta - a.delta);
    let length = 0;
    const timeline = [];
    const blockage = [];
    let blockedSince = null;
    for (const change of changes) {
      length = Math.max(0, length + change.delta);
      timeline.push({ time: change.time, length });
      if (length > 0 && blockedSince === null) blockedSince = change.time;
      if (length === 0 && blockedSince !== null) {
        blockage.push([blockedSince, change.time]);
        blockedSince = null;
      }
    }
    // 队列在采集截止时未清零的，阻塞延续到截止之后（不可见部分不臆造）
    if (blockedSince !== null) blockage.push([blockedSince, state.cutoff]);
    zoneView[zone] = {
      timeline,
      blockage,
      remainingAtCutoff: length,
      inferredEntries: data.entries.filter(e => e.inferred).length,
      evidencedEntries: data.entries.filter(e => !e.inferred).length,
    };
  }

  const groups = {};
  for (const [key, members] of model.groupsOf(visit)) {
    groups[key] = members.map(person => {
      const iv = waitInterval(person, model);
      return {
        person: person.person,
        type: serviceTypeOf(person),
        state: iv.evidence === '仅预约' ? '无观测'
          : (iv.exit && iv.exit.hi !== Infinity ? `已于 ${formatTime(iv.exit.lo)} 通过 ${iv.zone}` : `在 ${iv.zone ?? '未知区域'} 等待（未闭合）`),
        anomalies: person.anomalies.map(a => a.type),
      };
    });
  }

  return {
    visit,
    cutoff: state.cutoff,
    zones: zoneView,
    capacityReference: model.capacity.map(o => ({
      option: o.option, from: o.from, to: o.to,
      normalCounters: o.normalCounters, assistedCounters: o.assistedCounters, helpers: o.helpers,
      accessibleZones: o.accessibleZones,
    })),
    disruptions: state.disruptions,
    groups,
    note: '协助人员占用无直接观测，阻塞按队列与窗口容量推断；推断进场已标注。',
  };
}

// 航司视图：聚合指标。分位数以区间形式给出，删失比例一并披露。
export function airlineView(model, visit) {
  const waits = estimateWaits(model, { visit });
  const people = model.peopleOf(visit);
  const state = model.visits.get(visit);
  const promises = promiseSummary(model, waits, visit);

  const count = status => promises.filter(p => p.status.startsWith(status)).length;
  const byType = {};
  for (const type of ['normal', 'assisted']) {
    const strata = waits.strata.filter(s => s.serviceType === type);
    const n = strata.reduce((sum, s) => sum + s.n, 0);
    const censored = strata.reduce((sum, s) => sum + s.censored, 0);
    byType[type] = {
      样本: n,
      删失: censored,
      仅预约未计: waits.appointmentOnly[type],
      快道剔除: strata.reduce((sum, s) => sum + s.excludedFastTrack.length, 0),
      分层: strata.map(s => ({
        时段: s.bucket,
        样本: s.n,
        p50: s.quantiles.p50,
        p75: s.quantiles.p75,
        p90: s.quantiles.p90,
      })),
    };
  }

  return {
    visit,
    总人数: people.length,
    受助人数: people.filter(p => p.assisted).length,
    等待分布: byType,
    承诺核对: {
      总数: promises.length,
      守约: count('守约'),
      超出承诺: count('超出'),
      无法确认: promises.length - count('守约') - count('超出'),
    },
    停用分钟: state.disruptions.map(d => ({ zone: d.zone, kind: d.kind, minutes: d.last - d.first })),
    尾部完整性: {
      采集截止: state.cutoff,
      截止后记录: people.flatMap(p => p.events.filter(e => e.time > state.cutoff)).length,
    },
  };
}
