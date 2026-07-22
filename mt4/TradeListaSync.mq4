//+------------------------------------------------------------------+
//|                                              TradeListaSync.mq4   |
//| Sends every trade this account closes to TradeLista, via the     |
//| ingest-trade Supabase Edge Function. This is the MT4 version —   |
//| see mt5/TradeListaSync.mq5 for the MT5 counterpart. Both talk to |
//| the same server endpoint.                                        |
//|                                                                    |
//| Setup:                                                            |
//|  1. Tools > Options > Expert Advisors > check "Allow WebRequest   |
//|     for listed URL" and add https://xkmpknoughjnxalkoatx.supabase.co |
//|  2. Attach this EA to any chart on the account you want to sync.  |
//|  3. In the EA's Inputs tab, paste the API key for the matching    |
//|     TradeLista account (Account settings > Trading accounts >     |
//|     Copy key in the web app).                                    |
//+------------------------------------------------------------------+
#property strict

input string ApiKey = ""; // TradeLista account API key (Account settings > Trading accounts)
input int CatchUpDays = 30; // On start, resend any closed trade from this many past days (e.g. ones placed from a phone while this terminal was closed)

string EndpointUrl = "https://xkmpknoughjnxalkoatx.supabase.co/functions/v1/ingest-trade";

// How many history entries existed last time we checked. MT4 has no
// per-deal event like MT5's OnTradeTransaction, so instead we watch the
// history list's length and process whatever got added since last time.
int lastHistoryTotal = 0;

// Order tickets already sent this session — guards against sending the
// same closed order twice if OnTrade fires more than once for it. The
// server independently de-duplicates by ticket too (in case the EA is
// ever restarted or attached to more than one chart on the same account).
int sentTickets[];

bool alreadySent(int ticket)
{
   for(int i = 0; i < ArraySize(sentTickets); i++)
      if(sentTickets[i] == ticket) return true;
   return false;
}

int OnInit()
{
   int total = OrdersHistoryTotal();
   lastHistoryTotal = total;

   if(StringLen(ApiKey) == 0)
   {
      Alert("TradeListaSync: no API key set — trades will not be sent. Open the EA's Inputs tab and paste your TradeLista account's API key.");
      return(INIT_SUCCEEDED);
   }

   // Catch up on anything closed while this EA wasn't running — e.g. trades
   // placed from a phone while the desktop terminal was shut. The server
   // upserts by ticket, so resending an already-synced trade is harmless;
   // it just overwrites the same row with the same data.
   datetime cutoff = TimeCurrent() - CatchUpDays * 86400;
   for(int i = 0; i < total; i++)
   {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_HISTORY)) continue;

      int orderType = OrderType();
      if(orderType != OP_BUY && orderType != OP_SELL) continue; // skip pending orders and balance/credit entries
      if(OrderCloseTime() == 0 || OrderCloseTime() < cutoff) continue;

      int ticket = OrderTicket();
      if(alreadySent(ticket)) continue;
      int idx = ArraySize(sentTickets);
      ArrayResize(sentTickets, idx + 1);
      sentTickets[idx] = ticket;

      sendClosedOrder(ticket);
   }

   return(INIT_SUCCEEDED);
}

void OnTrade()
{
   if(StringLen(ApiKey) == 0) return;

   int total = OrdersHistoryTotal();
   if(total <= lastHistoryTotal){ lastHistoryTotal = total; return; }

   for(int i = lastHistoryTotal; i < total; i++)
   {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_HISTORY)) continue;

      int orderType = OrderType();
      if(orderType != OP_BUY && orderType != OP_SELL) continue; // skip pending orders and balance/credit entries
      if(OrderCloseTime() == 0) continue;

      int ticket = OrderTicket();
      if(alreadySent(ticket)) continue;
      int idx = ArraySize(sentTickets);
      ArrayResize(sentTickets, idx + 1);
      sentTickets[idx] = ticket;

      sendClosedOrder(ticket);
   }

   lastHistoryTotal = total;
}

void sendClosedOrder(int ticket)
{
   if(!OrderSelect(ticket, SELECT_BY_TICKET, MODE_HISTORY)) return;

   string symbol = OrderSymbol();
   double volume = OrderLots();
   double openPrice = OrderOpenPrice();
   double closePrice = OrderClosePrice();
   double profit = OrderProfit() + OrderSwap() + OrderCommission();

   // OrderCloseTime() is in the broker's server time, which is usually not
   // the trader's own timezone (often off by 1-3 hours) — convert to the
   // computer's local time before splitting into date/time strings, so what
   // gets shown in TradeLista matches the trader's own wall clock.
   datetime localCloseTime = OrderCloseTime() + (TimeLocal() - TimeCurrent());
   string dateStr = TimeToString(localCloseTime, TIME_DATE); // "2026.07.19"
   StringReplace(dateStr, ".", "-");                          // -> "2026-07-19"
   string timeStr = TimeToString(localCloseTime, TIME_MINUTES); // "14:32"
   string ticketStr = IntegerToString(ticket);

   // Minutes this computer's local clock sits east of UTC right now (e.g.
   // +120 for UTC+2) — sent alongside the local date/time above so
   // TradeLista's website can re-derive the true UTC instant and show it
   // converted into whatever timezone the person viewing it is in.
   int tzOffsetMinutes = (int)((TimeLocal() - TimeGMT()) / 60);

   string json = StringFormat(
      "{\"api_key\":\"%s\",\"symbol\":\"%s\",\"lot\":%.2f,\"entry\":%.5f,\"exit\":%.5f,\"profit\":%.2f,\"date\":\"%s\",\"time\":\"%s\",\"tz_offset_minutes\":%d,\"deal_ticket\":\"%s\"}",
      ApiKey, symbol, volume, openPrice, closePrice, profit, dateStr, timeStr, tzOffsetMinutes, ticketStr
   );

   // Deliberately not passing a codepage here (MQL4's StringToCharArray
   // doesn't reliably support that 5th parameter across builds the way
   // MQL5's does) — the JSON is plain ASCII so the default is fine. Only
   // trim a trailing null if one is actually there, since whether one gets
   // appended can vary by build.
   char postData[];
   int written = StringToCharArray(json, postData, 0, StringLen(json));
   if(written > 0 && postData[written-1] == 0)
      ArrayResize(postData, written - 1);
   else
      ArrayResize(postData, written);

   char responseData[];
   string responseHeaders;
   int status = WebRequest("POST", EndpointUrl, "Content-Type: application/json\r\n", 5000, postData, responseData, responseHeaders);

   if(status == -1)
      Print("TradeListaSync: WebRequest failed, error ", GetLastError(), " — check the URL is whitelisted in Tools > Options > Expert Advisors.");
   else if(status >= 400)
      Print("TradeListaSync: server rejected the trade (HTTP ", status, "): ", CharArrayToString(responseData));
   else
      Print("TradeListaSync: sent ", symbol, " profit=", profit, " (HTTP ", status, ")");
}
