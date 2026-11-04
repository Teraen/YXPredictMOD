"""Names for fields already present in ordinary public spectator data."""
class BuildCatalog:
    def __init__(self,data=None):self.data=data or {}
    def name(self,kind,identifier,fallback):return self.data.get(kind,{}).get(str(identifier),fallback)
    def choices(self,kind,identifiers):
        result=[]
        for identifier in identifiers:
            name=self.name(kind,identifier,'名称待同步')
            if kind=='talents'and self.data.get('talentRealms',{}).get(str(identifier)):name=self.data['talentRealms'][str(identifier)]+' · '+name
            if kind=='baijia'and 0<identifier<1000:name=self.data.get('baijiaSkip','跳过本次百家仙命')
            result.append({'id':identifier,'name':name})
        return result
    def project(self,player,round_number,card_names=None):
        previous=player.get('lastRound');completed=max(0,player['wins']+player['losses'])
        cards=(previous or {}).get('usedCards')if completed>0 else None
        return {'characterId':player['characterId'],'characterName':self.name('characters',player['characterId'],'角色待识别'),
            'careerId':player['career'],'careerName':self.name('careers',player['career'],'未选择副职'if player['career']==0 else'副职待识别'),
            'sectId':player.get('sect',0),'sectName':self.name('sects',player.get('sect',0),'门派待识别'),
            'realmId':player.get('level',0),'realmName':self.name('realms',player.get('level',0),'境界待识别'),
            'talents':self.choices('talents',player.get('talents',[])),
            'baijia':self.choices('baijia',(previous or {}).get('baijia',[])),
            'fates':self.choices('fates',(previous or {}).get('fates',[])),
            'resonance':self.choices('resonances',[previous['resonanceId']])[0]if previous and previous.get('resonanceId',0)>0 else None,
            'selectionRound':min(round_number,completed),'selectionsKnown':bool(previous and (completed>0 or previous.get('baijia')or previous.get('fates')or previous.get('resonanceId'))),
            'cards':cards,'cardNames':None if cards is None else [(card_names or {}).get(str(i),'未知牌'if i else'空位')for i in cards]}
