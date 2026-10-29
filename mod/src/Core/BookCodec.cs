using System;
using System.Collections.Generic;
using Yx.Shared;

namespace YxPrediction
{
    public static class BookCodec
    {
        static Dictionary<string, object> Obj() { return new Dictionary<string, object>(); }

        public static Dictionary<string, object> Write(PredictionBook book)
        {
            var root = Obj();
            root["version"] = 5;
            root["balance"] = book.Balance;
            var markets = new List<object>();
            root["markets"] = markets;
            for (int n = 0; n < book.Markets.Count; n++)
            {
                Market m = book.Markets[n];
                var row = Obj();
                row["id"] = m.Id;
                row["rules"] = m.RuleVersion;
                row["round"] = m.HighestRound;
                row["locked"] = m.Locked;
                row["settled"] = m.Settled;
                row["abandoned"] = m.Abandoned;
                row["payout"] = m.TotalPayout;
                var players = new List<object>();
                var rates = new List<object>();
                var tickets = new List<object>();
                var ranks = new List<object>();
                var life = new List<object>();
                var swaps = new List<object>();
                for (int i = 0; i < 8; i++)
                {
                    var p = Obj();
                    p["uid"] = m.Players[i].Uid; p["name"] = m.Players[i].Name; p["ai"] = m.Players[i].IsAi;
                    p["elo"] = m.Ratings[i].Score; p["sigma"] = m.Ratings[i].Sigma; p["found"] = m.Ratings[i].Found;
                    players.Add(p);
                    for (int r = 0; r < 8; r++) rates.Add(m.BaseRates[i * 8 + r]);
                    Ticket t = m.Tickets[i];
                    if (t != null)
                    {
                        var ticket = Obj();
                        ticket["player"] = i; ticket["rank"] = t.Rank; ticket["round"] = t.Round;
                        ticket["stake"] = t.Stake; ticket["rate"] = t.RateBps;
                        tickets.Add(ticket);
                    }
                    if (m.FinalRanks != null) ranks.Add(m.FinalRanks[i]);
                    var points = new List<object>();
                    for (int pIndex = 0; pIndex < m.Life[i].Points.Count; pIndex++)
                    {
                        LifePoint point = m.Life[i].Points[pIndex]; points.Add(point.Round); points.Add(point.Life);
                    }
                    life.Add(points);
                    var swapPoints = new List<object>();
                    for (int pIndex = 0; pIndex < m.Swaps[i].Points.Count; pIndex++)
                    {
                        SwapPoint point = m.Swaps[i].Points[pIndex]; swapPoints.Add(point.Round); swapPoints.Add(point.Remaining);
                    }
                    swaps.Add(swapPoints);
                }
                row["players"] = players; row["rates"] = rates; row["tickets"] = tickets; row["ranks"] = ranks;
                if (m.IsTrading) row["trading"] = WriteTrading(m);
                row["life"] = life;
                row["swaps"] = swaps;
                markets.Add(row);
            }
            return root;
        }

        static Dictionary<string, object> WriteTrading(Market m)
        {
            var data = Obj();
            data["quoteRound"] = m.QuoteRound; data["version"] = m.TradeVersion; data["closedThrough"] = m.ClosedThroughRound;
            var states = new List<object>(); var rates = new List<object>(); var known = new List<object>(); var positions = new List<object>();
            for (int i = 0; i < 8; i++)
            {
                known.Add(m.KnownRanks[i]);
                if (m.QuoteStates != null)
                {
                    PlayerState state = m.QuoteStates[i]; var s = Obj();
                    s["life"] = state.Life; s["wins"] = state.Wins; s["losses"] = state.Losses; s["rank"] = state.FinalRank; states.Add(s);
                }
                Position p = m.Positions[i]; var row = Obj();
                row["rank"] = p.Rank; row["claim"] = p.Claim; row["cost"] = p.Cost; row["invested"] = p.Invested;
                row["returned"] = p.CashReturned; row["paid"] = p.FinalPayout; row["actions"] = p.Actions; row["resolved"] = p.Resolved;
                positions.Add(row);
            }
            for (int i = 0; i < 64; i++) rates.Add(m.QuoteRates[i]);
            var minimum = new List<object>(); var maximum = new List<object>(); var rounds = new List<object>();
            for (int i = 0; i < 8; i++) { minimum.Add(m.RankMinimum[i]); maximum.Add(m.RankMaximum[i]); rounds.Add(m.EliminationRounds[i]); }
            data["rankMinimum"] = minimum; data["rankMaximum"] = maximum; data["eliminationRounds"] = rounds;
            data["states"] = states; data["rates"] = rates; data["known"] = known; data["positions"] = positions;
            return data;
        }

        static void ReadTrading(Market market, Dictionary<string, object> data)
        {
            if (data == null) throw new FormatException("调仓存档缺失");
            market.QuoteRound = (int)Number(data, "quoteRound", 0, market.HighestRound);
            market.TradeVersion = (int)Number(data, "version", 0, 2000000000);
            market.ClosedThroughRound = (int)Number(data, "closedThrough", 0, 100000);
            var known = Array(data, "known", 8, 8); var seen = new bool[9];
            for (int i = 0; i < 8; i++)
            {
                int rank = ArrayNumber(known, i, 0, 8);
                if (rank > 0 && seen[rank]) throw new FormatException("确定名次重复");
                if (rank > 0) seen[rank] = true;
                market.KnownRanks[i] = rank;
            }
            if (data.ContainsKey("rankMinimum") || data.ContainsKey("rankMaximum") || data.ContainsKey("eliminationRounds"))
            {
                var minimum = Array(data,"rankMinimum",8,8); var maximum = Array(data,"rankMaximum",8,8); var rounds = Array(data,"eliminationRounds",8,8);
                for (int i = 0; i < 8; i++)
                {
                    int low = ArrayNumber(minimum,i,0,8), high = ArrayNumber(maximum,i,0,8);
                    market.RankMinimum[i] = low; market.RankMaximum[i] = high; market.EliminationRounds[i] = ArrayNumber(rounds,i,0,100000);
                    if ((low == 0) != (high == 0) || low > high || (low > 0 && (market.KnownRanks[i] < low || market.KnownRanks[i] > high))) throw new FormatException("同出区间存档无效");
                    if (low < high)
                    {
                        int members = 0;
                        for (int j = 0; j < 8; j++) if (ArrayNumber(minimum,j,0,8) == low && ArrayNumber(maximum,j,0,8) == high && ArrayNumber(rounds,j,0,100000) == market.EliminationRounds[i]) members++;
                        if (market.EliminationRounds[i] == 0 || members != high-low+1) throw new FormatException("同出分组存档无效");
                    }
                }
            }
            var states = Array(data, "states", market.QuoteRound == 0 ? 0 : 8, market.QuoteRound == 0 ? 0 : 8);
            if (states.Count == 8)
            {
                market.QuoteStates = new PlayerState[8];
                for (int i = 0; i < 8; i++)
                {
                    var s = ObjectAt(states, i);
                    var state = new PlayerState((int)Number(s, "life", -100000, 100000), (int)Number(s, "wins", 0, 100000),
                        (int)Number(s, "losses", 0, 100000), (int)Number(s, "rank", 0, 8));
                    if ((state.Life > 0 && state.FinalRank != 0) || (state.Life <= 0 && state.FinalRank != market.KnownRanks[i])) throw new FormatException("报价局势与淘汰记录不符");
                    market.QuoteStates[i] = state;
                }
            }
            var rates = Array(data, "rates", 64, 64);
            int[] expected = market.QuoteStates == null ? new int[64] : TradingOdds.Rates(market.Ratings, market.QuoteStates, market.QuoteRound, market.ChampionOnly);
            for (int i = 0; i < 64; i++)
            {
                int rate = ArrayNumber(rates, i, 0, Odds.MaximumRateBps);
                if (rate != expected[i]) throw new FormatException("动态报价存档损坏");
                market.QuoteRates[i] = rate;
            }
            var positions = Array(data, "positions", 8, 8);
            long paid = 0;
            for (int i = 0; i < 8; i++)
            {
                var row = ObjectAt(positions, i); Position p = market.Positions[i];
                p.Rank = (int)Number(row, "rank", 0, 8); p.Claim = Number(row, "claim", 0, Position.MaximumClaim);
                if (market.ChampionOnly && p.Rank > 1) throw new FormatException("冠军持仓名次无效");
                p.Cost = Number(row, "cost", 0, Position.MaximumInvested); p.Invested = Number(row, "invested", 0, Position.MaximumInvested);
                p.CashReturned = Number(row, "returned", 0, Position.MaximumClaim); p.FinalPayout = Number(row, "paid", 0, Position.MaximumClaim);
                p.Actions = (int)Number(row, "actions", 0, Position.MaximumActions); p.Resolved = Json.GetBool(row, "resolved", false);
                if (p.Cost > p.Invested || p.Invested > p.Actions * Odds.MaximumStake || p.Claim > p.Invested * 50
                    || p.CashReturned + p.Claim > p.Invested * 50 || (p.Claim == 0 && (p.Rank != 0 || p.Cost != 0))
                    || (p.Claim > 0 && p.Rank == 0) || p.Resolved != (market.KnownRanks[i] > 0)
                    || p.FinalPayout != (p.Resolved ? market.ReturnFor(i, market.KnownRanks[i]) : 0)) throw new FormatException("持仓记录损坏");
                paid += p.FinalPayout;
            }
            if (paid != market.TotalPayout) throw new FormatException("逐人结算总额损坏");
        }

        static long Number(Dictionary<string, object> row, string key, long min, long max)
        {
            object raw;
            if (!row.TryGetValue(key, out raw) || (!(raw is double) && !(raw is int) && !(raw is long) && !(raw is float))) throw new FormatException("存档数字类型无效：" + key);
            double value = Convert.ToDouble(raw, System.Globalization.CultureInfo.InvariantCulture);
            if (double.IsNaN(value) || double.IsInfinity(value) || value < min || value > max || Math.Floor(value) != value)
                throw new FormatException("存档数字字段无效：" + key);
            return (long)value;
        }

        static int ArrayNumber(List<object> values, int i, int min, int max)
        {
            object raw = values[i];
            if (!(raw is double) && !(raw is int) && !(raw is long)) throw new FormatException("存档数组数字无效");
            double value = Convert.ToDouble(raw, System.Globalization.CultureInfo.InvariantCulture);
            if (double.IsNaN(value) || double.IsInfinity(value) || value < min || value > max || value != Math.Floor(value)) throw new FormatException("存档数组范围无效");
            return (int)value;
        }

        static Dictionary<string, object> ObjectAt(List<object> rows, int i)
        {
            var row = rows[i] as Dictionary<string, object>;
            if (row == null) throw new FormatException("存档对象无效");
            return row;
        }

        static List<object> Array(Dictionary<string, object> row, string key, int min, int max)
        {
            var result = Json.GetArray(row, key);
            if (result == null || result.Count < min || result.Count > max) throw new FormatException("存档列表无效：" + key);
            return result;
        }

        public static PredictionBook Read(Dictionary<string, object> root)
        {
            if (root == null) throw new FormatException("马币存档为空");
            int formatVersion = (int)Number(root, "version", 1, 5);
            var book = new PredictionBook(Number(root, "balance", 0, Odds.MaximumBalance));
            var markets = Array(root, "markets", 0, 12);
            for (int n = 0; n < markets.Count; n++)
            {
                var row = ObjectAt(markets, n);
                string id = Json.GetString(row, "id", "");
                if (id.Length < 1 || id.Length > 256 || book.Find(id) != null) throw new FormatException("对局ID无效或重复");
                var source = Array(row, "players", 8, 8);
                var players = new Player[8];
                var ratings = new Rating[8];
                for (int i = 0; i < 8; i++)
                {
                    var p = ObjectAt(source, i);
                    players[i] = new Player(Json.GetString(p, "uid", ""), Json.GetString(p, "name", ""), Json.GetBool(p, "ai", false));
                    if (players[i].Uid.Length < 1 || players[i].Uid.Length > 128) throw new FormatException("玩家UID无效");
                    for (int j = 0; j < i; j++) if (players[i].Uid == players[j].Uid) throw new FormatException("玩家UID重复");
                    ratings[i] = new Rating(Json.GetNumber(p, "elo", double.NaN), Json.GetNumber(p, "sigma", double.NaN), Json.GetBool(p, "found", false));
                }
                var rawRates = Array(row, "rates", 64, 64);
                var rates = new int[64];
                for (int i = 0; i < 64; i++) rates[i] = ArrayNumber(rawRates, i, 10100, Odds.MaximumRateBps);
                int rules = formatVersion == 1 ? Odds.ExactOnlyRuleVersion : (int)Number(row, "rules", Odds.ExactOnlyRuleVersion, formatVersion == 2 ? Odds.AdjacentRuleVersion : Odds.CurrentRuleVersion);
                var market = new Market(id, players, ratings, rates, rules);
                market.HighestRound = (int)Number(row, "round", 1, 100000);
                market.Locked = Json.GetBool(row, "locked", false);
                market.Settled = Json.GetBool(row, "settled", false);
                market.Abandoned = Json.GetBool(row, "abandoned", false);
                if (market.Abandoned && (!market.Locked || market.Settled)) throw new FormatException("离场放弃状态损坏");
                market.TotalPayout = Number(row, "payout", 0, Odds.MaximumBalance);
                if (formatVersion >= 4)
                {
                    var life = Array(row, "life", 8, 8);
                    for (int i = 0; i < 8; i++)
                    {
                        var points = life[i] as List<object>;
                        if (points == null || points.Count > LifeHistory.MaximumSamples * 2 || points.Count % 2 != 0) throw new FormatException("命元走势存档无效");
                        int previousRound = 0;
                        for (int pIndex = 0; pIndex < points.Count; pIndex += 2)
                        {
                            int round = ArrayNumber(points, pIndex, 1, market.HighestRound);
                            int value = ArrayNumber(points, pIndex + 1, -100000, 100000);
                            if (round <= previousRound) throw new FormatException("命元走势回合乱序");
                            market.Life[i].Record(round, value); previousRound = round;
                        }
                    }
                }
                if (formatVersion >= 5)
                {
                    var swaps = Array(row, "swaps", 8, 8);
                    for (int i = 0; i < 8; i++)
                    {
                        var points = swaps[i] as List<object>;
                        if (points == null || points.Count > LifeHistory.MaximumSamples * 2 || points.Count % 2 != 0) throw new FormatException("换牌次数走势存档无效");
                        int previousRound = 0;
                        for (int pIndex = 0; pIndex < points.Count; pIndex += 2)
                        {
                            int round = ArrayNumber(points, pIndex, 1, market.HighestRound);
                            int remaining = ArrayNumber(points, pIndex + 1, 0, 100000);
                            if (round <= previousRound) throw new FormatException("换牌次数走势回合乱序");
                            market.Swaps[i].Record(round, remaining); previousRound = round;
                        }
                    }
                }
                if (!market.IsTrading && market.HighestRound > 5 && !market.Locked) throw new FormatException("封盘状态损坏");
                var tickets = Array(row, "tickets", 0, market.IsTrading ? 0 : 8);
                for (int i = 0; i < tickets.Count; i++)
                {
                    var t = ObjectAt(tickets, i);
                    int index = (int)Number(t, "player", 0, 7);
                    int rank = (int)Number(t, "rank", 1, 8);
                    int round = (int)Number(t, "round", 1, 5);
                    long stake = Number(t, "stake", 1, Odds.MaximumStake);
                    int rate = (int)Number(t, "rate", 10100, Odds.MaximumRateBps);
                    if (market.Tickets[index] != null || round > market.HighestRound || rate != Odds.EffectiveRate(rates[index * 8 + rank - 1], round)) throw new FormatException("投注记录损坏");
                    market.Tickets[index] = new Ticket(index, rank, round, stake, rate);
                }
                if (market.IsTrading) ReadTrading(market, Json.GetObject(row, "trading"));
                var ranks = Array(row, "ranks", market.Settled ? 8 : 0, market.Settled ? 8 : 0);
                if (market.Settled)
                {
                    if (!market.Locked) throw new FormatException("结算状态损坏");
                    market.FinalRanks = new int[8];
                    var seen = new bool[9];
                    long payout = 0;
                    for (int i = 0; i < 8; i++)
                    {
                        int rank = ArrayNumber(ranks, i, 1, 8);
                        if (seen[rank]) throw new FormatException("最终名次重复");
                        seen[rank] = true;
                        market.FinalRanks[i] = rank;
                        if (market.IsTrading && rank != market.KnownRanks[i] && (market.RankMinimum[i] == 0 || rank < market.RankMinimum[i] || rank > market.RankMaximum[i])) throw new FormatException("最终名次与逐人结算不符");
                        Ticket ticket = market.Tickets[i];
                        if (ticket != null) payout += ticket.ReturnFor(rank, market.RuleVersion);
                    }
                    if (!market.IsTrading && payout != market.TotalPayout) throw new FormatException("结算总额损坏");
                }
                else if (!market.IsTrading && market.TotalPayout != 0) throw new FormatException("未结算盘口存在派奖记录");
                book.Markets.Add(market);
            }
            return book;
        }
    }
}
