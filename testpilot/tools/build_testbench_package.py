#!/usr/bin/env python3
"""Transform an audit-contract package into a TestBench import package."""
import hashlib, json, shutil, sys, zipfile
from pathlib import Path

ALLOWED_EXT = {'.png','.jpg','.jpeg','.gif','.webp','.pdf','.txt','.log','.md','.csv','.json','.zip','.mp4','.webm'}

pkg = Path(sys.argv[1] if len(sys.argv) > 1 else 'AUD-20261105-01')
project_key = sys.argv[2] if len(sys.argv) > 2 else 'RS'
out_zip = Path(sys.argv[3] if len(sys.argv) > 3 else f'{pkg.name}-testbench.zip')

m = json.loads((pkg / 'manifest.json').read_text())
bugs = json.loads((pkg / 'bugs.json').read_text())
manual = json.loads((pkg / 'manual-tests.json').read_text())

bug_list = bugs if isinstance(bugs, list) else bugs.get('bugs', [])
test_list = manual if isinstance(manual, list) else manual.get('tests', manual.get('manual_tests', []))

# evidence_id -> relative file path
ev_map = {}
files, evidence_files = [], []
for ev in m.get('evidence', []):
    loc = (ev.get('location') or ev.get('path') or '').lstrip('./')
    if not loc:
        continue
    if Path(loc).suffix.lower() not in ALLOWED_EXT:
        continue
    ev_map[ev.get('evidence_id', '')] = loc
    src = pkg / loc
    if not src.is_file():
        continue
    data = src.read_bytes()
    files.append({'path': loc, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)})
    evidence_files.append((loc, data))

def ev_objects(evidence):
    out = []
    for e in evidence or []:
        if isinstance(e, str):
            loc = ev_map.get(e, '')
            if loc and Path(loc).suffix.lower() in ALLOWED_EXT:
                out.append({'path': loc, 'label': e})
        elif isinstance(e, dict):
            loc = (e.get('location') or e.get('path') or ev_map.get(e.get('evidence_id', ''), '')).lstrip('./')
            if loc and Path(loc).suffix.lower() in ALLOWED_EXT:
                out.append({'path': loc, 'label': e.get('label', e.get('description', ''))})
    return out

def norm_sev(v):
    """Severity may be a string or {"level": "Medium", "rationale": ...} (audit contract)."""
    if isinstance(v, dict):
        v = v.get('level')
    v = str(v or '').strip().lower()
    return v if v in ('low', 'medium', 'high', 'critical') else None

def str_list(v):
    return [s for s in v if isinstance(s, str)] if isinstance(v, list) else []

tb_bugs = []
for b in bug_list:
    sev = norm_sev(b.get('severity') or b.get('agentSeverity'))
    tb_bugs.append({
        # The bug's own ID, so TestBench de-duplicates per bug, not per requirement.
        'sourceId': b.get('bug_proposal_id') or b.get('sourceId') or '',
        'title': b.get('title', ''),
        'description': b.get('description', ''),
        'steps': str_list(b.get('steps') or b.get('steps_to_reproduce')),
        'expected': b.get('expected') or b.get('expected_result') or '',
        'actual': b.get('actual') or b.get('actual_result') or '',
        'environment': b.get('environment') if isinstance(b.get('environment'), str) else 'local',
        'url': b.get('url', (b.get('environment') or {}).get('url', m.get('target', {}).get('url', ''))),
        'agentSeverity': sev,
        'foundAt': b.get('found_at') or b.get('foundAt'),
        'agentReview': {'status': 'proposed', 'method': 'human review pending', 'notes': ''},
        'refs': {'requirements': [(b.get('requirement_link') or {}).get('requirement_id', '')] if b.get('requirement_link') else [],
                 'cases': [], 'tests': []},
        'evidence': ev_objects(b.get('evidence', [])),
    })
tb_bugs = [{k: v for k, v in b.items() if v is not None} for b in tb_bugs]

def viewport(v):
    if isinstance(v, dict):
        return v
    return {'width': int(v)} if str(v).isdigit() else {'device': str(v)}

tb_tests = []
for t in test_list:
    tb_tests.append({
        'sourceId': t.get('manual_test_proposal_id') or t.get('sourceId') or t.get('requirement_id', ''),
        'title': t.get('title', ''),
        'description': t.get('description', ''),
        'preconditions': t.get('preconditions', ''),
        'steps': [s if isinstance(s, str) else json.dumps(s) for s in t.get('steps', [])],
        'expected': t.get('expected') or t.get('expected_result') or t.get('acceptance_criteria', ''),
        'priority': t.get('priority', 'medium'),
        'category': t.get('category', 'functional'),
        'viewports': [viewport(v) for v in t.get('viewports', [])],
        'refs': {'requirements': [t.get('requirement_id', '')] if t.get('requirement_id') else [],
                 'cases': [], 'tests': []},
    })

def text(v):
    return v.strip() if isinstance(v, str) else ''

def automation_text(a):
    """The contract's automation object (section 5.9) as the import's text; anything else gives '' (and a warning)."""
    if isinstance(a, dict):
        if a.get('suitable') is True and text(a.get('mode')):
            return f"Yes, {text(a['mode'])}"
        if a.get('suitable') is False and text(a.get('reason')):
            return f"No: {text(a['reason'])}"
    return None

def req_refs(rid):
    return {'requirements': [rid] if isinstance(rid, str) and rid else []}

def build_test_plan(manifest):
    """Contract 1.3 manifest -> test-plan.json, by the mapping in contract section 9 (snake_case -> camelCase)."""
    items = []
    for t in manifest.get('test_plan_items', []):
        auto = ''
        if t.get('automation') is not None:
            auto = automation_text(t['automation'])
            if auto is None:
                auto = ''
                print(f"Varning: {t.get('test_plan_item_id')}: automation har inte kontraktets form (avsnitt 5.9) och lämnas tom", file=sys.stderr)
        item = {
            'sourceId': text(t.get('test_plan_item_id')),
            'title': text(t.get('title')),
            'type': text(t.get('type')),
            'risk': text(t.get('risk')),
            'priority': text(t.get('priority')),
            'preconditions': text(t.get('preconditions')),
            'testData': text(t.get('test_data')),
            'steps': str_list(t.get('steps')),
            'acceptanceCriteria': text(t.get('acceptance_criteria')),
            'automation': auto,
            'refs': req_refs(t.get('requirement_id')),
        }
        if t.get('readiness') in ('ready', 'needs-clarification'):
            item['readiness'] = t['readiness']
        items.append(item)
    gaps = [{
        'sourceId': text(g.get('coverage_gap_id')),
        'description': text(g.get('description')),
        'refs': req_refs(g.get('requirement_id')),
    } for g in manifest.get('coverage_gaps', [])]
    return {'version': 1, 'planItems': items, 'coverageGaps': gaps}

# Contract 1.3 packages carry a structured test plan; 1.2 packages do not, and get no test-plan.json.
plan_json = None
if m.get('contract_version') == '1.3':
    if (pkg / 'test-plan.md').is_file():
        plan_json = json.dumps(build_test_plan(m), indent=2)
    else:
        print('Varning: kontrakt 1.3 kräver test-plan.md, som saknas; ingen test-plan.json skrivs', file=sys.stderr)
if plan_json is not None:
    plan_bytes = plan_json.encode('utf-8')
    files.append({'path': 'test-plan.json', 'sha256': hashlib.sha256(plan_bytes).hexdigest(), 'size': len(plan_bytes)})

tb_manifest = {
    'format': 'testbench-audit-package',
    'version': 1,
    'audit': {
        'id': m.get('audit_id', pkg.name),
        'title': m.get('title', pkg.name),
        'project': project_key,
        'agent': {
            'name': m.get('agent', {}).get('name', 'TestPilot'),
            'version': m.get('agent', {}).get('version', ''),
            'model': m.get('agent', {}).get('model', ''),
        },
    },
    'files': files,
    'parts': {
        'bugs': 'bugs.json',
        'manualTests': 'manual-tests.json',
        **({'testPlan': 'test-plan.json'} if plan_json is not None else {}),
        'narrative': 'report.md',
    },
}

staging = Path('/tmp/tb-package')
if staging.exists():
    shutil.rmtree(staging)
staging.mkdir()
(staging / 'manifest.json').write_text(json.dumps(tb_manifest, indent=2))
(staging / 'bugs.json').write_text(json.dumps({'version': 1, 'bugs': tb_bugs}, indent=2))
(staging / 'manual-tests.json').write_text(json.dumps({'version': 1, 'tests': tb_tests}, indent=2))
if plan_json is not None:
    (staging / 'test-plan.json').write_bytes(plan_bytes)
shutil.copy(pkg / 'report.md', staging / 'report.md')
for rel, data in evidence_files:
    dest = staging / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)

if out_zip.exists():
    out_zip.unlink()
with zipfile.ZipFile(out_zip, 'w', zipfile.ZIP_DEFLATED) as z:
    for p in sorted(staging.rglob('*')):
        if p.is_file():
            z.write(p, p.relative_to(staging))

n_plan = 1 if plan_json is not None else 0
plan_note = ''
if plan_json is not None:
    plan = json.loads(plan_json)
    plan_note = f", testplan med {len(plan['planItems'])} poster och {len(plan['coverageGaps'])} luckor"
print(f'Skapade {out_zip} med {len(files) - n_plan} evidence-filer, {len(tb_bugs)} buggar, {len(tb_tests)} manuella tester{plan_note}')
