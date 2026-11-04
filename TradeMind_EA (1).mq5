//+------------------------------------------------------------------+
//| TradeMind_EA.mq5                                                  |
//| Reads TradeMind signals and (only if you switch it on) places     |
//| trades on YOUR MetaTrader 5 account.                              |
//|                                                                   |
//| UNTESTED CODE. Compile it and test it on a DEMO account first.    |
//| Trading is risky and you can lose money. Analysis only, not       |
//| advice. You are responsible for every trade this program places.  |
//|                                                                   |
//| Setup: Tools > Options > Expert Advisors > tick "Allow WebRequest"|
//| and add the ServerUrl below to the list.                          |
//+------------------------------------------------------------------+
#property copyright "TradeMind"
#property version   "1.00"
#include <Trade\Trade.mqh>

input string ServerUrl         = "https://trademind-prices.orjiakoshammah.workers.dev";
input string ApiKey            = "";        // your key from TradeMind > Trade Bot > Get my MT5 key
input bool   EnableTrading     = false;     // false = alert only, places NO trades
input double RiskPercent       = 0.5;       // % of equity risked per trade
input int    MaxOpenTrades     = 3;
input int    MinScore          = 60;
input int    MaxSignalAgeMin   = 45;        // ignore old signals
input double MaxDriftOfStop    = 0.5;       // skip if price moved more than this x stop distance
input double DailyLossLimitPct = 3.0;       // stop opening trades after this % daily drop
input int    MaxSpreadPoints   = 0;         // 0 = no spread limit
input string SymbolSuffix      = "";        // e.g. ".m" or "pro" if your broker adds one
input long   MagicNumber       = 26102026;
input int    PollSeconds       = 60;

CTrade trade;
double dayStartEquity = 0;
int    dayMarker      = -1;

int OnInit()
{
   if(ApiKey == "") { Alert("TradeMind EA: paste your ApiKey in the inputs."); return INIT_PARAMETERS_INCORRECT; }
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(30);
   EventSetTimer(PollSeconds);
   Print("TradeMind EA started. EnableTrading=", EnableTrading ? "ON (real orders)" : "OFF (alerts only)");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer() { Poll(); }

void Poll()
{
   char post[], res[];
   string hdr;
   ResetLastError();
   int code = WebRequest("GET", ServerUrl + "/ea/signals?key=" + ApiKey, "", 5000, post, res, hdr);
   if(code != 200)
   {
      Print("TradeMind EA: server answered ", code, " (error ", GetLastError(), "). Check the ApiKey and that the URL is allowed under Tools > Options > Expert Advisors.");
      return;
   }
   string lines[];
   int n = StringSplit(CharArrayToString(res, 0, WHOLE_ARRAY, CP_UTF8), '\n', lines);
   for(int i = 1; i < n; i++)
   {
      StringTrimLeft(lines[i]); StringTrimRight(lines[i]);
      if(lines[i] != "") Handle(lines[i]);
   }
}

int OpenCount()
{
   int c = 0;
   for(int i = 0; i < PositionsTotal(); i++)
   {
      ulong t = PositionGetTicket(i);
      if(t > 0 && PositionGetInteger(POSITION_MAGIC) == MagicNumber) c++;
   }
   return c;
}

bool HasPosition(string sym)
{
   for(int i = 0; i < PositionsTotal(); i++)
   {
      ulong t = PositionGetTicket(i);
      if(t > 0 && PositionGetInteger(POSITION_MAGIC) == MagicNumber && PositionGetString(POSITION_SYMBOL) == sym) return true;
   }
   return false;
}

bool DailyLossHit()
{
   MqlDateTime d; TimeToStruct(TimeCurrent(), d);
   if(d.day_of_year != dayMarker) { dayMarker = d.day_of_year; dayStartEquity = AccountInfoDouble(ACCOUNT_EQUITY); }
   return AccountInfoDouble(ACCOUNT_EQUITY) < dayStartEquity * (1.0 - DailyLossLimitPct / 100.0);
}

// line format: id|symbol|side|entry|stop|target|score|candleTimeMs
void Handle(string ln)
{
   string f[];
   if(StringSplit(ln, '|', f) < 8) return;
   string sym  = f[1] + SymbolSuffix;
   bool   buy  = (f[2] == "BUY");
   double entry = StringToDouble(f[3]), sl = StringToDouble(f[4]), tp = StringToDouble(f[5]);
   int    score = (int)StringToInteger(f[6]);
   long   ct    = StringToInteger(f[7]);

   string gv = "TM_" + f[1] + "_" + IntegerToString(ct / 1000);
   if(GlobalVariableCheck(gv)) return;          // already handled once
   GlobalVariableSet(gv, 1);

   if((TimeGMT() - (datetime)(ct / 1000)) / 60 > MaxSignalAgeMin) { Print("TradeMind: ", sym, " signal too old, skipped."); return; }
   if(score < MinScore) return;
   if(!SymbolSelect(sym, true)) { Print("TradeMind: ", sym, " not found at your broker (check SymbolSuffix)."); return; }

   if(!EnableTrading)
   {
      Alert("TradeMind signal (alert only): ", f[2], " ", sym, "  stop ", sl, "  target ", tp, "  score ", score);
      return;
   }
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)) { Print("TradeMind: trading is not allowed in this terminal."); return; }
   if(DailyLossHit())            { Print("TradeMind: daily loss limit reached, no new trades."); return; }
   if(OpenCount() >= MaxOpenTrades || HasPosition(sym)) return;
   if(MaxSpreadPoints > 0 && SymbolInfoInteger(sym, SYMBOL_SPREAD) > MaxSpreadPoints) { Print("TradeMind: spread too wide on ", sym); return; }

   double px = SymbolInfoDouble(sym, buy ? SYMBOL_ASK : SYMBOL_BID);
   double riskDist = MathAbs(entry - sl);
   if(px <= 0 || riskDist <= 0) return;
   if(MathAbs(px - entry) > MaxDriftOfStop * riskDist) { Print("TradeMind: price moved too far from the signal on ", sym, ", skipped."); return; }
   if(buy  && !(sl < px && tp > px)) return;
   if(!buy && !(sl > px && tp < px)) return;

   double tv = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE), ts = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   double dist = MathAbs(px - sl);
   if(tv <= 0 || ts <= 0 || dist <= 0) return;
   double lots = (AccountInfoDouble(ACCOUNT_EQUITY) * RiskPercent / 100.0) / (dist / ts * tv);
   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), mn = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), mx = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   if(step <= 0) return;
   lots = MathFloor(lots / step + 1e-9) * step;
   if(lots < mn) { Print("TradeMind: your risk setting is too small for the minimum lot on ", sym, ", skipped."); return; }
   lots = MathMin(lots, mx);
   int vd = (int)MathMax(0, MathRound(-MathLog10(step)));
   lots = NormalizeDouble(lots, vd);
   int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   sl = NormalizeDouble(sl, dg); tp = NormalizeDouble(tp, dg);

   trade.SetTypeFillingBySymbol(sym);
   bool ok = buy ? trade.Buy(lots, sym, 0, sl, tp, "TradeMind " + f[0]) : trade.Sell(lots, sym, 0, sl, tp, "TradeMind " + f[0]);
   Print("TradeMind: ", f[2], " ", sym, " lots ", lots, ok ? " placed." : " FAILED, code " + IntegerToString(trade.ResultRetcode()));
}
//+------------------------------------------------------------------+
