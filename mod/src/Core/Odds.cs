using System;

namespace YxPrediction
{
    public static class Odds
    {
        // 产品参数，尚未经历史观战预测回测；不是榜单网站提供的赔率。
        public const double Temperature = 600.0;
        public const double ReturnRate = 0.90;
        public const int MaximumRateBps = 500000;
        public const long MaximumStake = 10000;
        public const long MaximumBalance = 1000000000000;
        public const int ExactOnlyRuleVersion = 1;
        public const int AdjacentRuleVersion = 2;
        public const int TradingRuleVersion = 3;
        public const int ChampionRuleVersion = 4;
        public const int CurrentRuleVersion = ChampionRuleVersion;

        public static bool SupportsRule(int version)
        {
            return version >= ExactOnlyRuleVersion && version <= ChampionRuleVersion;
        }

        // 子集动态规划：到达某个已排名玩家集合的概率，再分配下一名。
        public static double[] Probabilities(Rating[] ratings)
        {
            if (ratings == null || ratings.Length != 8) throw new ArgumentException("需要八名玩家的Elo");
            double max = 0;
            for (int i = 0; i < 8; i++)
            {
                if (ratings[i] == null) throw new ArgumentException("Elo缺失");
                if (ratings[i].Score > max) max = ratings[i].Score;
            }
            var weights = new double[8];
            for (int i = 0; i < 8; i++) weights[i] = Math.Exp(Math.Max(-12.0, (ratings[i].Score - max) / Temperature));
            var reached = new double[256];
            // 热更运行时仅使用一维原生数组；下标为 玩家*8+名次。
            var answer = new double[64];
            reached[0] = 1.0;
            for (int mask = 0; mask < 255; mask++)
            {
                int rank = 0;
                double remaining = 0;
                for (int i = 0; i < 8; i++)
                {
                    if ((mask & (1 << i)) != 0) rank++;
                    else remaining += weights[i];
                }
                for (int i = 0; i < 8; i++)
                {
                    if ((mask & (1 << i)) != 0) continue;
                    double p = reached[mask] * weights[i] / remaining;
                    answer[i * 8 + rank] += p;
                    reached[mask | (1 << i)] += p;
                }
            }
            return answer;
        }

        public static int[] Rates(Rating[] ratings, int ruleVersion = CurrentRuleVersion)
        {
            if (!SupportsRule(ruleVersion)) throw new ArgumentException("不支持的结算规则");
            double[] p = Probabilities(ratings);
            var rates = new int[64];
            for (int i = 0; i < 8; i++)
                for (int r = 0; r < 8; r++)
                {
                    double weightedProbability = p[i * 8 + r];
                    if (ruleVersion >= AdjacentRuleVersion)
                    {
                        if (r > 0) weightedProbability += p[i * 8 + r - 1] * 0.25;
                        if (r < 7) weightedProbability += p[i * 8 + r + 1] * 0.25;
                    }
                    rates[i * 8 + r] = (int)Math.Floor(Math.Min(50.0, Math.Max(1.01, ReturnRate / weightedProbability)) * 10000.0 + 0.000001);
                }
            return rates;
        }

        public static int BonusBps(int round)
        {
            if (round < 1 || round > 5) return 0;
            return (5 - round) * 200;
        }

        public static int EffectiveRate(int baseRate, int round)
        {
            if (round < 1 || round > 5) throw new ArgumentOutOfRangeException("round");
            long rate = 10000L + (baseRate - 10000L) * (10000L + BonusBps(round)) / 10000L;
            return (int)Math.Min(MaximumRateBps, rate);
        }
    }
}
