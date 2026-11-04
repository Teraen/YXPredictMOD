"""Independent public-record recovery; no game websocket, login or wallet mutation."""
import argparse,json,logging,pathlib
from main import Backend
from public_archive import ArchivePending,records_for,recover_battles

def run(config):
    backend=Backend(config['backend'],config['key']);status=backend.call('status')
    names=json.loads(pathlib.Path(config['cardNames']).read_text(encoding='utf8'))
    for target in status.get('reports',[]):
        try:
            records=records_for(config,target)
            rounds=target.get('recoveryRounds',list(range(max(1,target['round']-1),target['round']+1)))
            for offset in range(0,len(rounds),2):
                batch={**target,'recoveryRounds':rounds[offset:offset+2]}
                battles=recover_battles(batch,records,names)
                result=backend.call('report',code=target['code'],gameId=target['gameId'],battles=battles)
                logging.info('Public report recovered; rounds=%s tables=%d ready=%s',batch['recoveryRounds'],len(battles),result.get('reportReady'))
        except Exception as error:logging.warning('Final public archive pending (%s): %s',type(error).__name__,str(error)if isinstance(error,ArchivePending)else'waiting for verified records')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);args=parser.parse_args()
    logging.basicConfig(level=logging.INFO,format='%(asctime)s %(levelname)s %(message)s')
    run(json.loads(pathlib.Path(args.config).read_text(encoding='utf8')))
