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

string EndpointUrl = "https://xkmpknoughjnxalkoatx.supabase.co/functions/v1/ingest-trade";

int OnInit()
{
   if(StringLen(ApiKey) == 0)
      Alert("TradeListaSync: no API key set — trades will not be sent. Open the EA's Inputs tab and paste your TradeLista account's API key.");
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

   ulong dealTicket = trans.deal;
   if(!HistoryDealSelect(dealTicket)) return;
   if((ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTicket, DEAL_ENTRY) != DEAL_ENTRY_OUT) return;

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

   string dateStr = TimeToString(closeTime, TIME_DATE); // "2026.07.19"
   StringReplace(dateStr, ".", "-");                    // -> "2026-07-19"

   string json = StringFormat(
      "{\"api_key\":\"%s\",\"symbol\":\"%s\",\"lot\":%.2f,\"entry\":%.5f,\"exit\":%.5f,\"profit\":%.2f,\"date\":\"%s\"}",
      ApiKey, symbol, volume, openPrice, closePrice, profit, dateStr
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
