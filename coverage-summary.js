'use strict';
const c = require('./.coverage/coverage-final.json');
const path = require('path');
const cwd = process.cwd();
const rows = [];
for (const p of Object.keys(c)) {
  const data = c[p] || {};
  const s = data.statementMap || {};
  const sc = data.s || {};
  const f = data.functionMap || {};
  const fc = data.f || {};
  const b = data.branchMap || {};
  const bc = data.b || {};
  const totalS = Object.keys(s).length;
  const covS = Object.values(sc).filter(v => v > 0).length;
  const totalF = Object.keys(f).length;
  const covF = Object.values(fc).filter(v => v > 0).length;
  let totalB = 0, covB = 0;
  for (const arr of Object.values(bc)) {
    for (const arm of arr) {
      totalB += 1;
      if (arm > 0) covB += 1;
    }
  }
  const linePct = totalS ? (covS / totalS) * 100 : 0;
  rows.push({ p: p.replace(cwd + path.sep, ''), linePct, totalS, covS, totalF, covF, totalB, covB });
}
rows.sort((a, b) => a.linePct - b.linePct);
for (const r of rows) {
  console.log(
    r.p.padEnd(60),
    'L:', `${r.covS}/${r.totalS}`.padEnd(10),
    `${r.linePct.toFixed(1)}%`.padEnd(7),
    'F:', `${r.covF}/${r.totalF}`.padEnd(8),
    'B:', `${r.covB}/${r.totalB}`
  );
}
