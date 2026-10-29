#if YX_GAME
using System;
using System.Reflection;
using Proto;
using UnityEngine;
using UnityEngine.UI;
using Yx.ModSdk;
using Yx.ModSdk.Unity;

namespace YxPrediction
{
    // Read only the existing native selection. Never create a detail item during polling.
    public sealed class LobbyRoomEntry
    {
        static readonly FieldInfo DetailField = typeof(XianFuLobbyPanel).GetField("m_RoomDetailItem", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        static readonly FieldInfo InfoField = typeof(XianFuLobbyRoomDetailItem).GetField("m_Info", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        static readonly FieldInfo ButtonField = typeof(XianFuLobbyRoomDetailItem).GetField("m_SpectateButton", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        readonly UiKit _ui;
        readonly NativeTheme _theme;
        readonly Action _toggle;
        GameObject _root;
        NativePanelButton _button;
        public bool Visible { get; private set; }
        public LobbyRoomEntry(ModContext ctx, NativeTheme theme, Action toggle) { _ui = new UiKit(ctx); _theme = theme; _toggle = toggle; }
        public static Button SelectedButton(out string roomId)
        {
            roomId = null;
            if (!NativeRoomSpectate.IsLobby) return null;
            var lobby = ILRPanelBase.FindILRPanel<LobbyPanel>();
            var panel = lobby == null ? null : lobby.FindILRSubPanel<XianFuLobbyPanel>();
            if (panel == null || panel.hiding || panel.transform == null || !panel.transform.gameObject.activeInHierarchy || DetailField == null || InfoField == null || ButtonField == null) return null;
            var detail = DetailField.GetValue(panel) as XianFuLobbyRoomDetailItem;
            if (detail == null || detail.transform == null || !detail.transform.gameObject.activeInHierarchy) return null;
            var native = ButtonField.GetValue(detail) as Button;
            var info = InfoField.GetValue(detail) as LobbyGameRoomInfo;
            if (native == null || !native.gameObject.activeInHierarchy || info == null || string.IsNullOrEmpty(info.roomId)) return null;
            roomId = info.roomId;
            return native;
        }
        public static bool SpectateSelected(out string roomId, out string error, bool confirmed = false)
        {
            error = null;
            Button native = SelectedButton(out roomId);
            if (native == null || !native.interactable) { error = "请先在仙府大厅选择一个可观战的对局"; return false; }
            if (confirmed && !NativeSpectateConfirmation.CanBegin(out error)) return false;
            native.onClick.Invoke();
            return !confirmed || NativeSpectateConfirmation.ConfirmOpened(out error);
        }
        public void Update()
        {
            string roomId;
            Button native = SelectedButton(out roomId);
            var lobby = NativeRoomSpectate.IsLobby ? ILRPanelBase.FindILRPanel<LobbyPanel>() : null;
            var panel = lobby == null ? null : lobby.FindILRSubPanel<XianFuLobbyPanel>();
            Visible = native != null || (panel != null && !panel.hiding && panel.transform != null && panel.transform.gameObject.activeInHierarchy);
            if (_root != null) _root.SetActive(Visible);
            if (!Visible) return;
            if (_root == null)
            {
                _root = _ui.Panel("PredictionRoomLauncher", Vector2.zero, new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(180f, 54f), Color.clear, false);
                if (_root == null) return;
                _button = _theme.CreateButtonTopLeft(_root.transform, "openRooms", "名次预测", 0f, 0f, 180f, 54f, NativePanelButtonStyle.Primary, _toggle, 22);
            }
            var rect = _root.transform as RectTransform;
            var parent = rect.parent as RectTransform;
            if (native == null)
            {
                rect.anchorMin = rect.anchorMax = new Vector2(1f, 1f); rect.pivot = new Vector2(0.5f, 0.5f);
                rect.anchoredPosition = new Vector2(-120f, -160f); _button.SetText("预测房间"); return;
            }
            _button.SetText("名次预测");
            var reference = native.transform as RectTransform;
            if (parent == null || reference == null) return;
            Vector3 center = parent.InverseTransformPoint(reference.TransformPoint(reference.rect.center));
            Vector3 edge = parent.InverseTransformPoint(reference.TransformPoint(new Vector3(reference.rect.xMax, reference.rect.center.y, 0f)));
            float x = edge.x + 16f + 90f;
            if (x + 90f > parent.rect.xMax - 12f) x = center.x - (edge.x - center.x) - 16f - 90f;
            rect.anchorMin = rect.anchorMax = parent.pivot;
            rect.pivot = new Vector2(0.5f, 0.5f);
            rect.anchoredPosition = new Vector2(x, center.y);
            rect.sizeDelta = new Vector2(180f, 54f);
            var image = native.GetComponent<Image>();
            if (image != null && image.sprite != null && _button != null && _button.Background != null)
            {
                NativeControlStyle.Button(_button.Button, native, "名次预测", 22f);
            }
        }
        public void Destroy() { _ui.DestroyAll(); _root = null; }
    }
}
#endif
