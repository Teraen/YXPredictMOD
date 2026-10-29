using System;

namespace YxPrediction
{
    public sealed class PlayerState
    {
        public readonly int Life;
        public readonly int Wins;
        public readonly int Losses;
        public readonly int FinalRank;
        public PlayerState(int life, int wins, int losses, int finalRank)
        {
            if (life < -100000 || life > 100000 || wins < 0 || wins > 100000 || losses < 0 || losses > 100000 || finalRank < 0 || finalRank > 8)
                throw new ArgumentException("玩家局势数值无效");
            Life = life; Wins = wins; Losses = losses; FinalRank = finalRank;
        }
        public bool Same(PlayerState other)
        {
            return other != null && Life == other.Life && Wins == other.Wins && Losses == other.Losses && FinalRank == other.FinalRank;
        }
    }

    public sealed class Position
    {
        public const int MaximumActions = 512;
        public const long MaximumInvested = MaximumActions * Odds.MaximumStake;
        public const long MaximumClaim = MaximumInvested * 50;
        public int Rank;
        public long Claim;
        public long Cost;
        public long Invested;
        public long CashReturned;
        public long FinalPayout;
        public int Actions;
        public bool Resolved;
        public bool ChampionOnly;
        public long ReturnFor(int finalRank)
        {
            int difference = Math.Abs(Rank - finalRank);
            if (Rank == 0) return 0;
            if (ChampionOnly) return finalRank == 1 ? Claim : finalRank == 2 ? Claim / 4 : finalRank == 3 ? Claim / 10 : 0;
            return difference == 0 ? Claim : (difference == 1 ? Claim / 4 : 0);
        }
        public long NetResult { get { return CashReturned + FinalPayout - Invested; } }
    }

    public static class TradingOdds
    {
        public const int SellPercent = 97;

        // 固定已淘汰名次，仅对存活玩家做排名DP；公开基础状态供观众判断模型偏差。
        public static double[] Probabilities(Rating[] ratings, PlayerState[] states)
        {
            if (ratings == null || ratings.Length != 8 || states == null || states.Length != 8) throw new ArgumentException("缺少八人局势");
            int deadMask = 0, deadCount = 0, alive = 0;
            double lifeSum = 0;
            var seen = new bool[9];
            for (int i = 0; i < 8; i++)
            {
                if (ratings[i] == null || states[i] == null) throw new ArgumentException("局势尚未完整");
                if (states[i].Life <= 0)
                {
                    int rank = states[i].FinalRank;
                    if (rank < 1 || rank > 8 || seen[rank]) throw new ArgumentException("淘汰名次尚未完整");
                    seen[rank] = true; deadMask |= 1 << i; deadCount++;
                }
                else { alive++; lifeSum += states[i].Life; }
            }
            if (alive < 2) throw new ArgumentException("胜负已确定，等待最终结果");
            for (int rank = alive + 1; rank <= 8; rank++) if (!seen[rank]) throw new ArgumentException("淘汰名次尚未对齐");
            double meanLife = lifeSum / alive;
            var strength = new double[8];
            double maximum = double.MinValue;
            for (int i = 0; i < 8; i++)
            {
                if ((deadMask & (1 << i)) != 0) continue;
                strength[i] = ratings[i].Score + Math.Max(-800, Math.Min(800, (states[i].Life - meanLife) * 8.0))
                    + Math.Max(-350, Math.Min(350, (states[i].Wins - states[i].Losses) * 35.0));
                if (strength[i] > maximum) maximum = strength[i];
            }
            var weights = new double[8];
            var result = new double[64];
            for (int i = 0; i < 8; i++)
            {
                if ((deadMask & (1 << i)) == 0) weights[i] = Math.Exp(Math.Max(-12, (strength[i] - maximum) / Odds.Temperature));
                else result[i * 8 + states[i].FinalRank - 1] = 1;
            }
            var reached = new double[256];
            reached[deadMask] = 1;
            for (int mask = deadMask; mask < 255; mask++)
            {
                if ((mask & deadMask) != deadMask) continue;
                int count = 0;
                double remaining = 0;
                for (int i = 0; i < 8; i++) { if ((mask & (1 << i)) != 0) count++; else remaining += weights[i]; }
                int rank = count - deadCount;
                if (remaining <= 0) continue;
                for (int i = 0; i < 8; i++)
                {
                    if ((mask & (1 << i)) != 0) continue;
                    double p = reached[mask] * weights[i] / remaining;
                    result[i * 8 + rank] += p; reached[mask | (1 << i)] += p;
                }
            }
            return result;
        }

        public static int[] Rates(Rating[] ratings, PlayerState[] states, int round, bool championOnly = false)
        {
            double[] probabilities = Probabilities(ratings, states);
            var rates = new int[64];
            for (int i = 0; i < 8; i++) for (int r = 0; r < 8; r++)
            {
                double q = probabilities[i * 8 + r];
                if (championOnly && r == 0) q = probabilities[i * 8] + probabilities[i * 8 + 1] * 0.25 + probabilities[i * 8 + 2] * 0.10;
                else { if (r > 0) q += probabilities[i * 8 + r - 1] * 0.25; if (r < 7) q += probabilities[i * 8 + r + 1] * 0.25; }
                if (q <= 0) continue;
                int basis = (int)Math.Floor(Math.Max(1.01, Math.Min(50, Odds.ReturnRate / q)) * 10000 + 0.000001);
                rates[i * 8 + r] = Odds.EffectiveRate(basis, Math.Max(1, Math.Min(5, round)));
            }
            return rates;
        }

        public static bool CanBuy(Market market, int player, int rank)
        {
            if (market.QuoteStates == null || player < 0 || player > 7 || rank < 1 || rank > 8 || market.KnownRanks[player] > 0 || market.QuoteStates[player].Life <= 0) return false;
            if (market.ChampionOnly && rank != 1) return false;
            int alive = 0;
            for (int i = 0; i < 8; i++) if (market.QuoteStates[i].Life > 0) alive++;
            return alive >= 2 && rank <= alive && market.QuoteRates[player * 8 + rank - 1] > 0;
        }

        public static long Sale(Market market, int player, bool half)
        {
            Position position = market.Positions[player];
            if (position.Resolved || position.Claim <= 0 || position.Rank < 1) return 0;
            long claim = half ? position.Claim / 2 : position.Claim;
            int rate = market.QuoteRates[player * 8 + position.Rank - 1];
            // 0表示连相邻名次也已不可能；权益和乘积都有持仓上限，避免mul.ovf。
            return rate <= 0 ? 0 : claim * 10000 * SellPercent / (rate * 100L);
        }
    }
}
