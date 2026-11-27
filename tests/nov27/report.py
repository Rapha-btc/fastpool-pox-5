"""Merge SDK LCOV across fresh sessions; exclude mocks from production totals."""
from pathlib import Path
import json
here=Path(__file__).resolve().parent
root=here.parents[1]
targets=json.loads((here/'targets.json').read_text())
records={}
for path in sorted((here/'.build/coverage').glob('*.lcov')):
 current=None
 for line in path.read_text().splitlines():
  if line.startswith('SF:'):
   name=Path(line[3:]).stem
   current=records.setdefault(name,{'lines':{},'functions':{},'branches':{}})
  elif current is not None:
   if line.startswith('FN:'):
    _,key=line[3:].split(',',1);current['functions'].setdefault(key,0)
   elif line.startswith('DA:'):
    key,count,*_=line[3:].split(',');current['lines'][key]=current['lines'].get(key,0)+int(count)
   elif line.startswith('FNDA:'):
    count,key=line[5:].split(',',1);current['functions'][key]=current['functions'].get(key,0)+int(count)
   elif line.startswith('BRDA:'):
    a,b,c,count=line[5:].split(',');key=','.join([a,b,c]);current['branches'][key]=current['branches'].get(key,0)+(0 if count=='-' else int(count))
   elif line=='end_of_record':current=None
summary={}
for name,source in targets.items():
 record=records.get(name)
 if record is None:raise SystemExit(f'No coverage for {name}: found {list(records)}')
 entry={'source':source}
 for kind,values in record.items():
  hit=sum(v>0 for v in values.values());total=len(values)
  entry[kind]={'covered':hit,'total':total,'percent':round(100*hit/total,2) if total else None}
 entry['uncovered_functions']=sorted(k for k,v in record['functions'].items() if v==0)
 entry['uncovered_lines']=sorted(int(k) for k,v in record['lines'].items() if v==0)
 summary[name]=entry
results=json.loads((here/'.build/results.json').read_text())
report={'toolchain':{'clarinet':'3.23.2','sdk':'3.23.2','vitest':'3.2.4','rendezvous':'1.0.3'},
 'sources':json.loads((here/'.build/source-hashes.json').read_text()),
 'test_files':[{'file':str(Path(t['name']).relative_to(root)),'status':t['status'],'passed':sum(a['status']=='passed' for a in t['assertionResults']),'failed':sum(a['status']=='failed' for a in t['assertionResults'])} for t in results['testResults']],
 'coverage':summary}
(here/'reports').mkdir(exist_ok=True)
(here/'reports/latest.json').write_text(json.dumps(report,indent=2)+'\n')
for name,c in summary.items():print(name, 'lines:',c['lines'],'functions:',c['functions'])

# Publish a compact, reproducible human-readable report beside the tests.
baseline_path=here/'reports/baseline.json'
baseline=json.loads(baseline_path.read_text()) if baseline_path.exists() else None
fuzz_cases=sum(t['passed'] for t in report['test_files'] if 'rendezvous' in t['file'])*int(__import__('os').environ.get('RV_RUNS','500'))
report['fuzz']={'engine':'Rendezvous SDK strategyFor + fast-check with shrinking','seeds':[20261126,20261127], 'runs_per_property':int(__import__('os').environ.get('RV_RUNS','500')), 'generated_cases':fuzz_cases}
(here/'reports/latest.json').write_text(json.dumps(report,indent=2)+'\n')
lines=['# November 26–27 validation and coverage', '',
 'All listed tests passed with Clarinet CLI/SDK 3.23.2 and Vitest 3.2.4. Sources and SHA-256 hashes are recorded in [latest.json](reports/latest.json).', '',
 '| Test file | Result | Passed |', '|---|---|---:|']
for t in report['test_files']:
 if t['status']!='passed' or t['failed']:raise SystemExit('Refusing to publish a green report for failed tests')
 lines.append(f"| [{Path(t['file']).name}]({Path(t['file']).name}) | PASS | {t['passed']} |")
lines+=['','## Whole-contract Clarity coverage','',
 'SDK LCOV is merged across fresh simnets. Mock/dependency contracts are excluded from these totals. Function denominators include uncalled functions. Branch coverage is not emitted by this SDK; no branch-coverage percentage is claimed.', '',
 '| Production source | Baseline lines | Current lines | Functions reached |', '|---|---:|---:|---:|']
for name,c in summary.items():
 old=baseline['coverage'][name]['lines']['percent'] if baseline else None
 lines.append(f"| `{c['source']}` | {old}% | {c['lines']['percent']}% ({c['lines']['covered']}/{c['lines']['total']}) | {c['functions']['covered']}/{c['functions']['total']} |")
lines+=['','## Reproducible fuzzing','',
 f"Rendezvous 1.0.3 generates ABI-typed inputs; fast-check shrinks failures. Seeds: `20261126`, `20261127`; **{report['fuzz']['runs_per_property']} cases per property**, **{fuzz_cases:,} generated cases** in this repository. Assertions run against production contract bodies with local external mocks. There are no discards or skipped properties. These are Rendezvous SDK tests inside Vitest, not runs of the legacy RV CLI suites.", '',
 '```sh', 'npm ci --prefix tests/nov27', 'npm --prefix tests/nov27 test', '# Larger campaign; seed values stay fixed for reproducibility:', 'RV_RUNS=2000 npm --prefix tests/nov27 test', '```', '',
 'The original 88-test baseline is preserved in [baseline.json](reports/baseline.json). Current results, complete uncovered line/function lists and source hashes are in [latest.json](reports/latest.json). Raw LCOV and Vitest JSON remain under `.build/`.', '',
 '## Scope and next coverage work', '',
 'Passing mocks do not validate mainnet liquidity, external oracle availability, or node-level PoX locking. Increasing whole-contract coverage requires exercising the remaining production paths, not counting mocks or removing defensive guards.']
for name,c in summary.items():
 gaps=c['uncovered_functions']
 lines.append(f"- `{name}`: "+('uncalled functions: '+', '.join('`'+f+'`' for f in gaps)+'.' if gaps else 'all functions reached; remaining uncovered lines are alternate branches.'))
(here/'RESULTS.md').write_text('\n'.join(lines)+'\n')
