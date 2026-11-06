"""Tests for tools/build_testbench_package.py: test-plan.json is written for contract 1.3 packages only.

Run: python3 -m unittest discover -s tests
"""
import hashlib, json, subprocess, sys, tempfile, unittest, zipfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / 'tools' / 'build_testbench_package.py'
AID = 'AUD-20260102-01'


def make_package(root, version, with_plan_md=True):
    pkg = Path(root) / AID
    (pkg / 'evidence').mkdir(parents=True)
    (pkg / 'evidence' / 'dom.txt').write_text('counter: 0\n')
    ready = version == '1.3'
    items = [
        {'test_plan_item_id': 'TPI-001', 'requirement_id': 'REQ-1', 'title': 'Check REQ-1', 'risk': 'High', 'priority': 'High',
         'type': 'Functional', 'readiness': 'ready'},
        {'test_plan_item_id': 'TPI-002', 'requirement_id': 'REQ-LOCAL-002', 'title': 'Check REQ-LOCAL-002', 'risk': 'Low', 'priority': 'Low',
         'type': 'Functional', 'readiness': 'needs-clarification'},
    ]
    if ready:
        items[0].update({'preconditions': 'One todo exists', 'test_data': 'Title: QA-AUDIT-1', 'steps': ['Add a todo', 'Complete it'],
                         'acceptance_criteria': 'The counter shows 0', 'automation': {'suitable': True, 'mode': 'both'}})
        items[1].update({'preconditions': 'None', 'test_data': 'None', 'steps': [], 'acceptance_criteria': 'No measurable criterion',
                         'automation': {'suitable': False, 'reason': 'no criterion to assert'}})
    manifest = {
        'audit_id': AID, 'contract_version': version, 'agent': {'name': 'testpilot', 'model': 'm'}, 'target': {'url': 'https://example.test'},
        'test_plan_items': items,
        'coverage_gaps': [{'coverage_gap_id': 'CG-001', 'requirement_id': 'REQ-LOCAL-002', 'description': 'no measurable criterion'}],
        'evidence': [{'evidence_id': 'EV-001', 'location': 'evidence/dom.txt'}],
    }
    (pkg / 'manifest.json').write_text(json.dumps(manifest))
    (pkg / 'bugs.json').write_text('[]')
    (pkg / 'manual-tests.json').write_text('[]')
    (pkg / 'report.md').write_text('# Audit\n')
    if with_plan_md:
        (pkg / 'test-plan.md').write_text('TPI-001 TPI-002 CG-001\n')
    return pkg


def build(pkg, out):
    r = subprocess.run([sys.executable, str(SCRIPT), str(pkg), 'RS', str(out)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r


class BuildTestPlan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def built(self, version, with_plan_md=True):
        pkg = make_package(self.tmp.name, version, with_plan_md)
        out = Path(self.tmp.name) / f'{version}-{with_plan_md}.zip'
        r = build(pkg, out)
        z = zipfile.ZipFile(out)
        return z, json.loads(z.read('manifest.json')), r

    def test_13_package_gets_test_plan_json_with_the_section_9_mapping(self):
        z, manifest, r = self.built('1.3')
        self.assertIn('test-plan.json', z.namelist())
        self.assertEqual(json.loads(z.read('test-plan.json')), {
            'version': 1,
            'planItems': [
                {'sourceId': 'TPI-001', 'title': 'Check REQ-1', 'type': 'Functional', 'risk': 'High', 'priority': 'High', 'readiness': 'ready',
                 'preconditions': 'One todo exists', 'testData': 'Title: QA-AUDIT-1', 'steps': ['Add a todo', 'Complete it'],
                 'acceptanceCriteria': 'The counter shows 0', 'automation': 'Yes, both', 'refs': {'requirements': ['REQ-1']}},
                {'sourceId': 'TPI-002', 'title': 'Check REQ-LOCAL-002', 'type': 'Functional', 'risk': 'Low', 'priority': 'Low',
                 'readiness': 'needs-clarification', 'preconditions': 'None', 'testData': 'None', 'steps': [],
                 'acceptanceCriteria': 'No measurable criterion', 'automation': 'No: no criterion to assert',
                 'refs': {'requirements': ['REQ-LOCAL-002']}},
            ],
            'coverageGaps': [{'sourceId': 'CG-001', 'description': 'no measurable criterion', 'refs': {'requirements': ['REQ-LOCAL-002']}}],
        })
        self.assertEqual(manifest['parts']['testPlan'], 'test-plan.json')
        entry = [f for f in manifest['files'] if f['path'] == 'test-plan.json']
        data = z.read('test-plan.json')
        self.assertEqual(entry, [{'path': 'test-plan.json', 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}])
        self.assertIn('testplan med 2 poster och 1 luckor', r.stdout)

    def test_12_package_gets_no_test_plan_json(self):
        z, manifest, r = self.built('1.2')
        self.assertNotIn('test-plan.json', z.namelist())
        self.assertNotIn('testPlan', manifest['parts'])
        self.assertEqual([f['path'] for f in manifest['files']], ['evidence/dom.txt'])
        self.assertNotIn('testplan', r.stdout)

    def test_13_package_without_test_plan_md_gets_none_and_a_warning(self):
        z, manifest, r = self.built('1.3', with_plan_md=False)
        self.assertNotIn('test-plan.json', z.namelist())
        self.assertNotIn('testPlan', manifest['parts'])
        self.assertIn('test-plan.md', r.stderr)

    def test_automation_that_is_not_the_contract_form_is_left_empty_with_a_warning(self):
        pkg = make_package(self.tmp.name, '1.3')
        m = json.loads((pkg / 'manifest.json').read_text())
        m['test_plan_items'][0]['automation'] = 'Yes'
        (pkg / 'manifest.json').write_text(json.dumps(m))
        out = Path(self.tmp.name) / 'bad.zip'
        r = build(pkg, out)
        plan = json.loads(zipfile.ZipFile(out).read('test-plan.json'))
        self.assertEqual(plan['planItems'][0]['automation'], '')
        self.assertIn('TPI-001', r.stderr)


if __name__ == '__main__':
    unittest.main()
