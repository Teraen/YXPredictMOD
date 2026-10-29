#if YX_GAME
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using TMPro;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;
using Yx.ModSdk;
using Yx.ModSdk.Game;
using Yx.ModSdk.Unity;

namespace YxPrediction
{
    // 以实际头像控件的 battlePlayerData.uid 绑定，昵称隐藏、同名及排序均不影响身份。
    public sealed class TianJiFeature
    {
        readonly PredictionMod _mod;
        readonly ModContext _ctx;
        readonly GameBridge _bridge;
        readonly UiKit _ui;
        readonly ConfigEntry<bool> _enabled, _icons, _iconsOnFocus;
        readonly HorseAssets _assets = new HorseAssets();
        readonly List<Plate> _plates = new List<Plate>();
        public readonly HorseRoster Roster = new HorseRoster();
        BattleManager _manager;
        FieldInfo _battlePanelField;
        static readonly FieldInfo ReadyField = typeof(BattlePanel).GetField("m_ReadyLayer", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
        float _nextUpdate;
        string _lastError;
        readonly Dictionary<string, FieldInfo> _scoreFields = new Dictionary<string, FieldInfo>();
        public bool Enabled { get { return _enabled.Value; } set { _enabled.Value = value; _nextUpdate = 0; } }

        sealed class Score
        {
            public string Uid;
            public int Value;
            public bool DaoXin;
        }
        Score[] _pendingScores, _scores;
        float _pendingAt;
        string _scoreMatchId;
        sealed class Plate
        {
            public string Uid;
            public BattlePlayerInfoItem Item;
            public GameObject Root, IconFrame;
            public TextMeshProUGUI Name, Label;
            public HorseCaption Caption;
            public Image Avatar, Icon;
            public Sprite Clip;
            public Rect HoverArea;
            public bool Visible;
        }
        public TianJiFeature(PredictionMod mod, ModContext ctx, GameBridge bridge)
        {
            _mod = mod; _ctx = ctx; _bridge = bridge; _ui = new UiKit(ctx);
            _enabled = ctx.Config.Bind("tianji", "enabled", true, "显示田忌赛马称号；按公开Elo分档，仅作趣味参考");
            _icons = ctx.Config.Bind("tianji", "icons", true, "允许圆形马图覆盖原头像；关闭后仅显示称号");
            // 默认保留角色头像，查看或悬停时显示马图；已有显示偏好和热键改键继续沿用。
            _iconsOnFocus = ctx.Config.Bind("tianji", "iconsOnFocus", true, "关闭：默认显示马图，查看或悬停时显示角色；开启：默认显示角色，查看或悬停时显示马图。Ctrl+Shift+H切换");
            ctx.Input.RegisterHotkey("horseAlwaysCover", "Ctrl+Shift+H", ToggleIconMode);
            ctx.Events.OnNetIn<Proto.MatchPlayerInfosResp>(OnScores);
        }
        public void Toggle() { _enabled.Value = !_enabled.Value; _nextUpdate = 0; Update(); }
        void ToggleIconMode()
        {
            var events = EventSystem.current;
            var selected = events == null ? null : events.currentSelectedGameObject;
            if (selected != null && (selected.GetComponent(typeof(TMP_InputField)) != null
                || selected.GetComponent(typeof(InputField)) != null)) return;
            _iconsOnFocus.Value = !_iconsOnFocus.Value;
            _ctx.Log.Info(_iconsOnFocus.Value ? "马图：默认显示角色，查看或悬停时显示马图" : "马图：默认显示马图，查看或悬停时显示角色");
            _nextUpdate = 0;
        }
        void OnScores(Proto.MatchPlayerInfosResp message)
        {
            try
            {
                var data = ScoreField(message, "datas") as IList;
                if (data == null || data.Count != 8) return;
                var scores = new Score[8];
                for (int i = 0; i < 8; i++)
                {
                    object p = data[i]; string uid = ScoreField(p, "uid") as string;
                    if (string.IsNullOrEmpty(uid)) return;
                    object value = ScoreField(p, "rankScore"), daoXin = ScoreField(p, "isDaoXinRank");
                    scores[i] = new Score { Uid = uid, Value = value is int ? (int)value : -1, DaoXin = daoXin is bool && (bool)daoXin };
                    for (int j = 0; j < i; j++) if (scores[j].Uid == uid) return;
                }
                _pendingScores = scores; _pendingAt = Time.unscaledTime;
                if (SamePlayers(_mod.Snapshot, scores)) { _scores = scores; _scoreMatchId = _mod.Snapshot.Id; }
            }
            catch (Exception ex) { _ctx.Log.Warn("田忌天梯分暂不可读：" + ex.Message); }
        }
        object ScoreField(object instance, string name)
        {
            if (instance == null) return null;
            Type type = instance.GetType(); string key = type.FullName + ":" + name;
            FieldInfo field;
            // 取运行时实例自身的字段，避免原MOD已记录的MatchPlayerInfo跨程序集token错配。
            if (!_scoreFields.TryGetValue(key, out field))
            { field = type.GetField(name, BindingFlags.Public | BindingFlags.Instance); _scoreFields[key] = field; }
            return field == null ? null : field.GetValue(instance);
        }
        static bool SamePlayers(MatchSnapshot snapshot, Score[] scores)
        {
            if (snapshot == null || scores == null || !snapshot.IsEightPlayerMatch()) return false;
            for (int i = 0; i < 8; i++)
            {
                bool found = false;
                for (int j = 0; j < 8; j++) if (snapshot.Players[i].Uid == scores[j].Uid) found = true;
                if (!found) return false;
            }
            return true;
        }
        public HorseMember Find(string uid)
        { return Enabled && _mod.Snapshot != null && Roster.MatchId == _mod.Snapshot.Id ? Roster.Find(uid) : null; }
        public Sprite GetSprite(string title) { return _assets.Get(title, _ctx); }

        public HorseMember FindMember(string uid)
        { return _mod.Snapshot != null && Roster.MatchId == _mod.Snapshot.Id ? Roster.Find(uid) : null; }

        public string RankScoreTag(string uid)
        {
            if (_scores != null && _scoreMatchId == Roster.MatchId)
            {
                for (int i = 0; i < _scores.Length; i++)
                {
                    if (_scores[i].Uid == uid && _scores[i].Value >= 0)
                    {
                        return (_scores[i].DaoXin ? "道心分 " : "天梯分 ") + PredictionMod.N(_scores[i].Value);
                    }
                }
            }
            return "";
        }

        public string Describe(string uid)
        {
            HorseMember member = Find(uid);
            return FormatMember(member, uid);
        }

        public string DescribeFull(string uid)
        {
            HorseMember member = FindMember(uid);
            return FormatMember(member, uid);
        }

        string FormatMember(HorseMember member, string uid)
        {
            if (member == null) return "";
            if (member.IsAi) return member.Title + " · " + member.Explanation;
            if (member.Profile == null || !member.Profile.Rating.Found) return "暂无公开Elo，不参与称号评定";
            string text = member.Caption + " · " + member.Explanation;
            if (member.Profile.DaoXinGames >= 0) text += " · 道心对局 " + PredictionMod.N(member.Profile.DaoXinGames) + "场";
            string tag = RankScoreTag(uid);
            if (!string.IsNullOrEmpty(tag)) text += " · " + tag;
            return text;
        }

        public void Update()
        {
            try
            {
                MatchSnapshot snapshot = _mod.Snapshot;
                if (!Enabled || snapshot == null || SceneLoader.currentSceneName != "Battle")
                { ClearPlates(); if (snapshot == null || !Enabled) Roster.Clear(); return; }
                var battling = BattleApi.IsBattling();
                if (!battling.Ok || battling.Value) { ClearPlates(); return; }
                if (Time.unscaledTime >= _nextUpdate)
                {
                    _nextUpdate = Time.unscaledTime + 0.5f;
                    if (Roster.MatchId != snapshot.Id)
                    {
                        ClearPlates(); _scores = null; _scoreMatchId = snapshot.Id;
                        if (Time.unscaledTime - _pendingAt <= 60 && SamePlayers(snapshot, _pendingScores)) _scores = _pendingScores;
                    }
                    Roster.Observe(snapshot, _bridge.HorseProfiles(snapshot.Players));
                    RefreshPlates();
                }
                UpdateIcons(snapshot);
                _lastError = null;
            }
            catch (Exception ex)
            {
                ClearPlates();
                string error = ex.GetType().Name + ": " + ex.Message;
                if (_lastError != error) { _lastError = error; _ctx.Log.Warn("田忌称号暂不可用：" + error); }
            }
        }
        void UpdateIcons(MatchSnapshot snapshot)
        {
            Vector3 mouse = Input.mousePosition;
            var screen = new Vector2(mouse.x, mouse.y);
            int hoveredIndex = -1;
            float closest = float.PositiveInfinity;
            for (int i = 0; i < _plates.Count; i++)
            {
                Plate plate = _plates[i];
                if (plate.IconFrame == null || plate.Icon == null) continue;
                bool valid = Roster.MatchId == snapshot.Id && plate.Item != null && plate.Avatar != null
                    && plate.Item.battlePlayerData != null && plate.Item.battlePlayerData.uid == plate.Uid;
                plate.Visible = valid && plate.Root != null && plate.Root.activeSelf && plate.Avatar.isActiveAndEnabled;
                if (plate.Visible)
                {
                    RectTransform avatar = plate.Avatar.rectTransform;
                    HorsePlateLayout.PlaceIcon(plate.IconFrame.transform as RectTransform, avatar);
                    Canvas canvas = plate.Avatar.canvas;
                    Camera camera = canvas != null && canvas.renderMode != RenderMode.ScreenSpaceOverlay ? canvas.worldCamera : null;
                    Vector2 local;
                    if (Application.isFocused && RectTransformUtility.ScreenPointToLocalPointInRectangle(avatar, screen, camera, out local))
                    {
                        float distance = HorsePlateLayout.HoverDistance(avatar, plate.HoverArea, local);
                        if (distance < closest) { closest = distance; hoveredIndex = i; }
                    }
                }
            }
            for (int i = 0; i < _plates.Count; i++)
            {
                Plate plate = _plates[i];
                if (plate.IconFrame == null || plate.Icon == null) continue;
                plate.IconFrame.SetActive(HorsePlateLayout.ShouldShow(_icons.Value && plate.Icon.sprite != null && plate.Clip != null,
                    plate.Visible, _iconsOnFocus.Value, plate.Uid, snapshot.FocusedUid, i == hoveredIndex));
            }
        }
        void RefreshPlates()
        {
            BattleManager manager = BattleManager.Instance;
            if (manager == null) { ClearPlates(); return; }
            if (!object.ReferenceEquals(manager, _manager))
            {
                _manager = manager;
                // 游戏没有公开 BattlePanel 属性；只读已核对的私有字段，不扫昵称。
                _battlePanelField = manager.GetType().GetField("m_BattlePanel", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            }
            var panel = _battlePanelField == null ? null : _battlePanelField.GetValue(manager) as BattlePanel;
            var layer = panel == null || ReadyField == null ? null : ReadyField.GetValue(panel) as ReadyLayer;
            var items = layer == null ? null : layer.battlePlayerInfoItems;
            if (items == null) { ClearPlates(); return; }
            for (int i = _plates.Count - 1; i >= 0; i--)
            {
                Plate plate = _plates[i];
                bool present = false;
                for (int j = 0; j < items.Count; j++) if (object.ReferenceEquals(items[j], plate.Item)) present = true;
                if (!present || plate.Root == null || plate.IconFrame == null || plate.Icon == null || plate.Avatar == null || plate.Item.gameObject == null)
                { DestroyPlate(plate); _plates.RemoveAt(i); }
            }
            for (int i = 0; i < items.Count; i++)
            {
                var item = items[i];
                if (item == null || item.gameObject == null || item.battlePlayerData == null) continue;
                HorseMember member = Roster.Find(item.battlePlayerData.uid);
                Plate plate = null;
                for (int j = 0; j < _plates.Count; j++) if (object.ReferenceEquals(_plates[j].Item, item)) plate = _plates[j];
                if (member == null || member.Title.Length == 0)
                { if (plate != null) { plate.Root.SetActive(false); plate.IconFrame.SetActive(false); } continue; }
                if (plate == null)
                {
                    var name = item.FindComponent<TextMeshProUGUI>("UsernameLabel", false);
                    var avatar = item.FindComponent<Image>("Avatar", false);
                    if (name == null || avatar == null) continue;
                    // 称号跟随昵称；图标仅覆盖原生头像，不改写其Sprite或接管点击。
                    GameObject root = _ui.Row(name.transform, "YXPredictHorse", Vector2.zero, new Vector2(150, 48), Color.clear);
                    var rect = root.transform as RectTransform;
                    rect.anchorMin = rect.anchorMax = name.rectTransform.pivot;
                    rect.pivot = new Vector2(0.5f, 1);
                    var background = root.GetComponent(typeof(Image)) as Image;
                    if (background != null) background.raycastTarget = false;
                    // 为字体本身的行高留足空间，再按实际字形顶边贴齐ID，避免大字号整行被裁掉。
                    var caption = new HorseCaption(_ui, root.transform);
                    var iconRoot = _ui.Row(avatar.transform, "YXPredictHorseIcon", Vector2.zero,
                        Vector2.zero, Color.white);
                    iconRoot.SetActive(false);
                    var iconRect = iconRoot.transform as RectTransform;
                    iconRect.pivot = new Vector2(0.5f, 0.5f);
                    var maskImage = iconRoot.GetComponent(typeof(Image)) as Image;
                    Sprite clip = _assets.CircleMask(_ctx);
                    maskImage.sprite = clip; maskImage.raycastTarget = false;
                    var mask = iconRoot.AddComponent(typeof(Mask)) as Mask;
                    mask.showMaskGraphic = false;
                    var face = _ui.Row(iconRoot.transform, "horseImage", Vector2.zero,
                        Vector2.zero, Color.white);
                    var faceRect = face.transform as RectTransform;
                    faceRect.anchorMin = new Vector2(0, 0); faceRect.anchorMax = new Vector2(1, 1);
                    faceRect.offsetMin = faceRect.offsetMax = Vector2.zero;
                    var icon = face.GetComponent(typeof(Image)) as Image;
                    icon.raycastTarget = false; icon.preserveAspect = true;
                    plate = new Plate { Item = item, Root = root, Name = name, Label = caption.Text, Caption = caption,
                        Avatar = avatar, Icon = icon, IconFrame = iconRoot, Clip = clip };
                    _plates.Add(plate);
                }
                plate.Uid = item.battlePlayerData.uid;
                plate.Root.SetActive(true);
                // 挂签只保留主称号和分数；赛季附加标签仍在单人说明及详细数据中显示。
                plate.Caption.Set(member.PlateCaption, member.IsAi ? new Color(0.55f, 0.9f, 0.9f) : ColorOf(member.Title));
                Sprite sprite = _icons.Value ? _assets.Get(member.IconTitle, _ctx) : null;
                plate.Icon.sprite = sprite;
                PositionPlate(plate);
            }
        }
        static void PositionPlate(Plate plate)
        {
            // 按正文测量字形，让黑边最上沿与原生ID字形下沿保留1单位间隔。
            plate.Name.ForceMeshUpdate(false, false);
            plate.Label.ForceMeshUpdate(false, false);
            Bounds bounds = plate.Name.textBounds;
            Bounds caption = plate.Label.textBounds;
            Rect nameRect = plate.Name.rectTransform.rect;
            var root = plate.Root.transform as RectTransform;
            float bottom = bounds.size.y > 0 ? bounds.min.y : nameRect.yMin;
            // TMP是SDK布局框的内层子节点，字形坐标须先转换回挂签根节点。
            float captionTop = caption.size.y > 0
                ? UiTextBox.PointIn(root, plate.Label, new Vector3(caption.center.x, caption.max.y, 0)).y : 0;
            root.anchoredPosition = new Vector2(bounds.size.y > 0 ? bounds.center.x : nameRect.center.x, bottom - HorseCaption.GapBelowName - captionTop);
            float stroke = HorseCaption.StrokeSize;
            Rect captionGlyph = caption.size.y > 0
                ? new Rect(caption.min.x - stroke, caption.min.y - stroke, caption.size.x + stroke * 2, caption.size.y + stroke * 2)
                : plate.Label.rectTransform.rect;
            plate.HoverArea = HorsePlateLayout.HoverBounds(plate.Avatar.rectTransform, plate.Name.rectTransform, plate.Label.rectTransform, captionGlyph);
        }
        public static Color ColorOf(string title)
        {
            switch (title)
            {
                case "特等马": return new Color(1, 0.83f, 0.28f);
                case "上等马": return new Color(0.87f, 0.9f, 1);
                case "牛马": return new Color(0.88f, 0.66f, 0.43f);
                case "海马": return new Color(0.4f, 0.85f, 1);
                case "黑马": return new Color(0.87f, 0.65f, 1); // 深色背景仍然可读。
                default: return new Color(0.95f, 0.9f, 0.78f);
            }
        }
        void ClearPlates()
        {
            for (int i = 0; i < _plates.Count; i++) DestroyPlate(_plates[i]);
            _plates.Clear();
        }
        void DestroyPlate(Plate plate)
        {
            if (plate.IconFrame != null) _ui.Destroy(plate.IconFrame);
            if (plate.Root != null) _ui.Destroy(plate.Root);
        }
        public void Destroy() { ClearPlates(); _ui.DestroyAll(); _assets.Destroy(); Roster.Clear(); }
    }
}
#endif
