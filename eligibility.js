/* 임대주택 자격 판정 — 순수 함수. 브라우저(window.Elig)와 Node(require) 양쪽에서 쓴다.
 * 입력: notice(docs/schema.md), profile(아래), ctx { now: Date, incomeTable }
 * 사용자 입력값은 이 파일 밖으로 나가지 않는다(네트워크 호출 없음).
 *
 * profile (모든 항목 선택):
 *   birth "YYYY-MM-DD", marital single|engaged|newlywed|married, household 숫자,
 *   income 월소득(원, 세전, 가구 합산), assets 총자산(원), car 자동차가액(원),
 *   homeless true|false, special true|false (수급자·차상위·장애인·국가유공자·한부모 등),
 *   home { sido, sigungu, since "YYYY-MM-DD" }, move { sido, sigungu, date } (이사 예정·최근 전입),
 *   job { sido, sigungu }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Elig = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const SIDO = [
    ['seoul', '서울'], ['incheon', '인천'], ['gyeonggi', '경기'], ['busan', '부산'], ['daegu', '대구'],
    ['gwangju', '광주'], ['daejeon', '대전'], ['ulsan', '울산'], ['sejong', '세종'], ['gangwon', '강원'],
    ['chungbuk', '충북'], ['chungnam', '충남'], ['jeonbuk', '전북'], ['jeonnam', '전남'],
    ['gyeongbuk', '경북'], ['gyeongnam', '경남'], ['jeju', '제주'],
  ];
  const SIDO_NAME = Object.fromEntries(SIDO);
  const RANK = { eligible: 3, conditional: 2, fail: 1 };
  const won = n => {
    if (n >= 1e8) { const e = Math.floor(n / 1e8), m = Math.round((n % 1e8) / 1e4); return `${e}억${m ? ` ${m.toLocaleString('ko-KR')}만` : ''}원`; }
    return `${Math.round(n / 1e4).toLocaleString('ko-KR')}만원`;
  };
  const md = s => { const [, m, d] = String(s).split('-'); return `${+m}/${+d}`; };
  const norm = s => String(s || '').replace(/\s+/g, '');
  const has = v => v !== undefined && v !== null && v !== '';

  function ageOn(birth, date) {
    const [by, bm, bd] = birth.split('-').map(Number);
    const [y, m, d] = String(date).slice(0, 10).split('-').map(Number);
    return y - by - ((m < bm || (m === bm && d < bd)) ? 1 : 0);
  }

  // 기준일 date에 주민등록이 어디였는지. 모르면 null.
  function areaOn(p, date) {
    if (p.move && p.move.sido && p.move.date && p.move.date <= date) return p.move;
    if (p.home && p.home.sido) {
      if (!p.home.since || p.home.since <= date) return p.home;
      return null; // 기준일엔 지금 주소로 오기 전이라 모름
    }
    return null;
  }

  // area: { sido, sigungu } | { sido: [..] } | { areas: [{ sido, sigungu }, ...] } (여러 지역 중 하나)
  function inArea(loc, area) {
    if (!loc || !loc.sido || !area) return false;
    if (Array.isArray(area.areas)) return area.areas.some(a => inArea(loc, a));
    if (Array.isArray(area.sido)) return area.sido.includes(loc.sido) && (!area.sigungu || norm(loc.sigungu) === norm(area.sigungu));
    if (loc.sido !== area.sido) return false;
    if (area.sigungu) return norm(loc.sigungu) === norm(area.sigungu);
    return true;
  }
  const inSido = (loc, area) => !!loc && (Array.isArray(area.areas) ? area.areas.some(a => a.sido === loc.sido)
    : Array.isArray(area.sido) ? area.sido.includes(loc.sido) : loc.sido === area.sido);

  const areaName = a => Array.isArray(a.areas) ? a.areas.map(areaName).join('·')
    : `${[].concat(a.sido).map(s => SIDO_NAME[s] || s).join('·')}${a.sigungu ? ' ' + a.sigungu : ''}`;

  function evalTrack(t, p, n, ctx) {
    const fails = [], conds = [], notes = [];
    const base = (n.postedOn || '').slice(0, 10);

    // 대상 계층
    if (t.target === 'restricted') fails.push(`${t.restrictedTo || '특정 대상'}만 신청 가능`);
    if (t.target === 'special_class') {
      if (p.special === false) fails.push('수급자·차상위·장애인·국가유공자·한부모 등 특정 계층만 신청 가능');
      else if (p.special !== true) conds.push('특정 계층(수급자 등) 해당 여부 미입력');
    }

    // 나이
    if (t.age) {
      const date = t.ageDate || base;
      if (!p.birth) conds.push('생년월일 미입력');
      else {
        const a = ageOn(p.birth, date);
        if (a < t.age[0] || a > t.age[1]) fails.push(`나이: ${md(date)} 기준 만 ${a}세 (만 ${t.age[0]}~${t.age[1]}세만)`);
      }
    }

    // 혼인
    const marital = t.marital || (t.target === 'newlywed' ? ['engaged', 'newlywed'] : null);
    if (marital) {
      const L = { single: '미혼', engaged: '예비신혼', newlywed: '신혼', married: '기혼' };
      if (!p.marital) conds.push('혼인 상태 미입력');
      else if (!marital.includes(p.marital)) fails.push(`혼인 상태: ${marital.map(x => L[x]).join('·')}만 신청 가능`);
    }

    // 무주택
    if (t.homeless) {
      if (p.homeless === false) fails.push('무주택자만 신청 가능');
      else if (p.homeless !== true) conds.push('무주택 여부 미입력');
    }

    // 소득
    const pct = (t.incomePctByHh && has(p.household) && t.incomePctByHh[String(p.household)]) || (p.household === 1 && t.incomePctSingle) || t.incomePct;
    if (pct) {
      const table = (ctx.incomeTable && ctx.incomeTable.monthly100) || {};
      const base100 = has(p.household) ? table[String(Math.min(p.household, 8))] : null;
      if (!has(p.income) || !has(p.household)) conds.push(`소득 미입력 (가구원수별 기준 ${pct}% 이하)`);
      else if (!base100) conds.push(`${p.household}인 가구 소득 기준표 없음 — 공고문 확인`);
      else {
        const limit = Math.floor(base100 * pct / 100);
        if (p.income > limit) fails.push(`소득: 월 ${won(p.income)} > 기준 ${won(limit)} (${p.household}인 ${pct}%)`);
      }
    }

    // 자산·자동차
    if (t.assetMax) {
      if (!has(p.assets)) conds.push(`총자산 미입력 (${won(t.assetMax)} 이하)`);
      else if (p.assets > t.assetMax) fails.push(`총자산 ${won(p.assets)} > ${won(t.assetMax)}`);
    }
    if (t.carMax) {
      if (!has(p.car)) conds.push(`자동차가액 미입력 (${won(t.carMax)} 이하)`);
      else if (p.car > t.carMax) fails.push(`자동차가액 ${won(p.car)} > ${won(t.carMax)}`);
    }

    // 거주 요건 (자격)
    if (t.residence) {
      const r = t.residence, date = r.date || base;
      const loc = areaOn(p, date);
      const jobOk = r.allowJob && p.job && inArea(p.job, r);
      const label = r.text || `${md(date)} 현재 ${areaName(r)} 거주${r.allowJob ? ' 또는 직장' : ''}`;
      if (inArea(loc, r) || jobOk) { /* ok */ }
      else if (!loc && !(r.allowJob && p.job && p.job.sido)) conds.push(`${md(date)} 당시 주소를 알 수 없음 — ${label}`);
      else fails.push(`거주 요건: ${label}`);
    }

    // 지역 순위 (자격 아님)
    if (t.priority) {
      const pr = t.priority, loc = areaOn(p, base);
      const job = pr.includesJob ? p.job : null;
      const any = [loc, job].filter(Boolean);
      let rank;
      const tiered = !!pr.sigungu && !pr.areas; // 시·군·구 → 시·도 → 그 외 3단계
      if (tiered) rank = any.some(a => inArea(a, pr)) ? 1 : any.some(a => inSido(a, pr)) ? 2 : 3;
      else rank = any.some(a => inArea(a, pr)) ? 1 : 2;
      const last = tiered ? 3 : 2;
      if (!any.length) conds.push(`지역순위 판단 불가 (주소${pr.includesJob ? '·직장' : ''} 미입력) — ${pr.text || ''}`.trim());
      else if (rank === last) conds.push(`지역 ${rank}순위 (후순위) — ${pr.text || areaName(pr) + ' 우선'}`);
      else notes.push(`지역 ${rank}순위`);
    }

    for (const c of t.needsCheck || []) conds.push(`확인 필요: ${c}`);
    for (const c of t.info || []) notes.push(c);

    const status = fails.length ? 'fail' : conds.length ? 'conditional' : 'eligible';
    return { status, fails, conds, notes, track: t };
  }

  function evalNotice(n, p, ctx = {}) {
    const now = ctx.now || new Date();
    const end = n.applyEnd ? new Date(n.applyEnd) : null;
    const start = n.applyStart ? new Date(n.applyStart) : null;
    const results = (n.tracks || []).map(t => evalTrack(t, p || {}, n, ctx));
    const best = results.slice().sort((a, b) =>
      RANK[b.status] - RANK[a.status] || a.conds.length - b.conds.length || a.fails.length - b.fails.length)[0]
      || { status: 'conditional', fails: [], conds: ['자격 정보 없음 — 공고문 확인'], notes: [], track: null };
    return {
      status: best.status,
      best,
      tracks: results,
      closed: !!(end && now > end),
      upcoming: !!(start && now < start),
    };
  }

  return { evalNotice, evalTrack, ageOn, areaOn, inArea, SIDO, SIDO_NAME, won };
});
