import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from public_snapshot import publish


class PublicSnapshotTests(unittest.TestCase):
    def data(self):
        # Even nested identity or replay fields must never reach the public file.
        players = {str(i).zfill(24): dict(rating=4000+i, sigma=50, games=40, last=200,
                   uid='private-uid', name='private-name', replay={'codeId': 'private-code'})
                   for i in range(120)}
        return dict(players=players, hashedPlayers={'private-hash': dict(rating=5000, sigma=10,
                    games=40, last=200)}, meta=dict(sourceAt=300, historyMerged=True))

    def test_top100_matches_order_and_keeps_only_public_scores(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'board.json'
            board=publish(self.data(), path)
            self.assertEqual(json.loads(path.read_bytes()), board)
            self.assertEqual(board['total'], 100)
            self.assertEqual(board['rows'][0], dict(conservative=4980, uncertainty=10, technical=5000))
            self.assertEqual(board['scores'][-1], 4021)
            self.assertEqual(set(board), {'rows','scores','offset','limit','total','updatedAt','minGames','activeDays'})
            self.assertTrue(all(set(r)=={'conservative','uncertainty','technical'} for r in board['rows']))
            self.assertNotIn('private', path.read_text())
            self.assertLess(path.stat().st_size, 32000)

    def test_invalid_or_failed_replacement_preserves_last_success(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'board.json'
            publish(self.data(), path)
            previous=path.read_bytes()
            with self.assertRaises(ValueError):
                publish(dict(players={},meta={}), path)
            with patch.object(Path, 'replace', side_effect=OSError('disk error')):
                with self.assertRaises(OSError):publish(self.data(), path)
            self.assertEqual(path.read_bytes(), previous)
            self.assertEqual(list(Path(d).iterdir()), [path])


if __name__=='__main__':unittest.main()
