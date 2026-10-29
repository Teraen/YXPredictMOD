#if YX_GAME
using System.Globalization;
using UnityEngine;
using Yx.ModSdk;
using Yx.ModSdk.Unity;
namespace YxPrediction
{
    public sealed class CharacterBetBar
    {
        readonly PredictionMod _mod;
        readonly NativeTheme _theme;
        readonly UiKit _ui;
        readonly ModContext _ctx;
        GameObject _root;
        NativePredictionBar _bar;
        UiInput _stake;
        NativePanelButton _buy, _half, _sell;
        TMPro.TextMeshProUGUI _name, _rank, _holding;
        int _selected, _index = -1;
        string _uid, _game, _room;
        bool _collapsed;
        public CharacterBetBar(PredictionMod mod, ModContext ctx, NativeTheme theme) { _mod = mod; _theme = theme; _ctx=ctx; _ui = new UiKit(ctx); }
        static void Ignore(string value) { }
        void Build()
        {
            _bar=new NativePredictionBar(_ctx,_theme,Minus,Plus,Buy,Half,Sell,Overview,Collapse);
            _root=_bar.Root;_stake=_bar.Stake;_buy=_bar.Buy;_half=_bar.Half;_sell=_bar.Sell;
            _name=_bar.PlayerName;_rank=_bar.Rank;_holding=_bar.Holding;
        }
        public void Update()
        {
            bool show = PredictionVisibility.CanShow() && !GameBridge.IsPlayingBattle();
            if (_root != null) _root.SetActive(show);
            if (!show) return;
            if (_root == null) Build(); if (_root == null) return;
            RoomState r = _mod.OnlinePanel.CurrentView(); string focus = FocusSelection.Uid(_mod.Snapshot);
            int index = -1; if (r != null) for(int i=0;i<8;i++) if(r.Uids[i]==focus) index=i;
            if(index<0) { _root.SetActive(false); return; }
            if (_uid != focus || _game != r.GameId || _room != r.Code) { _uid=focus;_game=r.GameId;_room=r.Code;_index=index;_stake.SetText("10"); }
            _selected = r.Rules >= 3 ? 1 : r.MyRanks[index];
            _index=index;
            _name.text=r.Names[index];_rank.text=r.Rules>=3?"冠军":_selected>0?"第"+PredictionMod.N(_selected)+"名（旧）":"旧盘口"; _bar.Minus.SetActive(false); _bar.Plus.SetActive(false);
            _holding.text=r.Forfeited && r.Ranks[index]==0 ? "离场已放弃" : r.Stakes[index]>0?"猜"+PredictionMod.N(r.MyRanks[index])+"名 · "+PredictionMod.N(r.Rules>=2?r.Claims[index]:r.Stakes[index])+"马币":"未持仓";
            HorseMember horse=_mod.Horses.FindMember(focus);
            _bar.Badge.sprite=horse==null?null:_mod.Horses.GetSprite(horse.IconTitle);
            _bar.Badge.gameObject.SetActive(!_collapsed&&_bar.Badge.sprite!=null);
            _bar.BadgeText.text=horse==null?"":horse.Caption;
            if(horse!=null)_bar.BadgeText.color=TianJiFeature.ColorOf(horse.Title);
            bool online=_mod.Online.State!=null&&_mod.Online.State.GameId==r.GameId;
            if(_selected>0)
            {
                long pool=0;for(int i=0;i<8;i++)pool+=r.Pools[index*8+i];long chosen=r.Pools[index*8+_selected-1];
                _bar.Rate.text=!online||r.Rules>=2?PredictionMod.Rate(r.QuoteRates[index*8+_selected-1]):chosen>0?(pool/(double)chosen).ToString("0.00",CultureInfo.InvariantCulture)+"x":"—";
            }
            else _bar.Rate.text="—";
            bool open=BettingAccess.CanTrade(r,_mod.Snapshot,index);
            _buy.SetInteractable(open&&r.Rules>=3&&_selected>0);_half.SetInteractable(open&&r.Stakes[index]>0);_sell.SetInteractable(open&&r.Stakes[index]>0);
            _buy.SetText(r.Stakes[index]>0?(r.MyRanks[index]==_selected?"加注":"换猜"):"投入");
            _half.SetActive(!_collapsed&&r.Stakes[index]>0);_sell.SetActive(!_collapsed&&r.Stakes[index]>0);
            _bar.SetCollapsed(_collapsed); _bar.Minus.SetActive(false); _bar.Plus.SetActive(false);
            var rt=_root.transform as RectTransform;var parent=rt.parent as RectTransform;
            float scale=Mathf.Min(1.15f,(parent.rect.width-32f)/990f);rt.localScale=new Vector3(scale,scale,1);
            bool hand,talent;GameBridge.InspectBottomHandZone(out hand,out talent);
            rt.anchoredPosition=new Vector2(0f,hand?Mathf.Max(326f,GameBridge.BottomHandTop(parent)+14f):76f);
            _mod.OnlinePanel.KeepBarAbove(_root.transform);
        }
        void Step(bool forward){if(!Valid())return;_mod.OnlinePanel.Selections.Step(_uid,forward);_selected=_mod.OnlinePanel.Selections.Selected(_uid);}
        void Minus(){Step(false);}
        void Plus(){Step(true);}
        bool Valid(){RoomState r=_mod.OnlinePanel.CurrentView();return r!=null&&r.GameId==_game&&r.Code==_room&&_index>=0&&r.Uids[_index]==_uid&&FocusSelection.Uid(_mod.Snapshot)==_uid;}
        void Buy(){if(!Valid())return;_selected=1;long amount;if(!long.TryParse(_stake.Text,NumberStyles.None,CultureInfo.InvariantCulture,out amount)||amount<1||amount>10000){_mod.OnlinePanel.SetFeedback("投入须为1至10000整数");return;}_mod.OnlinePanel.Submit(_index,_selected,amount,0);}
        void Half(){if(Valid())_mod.OnlinePanel.Submit(_index,0,0,1);}
        void Sell(){if(Valid())_mod.OnlinePanel.Submit(_index,0,0,2);}
        void Overview(){_mod.OnlinePanel.Toggle();}
        void Collapse(){_collapsed=!_collapsed;_bar.SetCollapsed(_collapsed); _bar.Minus.SetActive(false); _bar.Plus.SetActive(false);}
        public void Destroy(){if(_bar!=null)_bar.Destroy();_ui.DestroyAll();_root=null;}
    }
}
#endif
