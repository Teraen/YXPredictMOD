#if YX_GAME
using TMPro;
using UnityEngine;
using UnityEngine.UI;
using Yx.ModSdk;
using Yx.ModSdk.Unity;

namespace YxPrediction
{
    public sealed class ReliefPopup
    {
        readonly ReliefNotice _notice;
        readonly NativeTheme _theme;
        readonly UiKit _ui;
        GameObject _root;
        TextMeshProUGUI _message;

        public ReliefPopup(ModContext ctx, NativeTheme theme, ReliefNotice notice)
        { _notice = notice; _theme = theme; _ui = new UiKit(ctx); }

        void Build()
        {
            _root = _ui.Panel("BankruptcyReliefPopup", new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(520f, 200f), NativeTheme.LacquerBlack);
            if (_root == null) return;
            _theme.ApplyWindowFrame(_root.GetComponent<Image>());
            _theme.DecorateWindow(_root, "破产救济");
            var title = _ui.Label(_root.transform, "title", "破产救济", new Vector2(24f, -8f), new Vector2(472f, 36f), 24);
            _theme.ApplyTextStyle(title, 24, true, TextAlignmentOptions.Center);
            title.raycastTarget = false;
            _message = _ui.Label(_root.transform, "message", "", new Vector2(24f, -62f), new Vector2(472f, 48f), 24);
            _theme.ApplyTextStyle(_message, 24, false, TextAlignmentOptions.Center);
            _message.enableWordWrapping = true; _message.raycastTarget = false;
            _theme.CreateButtonTopLeft(_root.transform, "confirmRelief", "确认", 180f, -134f, 160f, 46f, NativePanelButtonStyle.Primary, Dismiss, 22);
            _root.SetActive(false);
        }
        public void Update()
        {
            double now = Time.unscaledTime;
            _notice.Update(now);
            if (_notice.PendingAmount > 0)
            {
                if (_root == null) Build();
                if (_root != null) _notice.ShowPending(now);
            }
            if (_root == null) return;
            _root.SetActive(_notice.Visible);
            if (!_notice.Visible) return;
            _message.text = "已发放破产救济金 " + PredictionMod.N(_notice.Amount) + " 马币";
            var rect = _root.transform as RectTransform;
            var parent = rect.parent as RectTransform;
            float scale = Mathf.Max(0.1f, Mathf.Min(1f, Mathf.Min((parent.rect.width - 32f) / 520f, (parent.rect.height - 32f) / 200f)));
            rect.localScale = new Vector3(scale, scale, 1f);
            rect.anchoredPosition = Vector2.zero;
            _root.transform.SetAsLastSibling();
        }
        public void Dismiss()
        {
            _notice.Dismiss();
            if (_root != null) _root.SetActive(false);
        }
        public void Destroy() { _ui.DestroyAll(); }
    }
}
#endif
