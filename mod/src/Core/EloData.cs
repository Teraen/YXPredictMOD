using System;
using System.Collections.Generic;
using Yx.Shared;

namespace YxPrediction
{
    public static class EloData
    {
        public const string BaseUrl = "https://162.211.181.181/data/elo/p/";
        public const string FallbackBaseUrl = "https://raymondwrw.github.io/yxp-card-stats/data/elo/p/";
        public static bool IsPublicUid(string uid)
        {
            if (uid == null || uid.Length != 24) return false;
            for (int i = 0; i < uid.Length; i++)
                if (!((uid[i] >= '0' && uid[i] <= '9') || (uid[i] >= 'a' && uid[i] <= 'f'))) return false;
            return true;
        }
        public static string Url(string uid, bool fallback = false)
        {
            if (!IsPublicUid(uid)) throw new ArgumentException("玩家UID无效");
            return (fallback ? FallbackBaseUrl : BaseUrl) + uid.Substring(uid.Length - 2) + ".json";
        }
        public static Rating ReadPlayer(Dictionary<string, object> shard, string uid)
        {
            var row = Json.GetObject(shard, uid);
            if (row == null) return Rating.Unknown();
            return new Rating(Json.GetNumber(row, "rating", double.NaN), Json.GetNumber(row, "sigma", double.NaN), true);
        }
    }
}
