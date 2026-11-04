using System;

namespace YxPrediction
{
    public static class HorseShuffle
    {
        // Version 1: a stable two/three-player cycle, keyed by game and sorted UID.
        // AI decoration stays independent; real names, UIDs and battle states never move.
        public static int[] Sources(string matchId, Player[] players)
        {
            if (players == null || players.Length != 8) throw new ArgumentException("需要八人名单");
            var result = new int[8]; var humans = new int[8]; int count = 0;
            for (int i = 0; i < 8; i++) { result[i] = i; if (!players[i].IsAi) humans[count++] = i; }
            for (int i = 1; i < count; i++)
            {
                int item = humans[i], at = i - 1;
                while (at >= 0 && string.CompareOrdinal(players[humans[at]].Uid, players[item].Uid) > 0) { humans[at + 1] = humans[at]; at--; }
                humans[at + 1] = item;
            }
            if (count < 2) return result;
            long seed = 17; string key = (matchId ?? "") + ":horse-shuffle-v1";
            for (int i = 0; i < key.Length; i++) seed = (seed * 131 + key[i]) % 2147483647;
            for (int i = 0; i < count; i++)
                for (int j = 0; j < players[humans[i]].Uid.Length; j++) seed = (seed * 131 + players[humans[i]].Uid[j]) % 2147483647;
            seed = (seed * 48271 + 1) % 2147483647;
            int chosen = Math.Min(count, 2 + (int)(seed % 2));
            for (int i = count - 1; i > 0; i--)
            {
                seed = (seed * 48271 + 1) % 2147483647; int at = (int)(seed % (i + 1));
                int item = humans[i]; humans[i] = humans[at]; humans[at] = item;
            }
            for (int i = 0; i < chosen; i++) result[humans[i]] = humans[(i + 1) % chosen];
            return result;
        }
        public static Rating[] Ratings(string id, Player[] players, Rating[] original, bool enabled)
        {
            if (!enabled) return original;
            int[] sources = Sources(id, players); var result = new Rating[8];
            for (int i = 0; i < 8; i++) result[i] = original[sources[i]];
            return result;
        }
        public static Rating[] Ratings(Market market) { return Ratings(market.Id, market.Players, market.Ratings, market.UseHorseShuffle); }
        public static string[] Titles(Market market)
        {
            var snapshot = new MatchSnapshot { Id = market.Id, Round = Math.Max(1, market.HighestRound), Players = market.Players, ShuffleHorses = market.UseHorseShuffle };
            var profiles = new HorseProfile[8]; for (int i = 0; i < 8; i++) profiles[i] = new HorseProfile(market.Ratings[i]);
            var roster = new HorseRoster(); roster.Observe(snapshot, profiles);
            var titles = new string[8]; for (int i = 0; i < 8; i++) titles[i] = roster.Find(market.Players[i].Uid).Title;
            return titles;
        }
    }
}
