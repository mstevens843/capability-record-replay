import fs from 'node:fs';
import { detect } from './detect.mjs';
const grids = JSON.parse(fs.readFileSync('./grids.json', 'utf8'));
for (const [name, g] of Object.entries(grids)) {
  console.log('\n' + '='.repeat(78) + '\n  GRID: ' + name);
  console.log('='.repeat(78));
  for (let y = 0; y < g.rows; y++) {
    const t = g.cells[y].map((c) => c.ch).join('').replace(/\s+$/, '');
    if (t) console.log(String(y).padStart(3) + ' |' + t);
  }
  console.log('    cursor=(' + g.cursor.y + ',' + g.cursor.x + ')');
  const obs = detect(g);
  console.log('  --> screenId: ' + JSON.stringify(obs.screenId));
  console.log('  --> nodes:');
  for (const n of obs.nodes) console.log('      ' + JSON.stringify(n));
}
