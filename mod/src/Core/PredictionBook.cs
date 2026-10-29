using System;
using System.Collections.Generic;

namespace YxPrediction
{
    public sealed class PredictionBook
    {
        public const int TradingClosingRound = 10;
        public const long ReliefThreshold = 10;
        public const long ReliefAmount = 50;
        public const int BettingCloseRound = 10;
        public long Balance;
        public readonly List<Market> Markets = new List<Market>();
        public int Revision;

        public PredictionBook(long initialPoints)
        {
            if (initialPoints < 0 || initialPoints > Odds.MaximumBalance) throw new ArgumentOutOfRangeException("initialPoints");
            Balance = initialPoints;
        }

        public bool CanGrantBankruptcyRelief
        {
            get
            {
                if (Balance < 0 || Balance >= ReliefThreshold) return false;
                // Check the whole wallet, including games no longer being observed.
                for (int n = 0; n < Markets.Count; n++)
                {
                    Market market = Markets[n];
                    if (market.Settled || market.Abandoned) continue;
                    for (int i = 0; i < 8; i++)
                    {
                        if (!market.IsTrading && market.Tickets[i] != null) return false;
                        Position position = market.Positions[i];
                        if (market.IsTrading && !position.Resolved && position.Claim > 0) return false;
                    }
                }
                return true;
            }
        }

        public bool GrantBankruptcyRelief()
        {
            if (!CanGrantBankruptcyRelief) return false;
            Balance += ReliefAmount;
            Revision++;
            return true;
        }

        public static bool HasPendingBets(Market market)
        {
            if (market.Settled || market.Abandoned) return false;
            for (int i = 0; i < 8; i++)
                if (market.IsTrading ? !market.Positions[i].Resolved && market.Positions[i].Claim > 0 : market.Tickets[i] != null) return true;
            return false;
        }

        public int AbandonExcept(string activeId)
        {
            int count = 0;
            for (int n = 0; n < Markets.Count; n++)
            {
                Market market = Markets[n];
                if (market.Id == activeId || !HasPendingBets(market)) continue;
                market.Abandoned = true; market.Locked = true; market.TradingWindowOpen = false;
                market.TradingWaitReason = "离场已放弃未结算投注，不退本金、不再返奖";
                Revision++; count++;
            }
            return count;
        }

        public Market Find(string id)
        {
            for (int i = 0; i < Markets.Count; i++) if (Markets[i].Id == id) return Markets[i];
            return null;
        }

        public static bool HasFinancialHistory(Market market)
        {
            if (market.TotalPayout != 0) return true;
            for (int i = 0; i < 8; i++)
            {
                if (market.Tickets[i] != null) return true;
                Position position = market.Positions[i];
                if (position == null || position.Rank != 0 || position.Claim != 0 || position.Cost != 0
                    || position.Invested != 0 || position.CashReturned != 0 || position.FinalPayout != 0 || position.Actions != 0) return true;
            }
            return false;
        }

        public bool HasNewMarketCapacity
        {
            get
            {
                if (Markets.Count < 12) return true;
                for (int i = 0; i < Markets.Count; i++) if (Markets[i].Settled || Markets[i].Abandoned || !HasFinancialHistory(Markets[i])) return true;
                return false;
            }
        }

        public Market Observe(MatchSnapshot snapshot, Rating[] ratings)
        {
            if (snapshot == null || !snapshot.IsEightPlayerMatch()) return null;
            Market market = Find(snapshot.Id);
            if (market == null)
            {
                if (!snapshot.LiveObserver || ratings == null || ratings.Length != 8) return null;
                // 保留未结束的盘口，切换观战、断线和重载不退回本金。
                if (Markets.Count >= 12)
                {
                    int removable = -1;
                    for (int i = 0; i < Markets.Count; i++) if (Markets[i].Settled || Markets[i].Abandoned) { removable = i; break; }
                    // Never drop invested/previously sold/partially paid markets. Merely
                    // observing another game must not exhaust the accounting capacity.
                    if (removable < 0)
                        for (int i = 0; i < Markets.Count; i++) if (!HasFinancialHistory(Markets[i])) { removable = i; break; }
                    if (removable < 0) return null;
                    Markets.RemoveAt(removable);
                }
                market = new Market(snapshot.Id, snapshot.Players, ratings, Odds.Rates(ratings));
                Markets.Add(market);
                Revision++;
            }
            // 同一局必须始终是同一组UID；不依赖列表顺序。
            for (int i = 0; i < 8; i++) if (market.FindPlayer(snapshot.Players[i].Uid) < 0) return null;
            if (market.Abandoned) { market.TradingWaitReason = "离场已放弃未结算投注，不退本金、不再返奖"; return market; }
            if (!market.Settled && snapshot.Round >= market.HighestRound && snapshot.RemainingSwaps != null && snapshot.RemainingSwaps.Length == 8)
            {
                for (int i = 0; i < 8; i++)
                {
                    int count = snapshot.RemainingSwaps[i];
                    if (count >= 0 && count <= 100000 && market.Swaps[market.FindPlayer(snapshot.Players[i].Uid)].Record(snapshot.Round, count)) Revision++;
                }
            }
            if (!market.Settled && snapshot.Round >= market.HighestRound && snapshot.States != null && snapshot.States.Length == 8)
            {
                bool complete = true;
                for (int i = 0; i < 8; i++) if (snapshot.States[i] == null) complete = false;
                if (complete)
                    for (int i = 0; i < 8; i++)
                        if (market.Life[market.FindPlayer(snapshot.Players[i].Uid)].Record(snapshot.Round, snapshot.States[i].Life)) Revision++;
            }
            if (market.IsTrading) { ObserveTrading(market, snapshot); return market; }
            if (snapshot.Round > market.HighestRound) { market.HighestRound = snapshot.Round; Revision++; }
            if (!market.Locked && (snapshot.Round > 5 || snapshot.FifthRoundEnded || snapshot.Ended))
            {
                market.Locked = true; Revision++;
            }
            if (snapshot.Ended) TrySettle(market, snapshot);
            return market;
        }

        public string Bet(MatchSnapshot snapshot, string uid, int rank, long stake)
        {
            if (snapshot == null || !snapshot.LiveObserver || !snapshot.IsEightPlayerMatch()) return "仅限正在观战的八人实时对局";
            Market market = Find(snapshot.Id);
            if (market == null) return "赔率尚未准备好";
            if (Observe(snapshot, null) == null) return "本局玩家信息不一致，请稍后重试";
            if (market.IsTrading) return Buy(snapshot, uid, rank, stake, market.TradeVersion);
            if (market.Locked || market.Settled || snapshot.Ended || snapshot.FifthRoundEnded || snapshot.Round > 5) return "已封盘，不能再下注";
            // 抵御状态倒退：旧回合不能重新获得早猜加成。
            if (snapshot.Round != market.HighestRound) return "对局状态正在同步，请稍后重试";
            int index = market.FindPlayer(uid);
            if (index < 0) return "该玩家不在本局";
            if (snapshot.States != null) for (int i = 0; i < snapshot.Players.Length; i++)
                if (snapshot.Players[i].Uid == uid && (i >= snapshot.States.Length || snapshot.States[i] == null || snapshot.States[i].Life <= 0)) return "该玩家已淘汰或退出，不能下注";
            if (market.Tickets[index] != null) return "该玩家已下注，不能修改或重复下注";
            if (rank < 1 || rank > 8) return "请选择1至8名";
            if (stake < 1 || stake > Odds.MaximumStake) return "本金须为1至10000的整数马币";
            if (stake > Balance) return "马币不足";
            int rate = Odds.EffectiveRate(market.BaseRates[index * 8 + rank - 1], snapshot.Round);
            var ticket = new Ticket(index, rank, snapshot.Round, stake, rate);
            Balance -= stake;
            market.Tickets[index] = ticket;
            Revision++;
            return null;
        }

        static int[] FinalRanks(Market market, MatchSnapshot snapshot)
        {
            if (!snapshot.Ended || snapshot.Ranks == null || snapshot.Ranks.Length != 8) return null;
            var ranks = new int[8]; var seen = new bool[9];
            for (int i = 0; i < 8; i++)
            {
                int rank = snapshot.Ranks[i];
                if (rank < 1 || rank > 8 || seen[rank]) return null;
                seen[rank] = true; ranks[market.FindPlayer(snapshot.Players[i].Uid)] = rank;
            }
            return ranks;
        }

        void TradingChange(Market market)
        {
            if (market.TradeVersion >= 2000000000) throw new InvalidOperationException("本局状态版本已达上限");
            market.TradeVersion++; Revision++;
        }

        void ObserveTrading(Market market, MatchSnapshot snapshot)
        {
            market.TradingWindowOpen = false;
            market.TradingWaitReason = "等待完整修炼阶段状态";
            if (market.Settled) return;
            if (snapshot.Round < market.HighestRound) { market.TradingWaitReason = "对局状态正在同步"; return; }
            if (snapshot.Round > market.HighestRound) { market.HighestRound = snapshot.Round; Revision++; }
            if (snapshot.ResultsThroughRound > market.ClosedThroughRound)
            { market.ClosedThroughRound = snapshot.ResultsThroughRound; TradingChange(market); }
            if (!market.Locked && (market.HighestRound >= BettingCloseRound || market.ClosedThroughRound >= TradingClosingRound))
            { market.Locked = true; TradingChange(market); }
            int[] final = FinalRanks(market, snapshot);
            PlayerState[] states = null;
            if (snapshot.States != null && snapshot.States.Length == 8)
            {
                states = new PlayerState[8];
                for (int i = 0; i < 8; i++)
                {
                    if (snapshot.States[i] == null) { states = null; break; }
                    states[market.FindPlayer(snapshot.Players[i].Uid)] = snapshot.States[i];
                }
            }
            bool grouped = snapshot.EliminationRounds != null && snapshot.EliminationRounds.Length == 8;
            for (int i = 0; i < 8; i++) if (market.EliminationRounds[i] > 0) grouped = true;
            EliminationPlan plan = null;
            int[] known;
            if (grouped)
            {
                if (!snapshot.Ended && !snapshot.TradingOpen && !snapshot.RoundResultsComplete)
                { market.TradingWaitReason = "等待本轮完整战果，防止把同出拆为单人结算"; return; }
                var incoming = new int[8]; var rounds = new int[8]; var dead = new bool[8];
                for (int i = 0; i < 8; i++)
                {
                    int at = market.FindPlayer(snapshot.Players[i].Uid);
                    incoming[at] = final != null ? final[at] : states != null && states[at].Life <= 0 ? states[at].FinalRank : 0;
                    dead[at] = final != null || (states != null && states[at].Life <= 0) || market.KnownRanks[at] > 0;
                    rounds[at] = snapshot.EliminationRounds == null ? 0 : snapshot.EliminationRounds[i];
                }
                try { plan = EliminationPlan.Build(incoming, rounds, dead, market.KnownRanks, market.RankMinimum, market.RankMaximum, market.EliminationRounds); }
                catch (ArgumentException ex) { market.TradingWaitReason = ex.Message; return; }
                known = plan.Ranks;
                if (states != null)
                    for (int i = 0; i < 8; i++) if (dead[i] && known[i] > 0) states[i] = new PlayerState(states[i].Life, states[i].Wins, states[i].Losses, known[i]);
            }
            else
            {
                known = new int[8]; var seen = new bool[9];
                if (final == null && states != null)
                {
                    int alive = 0;
                    for (int i = 0; i < 8; i++) if (states[i].Life > 0) alive++;
                    for (int i = 0; i < 8; i++)
                        if ((states[i].Life > 0 && states[i].FinalRank != 0)
                            || (states[i].Life <= 0 && states[i].FinalRank > 0 && states[i].FinalRank <= alive))
                        { market.TradingWaitReason = "确定名次与存活人数尚未对齐"; return; }
                }
                for (int i = 0; i < 8; i++)
                {
                    int rank = final != null ? final[i] : (states != null && states[i].Life <= 0 ? states[i].FinalRank : 0);
                    if (rank == 0) rank = market.KnownRanks[i];
                    if ((market.KnownRanks[i] > 0 && rank != market.KnownRanks[i]) || (rank > 0 && seen[rank])
                        || (final == null && market.KnownRanks[i] > 0 && states != null && states[i].Life > 0))
                    { market.TradingWaitReason = "淘汰名次正在同步"; return; }
                    known[i] = rank; if (rank > 0) seen[rank] = true;
                }
                int confirmed = 0;
                for (int i = 0; i < 8; i++) if (known[i] > 0) confirmed++;
                if (final == null)
                    for (int i = 0; i < 8; i++) if (known[i] > 0 && known[i] <= 8 - confirmed)
                    { market.TradingWaitReason = "淘汰名次尚未对齐，等待同轮完整结果"; return; }
            }
            // 先验证整批，再逐人结算；部分淘汰可以提前入账，最终结果不重复派奖。
            long payment = 0;
            for (int i = 0; i < 8; i++) if (known[i] > 0 && !market.Positions[i].Resolved) payment += plan == null ? market.ReturnFor(i, known[i]) : market.ChampionOnly ? EliminationPlan.ChampionReturn(market.Positions[i].Claim, plan.Minimum[i], plan.Maximum[i]) : EliminationPlan.Return(market.Positions[i].Claim, market.Positions[i].Rank, plan.Minimum[i], plan.Maximum[i]);
            if (payment > Odds.MaximumBalance - Balance) throw new InvalidOperationException("积分余额超过上限，保留待结算");
            if (plan != null)
                for (int i = 0; i < 8; i++)
                {
                    if (market.EliminationRounds[i] != plan.Rounds[i] || market.RankMinimum[i] != plan.Minimum[i] || market.RankMaximum[i] != plan.Maximum[i])
                    { market.EliminationRounds[i] = plan.Rounds[i]; market.RankMinimum[i] = plan.Minimum[i]; market.RankMaximum[i] = plan.Maximum[i]; TradingChange(market); }
                }
            for (int i = 0; i < 8; i++)
            {
                if (known[i] == 0 || market.Positions[i].Resolved) continue;
                Position position = market.Positions[i];
                market.KnownRanks[i] = known[i]; position.FinalPayout = market.ReturnFor(i, known[i]); position.Resolved = true;
                TradingChange(market);
            }
            Balance += payment; market.TotalPayout += payment;
            if (snapshot.Ended)
            {
                if (!market.Locked) { market.Locked = true; Revision++; }
                market.TradingWaitReason = "等待八人的完整最终名次";
                if (final != null) { market.FinalRanks = final; market.Settled = true; TradingChange(market); }
                return;
            }
            if (market.Locked)
            {
                market.TradingWaitReason = market.HighestRound >= BettingCloseRound || market.ClosedThroughRound >= TradingClosingRound
                    ? "第10回合起已封盘；已有投注继续结算" : "已收到整局结束信号，等待最终名次";
                return;
            }
            if (!snapshot.LiveObserver || !snapshot.TradingOpen || snapshot.Round <= market.ClosedThroughRound)
            { market.TradingWaitReason = "本轮交易暂停，等待下一轮修炼阶段"; return; }
            if (states == null) return;
            bool changed = market.QuoteRound != snapshot.Round || market.QuoteStates == null;
            for (int i = 0; i < 8; i++)
            {
                if (states[i].Life <= 0 && states[i].FinalRank == 0) { market.TradingWaitReason = "等待淘汰玩家的确定名次"; return; }
                if (market.QuoteStates == null || !states[i].Same(market.QuoteStates[i])) changed = true;
            }
            if (changed)
            {
                int[] rates;
                try { rates = TradingOdds.Rates(market.Ratings, states, snapshot.Round, market.ChampionOnly); }
                catch (ArgumentException ex) { market.TradingWaitReason = ex.Message; return; }
                market.QuoteStates = states; market.QuoteRates = rates; market.QuoteRound = snapshot.Round; TradingChange(market);
            }
            market.TradingWindowOpen = true; market.TradingWaitReason = null;
        }

        string TradingCheck(MatchSnapshot snapshot, string uid, int expectedVersion, out Market market, out int index)
        {
            market = null; index = -1;
            if (snapshot == null || !snapshot.IsEightPlayerMatch() || !snapshot.LiveObserver) return "仅限实时八人观战";
            market = Find(snapshot.Id);
            if (market == null || !market.IsTrading) return "此盘口采用旧版固定投注规则";
            if (Observe(snapshot, null) == null) return "本局玩家信息不一致";
            if (market.Abandoned) return "离场已放弃本局未结算投注，不能重新下注";
            if (market.Settled || market.Locked || snapshot.Ended) return "本局已封盘，不能再交易";
            if (!market.TradingWindowOpen || snapshot.Round != market.QuoteRound) return market.TradingWaitReason ?? "当前交易暂停";
            index = market.FindPlayer(uid);
            if (index < 0) return "该玩家不在本局";
            for (int i = 0; i < 8; i++) if (snapshot.Players[i].Uid == uid
                && (snapshot.States == null || snapshot.States[i] == null || snapshot.States[i].Life <= 0)) return "该玩家已淘汰或退出，不能交易";
            if (market.KnownRanks[index] > 0 || market.Positions[index].Resolved) return "该玩家名次已确定，不能交易";
            if (expectedVersion != market.TradeVersion) return "报价或持仓已更新，请查看新报价后再操作";
            if (market.Positions[index].Actions >= Position.MaximumActions) return "该玩家本局操作次数已达512次";
            return null;
        }

        public string Buy(MatchSnapshot snapshot, string uid, int rank, long stake, int expectedVersion)
        {
            Market market; int index;
            string error = TradingCheck(snapshot, uid, expectedVersion, out market, out index);
            if (error != null) return error;
            Position p = market.Positions[index];
            if (!TradingOdds.CanBuy(market, index, rank)) return "该名次已不可能达到，请选择仍可能的名次";
            if (p.Claim > 0 && p.Rank != rank) return "持仓名次不同，请使用换预测";
            if (stake < 1 || stake > Odds.MaximumStake || stake > Balance) return "本金须为1至10000整数马币且不能超过余额";
            long claim = stake * market.QuoteRates[index * 8 + rank - 1] / 10000;
            p.Rank = rank; p.Claim += claim; p.Cost += stake; p.Invested += stake; p.Actions++;
            Balance -= stake; TradingChange(market);
            return null;
        }

        public string Sell(MatchSnapshot snapshot, string uid, bool half, int expectedVersion)
        {
            Market market; int index;
            string error = TradingCheck(snapshot, uid, expectedVersion, out market, out index);
            if (error != null) return error;
            Position p = market.Positions[index];
            long removed = half ? p.Claim / 2 : p.Claim;
            if (removed <= 0) return half && p.Claim > 0 ? "剩余权益不足减半，请使用清仓" : "当前没有持仓";
            long returned = TradingOdds.Sale(market, index, half);
            if (returned > Odds.MaximumBalance - Balance) return "马币余额已达上限";
            long releasedCost = p.Cost * removed / p.Claim;
            p.Claim -= removed; p.Cost -= releasedCost; p.CashReturned += returned; p.Actions++;
            if (p.Claim == 0) { p.Rank = 0; p.Cost = 0; }
            Balance += returned; TradingChange(market);
            return null;
        }

        public string Switch(MatchSnapshot snapshot, string uid, int rank, long stake, int expectedVersion)
        {
            Market market; int index;
            string error = TradingCheck(snapshot, uid, expectedVersion, out market, out index);
            if (error != null) return error;
            Position p = market.Positions[index];
            if (p.Claim <= 0) return "当前没有持仓，请直接买入";
            if (p.Rank == rank) return "预测名次相同，请使用增持";
            if (!TradingOdds.CanBuy(market, index, rank)) return "该名次已不可能达到";
            long returned = TradingOdds.Sale(market, index, false);
            if (stake < 1 || stake > Odds.MaximumStake || stake > Balance + returned) return "换预测本金无效或余额不足（含出售所得）";
            if (returned - stake > Odds.MaximumBalance - Balance) return "马币余额已达上限";
            // 一次性完成，验证失败时不出售旧仓；新仓不继承旧名次的高赔率。
            long claim = stake * market.QuoteRates[index * 8 + rank - 1] / 10000;
            p.CashReturned += returned; p.Invested += stake; p.Cost = stake; p.Claim = claim; p.Rank = rank; p.Actions++;
            Balance += returned - stake; TradingChange(market);
            return null;
        }

        void TrySettle(Market market, MatchSnapshot snapshot)
        {
            if (market.Settled || snapshot.Ranks == null || snapshot.Ranks.Length != 8) return;
            var orderedRanks = new int[8];
            var seen = new bool[9];
            for (int i = 0; i < 8; i++)
            {
                int rank = snapshot.Ranks[i];
                if (rank < 1 || rank > 8 || seen[rank]) return;
                seen[rank] = true;
                orderedRanks[market.FindPlayer(snapshot.Players[i].Uid)] = rank;
            }
            long total = 0;
            for (int i = 0; i < 8; i++)
            {
                Ticket ticket = market.Tickets[i];
                if (ticket != null) total += ticket.ReturnFor(orderedRanks[i], market.RuleVersion);
            }
            if (total > Odds.MaximumBalance - Balance) throw new InvalidOperationException("马币余额超过存档上限，结算已保留等待处理");
            Balance += total;
            market.TotalPayout = total;
            market.FinalRanks = orderedRanks;
            market.Locked = true;
            market.Settled = true;
            Revision++;
        }
    }
}
