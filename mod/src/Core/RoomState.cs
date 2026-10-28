using System;
using System.Collections.Generic;
using System.Globalization;
using Yx.Shared;

namespace YxPrediction
{
    public sealed class RoomState
    {
        public bool AllowMatch;
        public int ReliefAmount;
        public long ReliefCount;
        public bool ReliefRequiresNoPendingBets;
        public string Code, GameId;
        public string[] MemberIds = new string[0], MemberNames = new string[0], MemberUids = new string[0];
        public bool Host, Open, Settled, Forfeited, TradingClosed;
        public int Version, Round, Members, Rules;
        public int[] BaseRates=new int[64], QuoteRates=new int[64], Factors=new int[64];
        public long[] Claims=new long[8], FinalPayouts=new long[8];
        public long Balance, Payout;
        public readonly string[] Uids = new string[8], Names = new string[8];
        public readonly int[] Ranks = new int[8], MyRanks = new int[8], RankMinimum = new int[8], RankMaximum = new int[8];
        public string ResultPlace(int player)
        {
            return RankMinimum[player] > 0 && RankMinimum[player] < RankMaximum[player]
                ? "第" + RankMinimum[player].ToString(CultureInfo.InvariantCulture) + "–" + RankMaximum[player].ToString(CultureInfo.InvariantCulture) + "名同出" : "最终第" + Ranks[player].ToString(CultureInfo.InvariantCulture) + "名";
        }
        public readonly long[] Stakes = new long[8], Pools = new long[64];
        public bool HasPendingBets
        {
            get
            {
                if (Settled || Forfeited) return false;
                for (int i = 0; i < 8; i++) if ((Rules != 2 || Ranks[i] == 0) && (Claims[i] > 0 || Stakes[i] > 0)) return true;
                return false;
            }
        }
        public static RoomState Read(Dictionary<string, object> d)
        {
            var r = new RoomState();
            r.Code = Json.GetString(d, "code", ""); r.GameId = Json.GetString(d, "gameId", "");
            r.Host = Json.GetBool(d, "host", false); r.Open = Json.GetBool(d, "open", false); r.Settled = Json.GetBool(d, "settled", false);
            r.AllowMatch = Json.GetBool(d, "allowMatch", true);
            r.ReliefAmount = (int)Json.GetNumber(d, "reliefAmount", 0);
            r.ReliefCount = (long)Json.GetNumber(d, "reliefCount", 0);
            r.ReliefRequiresNoPendingBets = Json.GetBool(d, "reliefRequiresNoPendingBets", false);
            r.Version = (int)Json.GetNumber(d, "version", 0); r.Round = (int)Json.GetNumber(d, "round", 0); r.Members = (int)Json.GetNumber(d, "members", 0);
            r.Forfeited = Json.GetBool(d, "forfeited", false);
            r.TradingClosed = Json.GetBool(d, "tradingClosed", false) || r.Round > PredictionBook.TradingClosingRound;
            r.Open = r.Open && !r.Forfeited && !r.TradingClosed;
            r.Balance = (long)Json.GetNumber(d, "balance", 0); r.Payout = (long)Json.GetNumber(d, "payout", 0);
            r.Rules=(int)Json.GetNumber(d,"rules",1);
            if(r.Rules==2){
                var baseline=Json.GetArray(d,"baseRates");var quoted=Json.GetArray(d,"quoteRates");var factors=Json.GetArray(d,"factors");
                if(baseline==null||quoted==null||factors==null||baseline.Count!=64||quoted.Count!=64||factors.Count!=64)throw new FormatException("房间倍率缺失");
                for(int i=0;i<64;i++){r.BaseRates[i]=Convert.ToInt32(baseline[i],CultureInfo.InvariantCulture);r.QuoteRates[i]=Convert.ToInt32(quoted[i],CultureInfo.InvariantCulture);r.Factors[i]=Convert.ToInt32(factors[i],CultureInfo.InvariantCulture);}
            }
            var members = Json.GetArray(d, "memberDetails");
            if (members != null)
            {
                if (members.Count > 32) throw new FormatException("房间成员数量无效");
                r.MemberIds = new string[members.Count]; r.MemberNames = new string[members.Count]; r.MemberUids = new string[members.Count];
                for(int i=0;i<members.Count;i++) { var member=members[i] as Dictionary<string,object>; r.MemberIds[i]=Json.GetString(member,"id",""); r.MemberNames[i]=Json.GetString(member,"name",""); r.MemberUids[i]=Json.GetString(member,"uid",""); }
            }
            var players = d["players"] as List<object>; var ranks = d["ranks"] as List<object>;
            var positions = d["positions"] as List<object>; var pools = d["totals"] as List<object>;
            if (players == null || players.Count != 8 || ranks == null || ranks.Count != 8 || positions == null || positions.Count != 8 || pools == null || pools.Count != 8) throw new FormatException("房间响应维度错误");
            for (int i = 0; i < 8; i++)
            {
                var player = players[i] as Dictionary<string, object>;
                r.Uids[i] = Json.GetString(player, "uid", ""); r.Names[i] = Json.GetString(player, "name", "");
                r.Ranks[i] = Convert.ToInt32(ranks[i], CultureInfo.InvariantCulture);
                var minimum = Json.GetArray(d,"rankMinimum"); var maximum = Json.GetArray(d,"rankMaximum");
                if ((minimum != null && minimum.Count != 8) || (maximum != null && maximum.Count != 8)) throw new FormatException("名次区间维度错误");
                r.RankMinimum[i] = minimum == null ? r.Ranks[i] : Convert.ToInt32(minimum[i],CultureInfo.InvariantCulture);
                r.RankMaximum[i] = maximum == null ? r.Ranks[i] : Convert.ToInt32(maximum[i],CultureInfo.InvariantCulture);
                var pos = positions[i] as Dictionary<string, object>;
                if (pos != null) { r.MyRanks[i] = (int)Json.GetNumber(pos, "rank", 0); r.Stakes[i] = (long)Json.GetNumber(pos, "stake", 0); r.Claims[i]=(long)Json.GetNumber(pos,"claim",r.Stakes[i]);r.FinalPayouts[i]=(long)Json.GetNumber(pos,"payout",0); }
                var totals = pools[i] as List<object>; if (totals == null || totals.Count != 8) throw new FormatException("资金池维度错误");
                for (int j = 0; j < 8; j++) r.Pools[i * 8 + j] = Convert.ToInt64(totals[j], CultureInfo.InvariantCulture);
            }
            return r;
        }
    }

}
