using System;
using Yx.Shared;

namespace YxPrediction
{
    public static class InterpreterProbe
    {
        public static string Run()
        {
            var ratings = new Rating[8];
            var players = new Player[8];
            for (int i = 0; i < 8; i++)
            {
                ratings[i] = new Rating(4400 - i * 160, 150, true);
                players[i] = new Player("player" + i.ToString(System.Globalization.CultureInfo.InvariantCulture), "player", false);
            }
            var snapshot = new MatchSnapshot { Id = "probe", Round = 2, LiveObserver = true, Players = players };
            var book = new PredictionBook(1000);
            book.Markets.Add(new Market(snapshot.Id, players, ratings, Odds.Rates(ratings, 2), 2));
            Market market = book.Observe(snapshot, null);
            if (market == null || market.Players[0].Uid != players[0].Uid) throw new Exception("Market not created");
            if (book.Bet(snapshot, players[0].Uid, 1, 10) != null || book.Balance != 990) throw new Exception("Bet not accepted");
            if (book.Bet(snapshot, players[1].Uid, 3, 10) != null || book.Balance != 980) throw new Exception("Adjacent bet not accepted");
            long expected = 980 + market.Tickets[0].Payout + market.Tickets[1].AdjacentPayout;
            book = BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(book))));
            snapshot.Round = 6;
            book.Observe(snapshot, null);
            if (!book.Find("probe").Locked || book.Bet(snapshot, players[2].Uid, 2, 10) == null) throw new Exception("Cutoff failed");
            snapshot.Ended = true; snapshot.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 8 };
            book.Observe(snapshot, null); book.Observe(snapshot, null);
            if (book.Balance != expected || !book.Find("probe").Settled) throw new Exception("Settlement failed");
            book = BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(book))));
            book.Observe(snapshot, null);
            if (book.Balance != expected || book.Find("probe").RuleVersion != 2) throw new Exception("Adjacent reward persistence failed");
            CapacityFlow(players, ratings);
            TradingFlow(players, ratings);
            ChampionFlow(players, ratings);
            ChampionGroupedFlow(players, ratings);
            LifeFlow(players, ratings);
            SharedTrendsFlow(players, ratings);
            RankSelectionFlow(players, ratings);
            ProtocolRankFlow(players, ratings);
            DepartureClosingFlow(players, ratings);
            CohortFlow(players, ratings);
            HorseFlow(players, ratings);
            PanelLayoutFlow();
            RoomWireFixture.Verify();
            EloScanFixture.Verify();
            RoomRateFixture.Verify();
            RoomFixFixture.VerifyFinals();
            RoomFixFixture.VerifySelections();
            var relief = new PredictionBook(9);
            if (!relief.GrantBankruptcyRelief() || relief.Balance != 59 || relief.GrantBankruptcyRelief()) throw new Exception("Relief boundary failed");
            relief = BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(relief))));
            if (relief.GrantBankruptcyRelief() || relief.Balance != 59) throw new Exception("Relief duplicated after reload");
            relief.Balance = 0;
            if (!relief.GrantBankruptcyRelief() || relief.Balance != 50) throw new Exception("Relief did not recur after bankruptcy");
            var pending = new PredictionBook(0);
            var pendingMarket = new Market("relief-pending", players, ratings, Odds.Rates(ratings, 2), 2);
            pendingMarket.HighestRound = 1;
            pendingMarket.Tickets[0] = new Ticket(0, 1, 1, 1, Odds.EffectiveRate(pendingMarket.BaseRates[0], 1));
            pending.Markets.Add(pendingMarket);
            pending = BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(pending))));
            if (pending.CanGrantBankruptcyRelief || pending.GrantBankruptcyRelief() || pending.Balance != 0) throw new Exception("Pending fixed bet received relief");
            var tradingPending = new PredictionBook(0);
            var tradingMarket = new Market("relief-trading", players, ratings, Odds.Rates(ratings));
            tradingMarket.Positions[0].Claim = 1;
            tradingPending.Markets.Add(tradingMarket);
            if (tradingPending.GrantBankruptcyRelief()) throw new Exception("Pending trading bet received relief");
            tradingMarket.Positions[0].Resolved = true;
            if (!tradingPending.GrantBankruptcyRelief() || tradingPending.Balance != 50) throw new Exception("Resolved bet blocked relief");
            var notice = new ReliefNotice(); notice.Notify(50); notice.Update(100);
            if (notice.Visible || notice.PendingAmount != 50) throw new Exception("Relief notice started before presentation");
            notice.ShowPending(100); notice.Update(102.99);
            if (!notice.Visible) throw new Exception("Relief notice closed too early");
            notice.Update(103);
            if (notice.Visible) throw new Exception("Relief notice did not auto-dismiss");
            notice.Notify(50); notice.ShowPending(104); notice.Dismiss();
            if (notice.Visible) throw new Exception("Relief notice confirmation failed");
            return "INTERPRETER PASS";
        }

        static void CapacityFlow(Player[] players, Rating[] ratings)
        {
            var empty = new PredictionBook(1000);
            var funded = new PredictionBook(1000);
            for (int i = 0; i < 12; i++)
            {
                string id = "capacity-" + i.ToString(System.Globalization.CultureInfo.InvariantCulture);
                var s = new MatchSnapshot { Id = id, Round = 1, LiveObserver = true, Players = players };
                empty.Markets.Add(new Market(id, players, ratings, Odds.Rates(ratings, 2), 2));
                funded.Markets.Add(new Market(id, players, ratings, Odds.Rates(ratings, 2), 2));
                if (funded.Bet(s, players[0].Uid, 1, 1) != null) throw new Exception("Capacity fixture bet failed");
            }
            var next = new MatchSnapshot { Id = "capacity-next", Round = 1, LiveObserver = true, Players = players };
            if (!empty.HasNewMarketCapacity || empty.Observe(next, ratings) == null || empty.Markets.Count != 12 || empty.Balance != 1000)
                throw new Exception("Passive markets exhausted capacity");
            funded = BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(funded))));
            if (funded.HasNewMarketCapacity || funded.Observe(next, ratings) != null || funded.Markets.Count != 12 || funded.Balance != 988)
                throw new Exception("Capacity discarded funded markets");
        }

        static void PanelLayoutFlow()
        {
            var layout = new PanelLayout(null, null);
            if (layout.WindowX != 0.5 || layout.WindowY != 0.5 || layout.BetBarCustom) throw new Exception("Panel layout init failed");
            layout.MoveWindow(1.2, 0.4, 0.4, 0.4);
            if (layout.WindowX > 0.81 || layout.WindowX < 0.79) throw new Exception("Window clamping failed");
            layout.MoveBetBar(0.2, 0.3, 0.2, 0.1);
            if (!layout.BetBarCustom) throw new Exception("Bet bar custom flag failed");
            var winData = layout.WriteWindow();
            var barData = layout.WriteBetBar();
            var restored = new PanelLayout(winData, barData);
            if (restored.WindowX != layout.WindowX || !restored.BetBarCustom) throw new Exception("Panel layout persistence failed");
            if (PanelLayout.BetBarAutoY(true, false) != PanelLayout.BetBarHandY) throw new Exception("Panel layout auto Y failed");
        }

        static void HorseFlow(Player[] players, Rating[] ratings)
        {
            var profiles = new HorseProfile[8]; var states = new PlayerState[8];
            for (int i = 0; i < 8; i++) { profiles[i] = new HorseProfile(ratings[i], 1, 10, i == 7); states[i] = new PlayerState(100, 0, 0, 0); }
            var s = new MatchSnapshot { Id = "horses", Round = 1, Players = players, States = states };
            var roster = new HorseRoster(); roster.Observe(s, profiles);
            s.Round = 2; states[7] = new PlayerState(100, 1, 0, 0); roster.Observe(s, profiles); roster.Observe(s, profiles);
            s.Round = 3; states[7] = new PlayerState(100, 2, 0, 0); roster.Observe(s, profiles);
            var member = roster.Find(players[7].Uid);
            if (!member.DarkHorse || member.Tags != "旋转木马" || member.ConsecutiveWins != 2) throw new Exception("Horse streak or stable tag failed");
            s.Round = 4; states[7] = new PlayerState(100, 2, 1, 0); roster.Observe(s, profiles);
            if (member.DarkHorse || member.Tags != "旋转木马") throw new Exception("Horse loss cleared seasonal tag");
            var shard = Json.ParseObject("{\"uid\":{\"rating\":3500,\"sigma\":100,\"dx\":2,\"seasons\":{\"10\":{\"start\":3500,\"peak\":3700,\"end\":3450}}}}");
            var profile = HorseProfile.Read(shard, "uid");
            if (!profile.Spinning || profile.DaoXinGames != 2 || profile.Rating.Score != 3500) throw new Exception("Horse profile failed under interpreter");
            s.Id = "new-horses"; roster.Observe(s, profiles);
            if (roster.Find(players[7].Uid).ConsecutiveWins != 0) throw new Exception("Horse state leaked across matches");
        }

        static void CohortFlow(Player[] players, Rating[] ratings)
        {
            for (int predicted = 6; predicted <= 8; predicted++)
            {
                var states = new PlayerState[8]; for (int i = 0; i < 8; i++) states[i] = new PlayerState(100,0,0,0);
                var s = new MatchSnapshot { Id = "cohort", Round = 4, LiveObserver = true, TradingOpen = true, Players = players, States = states, EliminationRounds = new int[8] };
                var b = HistoricalBook(s,ratings); Market m = b.Find(s.Id); b.Buy(s,players[7].Uid,predicted,100,m.TradeVersion); long claim = m.Positions[7].Claim;
                s.Round=5;s.TradingOpen=false;s.RoundResultsComplete=true;s.EliminationRounds[6]=s.EliminationRounds[7]=5;
                states[6]=states[7]=new PlayerState(0,2,3,0);b.Observe(s,null);
                long expected=900+(predicted==6?0:claim);
                if (b.Balance!=expected || !m.Positions[7].Resolved || m.RankMinimum[7]!=7 || m.RankMaximum[7]!=8) throw new Exception("Cohort payout failed");
                b=BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(b))));b.Observe(s,null);
                s.Ended=true;s.Ranks=new int[]{1,2,3,4,5,6,8,7};b.Observe(s,null);
                if(b.Balance!=expected || !b.Find(s.Id).Settled) throw new Exception("Cohort reload/final paid twice");
            }
        }

        static void DepartureClosingFlow(Player[] players, Rating[] ratings)
        {
            var states = new PlayerState[8];
            for (int i = 0; i < 8; i++) states[i] = new PlayerState(100, 0, 0, 0);
            var s = new MatchSnapshot { Id = "departure-close", Round = 9, LiveObserver = true, TradingOpen = true, Players = players, States = states };
            var b = new PredictionBook(1000); Market m = b.Observe(s, ratings);
            if (b.Buy(s, players[0].Uid, 1, 1000, m.TradeVersion) != null) throw new Exception("Round ten purchase failed");
            s.Round = 10; s.ResultsThroughRound = 10; b.Observe(s, null);
            if (!m.Locked || m.TradingWindowOpen || b.Sell(s, players[0].Uid, false, m.TradeVersion) == null) throw new Exception("Round ten close failed");
            if (b.AbandonExcept(null) != 1 || !b.GrantBankruptcyRelief() || b.Balance != 50) throw new Exception("Departure relief failed");
            b = BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(b))));
            if (!b.Find(s.Id).Abandoned || b.GrantBankruptcyRelief()) throw new Exception("Departure was not persistent");
            var queue = new RoomDepartureSync(); queue.Capture("https://example.test", "token", "123456", s.Id);
            queue = RoomDepartureSync.Read(Json.ParseObject(Json.Serialize(queue.Write())));
            if (queue.Count != 1 || !queue.Confirm(queue.At(0), "123456", s.Id, true) || queue.Count != 0) throw new Exception("Departure queue failed");
        }

        static void ProtocolRankFlow(Player[] players, Rating[] ratings)
        {
            var states = new PlayerState[8]; var ranks = new int[8];
            for (int i = 0; i < 8; i++) states[i] = GameRanks.ReadState(100, 0, 0, i);
            var s = new MatchSnapshot { Id = "protocol-ranks", Round = 7, LiveObserver = true, Players = players, States = states, Ranks = ranks, TradingOpen = true };
            var b = HistoricalBook(s, ratings); Market m = b.Find(s.Id);
            if (b.Buy(s, players[6].Uid, 8, 40, m.TradeVersion) != null || b.Buy(s, players[4].Uid, 6, 10, m.TradeVersion) != null)
                throw new Exception("Protocol rank fixture purchase failed");
            long expected = 950 + m.Positions[6].Claim + m.Positions[4].Claim / 4;
            int[] life = new int[] { -18, 48, 0, 29, -12, 74, -19, 66 };
            int[] raw = new int[] { 4, 2, 5, 3, 6, 0, 7, 1 }; s.Round = 15;
            for (int i = 0; i < 8; i++) states[i] = new PlayerState(life[i], 0, 0, life[i] <= 0 ? raw[i] : 0);
            b.Observe(s, null);
            if (b.Balance != 950 || m.Positions[6].Resolved || m.TradingWindowOpen) throw new Exception("Old rank mismatch was not reproduced");
            b = BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(b)))); m = b.Find(s.Id);
            for (int i = 0; i < 8; i++) { states[i] = GameRanks.ReadState(life[i], 0, 0, raw[i]); ranks[i] = GameRanks.FromProtocol(raw[i]); }
            b.Observe(s, null);
            if (b.Balance != expected || m.KnownRanks[6] != 8 || !m.Positions[6].Resolved || m.TradingWindowOpen || !m.Locked)
                throw new Exception("Normalized ranks did not recover pending rewards");
            s.Ended = true; b.Observe(s, null);
            if (!m.Settled || m.FinalRanks[5] != 1 || b.Balance != expected) throw new Exception("Zero based winner settlement failed");
            b = BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(b)))); b.Observe(s, null);
            if (b.Balance != expected) throw new Exception("Recovered rank rewards were paid twice");
        }

        static void RankSelectionFlow(Player[] players, Rating[] ratings)
        {
            var states = new PlayerState[8];
            for (int i = 0; i < 8; i++) states[i] = new PlayerState(100, 0, 0, 0);
            var s = new MatchSnapshot { Id = "rank-selection", Round = 1, LiveObserver = true, Players = players, States = states, TradingOpen = true };
            var b = HistoricalBook(s, ratings); Market m = b.Find(s.Id);
            var choices = new RankSelection(); choices.Observe(m);
            for (int i = 0; i < 8; i++) if (choices.Selected(i) != 0) throw new Exception("Unbought rank was preselected");
            choices.Step(0, false); if (choices.Selected(0) != 8) throw new Exception("Unselected reverse step failed");
            choices.Step(0, true); if (choices.Selected(0) != 1) throw new Exception("Rank cycling failed");
            if (!choices.SelectText(6, "3") || choices.SelectText(6, "9")) throw new Exception("Typed rank validation failed");
            if (b.Buy(s, players[6].Uid, choices.Selected(6), 10, m.TradeVersion) != null) throw new Exception("Rank selection buy failed");
            choices.Observe(m);
            if (choices.Selected(6) != 3 || choices.Selected(5) != 0 || RankSelection.DisplayOrder(m)[0] != 6) throw new Exception("Purchased rank sync or order failed");
            if (choices.Stake(6) != "10") throw new Exception("Stake default failed");
            choices.SetStake(6, "25");
            if (choices.Stake(6) != "25") throw new Exception("Stake update failed");
            choices.SelectText(6, "4"); choices.Observe(m);
            if (choices.Selected(6) != 4) throw new Exception("Draft overwritten by refresh");
            if (b.Switch(s, players[6].Uid, 5, 10, m.TradeVersion) != null) throw new Exception("Rank selection switch failed");
            choices.Observe(m); if (choices.Selected(6) != 5) throw new Exception("Switch did not sync rank");
            if (b.Sell(s, players[6].Uid, false, m.TradeVersion) != null) throw new Exception("Rank selection liquidation failed");
            choices.Observe(m);
            if (choices.Selected(6) != 0 || RankSelection.DisplayOrder(m)[0] != 0) throw new Exception("Liquidation did not clear rank and priority");
        }

        static void SharedTrendsFlow(Player[] players, Rating[] ratings)
        {
            var states = new PlayerState[8]; var swaps = new int[8];
            for (int i = 0; i < 8; i++) { states[i] = new PlayerState(100, 0, 0, 0); swaps[i] = 8; }
            var s = new MatchSnapshot { Id = "shared-trends", Round = 4, LiveObserver = true, Players = players, States = states, RemainingSwaps = swaps, TradingOpen = true };
            var b = new PredictionBook(1000); Market m = b.Observe(s, ratings);
            s.Round = 5; states[7] = new PlayerState(85, 0, 1, 0); swaps[7] = 4; b.Observe(s, null);
            b = BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(b)))); m = b.Find(s.Id);
            if (m.Swaps[7].Points[1].Remaining != 4 || b.Balance != 1000) throw new Exception("Swap history restore failed");
            for (int metric = 0; metric < 3; metric++)
            {
                var first = new TrendChartData(m, 0, metric); var other = new TrendChartData(m, 7, metric);
                if (first.Minimum <= 0 || first.Minimum != other.Minimum || first.Maximum != other.Maximum || first.FirstRound != other.FirstRound || first.LastRound != other.LastRound)
                    throw new Exception("Common dynamic axes differ between players");
                if (other.Y[1] < 0 || other.Y[1] > 1 || !other.Connected[1]) throw new Exception("Shared chart geometry failed");
            }
        }

        static void LifeFlow(Player[] players, Rating[] ratings)
        {
            var states = new PlayerState[8];
            for (int i = 0; i < 8; i++) states[i] = new PlayerState(100, 0, 0, 0);
            var s = new MatchSnapshot { Id = "life", Round = 1, LiveObserver = true, Players = players, States = states, TradingOpen = true, FocusedUid = players[3].Uid };
            var book = new PredictionBook(1000); Market m = book.Observe(s, ratings);
            s.Round = 2; states[3] = new PlayerState(85, 0, 1, 0); book.Observe(s, null);
            if (FocusSelection.Index(m, s) != 3 || m.Life[3].Points.Count != 2) throw new Exception("Focused life collection failed");
            book = BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(book)))); m = book.Find("life");
            if (m.Life[3].Points[1].Life != 85 || book.Balance != 1000) throw new Exception("Life history restore failed");
            var data = new LifeChartData(m.Life[3]);
            if (!data.Connected[1] || data.Y[1] != 0.85 || data.X[1] != 1) throw new Exception("Life chart geometry failed");
            var share = new LifeShareChartData(m, 3);
            if (!share.HasCurrentValue || Math.Abs(share.CurrentShare * 785 - 85) > 0.000000001 || !share.Connected[1]) throw new Exception("Life share geometry failed");
            m.Life[3].Record(4, 70); data = new LifeChartData(m.Life[3]);
            if (data.Connected[2] || data.X[2] != 1) throw new Exception("Missing rounds were joined");
            share = new LifeShareChartData(m, 3);
            if (share.HasCurrentValue || share.X.Length != 2) throw new Exception("Missing total life was fabricated");
            s.FocusedUid = players[5].Uid;
            if (FocusSelection.Index(m, s) != 5 || m.Life[5].Points[1].Life != 100) throw new Exception("Focus mixed player data");
        }

        static PredictionBook HistoricalBook(MatchSnapshot s, Rating[] ratings)
        {
            var b = new PredictionBook(1000);
            b.Markets.Add(new Market(s.Id, s.Players, ratings, Odds.Rates(ratings, 3), 3)); b.Observe(s, null); return b;
        }
        static void ChampionGroupedFlow(Player[] players, Rating[] ratings)
        {
            var states=new PlayerState[8];for(int i=0;i<8;i++)states[i]=new PlayerState(100,0,0,0);
            var s=new MatchSnapshot{Id="champion-group",Round=1,Players=players,States=states,LiveObserver=true,TradingOpen=true,EliminationRounds=new int[8]};
            var book=new PredictionBook(1000);Market m=book.Observe(s,ratings);book.Buy(s,players[2].Uid,1,101,m.TradeVersion);long claim=m.Positions[2].Claim;
            s.Round=9;s.TradingOpen=false;s.RoundResultsComplete=true;
            for(int i=1;i<8;i++){states[i]=new PlayerState(0,0,0,i+1);s.EliminationRounds[i]=10-i;}
            s.EliminationRounds[2]=s.EliminationRounds[1];states[1]=states[2]=new PlayerState(0,0,0,0);book.Observe(s,null);
            if(m.Positions[2].FinalPayout!=claim/4 || book.Balance!=899+claim/4)throw new Exception("Champion cohort maximum failed");
            book=BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(book))));s.Ended=true;s.Ranks=new int[]{1,3,2,4,5,6,7,8};book.Observe(s,null);
            if(book.Balance!=899+claim/4 || !book.Find(s.Id).Settled)throw new Exception("Champion grouped final repeated or reset reward");
        }

        static void ChampionFlow(Player[] players, Rating[] ratings)
        {
            var states = new PlayerState[8]; for (int i = 0; i < 8; i++) states[i] = new PlayerState(100, 0, 0, 0);
            var s = new MatchSnapshot { Id = "champion", Round = 9, LiveObserver = true, TradingOpen = true, Players = players, States = states };
            var b = new PredictionBook(1000); Market m = b.Observe(s, ratings);
            if (!m.ChampionOnly || b.Buy(s, players[0].Uid, 2, 10, m.TradeVersion) == null) throw new Exception("Champion policy failed");
            for (int i = 0; i < 3; i++) if (b.Buy(s, players[i].Uid, 1, 10, m.TradeVersion) != null) throw new Exception("Champion purchase failed");
            long expected = 970 + m.Positions[0].Claim + m.Positions[1].Claim / 4 + m.Positions[2].Claim / 10;
            s.Round = 10; b.Observe(s, null); if (m.TradingWindowOpen) throw new Exception("Round ten reopened");
            b = BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(b)))); s.Round = 9;
            if (b.Buy(s, players[3].Uid, 1, 10, b.Find(s.Id).TradeVersion) == null) throw new Exception("Cutoff rewound");
            s.Round = 15; s.Ended = true; s.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 8 }; b.Observe(s, null);
            b = BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(b)))); b.Observe(s, null);
            if (b.Balance != expected || !b.Find(s.Id).Settled) throw new Exception("Champion awards or persistence failed");
        }
        static void TradingFlow(Player[] players, Rating[] ratings)
        {
            var states = new PlayerState[8];
            for (int i = 0; i < 8; i++) states[i] = new PlayerState(100, 0, 0, 0);
            var snapshot = new MatchSnapshot { Id = "trading", Round = 2, LiveObserver = true, Players = players, States = states, TradingOpen = true };
            var book = HistoricalBook(snapshot, ratings); Market m = book.Find(snapshot.Id);
            if (!m.IsTrading || !m.TradingWindowOpen) throw new Exception("Trading window not open");
            if (book.Buy(snapshot, players[0].Uid, 1, 100, m.TradeVersion) != null) throw new Exception("Initial buy failed");
            if (book.Buy(snapshot, players[7].Uid, 7, 10, m.TradeVersion) != null) throw new Exception("Near-rank buy failed");
            if (book.Sell(snapshot, players[0].Uid, true, m.TradeVersion) != null) throw new Exception("Half sale failed");
            if (book.Buy(snapshot, players[0].Uid, 1, 20, m.TradeVersion) != null) throw new Exception("Increase failed");
            int stale = m.TradeVersion; long before = book.Balance;
            snapshot.Round = 6; states[0] = new PlayerState(160, 5, 0, 0);
            if (book.Buy(snapshot, players[0].Uid, 1, 20, stale) == null || book.Balance != before) throw new Exception("Stale quote accepted");
            book = BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(book)))); m = book.Find("trading");
            if (m.TradingWindowOpen) throw new Exception("Reload restored an open window");
            book.Observe(snapshot, null);
            if (book.Switch(snapshot, players[0].Uid, 2, 10, m.TradeVersion) != null) throw new Exception("Atomic switch failed");
            snapshot.ResultsThroughRound = 6; book.Observe(snapshot, null);
            if (book.Sell(snapshot, players[0].Uid, false, m.TradeVersion) == null) throw new Exception("Result latch failed");
            book = BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(book)))); m = book.Find("trading");
            snapshot.ResultsThroughRound = 0; book.Observe(snapshot, null);
            if (m.TradingWindowOpen) throw new Exception("Result latch lost on reload");
            snapshot.Round = 7; states[7] = new PlayerState(0, 0, 6, 8); before = book.Balance;
            long near = m.Positions[7].Claim / 4; book.Observe(snapshot, null);
            if (!m.Positions[7].Resolved || book.Balance != before + near || !m.TradingWindowOpen) throw new Exception("Partial rank settlement failed");
            if (book.Sell(snapshot, players[0].Uid, false, m.TradeVersion) != null) throw new Exception("Full sale failed");
            if (book.Buy(snapshot, players[1].Uid, 1, 10, m.TradeVersion) != null) throw new Exception("Late buy failed");
            long expected = book.Balance + m.Positions[1].Claim / 4;
            snapshot.Ended = true; snapshot.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 8 };
            book.Observe(snapshot, null); book = BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(book))));
            book.Observe(snapshot, null);
            if (book.Balance != expected || !book.Find("trading").Settled) throw new Exception("Trading settlement persistence failed");
        }
    }
}
