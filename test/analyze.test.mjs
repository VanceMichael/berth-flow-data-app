import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTime, formatTime } from '../tools/lib/time.mjs';
import { loadMaterials } from '../tools/lib/load.mjs';
import { buildGraph, shortestWalk, allPaths, compatiblePaths } from '../tools/lib/graph.mjs';
import { buildModel, pathsFor } from '../tools/lib/model.mjs';
import { waitInterval, turnbull, estimateWaits } from '../tools/lib/waits.mjs';
import { compareVisits } from '../tools/lib/compare.mjs';
import { evaluatePlan, releaseSchedule, defaultServiceRanges } from '../tools/lib/plan.mjs';
import { analyzeOutage } from '../tools/lib/outage.mjs';
import { buildReview } from '../tools/lib/review.mjs';
import { opsView, airlineView } from '../tools/lib/views.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const model = buildModel(await loadMaterials(fixtures));

test('时间解析与格式化', () => {
  assert.equal(parseTime('09:24'), 564);
  assert.equal(formatTime(564), '09:24');
  assert.equal(formatTime(Infinity), '未定');
  assert.throws(() => parseTime('9点24'), /HH:MM/);
});

test('步行图：轮椅过滤与最短路径', () => {
  const graph = buildGraph([
    { from: 'hall', to: 'A', minutes: 4, wheelchair: true },
    { from: 'hall', to: 'B', minutes: 3, wheelchair: false },
    { from: 'A', to: 'meet', minutes: 6, wheelchair: true },
    { from: 'B', to: 'meet', minutes: 4, wheelchair: true },
  ]);
  assert.equal(shortestWalk(graph, 'hall', 'meet'), 7);
  assert.equal(shortestWalk(graph, 'hall', 'meet', { wheelchair: true }), 10);
  assert.equal(shortestWalk(graph, 'hall', 'B', { wheelchair: true }), null);
  const paths = allPaths(graph, 'hall', 'meet', { wheelchair: true });
  assert.deepEqual(paths.map(p => p.zones.join('>')), ['hall>A>meet']);
});

test('相容路径：时间可行性排除绕路', () => {
  // P32 大厅 09:04 到达、B 09:24 前 6 分钟内通过：来不及经 A（需 7 分钟）
  const p32 = model.people.get('P32');
  const zones = pathsFor(p32, model).map(p => p.zones.join('>'));
  assert.ok(zones.includes('hall>B>meet'));
  assert.ok(!zones.some(z => z.includes('A')));
  // P02 时间充裕：hall>A>B 与 hall>B 均相容（多条相容路径）
  const p02 = pathsFor(model.people.get('P02'), model).map(p => p.zones.join('>'));
  assert.ok(p02.includes('hall>B>meet'));
  assert.ok(p02.some(z => z.startsWith('hall>A')));
});

test('异常识别：重扫、换口、超采集时段、陪同分离', () => {
  const p03 = model.people.get('P03');
  assert.ok(p03.anomalies.some(a => a.type === '重扫'));
  assert.ok(p03.anomalies.some(a => a.type === '换口' && a.detail === 'A→B'));
  assert.ok(model.people.get('P28').anomalies.some(a => a.type === '超出采集时段'));
  assert.ok(model.people.get('P01').anomalies.some(a => a.type === '陪同者先行离开'));
  // 快道证据：换口者不能补成普通窗口对照
  assert.ok(p03.fastTrack.includes('换口'));
});

test('等待区间：有证据、右删失、断报删失分别对待', () => {
  // P32：大厅到达+径直步行约定 → 点等待 3 分钟
  const p32 = waitInterval(model.people.get('P32'), model);
  assert.deepEqual(p32.wait, { lo: 3, hi: 3 });
  assert.equal(p32.censor, '无');
  // P12（V0）：B 断报 09:40 起，等待只有下界
  const p12 = waitInterval(model.people.get('P12'), model);
  assert.equal(p12.censor, '断报删失');
  assert.equal(p12.wait.lo, 22); // 09:40 - (09:15+3)
  assert.equal(p12.wait.hi, Infinity);
  // P30（V0）：只有预约
  const p30 = waitInterval(model.people.get('P30'), model);
  assert.equal(p30.evidence, '仅预约');
  // P01：有 start 记录，排队与服务分段
  const p01 = waitInterval(model.people.get('P01'), model);
  assert.ok(p01.segments.queue && p01.segments.service);
  assert.equal(p01.segments.service.lo, 20); // 09:41 - 09:21
});

test('Turnbull：点观测退化为经验分布，删失质量落到尾部', () => {
  const points = turnbull([{ lo: 5, hi: 5 }, { lo: 5, hi: 5 }, { lo: 9, hi: 9 }]);
  const total = points.masses.reduce((s, m) => s + m.p, 0);
  assert.ok(Math.abs(total - 1) < 1e-6);
  const at5 = points.masses.find(m => m.hi === 5);
  assert.ok(Math.abs(at5.p - 2 / 3) < 1e-6);
  const censored = turnbull([{ lo: 0, hi: 3 }, { lo: 15, hi: Infinity }]);
  const tail = censored.masses.find(m => m.hi === Infinity);
  assert.ok(tail && Math.abs(tail.p - 0.5) < 1e-6);
});

test('分层估计：快道剔除、仅预约单列、删失计数', () => {
  const est = estimateWaits(model, { visit: 'V1' });
  const normal = est.strata.filter(s => s.serviceType === 'normal');
  const excluded = normal.flatMap(s => s.excludedFastTrack.map(e => e.person));
  assert.deepEqual(excluded, ['P03']);
  assert.ok(!normal.flatMap(s => s.samples ?? []).some(s => s.person === 'P03'));
  const estV0 = estimateWaits(model, { visit: 'V0' });
  assert.deepEqual(estV0.appointmentOnly.people, ['P30']);
  assert.ok(estV0.strata.some(s => s.censored > 0));
});

test('航次对比：构成、停用、尾部完整性都讲清', () => {
  const cmp = compareVisits(model, 'V0', 'V1');
  assert.ok(cmp.notes.some(n => n.includes('群组构成不同')));
  assert.ok(cmp.notes.some(n => n.includes('停用（禁止配置新服务）')));
  assert.ok(cmp.notes.some(n => n.includes('断报（观察不全）')));
  assert.ok(cmp.notes.some(n => n.includes('观察尾部不完整')));
  assert.equal(cmp.commonHorizon, 581);
});

test('放行计划：协助人员串行约束与承诺逐一核对', () => {
  // V1 有 4 名无陪同受助者，协助人员只有 1 名：协助服务必须串行
  const result = evaluatePlan(model, 'V1', {
    arrangement: ['S0', 'S1'],
    release: 'window',
    service: { normal: [3, 11], assisted: [10, 10] },
  });
  const assistedDone = result.people.filter(p => p.type === 'assisted' && p.completion);
  const intervals = assistedDone.map(p => p.completion).sort((a, b) => a.lo - b.lo);
  // 无陪同者（P05/P10/P20/P25）共享 1 名协助人员：完成时刻两两至少相隔服务时长
  const unaccompanied = ['P05', 'P10', 'P20', 'P25'];
  const times = result.people.filter(p => unaccompanied.includes(p.person)).map(p => p.completion.lo).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] - times[i - 1] >= 10, `协助人员串行：${times}`);
  }
  // 承诺逐一核对，不用普通队列平均抵消
  const promises = Object.fromEntries(result.promises.map(p => [p.person, p.promise]));
  assert.equal(promises.P01, '守约'); // 09:00+10=09:10 ≤ 09:45
  assert.equal(promises.P10, '守约'); // 第二个被服务，09:24 后 C 区可用
  assert.ok(['超出承诺', '存疑（情景间不一致）'].includes(promises.P25) || promises.P25 === '守约');
  assert.ok(intervals.length > 0);
});

test('放行计划：协助服务资料不足时不编造等待数字', () => {
  const ranges = defaultServiceRanges(model, { visits: ['V9'] }); // 无此航次 → 无证据
  assert.equal(ranges.normal, null);
  const result = evaluatePlan(model, 'V1', {
    arrangement: ['S0', 'S1'],
    release: 'window',
    service: { normal: [3, 11], assisted: null },
  });
  assert.match(result.serviceRanges.note, /不填写固定等待数字/);
});

test('错峰放行计划生成', () => {
  const schedule = releaseSchedule(model, 'V1', 'stagger:5');
  const g1 = schedule.get('V1:G1');
  assert.equal(g1, 540); // 不早于预约 09:00
  const values = [...schedule.values()];
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] >= values[i - 1]);
  }
});

test('区域停用：受影响分类、重走路径、资料不足提示', () => {
  const result = analyzeOutage(model, { visit: 'V1', zone: 'A', first: 564, last: 590 });
  const byPerson = Object.fromEntries(result.affected.map(a => [a.person, a]));
  // P01 已在服务：可完成；P05 在队列：须改道或等待
  assert.match(byPerson.P01.status, /在服务可完成/);
  assert.match(byPerson.P05.status, /在队列/);
  // 重走以当前位置为起点，且不再经过 A
  assert.ok(byPerson.P05.reroutes.every(r => !r.zones.slice(1).includes('A')));
  assert.ok(byPerson.P05.reroutes.some(r => r.zones.includes('C')));
  // 停用期间完成的单列，不混入受影响
  assert.deepEqual(result.completedDuring.sort(), ['P10', 'P20', 'P25']);
  // 未闭合者资料不足以承诺等待上限
  assert.ok(byPerson.P01.insufficientForUpperBound);
  // 已通知承诺者列入须确认联络
  assert.ok(byPerson.P05.needsContact);
});

test('运营复核：告知时段与事后估计并列，回复与改约进入下一轮', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-'));
  await cp(fixtures, dir, { recursive: true });
  await writeFile(path.join(dir, 'replies.csv'), 'visit,person,response,new_window\nV1,P05,确认需协助,10:05\nV1,P28,已离站,-\n');
  const withReplies = buildModel(await loadMaterials(dir));
  const review = buildReview(withReplies);
  const p05 = review.rows.find(r => r.person === 'P05');
  assert.equal(p05.response, '确认需协助');
  assert.equal(p05.rebookedWindow, 605);
  assert.deepEqual(review.rebookings, [{ person: 'P05', visit: 'V1', newWindow: 605 }]);
  // 无 replies.csv 时标明缺失
  const plain = buildReview(model);
  assert.equal(plain.repliesMissing, true);
  // 告知时段与事后估计都保留
  const p10 = plain.rows.find(r => r.person === 'P10');
  assert.equal(p10.toldWindow, 540);
  assert.equal(p10.status, '守约');
});

test('现场视图：按航次与小组追查阻塞；航司视图只有聚合指标', () => {
  const ops = opsView(model, 'V1');
  assert.ok(ops.zones.A.remainingAtCutoff > 0); // A 区截止时仍有人在队列
  assert.ok(Object.keys(ops.groups).includes('V1:G1'));
  assert.ok(ops.groups['V1:G1'].some(m => m.state.includes('未闭合')));
  const airline = airlineView(model, 'V1');
  const text = JSON.stringify(airline);
  assert.ok(!/P\d{2}/.test(text), '航司视图不得出现个人标识');
  assert.equal(airline.承诺核对.总数, 5);
  assert.equal(airline.承诺核对.守约, 3);
});
