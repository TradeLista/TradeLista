//+------------------------------------------------------------------+
//|                                              TradeListaSync.mq5   |
//| Sends every trade this account closes to TradeLista, via the     |
//| ingest-trade Supabase Edge Function.                             |
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

// Deal tickets already sent this session — MT5 can fire OnTradeTransaction
// more than once for the same deal, and this stops us re-sending it. The
// server independently de-duplicates by deal ticket too (in case the EA is
// ever restarted or attached to more than one chart on the same account).
ulong sentDeals[];

bool alreadySent(ulong ticket)
{
   for(int i = 0; i < ArraySize(sentDeals); i++)
      if(sentDeals[i] == ticket) return true;
   return false;
}

int OnInit()
{
   if(StringLen(ApiKey) == 0)
   {
      Alert("TradeListaSync: no API key set — trades will not be sent. Open the EA's Inputs tab and paste your TradeLista account's API key.");
      return(INIT_SUCCEEDED);
   }

   // Catch up on anything closed while this EA wasn't running — e.g. trades
   // placed from a phone while the desktop terminal was shut. The server
   // upserts by deal ticket, so resending an already-synced trade is
   // harmless; it just overwrites the same row with the same data. Collect
   // the candidate tickets first, then process them — ProcessDeal() below
   // calls HistorySelectByPosition() internally, which would otherwise pull
   // the rug out from under HistoryDealGetTicket() mid-loop.
   HistorySelect(TimeCurrent() - CatchUpDays * 86400, TimeCurrent());
   int total = HistoryDealsTotal();
   ulong candidates[];
   for(int i = 0; i < total; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if((ENUM_DEAL_ENTRY)HistoryDealGetInteger(ticket, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;
      int idx = ArraySize(candidates);
      ArrayResize(candidates, idx + 1);
      candidates[idx] = ticket;
   }
   for(int i = 0; i < ArraySize(candidates); i++)
      ProcessDeal(candidates[i]);

   return(INIT_SUCCEEDED);
}

// Fires on every deal MT5 records. We only care about DEAL_ENTRY_OUT deals —
// those are the ones that close a position and produce a final profit, which
// is the only trade shape TradeLista's calendar understands.
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD) return;
   if(StringLen(ApiKey) == 0) return;
   ProcessDeal(trans.deal);
}

// Builds and sends the ingest-trade payload for one closed deal. Called
// both from the live OnTradeTransaction event and from OnInit's catch-up
// scan, so a trade missed while the EA wasn't running gets sent the next
// time it starts, not just trades that happen to close while it's already
// attached.
void ProcessDeal(ulong dealTicket)
{
   if(alreadySent(dealTicket)) return;
   if(!HistoryDealSelect(dealTicket)) return;
   if((ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTicket, DEAL_ENTRY) != DEAL_ENTRY_OUT) return;

   int idx = ArraySize(sentDeals);
   ArrayResize(sentDeals, idx + 1);
   sentDeals[idx] = dealTicket;

   string symbol = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
   double volume = HistoryDealGetDouble(dealTicket, DEAL_VOLUME);
   double closePrice = HistoryDealGetDouble(dealTicket, DEAL_PRICE);
   datetime closeTime = (datetime)HistoryDealGetInteger(dealTicket, DEAL_TIME);
   double profit = HistoryDealGetDouble(dealTicket, DEAL_PROFIT)
                 + HistoryDealGetDouble(dealTicket, DEAL_SWAP)
                 + HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);

   // Walk the same position's deal history to find its opening price.
   ulong positionId = HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
   double openPrice = 0;
   HistorySelectByPosition(positionId);
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong t = HistoryDealGetTicket(i);
      if((ENUM_DEAL_ENTRY)HistoryDealGetInteger(t, DEAL_ENTRY) == DEAL_ENTRY_IN)
      {
         openPrice = HistoryDealGetDouble(t, DEAL_PRICE);
         break;
      }
   }

   // DEAL_TIME is in the broker's server time, which is usually not the
   // trader's own timezone (often off by 1-3 hours) — convert to the
   // computer's local time before splitting into date/time strings, so what
   // gets shown in TradeLista matches the trader's own wall clock.
   datetime localCloseTime = closeTime + (TimeLocal() - TimeCurrent());
   string dateStr = TimeToString(localCloseTime, TIME_DATE); // "2026.07.19"
   StringReplace(dateStr, ".", "-");                         // -> "2026-07-19"
   string timeStr = TimeToString(localCloseTime, TIME_MINUTES); // "14:32"
   string dealTicketStr = IntegerToString(dealTicket);

   // Minutes this computer's local clock sits east of UTC right now (e.g.
   // +120 for UTC+2) — sent alongside the local date/time above so
   // TradeLista's website can re-derive the true UTC instant and show it
   // converted into whatever timezone the person viewing it is in.
   int tzOffsetMinutes = (int)((TimeLocal() - TimeGMT()) / 60);

   string json = StringFormat(
      "{\"api_key\":\"%s\",\"symbol\":\"%s\",\"lot\":%.2f,\"entry\":%.5f,\"exit\":%.5f,\"profit\":%.2f,\"date\":\"%s\",\"time\":\"%s\",\"tz_offset_minutes\":%d,\"deal_ticket\":\"%s\"}",
      ApiKey, symbol, volume, openPrice, closePrice, profit, dateStr, timeStr, tzOffsetMinutes, dealTicketStr
   );

   // StringToCharArray's exact return count (with or without a trailing \0)
   // varies by build, so only trim a trailing null if one is actually there —
   // blindly subtracting 1 can instead chop off the JSON's real last byte.
   char postData[];
   int written = StringToCharArray(json, postData, 0, StringLen(json), CP_UTF8);
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
