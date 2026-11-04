using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Yx.Shared;
using YxPrediction;
internal static partial class Program
{
    static void ExportObserverQuotes(string path)
    {
        var output=new List<object>();
        for(int scenario=0;scenario<24;scenario++)
        {
            string id="code:fixture-"+scenario.ToString(CultureInfo.InvariantCulture);
            var players=new Player[8];var ratings=new Rating[8];var states=new PlayerState[8];
            var rows=new List<object>();var stateRows=new List<object>();int round=scenario%12+1,dead=scenario%3;
            for(int i=0;i<8;i++)
            {
                bool ai=scenario%4==0&&i>=6;string uid=ai?"ai"+i.ToString(CultureInfo.InvariantCulture):i.ToString("x24",CultureInfo.InvariantCulture);
                players[i]=new Player(uid,"Synthetic",ai);
                ratings[i]=new Rating(scenario%5==0?3000:2200+i*217+scenario*13,150,!(scenario%7==0&&i==3));
                int rank=i>=8-dead?i+1:0;states[i]=new PlayerState(rank>0?0:100-i*4,i%3,i%2,rank);
                rows.Add(new Dictionary<string,object>{{"uid",uid},{"isAI",ai},{"score",ratings[i].Score},{"found",ratings[i].Found}});
                stateRows.Add(new Dictionary<string,object>{{"life",states[i].Life},{"wins",states[i].Wins},{"losses",states[i].Losses},{"rank",rank}});
            }
            var m=new Market(id,players,ratings,Odds.Rates(ratings));m.UseHorseShuffle=true;
            int[] src=HorseShuffle.Sources(id,players),quotes=TradingOdds.Rates(HorseShuffle.Ratings(m),states,round,true);
            var sourceRows=new List<object>();var rates=new List<object>();var names=new List<object>();string[] titles=HorseShuffle.Titles(m);
            for(int i=0;i<8;i++){sourceRows.Add(src[i]);names.Add(titles[i]);}for(int i=0;i<64;i++)rates.Add(quotes[i]);
            output.Add(new Dictionary<string,object>{{"id",id},{"round",round},{"players",rows},{"states",stateRows},{"sources",sourceRows},{"titles",names},{"rates",rates}});
        }
        File.WriteAllText(path,Json.Serialize(output));Console.WriteLine("Observer quote reference exported");
    }
}
