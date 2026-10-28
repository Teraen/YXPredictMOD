using System;

namespace YxPrediction
{
    public sealed class Player
    {
        public readonly string Uid;
        public readonly string Name;
        public readonly bool IsAi;
        public Player(string uid, string name, bool isAi)
        {
            Uid = uid; Name = name ?? ""; IsAi = isAi;
        }
    }

    public sealed class Rating
    {
        public readonly double Score;
        public readonly double Sigma;
        public readonly bool Found;
        public Rating(double score, double sigma, bool found)
        {
            if (double.IsNaN(score) || double.IsInfinity(score) || score < 0 || score > 10000) throw new ArgumentException("Elo分数无效");
            if (double.IsNaN(sigma) || double.IsInfinity(sigma) || sigma < 0 || sigma > 2000) throw new ArgumentException("Elo不确定度无效");
            Score = score; Sigma = sigma; Found = found;
        }
        public static Rating Unknown() { return new Rating(3000, 400, false); }
    }

    public sealed class MatchSnapshot
    {
        public string Id;
        public int Round;
        public bool LiveObserver;
        public bool Ended;
        public bool FifthRoundEnded;
        public Player[] Players;
        public int[] Ranks;
        public bool TradingOpen;
        public int ResultsThroughRound;
        public PlayerState[] States;
        public string FocusedUid;
        public int[] RemainingSwaps;
        public int[] EliminationRounds;
        public bool RoundResultsComplete;

        public bool IsEightPlayerMatch()
        {
            if (string.IsNullOrEmpty(Id) || Players == null || Players.Length != 8 || Round < 1 || Round > 100000
                || ResultsThroughRound < 0 || ResultsThroughRound > 100000) return false;
            for (int i = 0; i < 8; i++)
            {
                if (Players[i] == null || string.IsNullOrEmpty(Players[i].Uid)) return false;
                for (int j = 0; j < i; j++) if (Players[i].Uid == Players[j].Uid) return false;
            }
            return true;
        }
    }

    public sealed class Ticket
    {
        public readonly int PlayerIndex;
        public readonly int Rank;
        public readonly int Round;
        public readonly long Stake;
        public readonly int RateBps;
        public readonly long Payout;
        public long AdjacentPayout { get { return Payout / 4; } }
        public Ticket(int playerIndex, int rank, int round, long stake, int rateBps)
        {
            if (playerIndex < 0 || playerIndex > 7 || rank < 1 || rank > 8 || round < 1 || round > 5
                || stake < 1 || stake > Odds.MaximumStake || rateBps < 10100 || rateBps > Odds.MaximumRateBps) throw new ArgumentException("投注参数超出范围");
            PlayerIndex = playerIndex; Rank = rank; Round = round; Stake = stake; RateBps = rateBps;
            // 上述界限保证乘积不超过5,000,000,000；避免热更解释器不支持的mul.ovf。
            Payout = stake * rateBps / 10000;
        }

        public long ReturnFor(int finalRank, int ruleVersion)
        {
            if (finalRank < 1 || finalRank > 8 || !Odds.SupportsRule(ruleVersion)) throw new ArgumentException("名次或结算规则无效");
            int difference = Math.Abs(Rank - finalRank);
            if (difference == 0) return Payout;
            if (difference == 1 && ruleVersion >= Odds.AdjacentRuleVersion) return AdjacentPayout;
            return 0;
        }
    }

    public sealed class Market
    {
        public readonly string Id;
        public readonly Player[] Players;
        public readonly Rating[] Ratings;
        public readonly int[] BaseRates;
        public readonly int RuleVersion;
        public bool HasAdjacentReward { get { return RuleVersion >= Odds.AdjacentRuleVersion; } }
        public bool IsTrading { get { return RuleVersion == Odds.TradingRuleVersion; } }
        public readonly Ticket[] Tickets = new Ticket[8];
        public readonly Position[] Positions = new Position[8];
        public readonly int[] KnownRanks = new int[8];
        public readonly int[] RankMinimum = new int[8], RankMaximum = new int[8], EliminationRounds = new int[8];
        public long ReturnFor(int player, int rank)
        {
            return RankMinimum[player] > 0 ? EliminationPlan.Return(Positions[player].Claim, Positions[player].Rank, RankMinimum[player], RankMaximum[player])
                : Positions[player].ReturnFor(rank);
        }
        public readonly LifeHistory[] Life = new LifeHistory[8];
        public readonly SwapHistory[] Swaps = new SwapHistory[8];
        public PlayerState[] QuoteStates;
        public int[] QuoteRates = new int[64];
        public int QuoteRound;
        public int TradeVersion;
        public int ClosedThroughRound;
        // 窗口只由刚读取的游戏状态启用，不从存档恢复开放。
        public bool TradingWindowOpen;
        public string TradingWaitReason;
        public int HighestRound;
        public bool Locked;
        public bool Settled;
        public bool Abandoned;
        public int[] FinalRanks;
        public long TotalPayout;

        public Market(string id, Player[] players, Rating[] ratings, int[] rates, int ruleVersion = Odds.CurrentRuleVersion)
        {
            if (players == null || players.Length != 8 || ratings == null || ratings.Length != 8 || rates == null || rates.Length != 64) throw new ArgumentException("盘口快照维度无效");
            if (!Odds.SupportsRule(ruleVersion)) throw new ArgumentException("不支持的盘口规则");
            Id = id;
            RuleVersion = ruleVersion;
            Players = new Player[8];
            Ratings = new Rating[8];
            BaseRates = new int[64];
            for (int i = 0; i < 8; i++) { Players[i] = players[i]; Ratings[i] = ratings[i]; Positions[i] = new Position(); Life[i] = new LifeHistory(); Swaps[i] = new SwapHistory(); }
            for (int i = 0; i < 64; i++) BaseRates[i] = rates[i];
        }

        public int FindPlayer(string uid)
        {
            for (int i = 0; i < 8; i++) if (Players[i].Uid == uid) return i;
            return -1;
        }
    }
}
