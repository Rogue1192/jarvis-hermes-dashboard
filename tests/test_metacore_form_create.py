"""Read-only CLI dispatch tests; no network or credentials needed."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('interface', ROOT / 'tools/metacore_form_create.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
OPT = '12208253-8598-4a93-9f1a-d2c19cfb6955'

class Backend:
    def main(self):
        self.argv = list(sys.argv)
        return 7

class InterfaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.out = str(Path(self.temp.name) / 'new.json')
    def tearDown(self):
        self.temp.cleanup()
    def invoke(self, args, expected):
        b = Backend()
        before = sys.argv
        with patch.object(m, 'load_backend', return_value=b):
            self.assertEqual(m.main(args + ['--output', self.out]), 7)
        self.assertEqual(b.argv[1:3], [expected, OPT])
        self.assertIs(sys.argv, before)
    def test_uuid_first_all_ops(self):
        for op in m.OPS:
            with self.subTest(op=op): self.invoke([OPT, op], op)
    def test_op_first_all_ops(self):
        for op in m.OPS:
            with self.subTest(op=op): self.invoke([op, OPT], op)
    def test_default_readonly(self): self.invoke([OPT], 'inspect')
    def test_prepare_only_never_create(self): self.invoke([OPT, 'create', '--prepare-only'], 'inspect')
    def test_reject_invalid_without_backend(self):
        for args in [['BAD', 'create'], [OPT.upper(), 'create'], [OPT, 'delete'], ['create'],
                     [OPT, 'read', '--prepare-only'], [OPT, 'inspect', '--prepare-only']]:
            with self.subTest(args=args), patch.object(m, 'load_backend') as load:
                with self.assertRaises(SystemExit): m.main(args + ['--output', self.out])
                load.assert_not_called()
    def test_refuse_existing_evidence(self):
        Path(self.out).write_text('keep')
        with patch.object(m, 'load_backend') as load:
            with self.assertRaises(SystemExit): m.main([OPT, '--output', self.out])
            load.assert_not_called()
        self.assertEqual(Path(self.out).read_text(), 'keep')
    def test_no_output_refused(self):
        with patch.object(m, 'load_backend') as load:
            with self.assertRaises(SystemExit): m.main([OPT])
            load.assert_not_called()

if __name__ == '__main__': unittest.main(verbosity=2)
