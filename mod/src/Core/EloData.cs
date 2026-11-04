using System;
using System.Collections.Generic;
using Yx.Shared;

namespace YxPrediction
{
    public static class EloData
    {
        public const string BaseUrl = "https://elo.kaigua.vip/data/elo/p/";
        public const string FallbackBaseUrl = "https://raymondwrw.github.io/yxp-card-stats/data/elo/p/";
        public const string ApiUrl = "https://elo.kaigua.vip/api/v1/ratings";
        public static string BatchUrl(string[] uids)
        {
            if (uids == null || uids.Length < 1 || uids.Length > 8) throw new ArgumentException("需要1至8个玩家UID");
            string url = ApiUrl;
            for (int i = 0; i < uids.Length; i++)
            {
                if (!IsPublicUid(uids[i])) throw new ArgumentException("玩家UID无效");
                url = url + (i == 0 ? "?uid=" : "&uid=") + uids[i];
            }
            return url;
        }
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
