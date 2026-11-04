using System;
using Yx.Shared;
using YxPrediction;

internal static partial class Program
{
    static void HorseShuffleChecks()
    {
        Check("horse shuffle selects a stable two or three human cycle across order, reload and observers", delegate
        {
            bool two = false, three = false;
            for (int game = 0; game < 100; game++)
            {
                MatchSnapshot s = Snapshot(1); s.Id = "shuffle-" + game; var sources = HorseShuffle.Sources(s.Id, s.Players); var seen = new bool[8]; int changed = 0;
                var reversed = new Player[8]; for (int i = 0; i < 8; i++) reversed[i] = s.Players[7-i];
                var other = HorseShuffle.Sources(s.Id, reversed);
                for (int i = 0; i < 8; i++)
                {
                    True(!seen[sources[i]]); seen[sources[i]] = true; if (sources[i] != i) changed++;
                    Equal(s.Players[sources[i]].Uid, reversed[other[7-i]].Uid);
                }
                True(changed == 2 || changed == 3); if (changed == 2) two = true; else three = true;
            }
            True(two && three);
            MatchSnapshot ai = Snapshot(1); for (int i = 1; i < 8; i++) ai.Players[i] = new Player(ai.Players[i].Uid, ai.Players[i].Name, true);
            var unchanged = HorseShuffle.Sources(ai.Id, ai.Players); for (int i = 0; i < 8; i++) Equal(unchanged[i], i);
        });
        Check("shuffled horse titles and initial quotes move together without changing actual Elo or names", delegate
        {
            MatchSnapshot normal = Snapshot(1); normal.TradingOpen = true;
            MatchSnapshot shuffled = Snapshot(1); shuffled.TradingOpen = true; shuffled.ShuffleHorses = true;
            var a = new PredictionBook(1000); a.Observe(normal, Ratings(true)); var b = new PredictionBook(1000); Market m = b.Observe(shuffled, Ratings(true));
            True(m.UseHorseShuffle); var sources = HorseShuffle.Sources(shuffled.Id, shuffled.Players); var baseTitles = HorseShuffle.Titles(a.Find(normal.Id)); var titles = HorseShuffle.Titles(m);
            for (int i = 0; i < 8; i++)
            {
                Equal(m.Ratings[i].Score, Ratings(true)[i].Score); Equal(m.Players[i].Uid, shuffled.Players[i].Uid); Equal(m.Players[i].Name, shuffled.Players[i].Name);
                Equal(titles[i], baseTitles[sources[i]]);
                for (int rank = 0; rank < 8; rank++) Equal(m.QuoteRates[i*8+rank], a.Find(normal.Id).QuoteRates[sources[i]*8+rank]);
            }
            Equal(b.Buy(shuffled, shuffled.Players[0].Uid, 1, 37, m.TradeVersion), null); long claim = m.Positions[0].Claim;
            b = BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(b)))); m = b.Find(shuffled.Id);
            True(m.UseHorseShuffle); Equal(m.Positions[0].Claim, claim); Equal(b.Balance, 963L);
            shuffled.Round = 2; shuffled.States[0] = new PlayerState(0,0,1,8); b.Observe(shuffled, null);
            True(b.Buy(shuffled, shuffled.Players[0].Uid, 1, 10, m.TradeVersion) != null);
        });
        Check("legacy markets retain original quotes and rights when the new shuffle rule becomes enabled", delegate
        {
            MatchSnapshot s = Snapshot(1); s.TradingOpen = true; var b = new PredictionBook(1000); var m = b.Observe(s, Ratings(true));
            Equal(b.Buy(s,s.Players[0].Uid,1,10,m.TradeVersion),null); long claim = m.Positions[0].Claim; int rate=m.QuoteRates[0];
            var saved=BookCodec.Write(b);saved["version"]=5;b=BookCodec.Read(saved);s.ShuffleHorses=true;b.Observe(s,null);m=b.Find(s.Id);
            True(!m.UseHorseShuffle);Equal(m.Positions[0].Claim,claim);Equal(m.QuoteRates[0],rate);Equal(b.Balance,990L);
        });
        Check("horse captions hide ratings and allocated profiles remain fixed for the whole game", delegate
        {
            MatchSnapshot s=Snapshot(1);s.ShuffleHorses=true;var roster=new HorseRoster();roster.Observe(s,HorseProfiles());
            var titles=new string[8];for(int i=0;i<8;i++){var member=roster.Find(s.Players[i].Uid);titles[i]=member.Title;Equal(member.PlateCaption,member.Title);for(int n=0;n<member.PlateCaption.Length;n++)True(member.PlateCaption[n]<'0'||member.PlateCaption[n]>'9');}
            var changed=HorseProfiles();for(int i=0;i<8;i++)changed[i]=new HorseProfile(new Rating(1000+i*500,100,true));s.Round=2;roster.Observe(s,changed);
            for(int i=0;i<8;i++)Equal(roster.Find(s.Players[i].Uid).Title,titles[i]);
        });
    }
}
