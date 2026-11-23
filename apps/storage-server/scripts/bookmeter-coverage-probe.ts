/**
 * More Bookmeter coverage, step 1: the second search on a handful of labeled books. Writes a
 * small Node program that the fetcher container runs (docker exec, so the requests go through
 * its VPN): each query one at a time, 5 s apart (Bookmeter's pace), the answers printed as JSON.
 * Fetches nothing itself.
 *
 *   npx ts-node --transpile-only scripts/bookmeter-coverage-probe.ts <queries.json> <out.cjs> <cid,cid,...>
 */
import fs from 'fs';
import { bookmeterSearchUrl } from '../src/cleanup/stage4/store-links';
const q = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as {
  cid: number;
  q0: string;
  q1: string;
  q2: string | null;
}[];
const pick = (process.argv[4] ?? '').split(',').map(Number);
const reqs: { cid: number; form: string; url: string }[] = [];
for (const cid of pick) {
  const r = q.find((x) => x.cid === cid)!;
  const au = r.q2 ? r.q2.slice(r.q1.length + 1) : '';
  if (r.q1 !== r.q0) reqs.push({ cid, form: 'Q1 main title', url: bookmeterSearchUrl(r.q1) });
  if (au)
    reqs.push({
      cid,
      form: 'Q2 main title + author= ',
      url: bookmeterSearchUrl(r.q1).replace('author=&', `author=${encodeURIComponent(au)}&`),
    });
}
const js = `const R=${JSON.stringify(reqs)};const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';(async()=>{const out=[];for(const r of R){const t=Date.now();try{const res=await fetch(r.url,{headers:{'User-Agent':UA,'Accept-Language':'ja,en;q=0.5',Accept:'text/html, */*; q=0.01'}});out.push({...r,status:res.status,ms:Date.now()-t,body:await res.text()});}catch(e){out.push({...r,error:String(e)});}process.stderr.write(out.length+' ');await new Promise(s=>setTimeout(s,5000));}process.stdout.write(JSON.stringify(out));})();`;
fs.writeFileSync(process.argv[3], js);
console.log(reqs.length, 'requests');
for (const r of reqs) console.log(r.cid, r.form, decodeURIComponent(r.url));
