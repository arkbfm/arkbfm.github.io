"""Regression checks for multiple speakers inside a stable search segment."""
import importlib.util,json,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('build_import',ROOT/'cloudflare-search/build_import.py');build=importlib.util.module_from_spec(spec);spec.loader.exec_module(build)
class SpeakerPiecesTests(unittest.TestCase):
 def setUp(self):
  self.identities={'SPEAKER_00':{'status':'confirmed','name':'あらB'},'SPEAKER_01':{'status':'confirmed','name':'ピジェ'}}
 def test_preserves_codepoint_lengths_and_both_speakers(self):
  segment={'start':10,'end':16,'text':'質問です。はい、答えです。','speaker':'SPEAKER_01','speaker_segments':[{'start':10,'text':'質問です。','speaker':'SPEAKER_00'},{'start':12,'text':'はい、答えです。','speaker':'SPEAKER_01'}]}
  turns=json.loads(build.speaker_turns([segment],self.identities))
  self.assertEqual(turns,[[5,'あらB',10.0,0],[8,'ピジェ',12.0,1]])
  self.assertEqual(sum(row[0] for row in turns),len(segment['text']))
 def test_legacy_and_unresolved(self):
  self.assertEqual(json.loads(build.speaker_turns([{'start':1,'text':'はい','speaker':None}],self.identities)),[[2,None,1.]])
 def test_rejects_missing_or_changed_text(self):
  with self.assertRaises(ValueError):build.speaker_turns([{'start':0,'text':'原文','speaker_segments':[{'start':0,'text':'変更'}]}],self.identities)
if __name__=='__main__':unittest.main()
