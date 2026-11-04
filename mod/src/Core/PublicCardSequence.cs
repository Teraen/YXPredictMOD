using System.Collections;

namespace YxPrediction
{
    public static class PublicCardSequence
    {
        // Read an existing native collection through its non-generic CLR boundary.
        // This never constructs or instantiates a CLR List<int> in the hot domain.
        public static int[] Copy(object value)
        {
            IList cards = value as IList;
            if (cards == null || cards.Count > 8) return null;
            var result = new int[cards.Count];
            for (int i = 0; i < cards.Count; i++)
            {
                object raw = cards[i];
                if (!(raw is int) || (int)raw < 0) return null;
                result[i] = (int)raw;
            }
            return result;
        }
    }
}
