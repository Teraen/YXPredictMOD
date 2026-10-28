using System;

namespace YxPrediction
{
    // Payout intervals are separate from the game's eventual ordering within a cohort.
    public sealed class EliminationPlan
    {
        public readonly int[] Ranks = new int[8], Minimum = new int[8], Maximum = new int[8], Rounds = new int[8];
        public static EliminationPlan Build(int[] incoming, int[] observedRounds, bool[] dead, int[] priorRanks, int[] priorMin, int[] priorMax, int[] priorRounds)
        {
            var p = new EliminationPlan(); int alive = 0;
            for (int i = 0; i < 8; i++)
            {
                if (!dead[i]) alive++;
                if (!dead[i] && (incoming[i] > 0 || priorRanks[i] > 0 || observedRounds[i] > 0)) throw new ArgumentException("存活状态与出局记录冲突");
                if (incoming[i] < 0 || incoming[i] > 8 || observedRounds[i] < 0 || observedRounds[i] > 100000) throw new ArgumentException("出局信息无效");
                if (priorRounds[i] > 0 && observedRounds[i] > 0 && priorRounds[i] != observedRounds[i]) throw new ArgumentException("出局轮次冲突");
                // A pre-upgrade paid singleton has no recorded cohort round. Keep its contract frozen.
                p.Rounds[i] = priorRanks[i] > 0 && priorRounds[i] == 0 ? 0 : priorRounds[i] > 0 ? priorRounds[i] : observedRounds[i];
                if (dead[i] && p.Rounds[i] == 0 && incoming[i] > 0) p.Minimum[i] = p.Maximum[i] = incoming[i];
                if (priorRanks[i] > 0)
                {
                    p.Minimum[i] = priorMin[i] > 0 ? priorMin[i] : priorRanks[i];
                    p.Maximum[i] = priorMax[i] > 0 ? priorMax[i] : priorRanks[i];
                    if (incoming[i] > 0 && (incoming[i] < p.Minimum[i] || incoming[i] > p.Maximum[i])) throw new ArgumentException("已结算名次区间冲突");
                }
            }
            for (int i = 0; i < 8; i++)
            {
                int round = p.Rounds[i]; if (!dead[i] || round == 0) continue;
                bool done = false; for (int j = 0; j < i; j++) if (p.Rounds[j] == round) done = true;
                if (done) continue;
                int count = 0, earlier = 0, later = 0;
                for (int j = 0; j < 8; j++) if (dead[j])
                {
                    if (p.Rounds[j] == round) count++;
                    else if (p.Rounds[j] > round) later++;
                    else if (p.Rounds[j] > 0) earlier++;
                }
                int chosen = 0, choices = 0;
                for (int low = alive + 1 + later; low + count - 1 <= 8 - earlier; low++)
                {
                    int high = low + count - 1; bool valid = true;
                    for (int j = 0; j < 8; j++) if (dead[j])
                    {
                        bool member = p.Rounds[j] == round;
                        if (member)
                        {
                            if (incoming[j] > 0 && (incoming[j] < low || incoming[j] > high)) valid = false;
                            if (priorRanks[j] > 0 && (p.Minimum[j] != low || p.Maximum[j] != high)) valid = false;
                        }
                        else
                        {
                            if (incoming[j] >= low && incoming[j] <= high) valid = false;
                            if (p.Rounds[j] > 0 && incoming[j] > 0 && (p.Rounds[j] < round ? incoming[j] <= high : incoming[j] >= low)) valid = false;
                            if (priorRanks[j] > 0 && p.Minimum[j] <= high && p.Maximum[j] >= low) valid = false;
                        }
                    }
                    if (valid) { chosen = low; choices++; }
                }
                if (choices != 1) throw new ArgumentException("等待完整同轮出局名单");
                for (int j = 0; j < 8; j++) if (p.Rounds[j] == round) { p.Minimum[j] = chosen; p.Maximum[j] = chosen + count - 1; }
            }
            var used = new bool[9];
            for (int i = 0; i < 8; i++) if (priorRanks[i] > 0) { p.Ranks[i] = priorRanks[i]; used[p.Ranks[i]] = true; }
            for (int i = 0; i < 8; i++) if (p.Ranks[i] == 0 && p.Minimum[i] > 0)
            {
                int rank = incoming[i];
                if (rank < p.Minimum[i] || rank > p.Maximum[i] || used[rank])
                { rank = p.Minimum[i]; while (rank <= p.Maximum[i] && used[rank]) rank++; }
                if (rank > p.Maximum[i]) throw new ArgumentException("出局名次区间冲突");
                p.Ranks[i] = rank; used[rank] = true;
            }
            int known = 0; for (int i = 0; i < 8; i++) if (p.Ranks[i] > 0) known++;
            for (int i = 0; i < 8; i++) if (p.Ranks[i] > 0 && p.Ranks[i] <= 8 - known) throw new ArgumentException("出局名次尚未对齐");
            return p;
        }
        public static long Return(long claim, int predicted, int minimum, int maximum)
        {
            if (predicted == 0 || minimum == 0) return 0;
            if (minimum != maximum) return predicted >= minimum && predicted <= maximum ? claim : 0;
            return predicted == minimum ? claim : Math.Abs(predicted - minimum) == 1 ? claim / 4 : 0;
        }
    }
}
