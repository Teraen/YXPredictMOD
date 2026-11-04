"""Export confirmed placement facts from the identity database, without game requests.

Run as a forced SSH command. Opens one read transaction and never imports or starts
the collector. UIDs are joined only by the collector's saved identity proof.
"""
import argparse
import hashlib
import json
import re
import sqlite3
import time


def export(database):
    db = sqlite3.connect('file:' + database + '?mode=ro', uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        headers = {r['code_id']: dict(r) for r in db.execute('''
            SELECT code_id,MIN(game_id) game_id,MIN(begin_ts) begin_ts,MAX(end_ts) end_ts,
              COUNT(DISTINCT game_id) game_ids,COUNT(DISTINCT begin_ts) begin_times
            FROM link_replays GROUP BY code_id''')}
        games = []
        rejected = 0
        for room in db.execute('''SELECT r.key,r.code_id,p.payload FROM link_rooms r
            JOIN link_reports p ON p.room_key=r.key AND p.code_id=r.code_id
            WHERE r.status IN ('verified','waiting_scores','ambiguous_identity')
            AND NOT EXISTS(SELECT 1 FROM link_conflicts c WHERE c.code_id=r.code_id)
            AND 1=(SELECT COUNT(*) FROM link_rooms x WHERE x.code_id=r.code_id)'''):
            header = headers.get(room['code_id'])
            report = json.loads(room['payload'])
            if (not header or header['game_ids'] != 1 or header['begin_times'] != 1
                    or header['end_ts'] <= header['begin_ts'] or report.get('conflicts')
                    or report.get('game') != [header['game_id'], room['code_id'], header['begin_ts']]):
                rejected += 1
                continue
            entries = []
            for p in db.execute('''SELECT p.*,s.mode,s.before,s.delta,s.after FROM link_people p
                JOIN link_scores s ON s.room_key=p.room_key AND s.uid=p.uid
                WHERE p.room_key=? AND s.code_id=?''', (room['key'],room['code_id'])):
                proof = json.loads(p['proof'])
                score = next((s for s in report.get('scores',[]) if s.get('uid') == p['uid']), None)
                identity = next((m for m in report.get('mapping',[]) if m.get('uid') == p['uid']), None)
                if (not re.fullmatch('[0-9a-f]{24}',p['uid']) or not re.fullmatch('record-player-[1-8]',p['alias'])
                        or proof != identity or proof.get('status') != 'verified' or not score
                        or any(score.get(k) != p[k] for k in ('uid','mode','before','delta','after'))
                        or score.get('anonymousUid') != p['alias'] or p['mode'] not in ('ladder','daoxin')):
                    rejected += 1
                    continue
                entries.append({'uid':p['uid'],'place':int(p['alias'][-1]),'mode':p['mode'],
                    'name':p['name'],'proof':hashlib.sha256(p['proof'].encode()).hexdigest()})
            if len(entries) >= 2 and len({p['uid'] for p in entries}) == len(entries) and len({p['place'] for p in entries}) == len(entries):
                games.append({'id':header['game_id'],'code':room['code_id'],'begin':header['begin_ts'],
                    'at':header['end_ts'],'players':sorted(entries,key=lambda p:p['place'])})
        return {'schema':1,'generatedAt':time.time_ns()//1000000,'games':games,'rejected':rejected,
            'scope':'Observed public ranked/DaoXin games; confirmed human identities and root-owner score evidence only; incomplete coverage.',
            'readOnly':True,'upstreamRequests':0}
    finally:
        db.close()


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--database',required=True)
    print(json.dumps(export(parser.parse_args().database),ensure_ascii=False,separators=(',',':')))
