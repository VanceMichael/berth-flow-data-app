// 运营复核：保留旅客被告知的时段与事后估计的实际等待；真实回复与改约进入下一轮。
import { waitInterval } from './waits.mjs';

export function buildReview(model) {
  const rows = [];
  for (const person of model.people.values()) {
    const iv = waitInterval(person, model);
    const actual = iv.exit
      ? (iv.exit.hi === Infinity ? { lo: iv.exit.lo, hi: Infinity } : { lo: iv.exit.lo, hi: iv.exit.hi })
      : null;
    let status = '无承诺';
    if (person.notifiedUntil !== null) {
      if (iv.evidence === '仅预约') status = '无法确认（无观测）';
      else if (actual && actual.hi !== Infinity && actual.hi <= person.notifiedUntil) status = '守约';
      else if (actual && actual.lo > person.notifiedUntil) status = '超出承诺';
      else status = '无法确认（观察未闭合）';
    }
    const reply = model.replies.find(r => r.person === person.person && r.visit === person.visit);
    rows.push({
      person: person.person,
      visit: person.visit,
      toldWindow: person.window,
      notifiedUntil: person.notifiedUntil,
      actualExit: actual,
      wait: iv.wait ?? null,
      evidence: iv.evidence,
      status,
      response: reply?.response ?? null,
      rebookedWindow: reply?.newWindow ?? null,
    });
  }
  return {
    rows,
    rebookings: rows.filter(r => r.rebookedWindow !== null).map(r => ({ person: r.person, visit: r.visit, newWindow: r.rebookedWindow })),
    repliesMissing: model.replies.length === 0,
  };
}
