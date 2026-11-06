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

print(f'Skapade {out_zip} med {len(files)} evidence-filer, {len(tb_bugs)} buggar, {len(tb_tests)} manuella tester')
